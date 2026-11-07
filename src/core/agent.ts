import { ToolError, toOutput, validateInput, type Tool, type ToolContext, type ToolOutput } from '../tools/types.js';
import { clampThinking, cost, type ModelInfo } from './models.js';
import type { PermissionMode } from './settings.js';
import {
  addUsage,
  contextTokens,
  emptyUsage,
  type AssistantMessage,
  type Message,
  type Provider,
  type StopReason,
  type ThinkingLevel,
  type ToolCallBlock,
  type ToolResultBlock,
  type Usage,
  type UserContent,
} from './types.js';

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'request_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call_streaming'; id: string; name: string }
  | { type: 'assistant_message'; message: AssistantMessage; usage: Usage; stopReason: StopReason; stopDetail?: string }
  | { type: 'tool_start'; call: ToolCallBlock; label: string }
  | { type: 'tool_update'; id: string; partial: string }
  | { type: 'tool_end'; call: ToolCallBlock; output: ToolOutput; isError: boolean; ms: number }
  | { type: 'steer'; text: string }
  | { type: 'message'; message: Message }
  | { type: 'compaction_start'; auto: boolean }
  | { type: 'compaction_end'; summary: string; tokensBefore: number }
  | { type: 'turn_end'; aborted?: boolean; error?: unknown };

export type Approval = 'yes' | 'no' | 'always';
export type Approver = (tool: Tool, input: any, preview: string, signal: AbortSignal) => Promise<Approval>;

export interface AgentOptions {
  cwd: string;
  provider: Provider;
  model: ModelInfo;
  tools: Tool[];
  system: string;
  maxTokens?: number;
  thinking: ThinkingLevel;
  permissionMode: PermissionMode;
  /** null: no way to ask (print mode) */
  approver: Approver | null;
  autoCompactAt?: number;
}

const MAX_STEPS = 250;

const SUMMARY_PROMPT = `Your context window is being compacted. Write a summary of the conversation so far that will replace it, so that work can continue seamlessly.

Include, as applicable:
1. The user's goals and explicit requests, including constraints and preferences they stated.
2. What has been done: files read, created or modified (with paths), commands run and their important results.
3. Key technical facts learned about the codebase (architecture, conventions, gotchas).
4. Decisions made and why; approaches tried that failed.
5. Current state and the exact next steps, including any unfinished task in progress.

Be specific (file paths, function names, error messages) and concise. Reply with only the summary, no preamble. Do not call tools.`;

export class Agent {
  messages: Message[] = [];
  /** Accumulated over the session (including compaction calls). */
  usage: Usage = emptyUsage();
  costUSD = 0;
  /** Prompt size of the most recent request, i.e. current context usage. */
  contextUsed = 0;
  readFiles = new Map<string, number>();
  private steerQueue: string[] = [];
  private alwaysAllowed = new Set<string>();
  private listeners = new Set<(e: AgentEvent) => void>();
  private toolsByName: Map<string, Tool>;
  running = false;

  constructor(public opts: AgentOptions) {
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: AgentEvent) {
    for (const fn of this.listeners) fn(e);
  }

  get thinking(): ThinkingLevel {
    return clampThinking(this.opts.thinking, this.opts.model);
  }

  setModel(provider: Provider, model: ModelInfo) {
    this.opts.provider = provider;
    this.opts.model = model;
  }

  get tools() {
    return this.opts.tools;
  }

  /** Replace history (session load / new session). */
  load(messages: Message[], usage?: { usage: Usage; costUSD: number; contextUsed: number }) {
    this.messages = messages;
    this.readFiles.clear();
    this.usage = usage?.usage ?? emptyUsage();
    this.costUSD = usage?.costUSD ?? 0;
    this.contextUsed = usage?.contextUsed ?? 0;
  }

  /** Queue a message to be delivered to the model after the current tool calls finish. */
  steer(text: string) {
    this.steerQueue.push(text);
  }

  /** Take back messages that were queued but not yet delivered. */
  drainQueue(): string[] {
    const q = this.steerQueue;
    this.steerQueue = [];
    return q;
  }

  get queued(): readonly string[] {
    return this.steerQueue;
  }

