import type { AgentEvent } from '../core/agent.js';
import type { Message, ToolCallBlock, ToolResultBlock } from '../core/types.js';
import type { ToolOutput } from '../tools/types.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import { formatDuration, stripAnsi, truncate, wrap } from './text.js';
import { SPINNER, theme } from './theme.js';

const TOOL_TITLES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'List',
};

export const toolTitle = (name: string) => {
  if (TOOL_TITLES[name]) return TOOL_TITLES[name];
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} › ${m[2]}` : name;
};

type ToolStatus = 'ok' | 'error' | 'running' | 'pending';

function toolHeader(name: string, label: string, status: ToolStatus, width: number, extra = '', frame = 0): string {
  const dot =
    status === 'ok' ? theme.success('●') : status === 'error' ? theme.error('●') : status === 'running' ? theme.accent(SPINNER[frame % SPINNER.length]) : theme.dim('◌');
  const shownLabel = name === 'bash' ? `$ ${label.split('\n')[0]}` : label;
  const head = `${dot} ${theme.toolName(toolTitle(name))} ${shownLabel}`;
  return truncate(head, width - stripAnsi(extra).length - 1) + (extra ? ' ' + theme.dim(extra) : '');
}

function indentBody(lines: string[], width: number): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const pre = i === 0 ? theme.dim('  ⎿  ') : '     ';
    for (const [j, part] of wrap(l, width - 5).entries()) out.push((j === 0 ? pre : '     ') + part);
  });
  return out;
}

/** Summarize a tool result for the transcript. */
export function renderToolBody(call: Pick<ToolCallBlock, 'name'>, output: ToolOutput, isError: boolean, width: number, verbose: boolean): string[] {
  // diffs (display) are worth showing in full; raw output is summarized
  const max = verbose ? 400 : isError ? 8 : call.name === 'bash' ? 6 : output.display ? 24 : 4;
  let lines: string[];
  if (isError) lines = output.content.split('\n').map((l) => theme.error(l));
  else if (output.display && !verbose) lines = output.display.split('\n');
  else lines = output.content.split('\n').map((l) => theme.dim(l));
  if (call.name === 'bash' && !isError && !verbose) {
    // the end of command output is usually what matters
    if (lines.length > max) {
      const hidden = lines.length - max;
      return indentBody([theme.dim(`… ${hidden} earlier lines (ctrl+o to expand)`), ...lines.slice(-max)], width);
    }
    return indentBody(lines, width);
  }
  if (lines.length > max) {
    const hidden = lines.length - max;
    lines = [...lines.slice(0, max), theme.dim(`… +${hidden} lines (ctrl+o to expand)`)];
  }
  return indentBody(lines, width);
}

export function renderUser(text: string, width: number): string[] {
  const bar = theme.user('▌ ');
  return wrap(text, width - 2).map((l) => bar + l);
}

// --- blocks -------------------------------------------------------------------

export interface RenderCtx {
  showThinking: boolean;
  verbose: boolean;
  frame: number;
}

/**
 * A transcript entry that can render itself at any width. Rendering is cached
 * per (width, revision, relevant display toggles), so re-rendering the whole
 * transcript every frame is cheap and resizes reflow correctly.
 */
abstract class Block {
  rev = 0;
  done = true;
  private cache: { key: string; lines: string[] } | null = null;

  lines(w: number, ctx: RenderCtx): string[] {
    const key = `${w}|${this.rev}|${this.depKey(ctx)}`;
    if (this.cache?.key === key) return this.cache.lines;
    const lines = this.draw(w, ctx);
    this.cache = { key, lines };
    return lines;
  }

  protected depKey(_ctx: RenderCtx): string {
    return '';
  }

  protected abstract draw(w: number, ctx: RenderCtx): string[];
}

class StaticBlock extends Block {
  constructor(readonly raw: string[]) {
    super();
  }
  get isBlank() {
    return this.raw.length === 1 && this.raw[0] === '';
  }
  protected draw(w: number) {
    return this.raw.flatMap((l) => wrap(l, w));
  }
}

class UserBlock extends Block {
  constructor(private text: string, private steer = false) {
    super();
  }
  protected draw(w: number) {
    if (this.steer) return [...wrap(this.text, w - 4).map((l, i) => theme.user(i === 0 ? '▌ ↳ ' : '▌   ') + l), ''];
    return ['', ...renderUser(this.text, w), ''];
  }
}

class AssistantBlock extends Block {
  text = '';
  private md: MarkdownStream | null = null;
  private mdWidth = 0;
  private committed: string[] = [];

  constructor() {
    super();
    this.done = false;
  }

  append(delta: string) {
    this.text += delta;
    if (this.md) {
      this.md.push(delta);
      this.committed.push(...this.md.take());
    }
    this.rev++;
  }

  finish() {
    this.done = true;
    this.md = null;
    this.committed = [];
    this.rev++;
  }

  protected draw(w: number) {
    if (this.done) return [...renderMarkdown(this.text, w), ''];
    // streaming: render complete lines once, re-render only the unfinished tail
    if (!this.md || this.mdWidth !== w) {
      this.md = new MarkdownStream(() => w);
      this.mdWidth = w;
      this.md.push(this.text);
      this.committed = this.md.take();
    }
    return [...this.committed, ...this.md.preview(10_000)];
  }
}

class ThinkingBlock extends Block {
  text = '';
  private started = Date.now();
  private ended = 0;

  constructor() {
    super();
    this.done = false;
  }

  append(delta: string) {
    this.text += delta;
    this.rev++;
  }

  finish() {
    this.done = true;
    this.ended = Date.now();
    this.rev++;
  }

  protected depKey(ctx: RenderCtx) {
    return String(ctx.showThinking);
  }

  protected draw(w: number, ctx: RenderCtx) {
    if (!this.text.trim()) return [];
    const style = (s: string) => theme.dim(theme.italic(s));
    if (!ctx.showThinking) {
      const label = this.done ? `∴ Thought for ${formatDuration(this.ended - this.started)}` : '∴ Thinking…';
      return [style(label) + theme.dim(' (ctrl+t to show)'), ''];
    }
    const body = renderMarkdown(this.text, w - 2).map((l) => theme.dim('│ ') + style(stripAnsi(l)));
    return [style('∴ Thinking'), ...body, ...(this.done ? [''] : [])];
  }
}

class ToolBlock extends Block {
  status: ToolStatus = 'pending';
  label = '';
  started = Date.now();
  ms = 0;
  partial = '';
  output: ToolOutput | null = null;
  call: ToolCallBlock;

  constructor(readonly id: string, name: string) {
    super();
    this.done = false;
    this.call = { type: 'tool_call', id, name, input: {} };
  }

  protected depKey(ctx: RenderCtx) {
    return `${ctx.verbose}|${this.status === 'running' ? ctx.frame : ''}`;
  }

  protected draw(w: number, ctx: RenderCtx) {
    const name = this.call.name;
    if (this.status === 'pending') return [toolHeader(name, theme.dim('preparing…'), 'pending', w)];
    if (this.status === 'running') {
      const out = [toolHeader(name, this.label, 'running', w, formatDuration(Date.now() - this.started), ctx.frame)];
      if (this.partial) out.push(...this.partial.trimEnd().split('\n').slice(-5).map((l) => '     ' + theme.dim(truncate(l, w - 6))));
      return out;
    }
    const extra = this.ms >= 1000 ? formatDuration(this.ms) : '';
    return [toolHeader(name, this.label, this.status, w, extra), ...renderToolBody(this.call, this.output ?? { content: '' }, this.status === 'error', w, ctx.verbose)];
  }
}

// --- transcript -----------------------------------------------------------------

/** Turns agent events into a list of renderable blocks. */
export class Transcript {
  private blocks: Block[] = [];
  private assistant: AssistantBlock | null = null;
  private thinking: ThinkingBlock | null = null;
  private tools = new Map<string, ToolBlock>();
  private committedIdx = 0; // inline mode: blocks already written to scrollback
  lastToolOutput: { call: ToolCallBlock; output: ToolOutput; isError: boolean } | null = null;
  lastAssistantText = '';
  frame = 0;
  /** Bumped on every change, so views can skip redundant redraws. */
  version = 0;

  constructor(private opts: { showThinking: () => boolean; verbose: () => boolean }) {}

  private ctx(): RenderCtx {
    return { showThinking: this.opts.showThinking(), verbose: this.opts.verbose(), frame: this.frame };
  }

  private add<T extends Block>(b: T): T {
    // a gap after a run of tool calls
    const prev = this.blocks.at(-1);
    if (prev instanceof ToolBlock && !(b instanceof ToolBlock) && !(b instanceof StaticBlock && b.isBlank)) this.blocks.push(new StaticBlock(['']));
    this.blocks.push(b);
    this.version++;
    return b;
  }

  commit(lines: string | string[]) {
    this.add(new StaticBlock(Array.isArray(lines) ? lines : [lines]));
  }

  blank() {
    this.commit('');
  }

  user(text: string) {
    this.add(new UserBlock(text));
  }

  notice(text: string, kind: 'info' | 'warn' | 'error' | 'success' = 'info') {
    const color = kind === 'error' ? theme.error : kind === 'warn' ? theme.warn : kind === 'success' ? theme.success : theme.dim;
    this.commit(text.split('\n').map((l) => color(l)));
  }

  private endThinking() {
    this.thinking?.finish();
    this.thinking = null;
  }

  private endText() {
    this.assistant?.finish();
    this.assistant = null;
  }

  handle(e: AgentEvent) {
    this.version++;
    switch (e.type) {
      case 'request_start':
        this.lastAssistantText = '';
        break;
      case 'thinking_delta':
        if (!e.delta) break;
        this.thinking ??= this.add(new ThinkingBlock());
        this.thinking.append(e.delta);
        break;
      case 'text_delta':
        this.endThinking();
        this.assistant ??= this.add(new AssistantBlock());
        this.lastAssistantText += e.delta;
        this.assistant.append(e.delta);
        break;
      case 'tool_call_streaming': {
        this.endThinking();
        this.endText();
        const b = this.add(new ToolBlock(e.id, e.name));
        if (e.id) this.tools.set(e.id, b);
        break;
      }
      case 'assistant_message':
        this.endThinking();
        this.endText();
        if (e.stopReason === 'refusal') this.notice(e.stopDetail ?? 'The model declined to continue.', 'warn');
        else if (e.stopReason === 'max_tokens') this.notice('(response hit the output token limit)', 'warn');
        else if (e.stopDetail) this.notice(e.stopDetail, 'warn');
        break;
      case 'tool_start': {
        let b = this.tools.get(e.call.id);
        if (!b || b.status !== 'pending') {
          b = this.add(new ToolBlock(e.call.id, e.call.name));
          this.tools.set(e.call.id, b);
        }
        b.call = e.call;
        b.label = e.label;
        b.status = 'running';
        b.started = Date.now();
        b.rev++;
        break;
      }
      case 'tool_update': {
        const b = this.tools.get(e.id);
        if (b) {
          b.partial = e.partial;
          b.rev++;
        }
        break;
      }
      case 'tool_end': {
        const b = this.tools.get(e.call.id) ?? this.add(new ToolBlock(e.call.id, e.call.name));
        b.call = e.call;
        b.status = e.isError ? 'error' : 'ok';
        b.output = e.output;
        b.ms = e.ms;
        b.done = true;
        b.rev++;
        this.tools.delete(e.call.id);
        this.lastToolOutput = { call: e.call, output: e.output, isError: e.isError };
        break;
      }
      case 'steer':
        this.add(new UserBlock(e.text, true));
        break;
      case 'compaction_start':
        this.notice(e.auto ? '⟳ Context is getting full, compacting the conversation…' : '⟳ Compacting the conversation…');
        break;
      case 'compaction_end':
        this.notice('✓ Compacted. The summary replaces the earlier conversation.', 'success');
        this.blank();
        break;
      case 'turn_end':
        this.endThinking();
        this.endText();
        // tool calls that never started (e.g. cut off by max_tokens) disappear
        this.blocks = this.blocks.filter((b) => !(b instanceof ToolBlock && b.status === 'pending'));
        this.committedIdx = Math.min(this.committedIdx, this.blocks.length);
        this.tools.clear();
        break;
    }
  }

  /** Everything, rendered at width `w` (fullscreen view). */
  render(w: number): string[] {
    const ctx = this.ctx();
    const out: string[] = [];
    for (const b of this.blocks) for (const l of b.lines(w, ctx)) out.push(l);
    return out;
  }

  /** Inline view: lines of newly finished blocks, in order, to write to scrollback. */
  takeFinished(w: number): string[] {
    const ctx = this.ctx();
    const out: string[] = [];
    while (this.committedIdx < this.blocks.length && this.blocks[this.committedIdx].done) {
      out.push(...this.blocks[this.committedIdx].lines(w, ctx));
      this.committedIdx++;
    }
    return out;
  }

  /** Inline view: blocks still in progress (and anything after them). */
  live(w: number): string[] {
    const ctx = this.ctx();
    return this.blocks.slice(this.committedIdx).flatMap((b) => b.lines(w, ctx));
  }

  get busyLabel(): string {
    if (this.tools.size && [...this.tools.values()].some((b) => b.status === 'running')) return 'Running tools';
    if (this.tools.size) return 'Writing';
    if (this.assistant) return 'Responding';
    return 'Thinking';
  }

  /** Rebuild blocks for a saved conversation (when resuming a session). */
  replay(messages: Message[]) {
    const results = new Map<string, ToolResultBlock>();
    for (const m of messages) if (m.role === 'user') for (const b of m.content) if (b.type === 'tool_result') results.set(b.id, b);
    for (const m of messages) {
      if (m.role === 'user') {
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        const shell = /^I ran a shell command:\n\$ (.*)\n```\n([\s\S]*)\n```$/.exec(text);
        if (shell) {
          this.addDoneTool({ type: 'tool_call', id: `replay-${this.blocks.length}`, name: 'bash', input: { command: shell[1] } }, shell[1], shell[2], false);
        } else if (text.startsWith('The conversation so far was compacted')) {
          this.notice('⟳ (earlier conversation was compacted)');
          this.blank();
        } else if (text) this.user(text.length > 4000 ? text.slice(0, 4000) + '…' : text);
        continue;
      }
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) {
          const a = this.add(new AssistantBlock());
          a.append(b.text);
          a.finish();
          this.lastAssistantText = b.text;
        } else if (b.type === 'thinking' && b.thinking.trim()) {
          const t = this.add(new ThinkingBlock());
          t.append(b.thinking);
          t.finish();
        } else if (b.type === 'tool_call') {
          const r = results.get(b.id);
          this.addDoneTool(b, labelFor(b), r?.content ?? '', Boolean(r?.isError));
        }
      }
    }
  }

  private addDoneTool(call: ToolCallBlock, label: string, content: string, isError: boolean) {
    const t = this.add(new ToolBlock(call.id, call.name));
    t.call = call;
    t.label = label;
    t.status = isError ? 'error' : 'ok';
    t.output = { content };
    t.done = true;
  }
}

function labelFor(b: ToolCallBlock): string {
  const i = b.input as Record<string, string>;
  return i.path ?? i.command ?? i.pattern ?? JSON.stringify(b.input);
}
