/**
 * Subagents: hand a focused job to a separate in-process wisp Agent with a fresh context and
 * get back its final answer.
 *
 * - The child is a plain `Agent` (src/core/agent.ts) on the caller's provider, model and thinking
 *   level. Coupling is kept thin: the caller passes the provider/model/tools, and may pass a
 *   `createAgent` factory (default `new Agent(opts)`) and `features` to register on the child
 *   (e.g. permissions or checkpoints, so write subagents still go through the parent's rules).
 * - access "read" (default): read_file, grep, glob, ls only. access "write": also edit_file,
 *   write_file and bash, but only those present in the `tools` the caller passes (so --tools
 *   limits hold). A write subagent with none of them is refused at once.
 * - The child never gets the `subagent` tool itself, so it cannot nest.
 * - At most MAX_CONCURRENT run at once (shared limiter); further calls wait in order and can be
 *   aborted while waiting. Aborting `signal` aborts the child.
 */

import { Agent, type AgentEvent, type AgentOptions } from './core/agent.js';
import type { Feature } from './core/hooks.js';
import type { ModelInfo } from './core/models.js';
import { emptyUsage, type Provider, type ThinkingLevel, type ToolSpec, type Usage } from './core/types.js';
import { ToolError, type Tool, type ToolContext, type ToolOutput } from './tools/types.js';

export const SUBAGENT_TOOL = 'subagent';
/** Subagents running at once; further calls wait for a free slot. */
export const MAX_CONCURRENT = 4;
/** Longest answer passed back to the parent, in characters. */
export const MAX_ANSWER_CHARS = 30_000;
const MAX_ACTIVITY = 30;

export type SubagentAccess = 'read' | 'write';
export type SubagentStatus = 'waiting' | 'running' | 'done' | 'failed' | 'stopped';

/** Tools a read-only subagent gets. */
export const READ_TOOLS: readonly string[] = ['read_file', 'grep', 'glob', 'ls'];
/** Extra tools a write subagent gets, when the caller provides them. */
export const MUTATING_TOOLS: readonly string[] = ['edit_file', 'write_file', 'bash'];

// --- model-facing tool spec ---------------------------------------------------

export const SUBAGENT_DESCRIPTION = `Start a subagent: a separate agent with a fresh context that works on one task by itself and returns one final answer. Its tool calls and the file contents it reads stay out of your context; only its answer comes back.

Use it for:
- Broad exploration or research across many files ("find every place that ...", "how does X work end to end").
- Several independent investigations at once: call subagent several times in one message and they run in parallel (up to ${MAX_CONCURRENT} at a time).
- A self-contained change (access "write") when the steps are clear and you only need a summary back.

Do not use it for:
- Reading a file or a few files you already know, or a single search: use read_file or grep yourself, it is faster and cheaper.
- Work that needs this conversation's context or a back-and-forth: the subagent sees only your prompt, cannot ask questions, and you cannot follow up.
- Steps that depend on each other's results: do those in order yourself.

Write the prompt as a standalone brief: the goal, what you already know (paths, names, constraints), what to leave alone, and the shape of the answer (for example file:line references, a short explanation, or a summary of the changes).

access "read" (the default) gives read_file, grep, glob and ls: the subagent cannot change files or run commands. access "write" also gives edit_file, write_file and bash; use it only when the task is to make changes, and never run two write subagents on the same files at once.

The user does not see the subagent's answer: report what matters from it in your own reply.`;

export const SUBAGENT_TOOL_SPEC: ToolSpec = {
  name: SUBAGENT_TOOL,
  description: SUBAGENT_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short label for the task (3-6 words), shown to the user.' },
      prompt: {
        type: 'string',
        description:
          'The complete, standalone brief: the goal, what you already know (paths, names, constraints), what to leave alone, and the shape of the answer you want back.',
      },
      access: {
        type: 'string',
        enum: ['read', 'write'],
        description: 'read (default): read_file, grep, glob and ls only. write: also edit_file, write_file and bash, to make changes.',
      },
    },
    required: ['description', 'prompt'],
  },
};

// --- child system prompt --------------------------------------------------------