  private append(message: Message) {
    this.messages.push(message);
    this.emit({ type: 'message', message });
  }

  private record(u: Usage) {
    this.usage = addUsage(this.usage, u);
    this.costUSD += cost(u, this.opts.model) ?? 0;
  }

  /** Run one user turn: call the model, execute tools, repeat until it stops. */
  async run(content: UserContent[], signal: AbortSignal): Promise<void> {
    this.running = true;
    this.emit({ type: 'turn_start' });
    try {
      this.append({ role: 'user', content });
      await this.loop(signal);
      this.emit({ type: 'turn_end' });
    } catch (error) {
      const aborted = signal.aborted || (error as Error)?.name === 'AbortError';
      this.emit({ type: 'turn_end', aborted, error: aborted ? undefined : error });
      if (!aborted) throw error;
    } finally {
      this.running = false;
    }
  }

  private async loop(signal: AbortSignal) {
    const specs = this.opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.shouldCompact()) {
        await this.compact(signal, { auto: true });
        this.append({ role: 'user', content: [{ type: 'text', text: 'Continue with the task where you left off.' }] });
      }

      this.emit({ type: 'request_start' });
      const res = await this.opts.provider.complete(
        {
          system: this.opts.system,
          messages: this.messages,
          tools: specs,
          maxTokens: this.opts.maxTokens ?? Math.min(64_000, this.opts.model.maxOutput),
          thinking: this.thinking,
          signal,
        },
        {
          onText: (delta) => this.emit({ type: 'text_delta', delta }),
          onThinking: (delta) => this.emit({ type: 'thinking_delta', delta }),
          onToolCallStart: (id, name) => this.emit({ type: 'tool_call_streaming', id, name }),
        },
      );
      this.record(res.usage);
      this.contextUsed = contextTokens(res.usage) + res.usage.output;

      const message: AssistantMessage = { role: 'assistant', content: res.content };
      this.emit({ type: 'assistant_message', message, usage: res.usage, stopReason: res.stopReason, stopDetail: res.stopDetail });
      if (res.content.length) this.append(message);

      // Every tool call needs a result or the next request is invalid, so run
      // them even if the stop reason disagrees (some servers report "stop").
      let calls = res.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
      // A response cut off by max_tokens may carry a truncated tool input.
      const truncated = res.stopReason === 'max_tokens' && calls.length > 0;

      if (!calls.length) {
        const pending = this.drainQueue();
        if (!pending.length) return;
        for (const text of pending) this.emit({ type: 'steer', text });
        this.append({ role: 'user', content: pending.map((text) => ({ type: 'text' as const, text })) });
        continue;
      }

      const results: ToolResultBlock[] = [];
      let halted = false;
      if (truncated) {
        for (const c of calls)
          results.push({ type: 'tool_result', id: c.id, isError: true, content: 'Your response hit the output token limit, so this tool call was cut off and not run. Retry with smaller steps (e.g. write a large file in parts).' });
        calls = [];
      }
      // Run consecutive read-only tools in parallel; anything needing approval runs alone.
      let i = 0;
      while (i < calls.length) {
        if (halted || signal.aborted) {
          results.push({ type: 'tool_result', id: calls[i].id, content: 'Skipped.', isError: true });
          i++;
          continue;
        }
        const batch: ToolCallBlock[] = [];
        while (i < calls.length && this.toolsByName.get(calls[i].name)?.permission === 'none') batch.push(calls[i++]);
        if (!batch.length) batch.push(calls[i++]);
        const outs = await Promise.all(batch.map((c) => this.execute(c, signal)));
        for (const o of outs) {
          results.push(o.result);
          if (o.denied) halted = true;
        }
      }

      const steering = halted ? [] : this.drainQueue();
      for (const text of steering) this.emit({ type: 'steer', text });
      this.append({
        role: 'user',
        content: [...results, ...steering.map((text) => ({ type: 'text' as const, text }))],
      });

