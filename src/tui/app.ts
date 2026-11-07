import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Agent, type AgentEvent, type Approval } from '../core/agent.js';
import { credentialSource, removeCredential, saveCredential, verifyCredential } from '../core/auth.js';
import {
  availableModels,
  createProvider,
  formatRef,
  getModelInfo,
  NotConfiguredError,
  ollamaBaseURL,
  ollamaReachable,
  parseModelRef,
  UnconfiguredProvider,
  type ModelRef,
} from '../core/config.js';
import {
  buildSystemPrompt,
  discoverContextFiles,
  discoverPromptTemplates,
  discoverSkills,
  expandTemplate,
  type ContextFile,
  type PromptTemplate,
  type Skill,
} from '../core/context.js';
import { describeError, isAbortError } from '../core/errors.js';
import { exportSession } from '../core/export.js';
import { buildUserContent, droppedImagePath } from '../core/input.js';
import { describeServer, isProjectTrusted, McpManager, trustProject, type McpServerEntry, type McpStatus } from '../core/mcp.js';
import { BUILTIN_MODELS, DEFAULT_MODEL, type ModelInfo, type ProviderName } from '../core/models.js';
import { buildTurnTree, countBranches, forkSession, listSessions, restore, Session, type RestoredState, type TurnNode } from '../core/session.js';
import { AGENT_DIR, GLOBAL_SETTINGS, PERMISSION_MODES, type PermissionMode, type SettingsStore } from '../core/settings.js';
import { THINKING_LEVELS, type ThinkingLevel } from '../core/types.js';
import { OpenAIProvider } from '../providers/openai.js';
import { bashTool } from '../tools/bash.js';
import type { Tool } from '../tools/types.js';
import { Autocomplete, FileIndex, type CommandInfo } from './autocomplete.js';
import { copyToClipboard } from './clipboard.js';
import { Dialog, TextInput } from './dialog.js';
import { Editor } from './editor.js';
import { FullScreen } from './fullscreen.js';
import type { InputEvent, Key } from './keys.js';
import { Screen } from './screen.js';
import { SelectList, type Option } from './select.js';
import { Terminal } from './terminal.js';
import { formatDuration, formatTokens, padEnd, shortenHome, spread, stringWidth, truncate } from './text.js';
import { SPINNER, theme, thinkingColor } from './theme.js';
import { renderToolBody, Transcript } from './transcript.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const HISTORY_FILE = join(AGENT_DIR, 'history.jsonl');

export interface AppOptions {
  cwd: string;
  settings: SettingsStore;
  model: ModelRef;
  thinking: ThinkingLevel;
  permissionMode: PermissionMode;
  tools: Tool[];
  systemOverride?: string;
  appendSystem: string[];
  useContextFiles: boolean;
  session: Session;
  restored?: RestoredState;
  initialPrompt?: string;
  persistSessions: boolean;
  tuiMode: 'fullscreen' | 'inline';
  mouse: boolean;
  /** Configured MCP servers (already filtered by --no-mcp). */
  mcpServers: McpServerEntry[];
  /** --trust-project: start project MCP servers without asking. */
  trustProjectMcp: boolean;
  /** The provider was guessed (no flag/setting), so check it actually works. */
  autoProvider: boolean;
}

/** $VISUAL, $EDITOR, or the first common editor that is installed. */
export function findEditor(): string | null {
  const configured = process.env.VISUAL || process.env.EDITOR;
  if (configured) return configured;
  for (const e of ['nano', 'vim', 'vi', 'micro', 'emacs', 'hx']) {
    const r = spawnSync('sh', ['-c', `command -v ${e}`], { stdio: 'ignore' });
    if (r.status === 0) return e;
  }
  return null;
}

const PROVIDER_LABEL: Record<ProviderName, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', ollama: 'Ollama (local models)' };
const KEY_HELP: Partial<Record<ProviderName, string>> = {
  anthropic: 'Create one at https://console.anthropic.com/settings/keys',
  openai: 'Create one at https://platform.openai.com/api-keys',
};

const COMMANDS: CommandInfo[] = [
  { name: 'help', description: 'Shortcuts and commands (?)' },
  { name: 'model', description: 'Switch model (ctrl+l)', args: '[name]' },
  { name: 'login', description: 'Connect Anthropic, OpenAI or Ollama' },
  { name: 'logout', description: 'Remove a saved API key' },
  { name: 'tree', description: 'Browse branches of this conversation and jump back' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'resume', description: 'Open a saved conversation', args: '[all]' },
  { name: 'fork', description: 'Copy this conversation (up to a message) into a new one' },
  { name: 'compact', description: 'Summarize the conversation to free up context', args: '[focus]' },
  { name: 'thinking', description: 'How hard the model thinks (shift+tab)', args: '[level]' },
  { name: 'mode', description: 'When to ask before edits and commands', args: '[ask|auto-edit|yolo]' },
  { name: 'name', description: 'Name this conversation', args: '<name>' },
  { name: 'session', description: 'Conversation info: file, tokens, cost' },
  { name: 'copy', description: 'Copy the last response (ctrl+x)' },
  { name: 'export', description: 'Save the conversation as HTML or Markdown', args: '[file]' },
  { name: 'mcp', description: 'MCP servers: status, tools, reconnect', args: '[tools|reconnect] [server]' },
  { name: 'reload', description: 'Reload AGENTS.md, skills and prompt templates' },
  { name: 'settings', description: 'Edit settings in your editor' },
  { name: 'mouse', description: 'Release / capture the mouse (to select text)' },
  { name: 'exit', description: 'Quit (ctrl+d)' },
];

const SHORTCUTS: [string, string][] = [
  ['enter', 'send (or steer)'],
  ['shift+enter', 'new line'],
  ['alt+enter', 'queue a follow-up'],
  ['esc', 'stop'],
  ['↑ ↓', 'prompt history'],
  ['@', 'attach a file'],
  ['!cmd', 'shell command'],
  ['tab', 'complete a path'],
  ['ctrl+l', 'switch model'],
  ['shift+tab', 'thinking level'],
  ['ctrl+t', 'show thinking'],
  ['ctrl+o', 'full tool output'],
  ['ctrl+g', 'open in $EDITOR'],
  ['ctrl+x', 'copy response'],
  ['pgup pgdn', 'scroll'],
  ['ctrl+c ×2', 'quit'],
];

/** "Claude Opus 5.5" → "Opus 5.5": short enough for the editor border. */
function shortModelName(m: ModelInfo): string {
  return m.name.replace(/^Claude /, '');
}

export class App {
  private term = new Terminal();
  private screen: Screen | null = null; // inline mode
  private full: FullScreen | null = null; // fullscreen mode
  private editor = new Editor();
  private files: FileIndex;
  private autocomplete: Autocomplete;
  private transcript: Transcript;
  private agent: Agent;
  private session: Session;
  private model: ModelInfo;
  private dialog: Dialog<any> | null = null;
  private turn: AbortController | null = null;
  private turnStarted = 0;
  private followUps: string[] = [];
  private showThinking: boolean;
  private verbose = false;
  private lastCtrlC = 0;
  private flash: { text: string; until: number } | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private gitBranch = '';
  private contextFiles: ContextFile[] = [];
  private skills: Skill[] = [];
  private templates: PromptTemplate[] = [];
  private ollamaModels: ModelInfo[] = [];
  private mcp: McpManager | null = null;
  private mcpStatus = new Map<string, McpStatus>();
  private firstRun: boolean;
  private exitResolve: (() => void) | null = null;

