import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Agent, type AgentEvent, type Approval } from '../core/agent.js';
import { availableModels, createProvider, formatRef, getModelInfo, parseModelRef, type ModelRef } from '../core/config.js';
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
import { describeServer, isProjectTrusted, McpManager, trustProject, type McpServerEntry, type McpStatus } from '../core/mcp.js';
import { buildUserContent, droppedImagePath } from '../core/input.js';
import { BUILTIN_MODELS, type ModelInfo } from '../core/models.js';
import { firstUserText, forkSession, listSessions, restore, Session, type RestoredState } from '../core/session.js';
import { AGENT_DIR, GLOBAL_SETTINGS, PERMISSION_MODES, type PermissionMode, type SettingsStore } from '../core/settings.js';
import { THINKING_LEVELS, type ThinkingLevel } from '../core/types.js';
import { OpenAIProvider } from '../providers/openai.js';
import { bashTool } from '../tools/bash.js';
import type { Tool } from '../tools/types.js';
import { Autocomplete, FileIndex, type CommandInfo } from './autocomplete.js';
import { copyToClipboard } from './clipboard.js';
import { Editor } from './editor.js';
import { FullScreen } from './fullscreen.js';
import type { InputEvent, Key } from './keys.js';
import { Screen } from './screen.js';
import { SelectList, type Option } from './select.js';
import { Terminal } from './terminal.js';
import { formatDuration, formatTokens, shortenHome, spread, stringWidth, truncate, wrap } from './text.js';
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

const COMMANDS: CommandInfo[] = [
  { name: 'model', description: 'Pick a model (ctrl+l)', args: '[name]' },
  { name: 'thinking', description: 'Set the thinking level (shift+tab cycles)', args: '[level]' },
  { name: 'mode', description: 'Permission mode: ask, auto-edit, yolo', args: '[mode]' },
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume a saved session', args: '[all]' },
  { name: 'fork', description: 'Branch from an earlier message' },
  { name: 'name', description: 'Name this session', args: '<name>' },
  { name: 'session', description: 'Session info: file, tokens, cost' },
  { name: 'compact', description: 'Summarize the conversation to free context', args: '[focus]' },
  { name: 'copy', description: 'Copy the last response (ctrl+x)' },
  { name: 'export', description: 'Save the session as HTML or Markdown', args: '[file]' },
  { name: 'reload', description: 'Reload AGENTS.md, skills and prompt templates' },
  { name: 'settings', description: 'Edit settings in $EDITOR' },
  { name: 'mouse', description: 'Toggle mouse capture (off: select text normally)' },
  { name: 'mcp', description: 'MCP servers: status, tools, reconnect', args: '[tools|reconnect] [server]' },
  { name: 'hotkeys', description: 'Keyboard shortcuts' },
  { name: 'help', description: 'Commands and shortcuts' },
  { name: 'exit', description: 'Quit (ctrl+d)' },
];

const HOTKEYS: [string, string][] = [
  ['enter', 'send (while working: steer after the current step)'],
  ['alt+enter', 'while working: queue a follow-up for when it finishes'],
  ['shift+enter / ctrl+j', 'new line (or end a line with \\)'],
  ['esc', 'stop the current task'],
  ['ctrl+c', 'clear input · stop · press twice to quit'],
  ['ctrl+d', 'quit (on empty input)'],
  ['↑ / ↓', 'prompt history'],
  ['tab', 'complete paths · accept suggestion'],
  ['@', 'mention a file (attaches it)'],
  ['!cmd / !!cmd', 'run a shell command (and add / don’t add output to context)'],
  ['shift+tab', 'cycle thinking level'],
  ['ctrl+l', 'pick a model'],
  ['ctrl+p', 'cycle favorite models'],
  ['ctrl+t', 'show / hide thinking'],
  ['ctrl+o', 'expand tool output'],
  ['ctrl+g', 'edit the prompt in $EDITOR'],
  ['ctrl+x', 'copy the last response'],
  ['alt+↑', 'pull queued messages back into the editor'],
  ['ctrl+_', 'undo'],
  ['ctrl+w / ctrl+u / ctrl+k / ctrl+y', 'delete word / to start / to end · paste deleted'],
  ['ctrl+z', 'suspend'],
  ['wheel / pgup / pgdn', 'scroll the conversation (fullscreen)'],
  ['shift+↑ / shift+↓', 'scroll one line · esc or end returns to the bottom'],
  ['shift+drag', 'select text while the mouse is captured (or /mouse to release it)'],
];