      if (signal.aborted) throw abortError();
      // On denial, hand control back so the user can say what to do instead.
      if (halted) return;
    }
    throw new Error(`Stopped after ${MAX_STEPS} steps.`);
  }

  private async execute(call: ToolCallBlock, signal: AbortSignal): Promise<{ result: ToolResultBlock; denied?: boolean }> {
    const started = Date.now();
    const finish = (output: ToolOutput, isError: boolean, denied = false) => {
      this.emit({ type: 'tool_end', call, output, isError, ms: Date.now() - started });
      return {
        result: { type: 'tool_result' as const, id: call.id, content: output.content, images: output.images, isError: isError || undefined },
        denied,
      };
    };

    const tool = this.toolsByName.get(call.name);
    const invalid = tool ? validateInput(tool, call.input) : `Unknown tool "${call.name}".`;
    this.emit({ type: 'tool_start', call, label: tool && !invalid ? tool.label(call.input) : JSON.stringify(call.input) });
    if (!tool || invalid) return finish({ content: invalid! }, true);

    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      signal,
      readFiles: this.readFiles,
      onUpdate: (partial) => this.emit({ type: 'tool_update', id: call.id, partial }),
    };
    try {
      const approval = await this.checkPermission(tool, call.input, ctx);
      if (approval === 'no')
        return finish({ content: 'The user denied this action. Do not retry it; wait for their instructions.' }, true, true);
      if (approval === 'unavailable')
        return finish({ content: `This action needs the user's approval, but wisp is running non-interactively. Tell the user to re-run with --auto-edit or --yes if they want to allow it.` }, true, true);
      return finish(toOutput(await tool.run(call.input, ctx)), false);
    } catch (err) {
      if (signal.aborted) return finish({ content: 'Interrupted by user.' }, true);
      const msg = err instanceof ToolError ? err.message : `Tool failed: ${(err as Error).message}`;
      return finish({ content: msg }, true);
    }
  }

  private async checkPermission(tool: Tool, input: any, ctx: ToolContext): Promise<Approval | 'unavailable'> {
    const mode = this.opts.permissionMode;
    if (tool.permission === 'none' || mode === 'yolo') return 'yes';
    if (mode === 'auto-edit' && tool.permission === 'edit') return 'yes';
    if (this.alwaysAllowed.has(tool.name)) return 'yes';
    if (!this.opts.approver) return 'unavailable';
    let preview: string;
    try {
      preview = tool.preview ? await tool.preview(input, ctx) : `${tool.name}: ${tool.label(input)}`;
    } catch (e) {
      // e.g. edit target not found: just run it so the model gets the error.
      if (e instanceof ToolError) return 'yes';
      throw e;
    }
    const answer = await this.opts.approver(tool, input, preview, ctx.signal);
    if (answer === 'always') this.alwaysAllowed.add(tool.name);
    return answer;
  }

  // --- compaction -----------------------------------------------------------

  shouldCompact(): boolean {
    const at = this.opts.autoCompactAt ?? 0.85;
    return at > 0 && this.messages.length > 4 && this.contextUsed > at * this.opts.model.contextWindow;
  }

  /** Summarize the history and replace it with the summary. */
  async compact(signal: AbortSignal, opts: { auto?: boolean; instructions?: string } = {}): Promise<string> {
    if (this.messages.length === 0) throw new Error('Nothing to compact yet.');
    this.emit({ type: 'compaction_start', auto: Boolean(opts.auto) });
    const tokensBefore = this.contextUsed;
    const prompt = SUMMARY_PROMPT + (opts.instructions ? `\n\nAdditional instructions from the user: ${opts.instructions}` : '');
    const res = await this.opts.provider.complete(
      {
        system: this.opts.system,
        messages: [...this.messages, { role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: this.opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        maxTokens: 16_000,
        thinking: 'low',
        signal,
      },
      { onText: () => {}, onThinking: () => {} },
    );
    this.record(res.usage);
    const summary = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!summary) throw new Error('Compaction failed: the model returned no summary.');
    this.messages = [compactionMessage(summary)];
    this.contextUsed = 0;
    this.emit({ type: 'compaction_end', summary, tokensBefore });
    return summary;
  }
}

export function compactionMessage(summary: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `The conversation so far was compacted to save context. Summary of what happened before:\n\n<summary>\n${summary}\n</summary>`,
      },
    ],
  };
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