const PREAMBLE = `You are a subagent of wisp, a coding agent. Another agent gave you one focused task. Work on it by yourself; you cannot ask questions or get a reply, so when something is unclear, make a reasonable assumption and mention it in your answer.`;
const READ_NOTE = `You have read-only tools: you cannot change files or run commands. If the task seems to need changes, describe them instead.`;
const WRITE_NOTE = `You may change files and run commands as the task requires. Keep changes to what the task asks for and follow the project's conventions.`;
const ANSWER_NOTE = `Your last message is the only thing the other agent sees. End with the answer itself, in the shape the task asked for: findings or what you changed, with file paths (and line numbers where useful). Be concise and leave out narration of your steps.`;

export function subagentSystemPrompt(access: SubagentAccess, tools: Tool[], cwd: string): string {
  const list = tools.map((t) => `- ${t.name}`).join('\n');
  return `${PREAMBLE}\n\n${access === 'write' ? WRITE_NOTE : READ_NOTE}\n\n${ANSWER_NOTE}\n\nWorking directory: ${cwd}\n\nYour tools:\n${list}`;
}

/** The child's tools for an access level, picked from what the caller provides. */
export function subagentTools(access: SubagentAccess, available: Tool[]): Tool[] {
  const allowed = new Set(access === 'write' ? [...READ_TOOLS, ...MUTATING_TOOLS] : READ_TOOLS);
  return available.filter((t) => t.name !== SUBAGENT_TOOL && allowed.has(t.name));
}

// --- concurrency ------------------------------------------------------------------

/** A counting semaphore; waiting callers are released in order and can be aborted. */
export class Limiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(readonly max: number) {}

  get active(): number {
    return this.running;
  }
  get waiting(): number {
    return this.queue.length;
  }

  /** Wait for a slot. Resolves with a release function (idempotent), or rejects when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    const once = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.running--;
        this.queue.shift()?.();
      };
    };
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(once());
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', onAbort);
        this.running++;
        resolve(once());
      };
      const onAbort = () => {
        const i = this.queue.indexOf(start);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortError());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(start);
    });
  }
}

/** Shared by every runSubagent call that does not pass its own limiter. */
export const defaultLimiter = new Limiter(MAX_CONCURRENT);

// --- runner -------------------------------------------------------------------------

/** The bits of Agent the runner uses, so tests or a refactored engine can plug in. */
export type AgentLike = Pick<Agent, 'run' | 'subscribe' | 'register' | 'messages' | 'usage' | 'costUSD'>;

export interface SubagentProgress {
  status: SubagentStatus;
  access: SubagentAccess;
  description: string;
  toolCount: number;
  /** Recent tool calls, newest last ("read_file src/app.ts"). */
  activity: string[];
  ms: number;
  usage: Usage;
  cost: number;
}

export interface SubagentOptions {
  description: string;
  prompt: string;
  access?: SubagentAccess;
  provider: Provider;
  model: ModelInfo;
  thinking: ThinkingLevel;
  /** Tools the parent has available; the child gets the subset its access level allows. */
  tools: Tool[];
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (p: SubagentProgress) => void;
  /** Features to register on the child (e.g. permissions). Must not add a subagent tool. */
  features?: Feature[];
  /** Build the child agent; default `new Agent(opts)`. */
  createAgent?: (opts: AgentOptions) => AgentLike;
  limiter?: Limiter;
  /** Defaults to 0 (no auto-compaction): subagents are short-lived. */
  autoCompactAt?: number;
}

export interface SubagentResult {
  /** The child's final answer (empty when it failed before answering). */
  text: string;
  toolCount: number;
  ms: number;
  usage: Usage;
  cost: number;
  status: 'done' | 'failed' | 'stopped';
  error?: string;
  activity: string[];
}