type Overlay = {
  list: SelectList<any>;
  header?: string[];
  onSelect: (value: any) => void;
  onCancel: () => void;
};

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
  private overlay: Overlay | null = null;
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
    this.agent = new Agent({
      cwd: o.cwd,
      provider: createProvider(o.model, s),
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
    this.editor.setHistory(this.loadHistory());
    this.editor.onChange = () => this.autocomplete.update(this.editor);
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
    this.header();
    if (this.o.restored?.messages.length) {
      this.transcript.notice(`Resumed session ${this.session.name ?? this.session.id}`, 'info');
      this.transcript.blank();
      this.transcript.replay(this.o.restored.messages);
    }
    this.term.start((e) => this.onInput(e), () => {
      this.screen?.resized();
      this.full?.resized();
      this.render();
    });
    this.render();
    await this.startMcp();
    if (this.o.initialPrompt) void this.submitText(this.o.initialPrompt);
    await new Promise<void>((r) => (this.exitResolve = r));
  }

  /** Called by main() after run() returns: stop MCP server processes. */
  async shutdown() {
    await this.mcp?.close();
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
      const w = this.width;
      const header = [
        theme.border('─'.repeat(w)),
        theme.warn(' This project wants to start MCP servers:'),
        ...project.map((e) => `   ${theme.bold(e.name)}  ${theme.dim(truncate(describeServer(e.config), w - e.name.length - 6))}`),
        theme.dim(` from ${[...new Set(project.map((e) => shortenHome(e.source)))].join(', ')} · they run with your permissions`),
        '',
      ];
      const list = new SelectList<'always' | 'once' | 'no'>(
        [
          { label: 'Yes, and remember for this project', value: 'always', hotkey: 'y', detail: 'asks again if the config changes' },
          { label: 'Yes, just this time', value: 'once', hotkey: 'o' },
          { label: "No, don't start them", value: 'no', hotkey: 'n', detail: 'esc' },
        ],
        { title: 'Start project MCP servers?', hint: 'y/o/n · ↑↓ enter' },
      );
      this.openOverlay(list, resolveTrust, header, () => resolveTrust('no'));
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
      if (s.status === 'connected') this.transcript.notice(`✓ MCP ${s.name}: ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`, 'success');
      else if (s.status === 'failed') this.transcript.notice(`✗ MCP ${s.name} failed: ${s.error ?? 'unknown error'} · /mcp for details`, 'error');
    }
    this.render();
  }

  private mcpCommand(args: string) {
    const t = this.transcript;
    const [sub, name] = args.split(/\s+/).filter(Boolean);
    const mcp = this.mcp;
    if (!mcp?.servers.length) {
      if (this.o.mcpServers.length) return t.notice('MCP servers are configured but were not started (skipped project servers, or --no-mcp).');
      return t.notice('No MCP servers configured. Add one with: wisp mcp add <name> -- <command> [args…]   or   wisp mcp add <name> --url <url>');
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

  private header() {
    const s = this.o.settings.merged;
    const t = this.transcript;
    t.commit(`${theme.accent(theme.bold('wisp'))} ${theme.dim('v' + VERSION)}`);
    if (s.quietStartup) return t.blank();
    t.commit(theme.dim(`${formatRef(this.o.model)} · thinking ${this.agent.thinking} · ${this.agent.opts.permissionMode} mode · ${shortenHome(this.o.cwd)}`));
    if (this.contextFiles.length) t.commit(theme.dim(`context  ${this.contextFiles.map((f) => shortenHome(f.path)).join(', ')}`));
    if (this.skills.length) t.commit(theme.dim(`skills   ${this.skills.map((x) => x.name).join(', ')}`));
    if (this.templates.length) t.commit(theme.dim(`prompts  ${this.templates.map((x) => '/' + x.name).join(', ')}`));
    t.commit(theme.dim('/help for commands and keys · @ attach files · ! run shell · esc stop · ctrl+l model'));
    if (this.full && this.term.mouse) t.commit(theme.dim('wheel or pgup/pgdn scrolls · shift+drag selects text · /mouse releases the mouse'));
    t.blank();
  }

  private async discoverOllama() {
    const s = this.o.settings.merged;
    const base = s.providers?.ollama?.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
    try {
      const p = new OpenAIProvider('ollama', '', { apiKey: 'ollama', baseURL: base });
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
    if (this.session.path && this.agent.messages.length) parts.push(`resume with ${theme.bold('wisp -c')}`);
    if (parts.length) process.stdout.write(theme.dim(parts.join(' · ')) + '\n');
    this.exitResolve?.();
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
      this.render();
    }, 90);
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private get width() {
    return (this.full ?? this.screen!).width;
  }

  private get height() {
    return (this.full ?? this.screen!).height;
  }

  /** Hand the composed bottom area (status, editor, footer) to the active view. */
  private present(bottom: string[], cursor: { row: number; col: number } | null) {
    const w = this.width;
    if (this.full) return this.full.draw(() => this.transcript.render(w), bottom, cursor);
    const screen = this.screen!;
    screen.commit(this.transcript.takeFinished(w));
    const live = this.transcript.live(w);
    screen.setLive([...live, ...bottom], cursor && { row: cursor.row + live.length, col: cursor.col });
  }

  private render() {
    const w = this.width;
    const lines: string[] = [];

    if (this.busy) {
      const spin = theme.accent(SPINNER[this.transcript.frame % SPINNER.length]);
      const elapsed = formatDuration(Date.now() - this.turnStarted);
      const label = this.overlay ? 'Waiting for your approval' : this.transcript.busyLabel;
      lines.push(`${spin} ${theme.dim(`${label}… ${elapsed} · esc to interrupt`)}`);
    }
    for (const q of this.agent.queued) lines.push(theme.dim(truncate(`  ↳ steer: ${q}`, w)));
    for (const q of this.followUps) lines.push(theme.dim(truncate(`  ⧗ follow-up: ${q}`, w)));

    if (this.overlay) {
      if (this.overlay.header) lines.push(...this.overlay.header);
      lines.push(...this.overlay.list.render(w, Math.min(12, Math.max(4, this.height - lines.length - 6))));
      return this.present(lines, null);
    }

    const level = this.agent.thinking;
    const color = thinkingColor[level];
    const label = ` ${level === 'off' ? 'thinking off' : `thinking ${level}`} `;
    lines.push(color('─'.repeat(Math.max(0, w - label.length - 2)) + label + '──'));
    const maxEditorRows = Math.max(3, Math.floor(this.height / 2) - 4);
    const ed = this.editor.render(w, maxEditorRows, theme.accent('› '));
    const cursor = { row: lines.length + ed.cursor.row, col: ed.cursor.col };
    lines.push(...ed.lines);
    lines.push(color('─'.repeat(w)));
    if (this.autocomplete.open) lines.push(...this.autocomplete.render(w));
    else lines.push(...this.footer(w));
    this.present(lines, cursor);
  }

  private footer(w: number): string[] {
    const s = this.agent;
    const where = shortenHome(this.o.cwd) + (this.gitBranch ? ` (${this.gitBranch})` : '');
    const name = this.session.name ? ` · ${this.session.name}` : '';
    const mode = s.opts.permissionMode === 'ask' ? '' : ` · ${s.opts.permissionMode === 'yolo' ? theme.warn('yolo') : 'auto-edit'}`;
    let mcp = '';
    if (this.mcp?.servers.length) {
      const m = this.mcp.summary;
      const text = m.connecting ? `mcp ${m.connected}/${m.total}…` : m.failed ? `mcp ${m.connected}/${m.total}` : `mcp ${m.connected}`;
      mcp = (m.failed ? theme.warn(text) : theme.dim(text)) + theme.dim(' · ');
    }
    const line1 = spread(theme.dim(where + name), mcp + theme.dim(`${this.model.id}`) + mode, w);

    const ctxPct = this.model.contextWindow ? Math.round((s.contextUsed / this.model.contextWindow) * 100) : 0;
    const ctxColor = ctxPct >= 80 ? theme.error : ctxPct >= 60 ? theme.warn : theme.dim;
    const u = s.usage;
    const stats = [
      ctxColor(`ctx ${formatTokens(s.contextUsed)}/${formatTokens(this.model.contextWindow)}${ctxPct >= 1 ? ` (${ctxPct}%)` : ''}`),
      theme.dim(`↑${formatTokens(u.input + u.cacheRead + u.cacheWrite)} ↓${formatTokens(u.output)}`),
    ];
    if (s.costUSD > 0) stats.push(theme.dim(`$${s.costUSD.toFixed(s.costUSD < 1 ? 3 : 2)}`));
    let hint = '/ commands · @ files · ! shell';
    if (this.flash && this.flash.until > Date.now()) hint = this.flash.text;
    const left = stats.join(theme.dim(' · '));
    // when space is tight, drop the hint before cutting into the numbers
    const fits = stringWidth(left) + stringWidth(hint) + 2 <= w;
    const line2 = fits ? spread(left, theme.dim(hint), w) : truncate(left, w);
    return [line1, line2];
  }

  private flashMessage(text: string, ms = 1500) {
    this.flash = { text, until: Date.now() + ms };
    setTimeout(() => this.render(), ms + 20);
  }

  // --- input ------------------------------------------------------------------

  private onInput(e: InputEvent) {
    if (e.type === 'mouse') {
      if (e.wheel && this.full) this.full.scrollBy(e.wheel === 'up' ? -3 : 3);
      return this.render();
    }
    if (e.type === 'paste') {
      if (this.overlay) return;
      const img = droppedImagePath(e.text);
      if (img) this.editor.insert(`@"${img}" `);
      else this.editor.paste(e.text);
    } else this.onKey(e.key);
    this.render();
  }

  private onKey(k: Key) {
    const id = `${k.ctrl ? 'C-' : ''}${k.alt ? 'M-' : ''}${k.shift && k.name.length > 1 ? 'S-' : ''}${k.name}`;

    if (id === 'C-c') return this.ctrlC();
    if (id === 'C-z') return this.term.suspend();

    if (this.overlay) {
      const r = this.overlay.list.handleKey(k);
      const ov = this.overlay;
      if (r === 'select') {
        this.overlay = null;
        ov.onSelect(ov.list.selected!.value);
      } else if (r === 'cancel') {
        this.overlay = null;
        ov.onCancel();
      }
      return;
    }

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
    this.editor.handleKey(k);
  }

  private ctrlC() {
    if (this.overlay) {
      const ov = this.overlay;
      this.overlay = null;
      return ov.onCancel();
    }
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
    this.editor.addToHistory(raw);
    this.saveHistory(raw);
    this.editor.clear();
    this.autocomplete.close();
    this.full?.toBottom();
    if (this.busy) {
      if (text.startsWith('/') || text.startsWith('!')) {
        this.editor.setText(raw);
        return this.flashMessage('commands run when wisp is idle (esc to stop)', 2500);
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
        this.transcript.notice('Interrupted.', 'warn');
        this.transcript.blank();
      }
    } catch (err) {
      if (isAbortError(err) || this.turn.signal.aborted) this.transcript.notice('Interrupted.', 'warn');
      else this.transcript.notice(describeError(err, { provider: this.model.provider }), 'error');
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
      if (slow.length) this.transcript.notice(`MCP ${slow.join(', ')} still starting; their tools will appear once connected.`, 'warn');
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
        this.transcript.notice(theme.dim('(output added to the conversation)'));
      }
    });
  }

  // --- overlays ---------------------------------------------------------------

  private openOverlay<T>(list: SelectList<T>, onSelect: (v: T) => void, header?: string[], onCancel = () => {}) {
    this.overlay = { list, onSelect, onCancel, header };
    this.render();
  }

  private approve(tool: Tool, preview: string, signal: AbortSignal): Promise<Approval> {
    return new Promise((resolveApproval) => {
      const w = this.width;
      const maxPreview = Math.max(4, this.height - 12);
      let body = preview.split('\n').flatMap((l) => wrap(l, w - 2));
      if (body.length > maxPreview) body = [...body.slice(0, maxPreview), theme.dim(`… ${body.length - maxPreview} more lines`)];
      const header = [theme.border('─'.repeat(w)), ...body.map((l) => ' ' + l), ''];
      const what = tool.mcp ? 'calls' : tool.permission === 'exec' ? 'commands' : 'edits';
      const list = new SelectList<Approval>(
        [
          { label: 'Yes', value: 'yes', hotkey: 'y', detail: 'y' },
          { label: `Yes, and allow ${tool.mcp ? `${tool.mcp.server} › ${tool.mcp.tool}` : tool.name} ${what} for this session`, value: 'always', hotkey: 'a', detail: 'a' },
          { label: 'No, tell wisp what to do instead', value: 'no', hotkey: 'n', detail: 'n · esc' },
        ],
        { title: `Allow ${tool.mcp ? `${tool.mcp.server} › ${tool.mcp.tool}` : tool.name}?`, hint: 'y/a/n · ↑↓ enter' },
      );
      const done = (a: Approval) => {
        signal.removeEventListener('abort', onAbort);
        resolveApproval(a);
      };
      const onAbort = () => {
        if (this.overlay?.list === list) this.overlay = null;
        done('no');
        this.render();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.openOverlay(list, done, header, () => done('no'));
    });
  }

  private modelOptions(): Option<ModelInfo>[] {
    const all = [...availableModels(this.o.settings.merged, BUILTIN_MODELS), ...this.ollamaModels];
    if (!all.some((m) => m.provider === this.model.provider && m.id === this.model.id)) all.unshift(this.model);
    return all.map((m) => ({
      label: `${m.provider}/${m.id}`,
      keywords: m.name,
      detail: [m.name !== m.id ? m.name : '', `${formatTokens(m.contextWindow)} ctx`, m.price ? `$${m.price.input}/$${m.price.output} per M` : ''].filter(Boolean).join(' · '),
      value: m,
    }));
  }

  private openModelPicker(query = '') {
    const options = this.modelOptions();
    const current = options.findIndex((o) => o.value.id === this.model.id && o.value.provider === this.model.provider);
    const list = new SelectList(options, { title: 'Select model', filterable: true, initial: current });
    list.filter = query;
    if (query) list.setOptions(options);
    this.openOverlay(list, (m: ModelInfo) => this.switchModel({ provider: m.provider, id: m.id }));
  }

  private switchModel(ref: ModelRef) {
    const s = this.o.settings.merged;
    try {
      const provider = createProvider(ref, s);
      this.model = getModelInfo(ref, s);
      this.agent.setModel(provider, this.model);
      this.o.model = ref;
      this.o.settings.saveGlobal({ provider: ref.provider, model: ref.id });
      this.session.log({ type: 'model', provider: ref.provider, model: ref.id, thinking: this.agent.thinking });
      this.transcript.notice(`Model: ${formatRef(ref)} · thinking ${this.agent.thinking}`);
    } catch (err) {
      this.transcript.notice(describeError(err), 'error');
    }
  }

  private cycleFavorite() {
    const favs = this.o.settings.merged.favoriteModels ?? [];
    const refs = favs.length ? favs.map((f) => parseModelRef(f)) : this.modelOptions().map((o) => ({ provider: o.value.provider, id: o.value.id }));
    if (refs.length < 2) return this.flashMessage('add "favoriteModels" in settings to cycle');
    const i = refs.findIndex((r) => r.provider === this.model.provider && r.id === this.model.id);
    const next = refs[(i + 1) % refs.length];
    this.switchModel(next);
    this.flashMessage(`model: ${next.id}`);
  }

  private setThinking(level: ThinkingLevel) {
    this.agent.opts.thinking = level;
    this.o.settings.saveGlobal({ thinking: level });
    const actual = this.agent.thinking;
    this.flashMessage(actual === level ? `thinking ${level}` : `thinking ${actual} (${this.model.id} doesn't support ${level})`, 2000);
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
      `Permission mode: ${mode} — ${mode === 'ask' ? 'asks before edits and commands' : mode === 'auto-edit' ? 'edits run freely, commands ask' : 'everything runs without asking'}`,
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
      this.transcript.commit(renderToolBody(last.call, last.output, last.isError, this.width, true));
      this.transcript.blank();
    }
    this.flashMessage(this.verbose ? 'tool output: expanded' : 'tool output: collapsed');
  }

  /** Run $EDITOR on a file with the terminal handed over. Returns false (and says why) on failure. */
  private async editFile(file: string): Promise<boolean> {
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
    if (await this.editFile(file)) {
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
    this.flashMessage(`copied (${via})`);
    this.render();
  }

  // --- sessions ---------------------------------------------------------------

  private newSession() {
    this.session = Session.create(this.o.cwd, { persist: this.o.persistSessions });
    this.agent.load([]);
    this.transcript.blank();
    this.transcript.notice(theme.accent('─── new session ───'));
    this.transcript.blank();
  }

  private loadSession(path: string) {
    const { session, entries } = Session.open(path);
    if (session.cwd !== this.o.cwd) {
      this.transcript.notice(`That session belongs to ${session.cwd}. Run: cd ${session.cwd} && wisp --session ${session.id}`, 'warn');
      return;
    }
    const state = restore(entries);
    this.session = session;
    this.agent.load(state.messages, state);
    if (state.model) {
      const ref = { provider: state.model.provider as ModelRef['provider'], id: state.model.model };
      if (ref.id !== this.model.id) this.switchModel(ref);
    }
    this.transcript.blank();
    this.transcript.notice(theme.accent(`─── resumed ${session.name ?? session.id} ───`));
    this.transcript.blank();
    this.transcript.replay(state.messages);
  }

  private openResume(all: boolean) {
    const sessions = listSessions(all ? null : this.o.cwd).filter((s) => s.path !== this.session.path);
    if (!sessions.length) return this.transcript.notice(all ? 'No saved sessions.' : 'No other sessions for this directory. Try /resume all.');
    const list = new SelectList(
      sessions.map((s) => ({
        label: truncate(s.name ?? s.firstMessage, 60),
        keywords: s.firstMessage + ' ' + s.id,
        detail: `${relativeTime(s.modified)} · ${s.messageCount} msgs${all ? ' · ' + shortenHome(s.cwd) : ''}`,
        value: s.path,
      })),
      { title: 'Resume session', filterable: true },
    );
    this.openOverlay(list, (path: string) => this.loadSession(path));
  }

  private openFork() {
    const entries = this.session.entries;
    const candidates: { idx: number; text: string }[] = [];
    let idx = 0;
    for (const e of entries) {
      if (e.type !== 'message') continue;
      const text = firstUserText(e.message);
      if (e.message.role === 'user' && text && !text.startsWith('I ran a shell command')) candidates.push({ idx, text });
      idx++;
    }
    if (!candidates.length) return this.transcript.notice('Nothing to fork from yet.');
    const list = new SelectList(
      candidates.reverse().map((c) => ({ label: truncate(c.text, 80), value: c })),
      { title: 'Fork from message (the conversation restarts just before it)', filterable: true },
    );
    this.openOverlay(list, (c: { idx: number; text: string }) => {
      const fork = forkSession(entries, this.o.cwd, c.idx, this.o.persistSessions);
      const state = restore(fork.entries);
      this.session = fork;
      this.agent.load(state.messages, state);
      this.transcript.blank();
      this.transcript.notice(theme.accent(`─── forked into new session ${fork.id} ───`));
      this.transcript.notice('Edit the message and press enter to continue down a different path.');
      this.transcript.blank();
      const original = entries.filter((e) => e.type === 'message')[c.idx];
      const text = original?.type === 'message' ? original.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : c.text;
      this.editor.setText(text);
    });
  }

  // --- slash commands ---------------------------------------------------------

  private async command(input: string): Promise<void> {
    const [, name, rest = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(input) ?? [];
    const args = rest.trim();
    const t = this.transcript;
    switch (name) {
      case 'help':
        t.blank();
        t.commit(theme.bold('Commands'));
        for (const c of this.commandList()) t.commit(`  ${theme.accent('/' + c.name)}${c.args ? ' ' + theme.dim(c.args) : ''}  ${theme.dim(c.description)}`);
        t.blank();
        return this.command('/hotkeys');
      case 'hotkeys':
        t.commit(theme.bold('Keys'));
        for (const [k, d] of HOTKEYS) t.commit(`  ${theme.accent(k.padEnd(34))}${theme.dim(d)}`);
        t.blank();
        return;
      case 'model':
        return this.openModelPicker(args);
      case 'thinking': {
        if (args && THINKING_LEVELS.includes(args as ThinkingLevel)) return this.setThinking(args as ThinkingLevel);
        const levels = this.model.thinking;
        const list = new SelectList(
          levels.map((l) => ({ label: l, value: l, detail: l === 'off' ? 'no reasoning' : l === 'max' ? 'deepest, slowest' : '' })),
          { title: `Thinking level for ${this.model.id}`, initial: levels.indexOf(this.agent.thinking) },
        );
        return this.openOverlay(list, (l: ThinkingLevel) => this.setThinking(l));
      }
      case 'mode': {
        if (PERMISSION_MODES.includes(args as PermissionMode)) return this.setMode(args as PermissionMode);
        const list = new SelectList(
          [
            { label: 'ask', value: 'ask' as PermissionMode, detail: 'ask before edits and commands' },
            { label: 'auto-edit', value: 'auto-edit' as PermissionMode, detail: 'edit files freely, ask before commands' },
            { label: 'yolo', value: 'yolo' as PermissionMode, detail: 'never ask (use in a sandbox)' },
          ],
          { title: 'Permission mode', initial: PERMISSION_MODES.indexOf(this.agent.opts.permissionMode) },
        );
        return this.openOverlay(list, (m: PermissionMode) => this.setMode(m));
      }
      case 'new':
      case 'clear':
        return this.newSession();
      case 'resume':
        return this.openResume(args === 'all');
      case 'fork':
        return this.openFork();
      case 'name':
        if (!args) return t.notice('Usage: /name <session name>', 'warn');
        this.session.log({ type: 'name', name: args });
        return t.notice(`Session named "${args}"`);
      case 'session': {
        const u = this.agent.usage;
        t.blank();
        t.commit(theme.bold('Session'));
        t.commit(`  id        ${this.session.id}${this.session.name ? ` (${this.session.name})` : ''}`);
        t.commit(`  file      ${this.session.path ? shortenHome(this.session.path) : '(not saved: --no-session)'}`);
        t.commit(`  messages  ${this.agent.messages.length}`);
        t.commit(`  model     ${formatRef(this.o.model)} · thinking ${this.agent.thinking}`);
        t.commit(`  context   ${formatTokens(this.agent.contextUsed)} / ${formatTokens(this.model.contextWindow)}`);
        t.commit(`  tokens    ${formatTokens(u.input)} in · ${formatTokens(u.cacheRead)} cache read · ${formatTokens(u.cacheWrite)} cache write · ${formatTokens(u.output)} out`);
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
        return t.notice(`Exported to ${shortenHome(file)}`, 'success');
      }
      case 'reload':
        this.discover();
        this.agent.opts.system = this.systemPrompt();
        return t.notice(`Reloaded: ${this.contextFiles.length} context files, ${this.skills.length} skills, ${this.templates.length} prompt templates.`);
      case 'settings': {
        if (!existsSync(GLOBAL_SETTINGS)) this.o.settings.saveGlobal({});
        if (!(await this.editFile(GLOBAL_SETTINGS))) return;
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
        return t.notice(this.term.mouse ? 'Mouse captured: the wheel scrolls the conversation (shift+drag to select).' : 'Mouse released: select text normally; scroll with pgup/pgdn.');
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
    t.notice(`Unknown command /${name}. Type /help for a list.`, 'error');
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
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

