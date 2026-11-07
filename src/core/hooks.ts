import type { Tool, ToolContext, ToolOutput } from '../tools/types.js';
import type { Agent } from './agent.js';
import type { Session } from './session.js';
import type { SettingDef, SettingsStore } from './settings.js';
import type { ToolCallBlock } from './types.js';

/**
 * Extension points. A Feature is a plain object; every member is optional
 * except `name`. Features are installed with `installFeatures()` (see
 * src/features/index.ts): settings are registered, `setup(host)` runs, then
 * `agent.register(feature)` wires tools and agent hooks.
 *
 * Hooks run in registration order and are awaited one after another.
 */
export interface Feature {
  name: string;
  /** Called once at install time, before the first turn. Keep the host for later use. */
  setup?(host: FeatureHost): void;
  /** Extra tools; re-read whenever the agent's tool set is rebuilt (call host.refreshTools() after a change). */
  tools?(): Tool[];
  /** Slash commands (shown in autocomplete and /help; no argument syntax). */
  commands?: SlashCommand[];
  /** Rows for /settings (and validated keys in settings.json). */
  settings?: SettingDef[];
  /** One or more lines shown above the editor; return null/[] to hide. Called on every frame: keep it cheap. */
  widget?(): string | string[] | null | undefined;
  /** A short segment for the right side of the footer (e.g. "auto-edit"). */
  status?(): string | null | undefined;

  /**
   * Before a (validated) tool call runs. Return:
   * - nothing: run it unchanged
   * - { input }: run it with this input instead (later features see the new input)
   * - { block, halt? }: don't run it; `block` is the error result the model sees.
   *   halt: true ends the turn after this batch (like a user denial).
   * Read-only tools (permission 'none') run in parallel, so these hooks can run concurrently.
   */
  beforeToolCall?(call: ToolCallBlock, ctx: ToolHookContext): BeforeToolCall | Promise<BeforeToolCall>;
  /** After a tool ran (or failed). Return { append } to add text to what the model sees, { isError } to override. */
  afterToolResult?(call: ToolCallBlock, result: ToolResultInfo, ctx: ToolHookContext): AfterToolResult | Promise<AfterToolResult>;
  /** A user turn starts (before the first request). */
  turnStart?(ctx: { agent: Agent }): void | Promise<void>;
  /** A turn ended (normally, aborted, or with an error). */
  turnEnd?(info: { agent: Agent; aborted: boolean; error?: unknown }): void | Promise<void>;
  /** A conversation was opened: at startup, /new, /resume, /fork. */
  sessionLoaded?(info: { session: Session; reason: 'startup' | 'new' | 'resume' | 'fork' }): void;
  /** The conversation moved to another point of its tree (/tree); `from` is the previous head. */
  branchChanged?(info: { session: Session; from: string | null }): void;
  /** wisp is exiting: stop servers, flush pending work (bounded; errors are ignored). */
  shutdown?(): void | Promise<void>;
}

export type BeforeToolCall = void | undefined | { input: Record<string, unknown> } | { block: string; halt?: boolean };
export type AfterToolResult = void | undefined | { append?: string; isError?: boolean };

export interface ToolResultInfo extends ToolOutput {
  isError: boolean;
  ms: number;
}

export interface ToolHookContext {
  agent: Agent;
  /** The tool being called (always defined: unknown/invalid calls never reach hooks). */
  tool: Tool;
  /** The context the tool will run with (cwd, signal, readFiles); usable for tool.preview(). */
  toolContext: ToolContext;
  /** Tell the UI the call waits for the user ('waiting') or may go ahead ('approved'). */
  setStatus(s: 'waiting' | 'approved'): void;
}

export interface SlashCommand {
  /** Without the slash, e.g. "mode". */
  name: string;
  description: string;
  /** May run while the agent is working (default false). */
  whileBusy?: boolean;
  /** `args` is whatever the user typed after the name (often ''): never require it. */
  run(args: string): void | Promise<void>;
}

export interface SelectOption<T> {
  label: string;
  value: T;
  detail?: string;
  hotkey?: string;
}

/** What features can do to the UI. In print/json mode `interactive` is false and dialogs resolve to undefined. */
export interface FeatureUI {
  readonly interactive: boolean;
  notice(text: string, kind?: 'info' | 'warn' | 'error' | 'success'): void;
  /** A short message in the footer. */
  flash(text: string, ms?: number): void;
  /** A list dialog. Resolves with the chosen value, or undefined on esc / abort. */
  select<T>(o: {
    title: string;
    options: SelectOption<T>[];
    body?: () => string[];
    hint?: string;
    initial?: number;
    filterable?: boolean;
    /** 'bottom' replaces the editor (approvals); default floats over the conversation. */
    anchor?: 'center' | 'bottom';
    signal?: AbortSignal;
  }): Promise<T | undefined>;
  /** A one-line text dialog. Resolves with the text, or undefined on esc. */
  input(o: { title: string; body?: string[]; initial?: string; placeholder?: string }): Promise<string | undefined>;
  /** Redraw (e.g. after a widget's state changed). */
  render(): void;
  /** Terminal rows (for sizing previews). */
  readonly height: number;
}

export interface FeatureHost {
  cwd: string;
  agent: Agent;
  settings: SettingsStore;
  ui: FeatureUI;
  /** The current conversation (changes on /new, /resume, /fork). */
  session(): Session;
  /** Rebuild the agent's tool list (after a feature's tools() changed). */
  refreshTools(): void;
}