export async function runSubagent(o: SubagentOptions): Promise<SubagentResult> {
  const access: SubagentAccess = o.access ?? 'read';
  const started = Date.now();
  const limiter = o.limiter ?? defaultLimiter;
  const cwd = o.cwd ?? process.cwd();
  let toolCount = 0;
  const activity: string[] = [];
  let agent: AgentLike | undefined;

  const usage = () => (agent ? { ...agent.usage } : emptyUsage());
  const costUSD = () => agent?.costUSD ?? 0;
  const progress = (status: SubagentStatus) =>
    o.onProgress?.({ status, access, description: o.description, toolCount, activity: [...activity], ms: Date.now() - started, usage: usage(), cost: costUSD() });
  const result = (status: SubagentResult['status'], text = '', error?: string): SubagentResult => {
    progress(status);
    return { text, toolCount, ms: Date.now() - started, usage: usage(), cost: costUSD(), status, error, activity };
  };

  const tools = subagentTools(access, o.tools);
  if (access === 'write' && !tools.some((t) => MUTATING_TOOLS.includes(t.name)))
    return result('failed', '', 'No write tools (edit_file, write_file, bash) are available in this session; use access "read" or do the change yourself.');
  if (!tools.length) return result('failed', '', 'No tools are available for the subagent.');

  if (o.signal?.aborted) return result('stopped');
  if (limiter.active >= limiter.max) progress('waiting');
  let release: () => void;
  try {
    release = await limiter.acquire(o.signal);
  } catch {
    return result('stopped');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const opts: AgentOptions = {
      cwd,
      provider: o.provider,
      model: o.model,
      tools,
      system: subagentSystemPrompt(access, tools, cwd),
      thinking: o.thinking,
      autoCompactAt: o.autoCompactAt ?? 0,
    };
    agent = o.createAgent ? o.createAgent(opts) : new Agent(opts);
    for (const f of o.features ?? []) agent.register(f);
    agent.subscribe((e: AgentEvent) => {
      if (e.type === 'tool_start') {
        toolCount++;
        activity.push(`${e.call.name} ${e.label}`.trim().slice(0, 200));
        if (activity.length > MAX_ACTIVITY) activity.shift();
        progress('running');
      } else if (e.type === 'tool_end' || e.type === 'assistant_message') progress('running');
    });
    progress('running');
    await agent.run([{ type: 'text', text: o.prompt }], controller.signal);
    if (controller.signal.aborted) return result('stopped', finalText(agent));
    return result('done', finalText(agent));
  } catch (err) {
    if (controller.signal.aborted) return result('stopped', agent ? finalText(agent) : '');
    return result('failed', agent ? finalText(agent) : '', (err as Error)?.message ?? String(err));
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    release();
  }
}

/** Text of the last assistant message that has any. */
function finalText(agent: AgentLike): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

// --- tool wrapper ---------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** What the parent model sees: the (shortened) answer plus a one-line usage note. */
export function answerText(r: SubagentResult): string {
  let text = r.text.trim();
  if (r.status === 'failed') text = `Subagent failed: ${r.error ?? 'unknown error'}${text ? `\n\nPartial answer:\n${text}` : ''}`;
  else if (r.status === 'stopped') text = `Subagent was stopped.${text ? `\n\nPartial answer:\n${text}` : ''}`;
  else if (!text) text = '(The subagent finished without an answer.)';
  if (text.length > MAX_ANSWER_CHARS)
    text = `${text.slice(0, MAX_ANSWER_CHARS)}\n\n[Answer shortened: ${text.length - MAX_ANSWER_CHARS} more characters were left out.]`;
  const tokens = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
  return `${text}\n\n[subagent: ${r.toolCount} tool call${r.toolCount === 1 ? '' : 's'}, ${formatElapsed(r.ms)}, ${formatTokens(tokens)} tokens]`;
}

export interface SubagentToolDeps {
  /** Read at call time, so model switches and tool changes apply. */
  context(): Pick<SubagentOptions, 'provider' | 'model' | 'thinking' | 'tools' | 'features' | 'createAgent'>;
  /** Child usage/cost, to add to the parent's totals. */
  onUsage?(usage: Usage, cost: number): void;
  limiter?: Limiter;
}

/**
 * The `subagent` tool for an Agent's tool list. permission 'none' so several calls in one message
 * run in parallel (the child's own write tools still pass through `features`, e.g. permissions).
 */
export function createSubagentTool(deps: SubagentToolDeps): Tool<{ description: string; prompt: string; access?: SubagentAccess }> {
  return {
    ...SUBAGENT_TOOL_SPEC,
    permission: 'none',
    label: (i) => `${i.description ?? ''}${i.access === 'write' ? ' (write)' : ''}`,
    async run(input, ctx: ToolContext): Promise<ToolOutput> {
      const r = await runSubagent({
        ...deps.context(),
        description: input.description,
        prompt: input.prompt,
        access: input.access,
        cwd: ctx.cwd,
        signal: ctx.signal,
        limiter: deps.limiter,
        onProgress: (p) => ctx.onUpdate?.(`${p.status} · ${p.toolCount} tools · ${formatElapsed(p.ms)}${p.activity.length ? ` · ${p.activity.at(-1)}` : ''}`),
      });
      deps.onUsage?.(r.usage, r.cost);
      if (r.status === 'failed') throw new ToolError(answerText(r));
      return { content: answerText(r) };
    },
  };
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