  constructor(private o: AppOptions) {
    const s = o.settings.merged;
    this.showThinking = s.showThinking ?? true;
    this.session = o.session;
    this.model = getModelInfo(o.model, s);
    this.files = new FileIndex(o.cwd);
    this.autocomplete = new Autocomplete(o.cwd, this.files, () => this.commandList());
    this.transcript = new Transcript({ showThinking: () => this.showThinking, verbose: () => this.verbose });
    if (o.tuiMode === 'fullscreen') {
      this.term.altScreen = true;
      this.term.mouse = o.mouse;
      this.full = new FullScreen(this.term);
    } else this.screen = new Screen(this.term);
    this.discover();
    const history = this.loadHistory();
    this.firstRun = history.length === 0;
    let provider;
    try {
      provider = createProvider(o.model, s);
    } catch {
      provider = new UnconfiguredProvider();
    }
    this.agent = new Agent({
      cwd: o.cwd,
      provider,
      model: this.model,
      tools: o.tools,
      system: this.systemPrompt(),
      maxTokens: s.maxTokens,
      thinking: o.thinking,
      permissionMode: o.permissionMode,
      approver: (tool, input, preview, signal) => this.approve(tool, preview, signal),
      autoCompactAt: s.autoCompactAt,
    });
    if (o.restored) this.agent.load(o.restored.messages, o.restored);
    this.agent.subscribe((e) => this.onAgentEvent(e));
    this.editor.setHistory(history);
    this.editor.onChange = () => this.autocomplete.update(this.editor);
  }

  private get configured() {
    return !(this.agent.opts.provider instanceof UnconfiguredProvider);
  }

  // --- setup ------------------------------------------------------------------

  private discover() {
    this.contextFiles = this.o.useContextFiles ? discoverContextFiles(this.o.cwd) : [];
    this.skills = discoverSkills(this.o.cwd);
    this.templates = discoverPromptTemplates(this.o.cwd);
  }

  private systemPrompt() {
    return buildSystemPrompt({
      cwd: this.o.cwd,
      tools: this.agent?.tools ?? this.o.tools,
      mcpInstructions: this.mcp?.instructions(),
      contextFiles: this.contextFiles,
      skills: this.skills,
      override: this.o.systemOverride,
      append: this.o.appendSystem,
    });
  }

  private commandList(): CommandInfo[] {
    return [
      ...COMMANDS,
      ...this.templates.map((t) => ({ name: t.name, description: t.description, args: '[args]' })),
      ...this.skills.map((s) => ({ name: `skill:${s.name}`, description: s.description })),
    ];
  }

  private loadHistory(): string[] {
    try {
      return readFileSync(HISTORY_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-500)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  private saveHistory(entry: string) {
    try {
      mkdirSync(AGENT_DIR, { recursive: true });
      appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
    } catch {}
  }

  private refreshGit() {
    try {
      this.gitBranch = execFileSync('git', ['branch', '--show-current'], { cwd: this.o.cwd, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      this.gitBranch = '';
    }
  }

  async run(): Promise<void> {
    this.refreshGit();
    void this.files.refresh();
    void this.discoverOllama();
    this.term.write(`\x1b]0;wisp · ${basename(this.o.cwd)}\x07`);
    // a guessed Ollama that isn't running is "not set up", not an error later
    if (this.configured && this.o.autoProvider && this.model.provider === 'ollama' && !(await ollamaReachable(this.o.settings.merged)))
      this.agent.setModel(new UnconfiguredProvider(), this.model);
    this.header();
    if (this.o.restored?.messages.length) this.replayConversation(`Resumed ${this.session.name ? `“${this.session.name}”` : 'your last conversation'}`);
    this.term.start((e) => this.onInput(e), () => {
      this.screen?.resized();
      this.full?.resized();
      this.render();
    });
    this.render();
    if (!this.configured) this.openLogin('Welcome! Pick how wisp should talk to a model. You can change this any time with /login.');
    await this.startMcp();
    if (this.o.initialPrompt) void this.submitText(this.o.initialPrompt);
    await new Promise<void>((r) => (this.exitResolve = r));
  }

  /** Called by main() after run() returns: stop MCP server processes. */
  async shutdown() {
    await this.mcp?.close();
  }

  private header() {
    const s = this.o.settings.merged;
    const t = this.transcript;
    t.live$(() => {
      const model = this.configured ? shortModelName(this.model) : theme.warn('no model yet');
      return [`${theme.accent(theme.bold('wisp'))} ${theme.dim('·')} ${model} ${theme.dim('·')} ${theme.dim(shortenHome(this.o.cwd))}  ${theme.dim('v' + VERSION)}`];
    });
    const loaded: string[] = [];
    for (const f of this.contextFiles) loaded.push(shortenHome(f.path).replace(this.o.cwd + '/', ''));
    if (this.skills.length) loaded.push(`${this.skills.length} skill${this.skills.length > 1 ? 's' : ''}`);
    if (this.templates.length) loaded.push(`${this.templates.length} prompt${this.templates.length > 1 ? 's' : ''}`);
    if (this.o.mcpServers.length) loaded.push(`${this.o.mcpServers.length} MCP server${this.o.mcpServers.length > 1 ? 's' : ''}`);
    if (loaded.length && !s.quietStartup) t.commit(theme.dim(`loaded ${loaded.join(' · ')}`));
    if (this.firstRun && !s.quietStartup) {
      t.blank();
      t.commit(`Ask wisp to explain, fix or build things in this folder. It reads files, edits them and runs commands, and asks before changing anything.`);
      t.commit(theme.dim(`try  ${theme.accent('“give me a tour of this codebase”')}  ·  ${theme.accent('@')} attach a file  ·  ${theme.accent('/')} commands  ·  ${theme.accent('?')} shortcuts`));
    }
    t.blank();
  }

  private async discoverOllama() {
    const s = this.o.settings.merged;
    try {
      const p = new OpenAIProvider('ollama', '', { apiKey: 'ollama', baseURL: ollamaBaseURL(s) });
      const ids = await p.listModels(AbortSignal.timeout(1500));
      this.ollamaModels = ids.map((id) => getModelInfo({ provider: 'ollama', id }, s));
    } catch {
      this.ollamaModels = [];
    }
  }

  private exit() {
    if (this.turn) this.turn.abort();
    this.stopTicker();
    this.screen?.close();
    this.full?.close();
    this.term.stop();
    const u = this.agent.usage;
    const parts = [];
    if (u.input + u.output) parts.push(`${formatTokens(u.input + u.cacheRead + u.cacheWrite)} in · ${formatTokens(u.output)} out`);
    if (this.agent.costUSD) parts.push(`$${this.agent.costUSD.toFixed(3)}`);
    if (this.session.path && this.agent.messages.length) parts.push(`continue with ${theme.bold('wisp -c')}`);
    if (parts.length) process.stdout.write(theme.dim(parts.join(' · ')) + '\n');
    this.exitResolve?.();
  }

  // --- MCP --------------------------------------------------------------------

  private async startMcp() {
    let entries = this.o.mcpServers;
    if (!entries.length) return;
    const project = entries.filter((e) => e.scope === 'project');
    if (project.length && !this.o.trustProjectMcp && !isProjectTrusted(this.o.cwd, entries)) {
      const answer = await this.askProjectTrust(project);
      if (answer === 'always') trustProject(this.o.cwd, entries);
      if (answer === 'no') {
        entries = entries.filter((e) => e.scope !== 'project');
        this.transcript.notice(`Skipped ${project.length} project MCP server${project.length > 1 ? 's' : ''}. Restart wisp to be asked again.`, 'warn');
      }
    }
    if (!entries.length) return;
    this.mcp = new McpManager(entries, this.o.cwd);
    this.mcp.onChange(() => this.onMcpChange());
    void this.mcp.start();
  }

  private askProjectTrust(project: McpServerEntry[]): Promise<'always' | 'once' | 'no'> {
    return new Promise((resolveTrust) => {
      const list = new SelectList<'always' | 'once' | 'no'>([
        { label: 'Yes, and remember for this project', value: 'always', hotkey: 'y', detail: 'asks again if the config changes' },
        { label: 'Yes, just this time', value: 'once', hotkey: 'o' },
        { label: "No, don't start them", value: 'no', hotkey: 'n' },
      ]);
      this.openDialog(
        new Dialog({
          title: 'Start this project’s MCP servers?',
          width: 78,
          body: () => [
            `This folder’s config wants to run ${project.length === 1 ? 'a program' : 'these programs'} with your permissions:`,
            '',
            ...project.map((e) => `  ${theme.bold(e.name)}  ${theme.dim(describeServer(e.config))}`),
            '',
            theme.dim(`from ${[...new Set(project.map((e) => shortenHome(e.source)))].join(', ')}`),
          ],
          list,
          onSelect: resolveTrust,
          onCancel: () => resolveTrust('no'),
          hint: 'y yes · o once · n no',
        }),
      );
    });
  }

  /** Servers came up, failed or changed their tools: refresh tools, prompt and notices. */
  private onMcpChange() {
    const mcp = this.mcp!;
    this.agent.setTools([...this.o.tools, ...mcp.tools()]);
    this.agent.opts.system = this.systemPrompt();
    for (const s of mcp.servers) {
      const prev = this.mcpStatus.get(s.name);
      if (prev === s.status) continue;
      this.mcpStatus.set(s.name, s.status);
      if (s.status === 'connected') this.transcript.notice(`✓ ${s.name} connected · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`, 'success');
      else if (s.status === 'failed') this.transcript.notice(`✗ ${s.name} (MCP) failed: ${s.error ?? 'unknown error'} · /mcp for details`, 'error');
    }
    this.render();
  }

  private mcpCommand(args: string) {
    const t = this.transcript;
    const [sub, name] = args.split(/\s+/).filter(Boolean);
    const mcp = this.mcp;
    if (!mcp?.servers.length) {
      if (this.o.mcpServers.length) return t.notice('MCP servers are configured but were not started (skipped project servers, or --no-mcp).');
      return t.notice('No MCP servers yet. Add one from your shell:  wisp mcp add <name> -- <command> [args…]   or   wisp mcp add <name> --url <url>');
    }
    const pick = (n?: string) => {
      const s = n ? mcp.get(n) : undefined;
      if (n && !s) t.notice(`No MCP server named "${n}". Configured: ${mcp.servers.map((x) => x.name).join(', ')}`, 'error');
      return s;
    };
    if (sub === 'reconnect') {
      const targets = name ? [pick(name)].filter(Boolean) : mcp.servers.filter((s) => s.status !== 'disabled');
      for (const s of targets) {
        this.mcpStatus.delete(s!.name);
        t.notice(`Reconnecting ${s!.name}…`);
        void s!.connect();
      }
      return;
    }
    if (sub === 'tools') {
      const servers = name ? [pick(name)].filter(Boolean) : mcp.servers;
      t.blank();
      for (const s of servers) {
        t.commit(theme.bold(`${s!.name}`) + theme.dim(` · ${s!.tools.length} tools`));
        for (const tool of s!.tools) t.commit(`  ${theme.accent(tool.name)}  ${theme.dim(truncate((tool.description ?? '').split('\n')[0], 100))}`);
      }
      t.blank();
      return;
    }
    const icon: Record<McpStatus, string> = { connected: theme.success('●'), failed: theme.error('●'), connecting: theme.warn('◌'), disabled: theme.dim('○') };
    t.blank();
    t.commit(theme.bold('MCP servers'));
    for (const s of mcp.servers) {
      const info = s.status === 'connected' ? `${s.tools.length} tools${s.serverInfo ? ` · ${s.serverInfo.name} ${s.serverInfo.version}` : ''}` : s.status === 'failed' ? (s.error ?? 'failed') : s.status;
      t.commit(`  ${icon[s.status]} ${theme.bold(s.name)} ${theme.dim(`(${s.entry.scope})`)}  ${s.status === 'failed' ? theme.error(info) : theme.dim(info)}`);
      t.commit(theme.dim(`      ${describeServer(s.entry.config)}`));
      if (s.status === 'failed' && s.stderr.length) for (const l of s.stderr.slice(-5)) t.commit(theme.dim(`      │ ${l}`));
    }
    t.commit(theme.dim('  /mcp tools [server] · /mcp reconnect [server] · config: ~/.wisp/mcp.json, .mcp.json'));
    t.blank();
  }

  // --- agent events -----------------------------------------------------------

  private onAgentEvent(e: AgentEvent) {
    this.transcript.handle(e);
    switch (e.type) {
      case 'message':
        this.session.log({ type: 'message', message: e.message });
        if (e.message.role === 'assistant')
          this.session.log({ type: 'usage', usage: this.agent.usage, costUSD: this.agent.costUSD, contextUsed: this.agent.contextUsed });
        break;
      case 'compaction_end':
        this.session.log({ type: 'compaction', summary: e.summary, tokensBefore: e.tokensBefore });
        this.session.log({ type: 'usage', usage: this.agent.usage, costUSD: this.agent.costUSD, contextUsed: 0 });
        break;
    }
    this.render();
  }

  // --- rendering --------------------------------------------------------------

  private get busy() {
    return this.turn !== null;
  }

  private startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.transcript.frame++;
      if (this.dialog) this.dialog.frame++;
      this.render();
    }, 90);
  }

  private stopTicker() {
    if (this.busy || this.dialog?.status?.kind === 'busy') return;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private get width() {
    return (this.full ?? this.screen!).width;
  }

  private get height() {
    return (this.full ?? this.screen!).height;
  }

  /** Content width: one column of margin on each side. */
  private get contentWidth() {
    return Math.max(20, this.width - 2);
  }

  private render() {
    const w = this.contentWidth;
    const pad = (l: string) => ' ' + l;
    const bottom: string[] = [];

    if (this.busy) {
      const spin = theme.accent(SPINNER[this.transcript.frame % SPINNER.length]);
      const elapsed = formatDuration(Date.now() - this.turnStarted);
      const label = this.dialog?.anchor === 'bottom' ? 'Waiting for you' : this.transcript.busyLabel;
      bottom.push(`${spin} ${label}… ${theme.dim(`${elapsed} · esc to stop`)}`);
    }
    for (const q of this.agent.queued) bottom.push(theme.dim(truncate(`↳ next step: ${q}`, w)));
    for (const q of this.followUps) bottom.push(theme.dim(truncate(`⧗ queued: ${q}`, w)));

    let cursor: { row: number; col: number } | null = null;
    const d = this.dialog;
    const inlineDialog = d && (d.anchor === 'bottom' || !this.full);
    if (inlineDialog) {
      const r = d.render(w, Math.max(6, this.height - bottom.length - 2));
      if (r.cursor) cursor = { row: bottom.length + r.cursor.row, col: r.cursor.col };
      bottom.push(...r.lines);
    } else {
      const level = this.agent.thinking;
      const color = thinkingColor[level];
      const label = this.configured ? ` ${shortModelName(this.model)} · ${level === 'off' ? 'no thinking' : level} ` : ' not set up · /login ';
      bottom.push(color('─'.repeat(Math.max(0, w - stringWidth(label) - 2)) + label + '──'));
      const maxEditorRows = Math.max(3, Math.floor(this.height / 2) - 4);
      const ed = this.editor.render(w, maxEditorRows, theme.accent('› '));
      cursor = { row: bottom.length + ed.cursor.row, col: ed.cursor.col };
      bottom.push(...ed.lines);
      bottom.push(color('─'.repeat(w)));
      if (this.autocomplete.open) bottom.push(...this.autocomplete.render(w));
      else bottom.push(...this.footer(w));
    }

    const lines = bottom.map(pad);
    const cur = cursor && { row: cursor.row, col: cursor.col + 1 };
    if (this.full) {
      let overlay = null;
      if (d && !inlineDialog) {
        const r = d.render(Math.min(this.width - 4, 90), this.full.viewportHeight(lines.length) - 2);
        overlay = { lines: r.lines, cursor: r.cursor };
      }
      return this.full.draw(() => this.transcript.render(w).map(pad), lines, overlay ? null : cur, overlay);
    }
    const screen = this.screen!;
    screen.commit(this.transcript.takeFinished(w).map(pad));
    const live = this.transcript.live(w).map(pad);
    screen.setLive([...live, ...lines], cur && { row: cur.row + live.length, col: cur.col });
  }

  private footer(w: number): string[] {
    const a = this.agent;
    const where = shortenHome(this.o.cwd) + (this.gitBranch ? ` (${this.gitBranch})` : '');
    const name = this.session.name ? ` · ${this.session.name}` : '';
    const right: string[] = [];
    if (this.mcp?.servers.length) {
      const m = this.mcp.summary;
      const text = m.connecting ? `mcp ${m.connected}/${m.total}…` : m.failed ? `mcp ${m.connected}/${m.total}` : `mcp ${m.connected}`;
      right.push(m.failed ? theme.warn(text) : theme.dim(text));
    }
    if (a.opts.permissionMode !== 'ask') right.push(a.opts.permissionMode === 'yolo' ? theme.warn('yolo') : theme.dim('auto-edit'));
    const pct = this.model.contextWindow ? (a.contextUsed / this.model.contextWindow) * 100 : 0;
    const ctxColor = pct >= 80 ? theme.error : pct >= 60 ? theme.warn : theme.dim;
    right.push(ctxColor(pct >= 1 ? `ctx ${Math.round(pct)}%` : `ctx ${formatTokens(a.contextUsed)}`));
    if (a.costUSD > 0) right.push(theme.dim(`$${a.costUSD.toFixed(a.costUSD < 1 ? 3 : 2)}`));
    const line1 = spread(theme.dim(where + name), right.join(theme.dim(' · ')), w);

    let hint: string;
    if (this.flash && this.flash.until > Date.now()) hint = theme.accent(this.flash.text);
    else if (this.full && !this.full.following) hint = theme.dim('end or esc · back to the latest   pgup/pgdn · scroll');
    else if (this.busy) hint = theme.dim('esc stop · enter adds a note for the next step · alt+enter queue · ctrl+o output');
    else if (!this.configured) hint = theme.dim('/login to set up a model · ? help');
    else if (!this.editor.isEmpty) hint = theme.dim('enter send · shift+enter new line · @ attach · ctrl+g editor');
    else hint = theme.dim('enter send · / commands · @ files · ! shell · ? help');
    return [line1, truncate(hint, w)];
  }

  private flashMessage(text: string, ms = 1800) {
    this.flash = { text, until: Date.now() + ms };
    setTimeout(() => this.render(), ms + 20);
  }

  // --- input ------------------------------------------------------------------

  private onInput(e: InputEvent) {
    if (e.type === 'mouse') {
      if (e.wheel && this.full && !this.dialog) this.full.scrollBy(e.wheel === 'up' ? -3 : 3);
      return this.render();
    }
    if (e.type === 'paste') {
      if (this.dialog) this.dialog.paste(e.text);
      else {
        const img = droppedImagePath(e.text);
        if (img) this.editor.insert(`@"${img}" `);
        else this.editor.paste(e.text);
      }
    } else this.onKey(e.key);
    this.render();
  }

  private onKey(k: Key) {
    const id = `${k.ctrl ? 'C-' : ''}${k.alt ? 'M-' : ''}${k.shift && k.name.length > 1 ? 'S-' : ''}${k.name}`;
    if (id === 'C-z') return this.term.suspend();

    if (this.dialog) {
      const d = this.dialog;
      if (d.handleKey(k) === 'close' && this.dialog === d) this.closeDialog();
      return;
    }
    if (id === 'C-c') return this.ctrlC();

    if (this.autocomplete.open) {
      if (id === 'up' || id === 'C-p') return this.autocomplete.move(-1);
      if (id === 'down' || id === 'C-n') return this.autocomplete.move(1);
      if (id === 'escape') return this.autocomplete.dismiss(this.editor);
      if (id === 'tab') {
        this.autocomplete.accept(this.editor);
        return;
      }
      if (id === 'enter') {
        const inserted = this.autocomplete.accept(this.editor);
        // run it right away unless it needs an argument (<required>)
        const cmd = inserted?.startsWith('/') && this.commandList().find((c) => `/${c.name} ` === inserted);
        if (cmd && !cmd.args?.startsWith('<')) this.submit();
        return;
      }
    }

    if (this.full) {
      switch (id) {
        case 'pageup':
          return this.full.page(-1);
        case 'pagedown':
          return this.full.page(1);
        case 'S-up':
          return this.full.scrollBy(-1);
        case 'S-down':
          return this.full.scrollBy(1);
        case 'C-home':
          if (this.editor.isEmpty) return this.full.toTop();
          break;
        case 'end':
        case 'C-end':
          if (!this.full.following && this.editor.isEmpty) return this.full.toBottom();
          break;
      }
    }

    switch (id) {
      case 'escape':
        if (this.busy) this.interrupt();
        else this.full?.toBottom();
        return;
      case 'enter':
        if (this.editor.beforeCursor.endsWith('\\')) {
          this.editor.replaceBeforeCursor(1, '\n');
          return;
        }
        return this.submit();
      case 'M-enter':
        if (this.busy) return this.submit('follow-up');
        this.editor.insert('\n');
        return;
      case 'C-d':
        if (this.editor.isEmpty && !this.busy) return this.exit();
        break;
      case 'tab':
        this.autocomplete.completePath(this.editor);
        return;
      case 'S-tab':
        return this.cycleThinking();
      case 'C-l':
        return this.openModelPicker();
      case 'C-p':
        return this.cycleFavorite();
      case 'C-t':
        this.showThinking = !this.showThinking;
        this.o.settings.saveGlobal({ showThinking: this.showThinking });
        return this.flashMessage(this.showThinking ? 'thinking shown' : 'thinking hidden');
      case 'C-o':
        return this.expandToolOutput();
      case 'C-g':
        void this.externalEditor();
        return;
      case 'C-x':
        void this.copyLast();
        return;
      case 'M-up': {
        const q = [...this.agent.drainQueue(), ...this.followUps.splice(0)];
        if (q.length) this.editor.setText([this.editor.text, ...q].filter(Boolean).join('\n'));
        return;
      }
    }
    // "?" on an empty prompt opens help instead of typing a question mark
    if (k.text === '?' && this.editor.isEmpty) return this.openHelp();
    this.editor.handleKey(k);
  }

  private ctrlC() {
    if (this.busy) return this.interrupt();
    if (!this.editor.isEmpty) {
      this.editor.clear();
      this.autocomplete.close();
      return;
    }
    if (Date.now() - this.lastCtrlC < 1500) return this.exit();
    this.lastCtrlC = Date.now();
    this.flashMessage('press ctrl+c again to quit');
  }

  /** Stop the current task; queued messages go back into the editor. */
  private interrupt() {
    this.turn?.abort();
    const q = [...this.agent.drainQueue(), ...this.followUps.splice(0)];
    if (q.length) this.editor.setText([this.editor.text, ...q].filter(Boolean).join('\n'));
  }

  private submit(kind: 'steer' | 'follow-up' = 'steer') {
    const raw = this.editor.text;
    const text = this.editor.expandedText();
    if (!text.trim()) return;
    const isCommand = text.trimStart().startsWith('/') || text.trimStart().startsWith('!');
    if (!isCommand && !this.configured) {
      // keep what they typed; set up a model first
      this.openLogin('Set up a model first, then press enter again to send your message.');
      return;
    }
    this.editor.addToHistory(raw);
    this.saveHistory(raw);
    this.editor.clear();
    this.autocomplete.close();
    this.full?.toBottom();
    if (this.busy) {
      if (isCommand) {
        this.editor.setText(raw);
        return this.flashMessage('commands run once wisp is idle · esc to stop it', 2500);
      }
      if (kind === 'follow-up') this.followUps.push(text);
      else this.agent.steer(text);
      return;
    }
    void this.submitText(text, raw);
  }

  private async submitText(text: string, display = text) {
    const t = text.trim();
    if (t.startsWith('!')) {
      const silent = t.startsWith('!!');
      return this.runShell(t.slice(silent ? 2 : 1).trim(), !silent);
    }
    if (t.startsWith('/')) return this.command(t);
    return this.prompt(text, display);
  }

  private async withTurn(fn: (signal: AbortSignal) => Promise<void>) {
    this.turn = new AbortController();
    this.turnStarted = Date.now();
    this.startTicker();
    this.render();
    try {
      await fn(this.turn.signal);
      if (this.turn.signal.aborted) {
        this.transcript.notice('Stopped.', 'warn');
        this.transcript.blank();
      }
    } catch (err) {
      if (isAbortError(err) || this.turn.signal.aborted) this.transcript.notice('Stopped.', 'warn');
      else if (err instanceof NotConfiguredError) this.openLogin('Set up a model to continue.');
      else {
        const msg = describeError(err, { provider: this.model.provider });
        this.transcript.notice(msg + (/Authentication failed/.test(msg) ? ' Run /login to update it.' : ''), 'error');
      }
      this.transcript.blank();
    } finally {
      this.turn = null;
      this.stopTicker();
      this.refreshGit();
      this.render();
    }
    const next = this.followUps.shift();
    if (next) void this.prompt(next, next);
  }

  private async prompt(text: string, display: string) {
    this.transcript.user(display);
    // give MCP servers that are still starting a moment, so their tools are there
    if (this.mcp?.summary.connecting) {
      this.flashMessage('waiting for MCP servers…', 5000);
      this.render();
      await this.mcp.ready(5000);
      const slow = this.mcp.servers.filter((s) => s.status === 'connecting').map((s) => s.name);
      if (slow.length) this.transcript.notice(`${slow.join(', ')} (MCP) still starting; their tools appear once connected.`, 'warn');
    }
    const { content, attachments } = await buildUserContent(text, this.o.cwd, { images: this.model.images, readFiles: this.agent.readFiles });
    for (const a of attachments) this.transcript.notice(`${a.note ? '⚠' : '⎘'} attached ${a.path}${a.kind === 'dir' ? '/' : ''}${a.note ? ` (${a.note})` : ''}`, a.note ? 'warn' : 'info');
    if (attachments.length) this.transcript.blank();
    await this.withTurn((signal) => this.agent.run(content, signal));
  }

  private async runShell(cmd: string, addToContext: boolean) {
    if (!cmd) return;
    const call = { type: 'tool_call' as const, id: `shell-${Date.now()}`, name: 'bash', input: { command: cmd } };
    this.transcript.blank();
    await this.withTurn(async (signal) => {
      this.transcript.handle({ type: 'tool_start', call, label: cmd });
      const started = Date.now();
      let output = '';
      let isError = false;
      try {
        const r = await bashTool.run({ command: cmd }, {
          cwd: this.o.cwd,
          signal,
          readFiles: this.agent.readFiles,
          onUpdate: (p) => {
            this.transcript.handle({ type: 'tool_update', id: call.id, partial: p });
            this.render();
          },
        });
        output = typeof r === 'string' ? r : r.content;
      } catch (err) {
        output = (err as Error).message;
        isError = true;
      }
      this.transcript.handle({ type: 'tool_end', call, output: { content: output }, isError, ms: Date.now() - started });
      if (addToContext && !signal.aborted) {
        const message = { role: 'user' as const, content: [{ type: 'text' as const, text: `I ran a shell command:\n$ ${cmd}\n\`\`\`\n${output}\n\`\`\`` }] };
        this.agent.messages.push(message);
        this.session.log({ type: 'message', message });
        this.transcript.notice(theme.dim('(output added to the conversation · use !! to keep it out)'));
      }
    });
  }

  // --- dialogs ----------------------------------------------------------------

  private openDialog(d: Dialog<any>) {
    this.dialog = d;
    this.autocomplete.close();
    this.render();
  }

  private closeDialog() {
    this.dialog = null;
    this.stopTicker();
    this.render();
  }

  private approve(tool: Tool, preview: string, signal: AbortSignal): Promise<Approval> {
    return new Promise((resolveApproval) => {
      const name = tool.mcp ? `${tool.mcp.server} › ${tool.mcp.tool}` : tool.name;
      const what = tool.mcp ? 'calls' : tool.permission === 'exec' ? 'commands' : 'edits';
      const title = tool.mcp ? `Allow ${name}?` : tool.permission === 'exec' ? 'Run this command?' : tool.name === 'write_file' ? 'Write this file?' : 'Make this edit?';
      const list = new SelectList<Approval>([
        { label: 'Yes', value: 'yes', hotkey: 'y', detail: 'y' },
        { label: `Yes, and don’t ask again for ${tool.mcp ? name : tool.name} ${what} this session`, value: 'always', hotkey: 'a', detail: 'a' },
        { label: 'No, and tell wisp what to do instead', value: 'no', hotkey: 'n', detail: 'n' },
      ]);
      const done = (a: Approval) => {
        signal.removeEventListener('abort', onAbort);
        resolveApproval(a);
      };
      const d = new Dialog<Approval>({
        title,
        anchor: 'bottom',
        width: 200,
        body: () => {
          const maxPreview = Math.max(4, this.height - 14);
          const body = preview.split('\n');
          return body.length > maxPreview ? [...body.slice(0, maxPreview), theme.dim(`… ${body.length - maxPreview} more lines`)] : body;
        },
        list,
        onSelect: done,
        onCancel: () => done('no'),
        hint: 'y yes · a always · n no · esc no',
      });
      const onAbort = () => {
        if (this.dialog === d) this.closeDialog();
        done('no');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.openDialog(d);
    });
  }

  private openHelp() {
    const cmds = this.commandList();
    const list = new SelectList(
      cmds.map((c) => ({ label: `/${c.name}`, detail: c.description, keywords: c.description, value: c })),
      { filterable: true },
    );
    this.openDialog(
      new Dialog<CommandInfo>({
        title: 'Help',
        width: 84,
        body: () => {
          // two fixed-width columns (one when narrow)
          const inner = Math.min(this.width - 4, 84) - 4;
          const keyW = 12;
          const colW = Math.floor(inner / 2);
          const cell = ([k, d]: [string, string], width: number) => padEnd(theme.accent(k), keyW) + theme.dim(truncate(d, width - keyW - 1));
          const rows: string[] = [theme.bold('Shortcuts')];
          if (inner >= 64) {
            const half = Math.ceil(SHORTCUTS.length / 2);
            for (let i = 0; i < half; i++) rows.push(padEnd(cell(SHORTCUTS[i], colW), colW) + (SHORTCUTS[i + half] ? cell(SHORTCUTS[i + half], colW) : ''));
          } else for (const s of SHORTCUTS) rows.push(cell(s, inner));
          rows.push('', theme.bold('Commands') + theme.dim('  type to search · enter to use'));
          return rows;
        },
        list,
        onSelect: (c) => {
          this.editor.setText(`/${c.name} `);
          if (!c.args?.startsWith('<')) setImmediate(() => this.submit());
        },
        hint: 'type to search · enter use · esc close',
      }),
    );
  }

  private modelOptions(): Option<ModelInfo>[] {
    const all = [...availableModels(this.o.settings.merged, BUILTIN_MODELS), ...this.ollamaModels];
    if (this.configured && !all.some((m) => m.provider === this.model.provider && m.id === this.model.id)) all.unshift(this.model);
    return all.map((m) => ({
      label: `${m.name !== m.id ? m.name : m.id}`,
      keywords: `${m.provider} ${m.id}`,
      detail: [m.provider === 'ollama' ? 'local' : m.provider, `${formatTokens(m.contextWindow)} context`, m.price ? `$${m.price.input} / $${m.price.output} per M tokens` : ''].filter(Boolean).join(' · '),
      value: m,
    }));
  }

  private openModelPicker(query = '', only?: ProviderName) {
    let options = this.modelOptions();
    if (only) options = options.filter((o) => o.value.provider === only);
    if (!options.length) return this.openLogin('No models available yet. Connect a provider first.');
    const current = options.findIndex((o) => o.value.id === this.model.id && o.value.provider === this.model.provider);
    const list = new SelectList(options, { filterable: true, initial: Math.max(0, current) });
    if (query) {
      list.filter = query;
      list.setOptions(options);
    }
    this.openDialog(
      new Dialog<ModelInfo>({
        title: 'Switch model',
        width: 84,
        list,
        onSelect: (m) => this.switchModel({ provider: m.provider, id: m.id }),
        keys: [{ key: '+', label: 'add a provider', run: () => this.openLogin() }],
        hint: 'type to search · enter switch · + add provider · esc close',
      }),
    );
  }

  private switchModel(ref: ModelRef, quiet = false) {
    const s = this.o.settings.merged;
    try {
      const provider = createProvider(ref, s);
      this.model = getModelInfo(ref, s);
      this.agent.setModel(provider, this.model);
      this.o.model = ref;
      this.o.settings.saveGlobal({ provider: ref.provider, model: ref.id });
      this.session.log({ type: 'model', provider: ref.provider, model: ref.id, thinking: this.agent.thinking });
      if (!quiet) this.transcript.notice(`Now using ${shortModelName(this.model)}${this.model.provider === 'ollama' ? ' (local)' : ''} · thinking ${this.agent.thinking}`);
    } catch (err) {
      this.transcript.notice(describeError(err), 'error');
    }
    this.render();
  }

  private cycleFavorite() {
    const favs = this.o.settings.merged.favoriteModels ?? [];
    const refs = favs.length ? favs.map((f) => parseModelRef(f)) : this.modelOptions().map((o) => ({ provider: o.value.provider, id: o.value.id }));
    if (refs.length < 2) return this.flashMessage('only one model available · ctrl+l to pick');
    const i = refs.findIndex((r) => r.provider === this.model.provider && r.id === this.model.id);
    this.switchModel(refs[(i + 1) % refs.length]);
  }

  private setThinking(level: ThinkingLevel) {
    this.agent.opts.thinking = level;
    this.o.settings.saveGlobal({ thinking: level });
    const actual = this.agent.thinking;
    this.flashMessage(actual === level ? `thinking: ${level}` : `thinking: ${actual} (${shortModelName(this.model)} can't do ${level})`, 2000);
  }

  private cycleThinking() {
    const levels = this.model.thinking;
    const i = levels.indexOf(this.agent.thinking);
    this.setThinking(levels[(i + 1) % levels.length]);
  }

  private setMode(mode: PermissionMode) {
    this.agent.opts.permissionMode = mode;
    this.o.settings.saveGlobal({ permissionMode: mode });
    this.transcript.notice(
      `Mode: ${mode} — ${mode === 'ask' ? 'asks before edits and commands' : mode === 'auto-edit' ? 'edits files freely, asks before commands' : 'never asks (only use in a sandbox)'}`,
      mode === 'yolo' ? 'warn' : 'info',
    );
  }

  private expandToolOutput() {
    this.verbose = !this.verbose;
    const last = this.transcript.lastToolOutput;
    // fullscreen re-renders every tool block with the new setting; inline can only append
    if (this.verbose && last && !this.full) {
      this.transcript.blank();
      this.transcript.notice(`Full output of the last ${last.call.name} call:`);
      this.transcript.commit(renderToolBody(last.call, last.output, last.isError, this.contentWidth, true));
      this.transcript.blank();
    }
    this.flashMessage(this.verbose ? 'tool output: full' : 'tool output: short');
  }

  // --- login ------------------------------------------------------------------

  private openLogin(message?: string) {
    const s = this.o.settings.merged;
    const status = (p: ProviderName) => {
      if (p === 'ollama') return this.ollamaModels.length ? `running · ${this.ollamaModels.length} model${this.ollamaModels.length > 1 ? 's' : ''}` : 'free, runs on your machine';
      const src = credentialSource(p, s.providers?.[p]?.apiKey);
      return src === 'login' ? '✓ key saved' : src === 'env' ? '✓ key from environment' : src === 'settings' ? '✓ key in settings' : 'needs an API key';
    };
    const list = new SelectList<ProviderName>(
      (['anthropic', 'openai', 'ollama'] as ProviderName[]).map((p) => ({ label: PROVIDER_LABEL[p], detail: status(p), value: p })),
    );
    const d = new Dialog<ProviderName>({
      title: 'Connect a model',
      width: 76,
      body: () => (message ? [message] : ['Choose a provider. Keys are stored in ~/.wisp/auth.json, readable only by you.']),
      list,
      onSelect: (p) => {
        if (p === 'ollama') {
          void this.connectOllama(d);
          return true;
        }
        this.openKeyInput(p);
        return true;
      },
    });
    this.openDialog(d);
  }

  private async connectOllama(d: Dialog<ProviderName>) {
    const s = this.o.settings.merged;
    const base = ollamaBaseURL(s);
    d.setStatus('Looking for Ollama…', 'busy');
    this.startTicker();
    try {
      const ids = await verifyCredential('ollama', { baseURL: base });
      this.ollamaModels = ids.map((id) => getModelInfo({ provider: 'ollama', id }, s));
      if (!ids.length) {
        d.setStatus('Ollama is running but has no models yet. In a terminal run:  ollama pull qwen3-coder', 'error');
      } else {
        d.status = null;
        if (this.dialog === d) this.closeDialog();
        this.openModelPicker('', 'ollama');
      }
    } catch {
      d.setStatus(`Ollama isn't running at ${base.replace(/\/v1\/?$/, '')}. Install it from https://ollama.com, then run:  ollama serve`, 'error');
    }
    this.stopTicker();
    this.render();
  }

  private openKeyInput(p: ProviderName) {
    const input = new TextInput({ placeholder: p === 'anthropic' ? 'sk-ant-…' : 'sk-…', mask: true });
    const d = new Dialog({
      title: `${PROVIDER_LABEL[p]} API key`,
      width: 76,
      body: () => [`Paste your API key and press enter. ${KEY_HELP[p] ?? ''}`],
      input,
      onSubmit: (value) => {
        const key = value.trim();
        if (!key) return true;
        d.setStatus('Checking the key…', 'busy');
        this.startTicker();
        void verifyCredential(p, { apiKey: key, baseURL: this.o.settings.merged.providers?.[p]?.baseURL })
          .then(() => {
            saveCredential(p, { apiKey: key });
            d.status = null;
            if (this.dialog === d) this.closeDialog();
            const ref = this.model.provider === p && this.configured ? this.o.model : { provider: p, id: DEFAULT_MODEL[p] };
            this.switchModel(ref, true);
            this.transcript.notice(`✓ Connected to ${PROVIDER_LABEL[p]} · using ${shortModelName(this.model)} · ctrl+l to switch models`, 'success');
            this.transcript.blank();
          })
          .catch((err) => d.setStatus((err as Error).message, 'error'))
          .finally(() => {
            this.stopTicker();
            this.render();
          });
        return true;
      },
      onCancel: () => this.openLogin(),
      hint: 'enter check & save · esc back',
    });
    this.openDialog(d);
  }

  private openLogout() {
    const saved = (['anthropic', 'openai'] as ProviderName[]).filter((p) => credentialSource(p) === 'login');
    if (!saved.length) return this.transcript.notice('No saved keys. (Keys from environment variables are not stored by wisp.)');
    const list = new SelectList(saved.map((p) => ({ label: PROVIDER_LABEL[p], detail: 'remove saved key', value: p })));
    this.openDialog(
      new Dialog<ProviderName>({
        title: 'Remove a saved key',
        width: 60,
        list,
        onSelect: (p) => {
          removeCredential(p);
          this.transcript.notice(`Removed the saved ${PROVIDER_LABEL[p]} key.`);
          if (this.model.provider === p && credentialSource(p) === null) this.agent.setModel(new UnconfiguredProvider(), this.model);
        },
      }),
    );
  }

  private async externalEditorFile(file: string): Promise<boolean> {
    const editorCmd = findEditor();
    if (!editorCmd) {
      this.transcript.notice(`No editor found. Set $EDITOR (e.g. export EDITOR=nano) or edit ${shortenHome(file)} directly.`, 'error');
      return false;
    }
    this.screen?.close();
    const r = await this.term.suspendFor(() => spawnSync('sh', ['-c', `${editorCmd} "$1"`, 'sh', file], { stdio: 'inherit' }));
    this.full?.resized();
    if (r.status !== 0) {
      this.transcript.notice(`The editor (${editorCmd}) exited with an error${r.status === 127 ? ': command not found' : ''}.`, 'error');
      return false;
    }
    return true;
  }

  private async externalEditor() {
    const file = join(tmpdir(), `wisp-prompt-${process.pid}.md`);
    writeFileSync(file, this.editor.expandedText());
    if (await this.externalEditorFile(file)) {
      try {
        this.editor.setText(readFileSync(file, 'utf8').replace(/\n$/, ''));
      } catch {}
    }
    this.render();
  }

  private async copyLast() {
    const text = this.transcript.lastAssistantText || lastAssistantText(this.agent.messages);
    if (!text) return this.flashMessage('nothing to copy yet');
    const via = await copyToClipboard(text, (s) => this.term.write(s));
    this.flashMessage(`copied the last response (${via})`);
    this.render();
  }

  // --- sessions & tree ----------------------------------------------------------

  /** Redraw the conversation from scratch (after switching session or branch). */
  private replayConversation(notice: string) {
    this.transcript.reset();
    this.header();
    this.transcript.notice(theme.accent(notice));
    this.transcript.blank();
    this.transcript.replay(this.agent.messages);
    this.full?.toBottom();
  }

  private newSession() {
    this.session = Session.create(this.o.cwd, { persist: this.o.persistSessions });
    this.agent.load([]);
    this.transcript.reset();
    this.header();
    this.render();
  }

  private loadSession(path: string) {
    const { session, entries } = Session.open(path);
    if (session.cwd !== this.o.cwd) {
      this.transcript.notice(`That conversation belongs to ${session.cwd}. Run: cd ${session.cwd} && wisp --session ${session.id}`, 'warn');
      return;
    }
    const state = restore(entries);
    this.session = session;
    this.agent.load(state.messages, state);
    if (state.model) {
      const ref = { provider: state.model.provider as ModelRef['provider'], id: state.model.model };
      if (ref.id !== this.model.id) this.switchModel(ref, true);
    }
    this.replayConversation(`Opened ${session.name ? `“${session.name}”` : 'conversation'}`);
  }

  private openResume(all: boolean) {
    const sessions = listSessions(all ? null : this.o.cwd).filter((s) => s.path !== this.session.path);
    if (!sessions.length) return this.transcript.notice(all ? 'No saved conversations yet.' : 'No other conversations in this folder yet. Try /resume all.');
    const list = new SelectList(
      sessions.map((s) => ({
        label: truncate(s.name ?? s.firstMessage, 56),
        keywords: s.firstMessage + ' ' + s.id,
        detail: `${relativeTime(s.modified)} · ${s.messageCount} messages${all ? ' · ' + shortenHome(s.cwd) : ''}`,
        value: s.path,
      })),
      { filterable: true },
    );
    this.openDialog(
      new Dialog<string>({
        title: all ? 'Open a conversation (all folders)' : 'Open a conversation',
        width: 90,
        list,
        onSelect: (path) => this.loadSession(path),
      }),
    );
  }

  /** Flatten the turn tree into list rows: the active line straight down, side branches indented. */
  private treeOptions(roots: TurnNode[]): Option<TurnNode>[] {
    const out: Option<TurnNode>[] = [];
    const pickMain = (nodes: TurnNode[]) => nodes.find((n) => n.onPath) ?? nodes.at(-1);
    const emit = (n: TurnNode, prefix: string) => {
      const dot = n.current ? theme.accent('●') : n.onPath ? theme.accent('•') : theme.dim('○');
      const text = n.current ? theme.bold(n.label) : n.onPath ? n.label : theme.dim(n.label);
      out.push({
        label: `${theme.border(prefix)}${dot} ${truncate(text, 64)}`,
        detail: `${n.current ? theme.accent('current') + ' · ' : ''}${relativeTime(new Date(n.ts))}${n.size > 1 ? ` · ${n.size} msgs` : ''}`,
        value: n,
      });
    };
    const walk = (nodes: TurnNode[], prefix: string) => {
      let level = nodes;
      while (level.length) {
        const main = pickMain(level)!;
        // side branches first, indented under a connector
        for (const alt of level.filter((x) => x !== main)) branch(alt, prefix);
        emit(main, prefix);
        level = main.children;
      }
    };
    const branch = (n: TurnNode, prefix: string) => {
      emit(n, prefix + '├─ ');
      walk(n.children, prefix + '│  ');
    };
    walk(roots, '');
    return out;
  }

  private openTree() {
    const roots = buildTurnTree(this.session.entries);
    if (!roots.length) return this.transcript.notice('Nothing here yet: the tree shows every message you send, and the branches you create by going back.');
    const options = this.treeOptions(roots);
    const current = options.findIndex((o) => o.value.current);
    const list = new SelectList(options, { initial: current >= 0 ? current : options.length - 1 });
    const branches = countBranches(roots);
    this.openDialog(
      new Dialog<TurnNode>({
        title: `Conversation tree${branches ? ` · ${branches} branch${branches > 1 ? 'es' : ''}` : ''}`,
        width: 100,
        body: () => [
          theme.dim('Go back to any message and carry on from there. Other branches are kept.'),
          theme.dim('Only the conversation moves: files on disk stay as they are.'),
        ],
        list,
        onSelect: (n) => this.jumpTo(n, 'continue'),
        keys: [{ key: 'e', label: 'edit & resend', run: (n) => (n ? this.jumpTo(n, 'edit') : true) }],
        hint: '↑↓ move · enter continue from here · e edit & resend · esc close',
      }),
    );
  }

  private jumpTo(n: TurnNode, how: 'continue' | 'edit') {
    if (this.busy) return void this.flashMessage('stop the current task first (esc)');
    if (how === 'edit' && n.kind !== 'prompt') return void this.flashMessage('only your own messages can be edited');
    this.session.moveHead(how === 'continue' ? n.endId : n.parentId);
    const state = restore(this.session.entries);
    this.agent.load(state.messages, state);
    this.replayConversation(how === 'continue' ? '↶ Back at an earlier point. Your next message starts a new branch (/tree to switch).' : '✎ Editing an earlier message. Send it to start a new branch (/tree to switch back).');
    if (how === 'edit') this.editor.setText(n.text);
    this.render();
  }

  private openFork() {
    const roots = buildTurnTree(this.session.entries);
    const onPath: TurnNode[] = [];
    const collect = (nodes: TurnNode[]) => {
      for (const n of nodes) {
        if (!n.onPath) continue;
        if (n.kind === 'prompt') onPath.push(n);
        collect(n.children);
      }
    };
    collect(roots);
    if (!onPath.length) return this.transcript.notice('Nothing to copy yet.');
    const list = new SelectList(
      [
        { label: theme.bold('Everything so far'), detail: 'copy the whole conversation', value: null as TurnNode | null },
        ...onPath.reverse().map((n) => ({ label: truncate(n.label, 70), detail: `up to just before this · ${relativeTime(new Date(n.ts))}`, value: n as TurnNode | null })),
      ],
      { filterable: true },
    );
    this.openDialog(
      new Dialog<TurnNode | null>({
        title: 'Copy into a new conversation',
        width: 96,
        body: () => [theme.dim('The copy is a separate conversation; this one stays as it is. (To go back within this conversation, use /tree.)')],
        list,
        onSelect: (n) => {
          const fork = forkSession(this.session.entries, this.o.cwd, this.o.persistSessions, n ? n.id : undefined);
          const state = restore(fork.entries);
          this.session = fork;
          this.agent.load(state.messages, state);
          this.replayConversation(`⑂ New conversation ${fork.id}, copied from the previous one.`);
          if (n) this.editor.setText(n.text);
        },
      }),
    );
  }

  // --- slash commands ---------------------------------------------------------

  private async command(input: string): Promise<void> {
    const [, name, rest = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(input) ?? [];
    const args = rest.trim();
    const t = this.transcript;
    switch (name) {
      case 'help':
      case 'hotkeys':
      case '?':
        return this.openHelp();
      case 'login':
        return this.openLogin();
      case 'logout':
        return this.openLogout();
      case 'model':
        return this.openModelPicker(args);
      case 'tree':
        return this.openTree();
      case 'thinking': {
        if (args && THINKING_LEVELS.includes(args as ThinkingLevel)) return this.setThinking(args as ThinkingLevel);
        const levels = this.model.thinking;
        const describe: Record<ThinkingLevel, string> = {
          off: 'answer straight away',
          low: 'quick, light reasoning',
          medium: 'balanced (default)',
          high: 'more careful',
          xhigh: 'very careful, slower',
          max: 'deepest, slowest, priciest',
        };
        const list = new SelectList(levels.map((l) => ({ label: l, value: l, detail: describe[l] })), { initial: levels.indexOf(this.agent.thinking) });
        return this.openDialog(new Dialog<ThinkingLevel>({ title: `How hard should ${shortModelName(this.model)} think?`, width: 60, list, onSelect: (l) => this.setThinking(l) }));
      }
      case 'mode': {
        if (PERMISSION_MODES.includes(args as PermissionMode)) return this.setMode(args as PermissionMode);
        const list = new SelectList(
          [
            { label: 'ask', value: 'ask' as PermissionMode, detail: 'ask before every edit and command' },
            { label: 'auto-edit', value: 'auto-edit' as PermissionMode, detail: 'edit files freely, ask before commands' },
            { label: 'yolo', value: 'yolo' as PermissionMode, detail: 'never ask — only in a sandbox' },
          ],
          { initial: PERMISSION_MODES.indexOf(this.agent.opts.permissionMode) },
        );
        return this.openDialog(new Dialog<PermissionMode>({ title: 'When should wisp ask first?', width: 64, list, onSelect: (m) => this.setMode(m) }));
      }
      case 'new':
      case 'clear':
        return this.newSession();
      case 'resume':
        return this.openResume(args === 'all');
      case 'fork':
        return this.openFork();
      case 'name':
        if (!args) return t.notice('Usage: /name <a name for this conversation>', 'warn');
        this.session.log({ type: 'name', name: args });
        return this.flashMessage(`named “${args}”`);
      case 'session': {
        const u = this.agent.usage;
        const branches = countBranches(buildTurnTree(this.session.entries));
        t.blank();
        t.commit(theme.bold('This conversation'));
        t.commit(`  id        ${this.session.id}${this.session.name ? ` (${this.session.name})` : ''}`);
        t.commit(`  file      ${this.session.path ? shortenHome(this.session.path) : '(not saved: --no-session)'}`);
        t.commit(`  messages  ${this.agent.messages.length}${branches ? ` · ${branches} branch${branches > 1 ? 'es' : ''} (/tree)` : ''}`);
        t.commit(`  model     ${formatRef(this.o.model)} · thinking ${this.agent.thinking}`);
        t.commit(`  context   ${formatTokens(this.agent.contextUsed)} of ${formatTokens(this.model.contextWindow)}`);
        t.commit(`  tokens    ${formatTokens(u.input)} in · ${formatTokens(u.cacheRead)} cached · ${formatTokens(u.cacheWrite)} cache writes · ${formatTokens(u.output)} out`);
        t.commit(`  cost      ${this.model.price || this.agent.costUSD ? '$' + this.agent.costUSD.toFixed(4) : 'unknown for this model'}`);
        t.blank();
        return;
      }
      case 'compact':
        if (this.agent.messages.length < 2) return t.notice('Nothing to compact yet.');
        return this.withTurn(async (signal) => {
          await this.agent.compact(signal, { instructions: args || undefined });
        });
      case 'copy':
        return this.copyLast();
      case 'export': {
        const file = resolve(this.o.cwd, args || `wisp-${this.session.name?.replace(/\W+/g, '-') ?? this.session.id}.html`);
        exportSession(file, this.agent.messages, this.session.name ?? `wisp session ${this.session.id}`);
        return t.notice(`Saved to ${shortenHome(file)}`, 'success');
      }
      case 'reload':
        this.discover();
        this.agent.opts.system = this.systemPrompt();
        return t.notice(`Reloaded: ${this.contextFiles.length} context files, ${this.skills.length} skills, ${this.templates.length} prompt templates.`);
      case 'settings': {
        if (!existsSync(GLOBAL_SETTINGS)) this.o.settings.saveGlobal({});
        if (!(await this.externalEditorFile(GLOBAL_SETTINGS))) return;
        try {
          this.o.settings.reload();
        } catch (err) {
          return t.notice(`${describeError(err)} — keeping the previous settings.`, 'error');
        }
        const s = this.o.settings.merged;
        this.showThinking = s.showThinking ?? this.showThinking;
        this.agent.opts.autoCompactAt = s.autoCompactAt;
        this.agent.opts.maxTokens = s.maxTokens;
        return t.notice(`Reloaded ${shortenHome(GLOBAL_SETTINGS)}.`, 'success');
      }
      case 'mouse':
        if (!this.full) return t.notice('Mouse capture is only used in fullscreen mode.');
        this.term.setMouse(!this.term.mouse);
        return this.flashMessage(this.term.mouse ? 'mouse captured: wheel scrolls (shift+drag selects)' : 'mouse released: select text normally · pgup/pgdn scrolls', 3000);
      case 'mcp':
        return this.mcpCommand(args);
      case 'exit':
      case 'quit':
        return this.exit();
    }
    if (name?.startsWith('skill:')) {
      const skill = this.skills.find((s) => s.name === name.slice(6));
      if (!skill) return t.notice(`Unknown skill ${name.slice(6)}`, 'error');
      const body = readFileSync(skill.path, 'utf8');
      return this.prompt(`Use the "${skill.name}" skill (${skill.path}):\n\n${body}\n\n${args}`.trim(), `/${name} ${args}`.trim());
    }
    const tpl = this.templates.find((x) => x.name === name);
    if (tpl) return this.prompt(expandTemplate(tpl, args), input);
    t.notice(`Unknown command /${name}. Press ? to see all commands.`, 'error');
  }
}

function lastAssistantText(messages: import('../core/types.js').Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

function relativeTime(d: Date): string {
  const s = (Date.now() - d.getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}
