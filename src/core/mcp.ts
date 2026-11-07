import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { truncateMiddle } from '../tools/bash.js';
import { ToolError, type Tool, type ToolOutput } from '../tools/types.js';
import { AGENT_DIR } from './settings.js';
import type { ImageBlock, JSONSchema } from './types.js';

/**
 * MCP (Model Context Protocol) client support. Servers are configured in the
 * same `mcpServers` format Claude Desktop, Cursor and Claude Code use:
 *
 *   ~/.wisp/mcp.json             global
 *   <project>/.mcp.json          project (shared with other tools)
 *   <project>/.wisp/mcp.json     project (wisp-only)
 *
 * Each server's tools are exposed to the model as `mcp__<server>__<tool>`.
 */

export interface McpServerConfig {
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // remote
  url?: string;
  headers?: Record<string, string>;
  /** stdio | http | sse ("streamable-http" accepted as http). Inferred when omitted. */
  type?: string;
  /** Tool names that run without asking ("*" = all of this server's tools). */
  autoApprove?: string[];
  disabled?: boolean;
  /** ms to wait for the server to start. Default 60s (npx downloads can be slow). */
  startupTimeout?: number;
  /** ms per tool call. Default 10 minutes. */
  timeout?: number;
}

export type McpScope = 'global' | 'project';

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  scope: McpScope;
  source: string;
}

export const GLOBAL_MCP_CONFIG = join(AGENT_DIR, 'mcp.json');
export const projectMcpConfigs = (cwd: string) => [join(cwd, '.mcp.json'), join(cwd, '.wisp', 'mcp.json')];
const TRUST_FILE = join(AGENT_DIR, 'trusted-mcp.json');
const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

function readConfigFile(path: string): Record<string, McpServerConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== 'object') throw new Error(`${path}: "mcpServers" must be an object`);
  return servers as Record<string, McpServerConfig>;
}

/** All configured servers; project entries override global ones with the same name. */
export function loadMcpConfig(cwd: string, extraFiles: string[] = []): McpServerEntry[] {
  const byName = new Map<string, McpServerEntry>();
  const add = (path: string, scope: McpScope) => {
    for (const [name, config] of Object.entries(readConfigFile(path))) byName.set(name, { name, config, scope, source: path });
  };
  add(GLOBAL_MCP_CONFIG, 'global');
  for (const p of projectMcpConfigs(cwd)) add(p, 'project');
  for (const p of extraFiles) add(p, 'global'); // explicitly passed (--mcp-config) = trusted
  return [...byName.values()];
}

/** Add or replace a server in a config file (used by `wisp mcp add`). */
export function writeServer(path: string, name: string, config: McpServerConfig | null) {
  let doc: { mcpServers?: Record<string, McpServerConfig> } = {};
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  doc.mcpServers ??= {};
  if (config) doc.mcpServers[name] = config;
  else delete doc.mcpServers[name];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

// --- trust --------------------------------------------------------------------
// A repository's MCP config can launch arbitrary commands, so project servers
// only start after the user approves them. Approval is tied to the exact
// config: if it changes, wisp asks again.

function trustKey(cwd: string, entries: McpServerEntry[]): string {
  const project = entries.filter((e) => e.scope === 'project').map((e) => [e.name, e.config]);
  return createHash('sha256').update(JSON.stringify([cwd, project])).digest('hex');
}

function readTrust(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(TRUST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function isProjectTrusted(cwd: string, entries: McpServerEntry[]): boolean {
  if (!entries.some((e) => e.scope === 'project')) return true;
  return readTrust()[cwd] === trustKey(cwd, entries);
}

export function trustProject(cwd: string, entries: McpServerEntry[]) {
  const t = readTrust();
  t[cwd] = trustKey(cwd, entries);
  try {
    mkdirSync(AGENT_DIR, { recursive: true });
    writeFileSync(TRUST_FILE, JSON.stringify(t, null, 2) + '\n');
  } catch {}
}

/** One-line description of how a server is launched or reached. */
export function describeServer(c: McpServerConfig): string {
  if (c.url) return c.url;
  return [c.command, ...(c.args ?? [])].join(' ');
}

// --- env expansion ------------------------------------------------------------

/** Expand ${VAR} and ${VAR:-default} from the environment. */
export function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, def) => env[name] ?? def ?? '');
}

const expandRecord = (r: Record<string, string> | undefined) =>
  r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expandEnv(String(v))])) : undefined;

// --- tool naming --------------------------------------------------------------

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Provider-safe tool name (^[a-zA-Z0-9_-]{1,64}$), unique across servers. */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  let name = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  if (name.length > 64 || taken.has(name)) {
    const hash = createHash('sha1').update(`${server}/${tool}`).digest('hex').slice(0, 6);
    name = `${name.slice(0, 57)}_${hash}`;
  }
  taken.add(name);
  return name;
}

/** "mcp__github__create_issue" → { server: "github", tool: "create_issue" } for display. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

// --- results ------------------------------------------------------------------

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_RESULT_CHARS = 50_000;

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; name?: string; description?: string }
  | { type: string; [k: string]: unknown };

/** Convert an MCP tool result to what the model and transcript see. */
export function convertResult(result: { content?: McpContent[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown }): ToolOutput & { isError: boolean } {
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  const content = result.content ?? [];
  for (const c of content) {
    switch (c.type) {
      case 'text':
        texts.push((c as { text: string }).text);
        break;
      case 'image': {
        const img = c as { data: string; mimeType: string };
        if (IMAGE_MIME.has(img.mimeType)) images.push({ type: 'image', mediaType: img.mimeType as ImageBlock['mediaType'], data: img.data });
        else texts.push(`[image of type ${img.mimeType} omitted]`);
        break;
      }
      case 'audio':
        texts.push(`[audio (${(c as { mimeType: string }).mimeType}) omitted]`);
        break;
      case 'resource': {
        const r = (c as { resource: { uri: string; mimeType?: string; text?: string; blob?: string } }).resource;
        if (r.text !== undefined) texts.push(`<resource uri="${r.uri}">\n${r.text}\n</resource>`);
        else if (r.blob && r.mimeType && IMAGE_MIME.has(r.mimeType)) images.push({ type: 'image', mediaType: r.mimeType as ImageBlock['mediaType'], data: r.blob });
        else texts.push(`[binary resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''}]`);
        break;
      }
      case 'resource_link': {
        const l = c as { uri: string; name?: string; description?: string };
        texts.push(`[resource: ${l.name ?? l.uri}${l.name ? ` <${l.uri}>` : ''}${l.description ? ` — ${l.description}` : ''}]`);
        break;
      }
      default:
        texts.push(`[unsupported content type "${c.type}"]`);
    }
  }
  if (!texts.length && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent, null, 2));
  if (!texts.length && result.toolResult !== undefined) texts.push(JSON.stringify(result.toolResult, null, 2));
  let text = texts.join('\n');
  if (!text && images.length) text = `(${images.length} image${images.length > 1 ? 's' : ''})`;
  return { content: truncateMiddle(text || '(no output)', MAX_RESULT_CHARS), images: images.length ? images : undefined, isError: Boolean(result.isError) };
}

// --- connections ----------------------------------------------------------------

export type McpStatus = 'connecting' | 'connected' | 'failed' | 'disabled';

interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export class McpServer {
  status: McpStatus = 'connecting';
  error?: string;
  tools: RemoteTool[] = [];
  instructions?: string;
  serverInfo?: { name: string; version: string };
  stderr: string[] = [];
  private client: Client | null = null;
  /** Set as soon as a transport exists, so a server that times out mid-start still gets shut down. */
  private transport: Transport | null = null;
  private pid: number | null = null;

  constructor(
    readonly entry: McpServerEntry,
    private cwd: string,
    private onChange: () => void,
  ) {
    if (entry.config.disabled) this.status = 'disabled';
  }

  get name() {
    return this.entry.name;
  }

  async connect(): Promise<void> {
    if (this.entry.config.disabled) return;
    await this.close();
    this.status = 'connecting';
    this.error = undefined;
    this.onChange();
    const timeout = this.entry.config.startupTimeout ?? 60_000;
    try {
      await withTimeout(this.open(), timeout, `did not start within ${Math.round(timeout / 1000)}s`);
      await this.refreshTools();
      this.status = 'connected';
    } catch (err) {
      this.status = 'failed';
      this.error = errorMessage(err);
      await this.close().catch(() => {});
      this.status = 'failed';
    }
    this.onChange();
  }

  private newClient(): Client {
    const client = new Client({ name: 'wisp', version: VERSION }, { capabilities: {} });
    client.onclose = () => {
      if (this.client === client && this.status === 'connected') {
        this.status = 'failed';
        this.error = 'connection closed' + (this.stderr.length ? `: ${this.stderr.at(-1)}` : '');
        this.onChange();
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools().catch(() => {});
      this.onChange();
    });
    return client;
  }

  private async open() {
    const c = this.entry.config;
    const type = (c.type ?? (c.url ? 'http' : 'stdio')).toLowerCase();
    if (type === 'stdio') {
      if (!c.command) throw new Error('no "command" configured');
      const transport = new StdioClientTransport({
        command: expandEnv(c.command),
        args: (c.args ?? []).map((a) => expandEnv(String(a))),
        // the user's own environment, plus anything configured for this server
        env: { ...(process.env as Record<string, string>), ...expandRecord(c.env) },
        cwd: c.cwd ? expandEnv(c.cwd) : this.cwd,
        stderr: 'pipe', // never let a server write over the TUI
      });
      transport.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split('\n')) if (line.trim()) this.stderr.push(line);
        if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
      });
      this.transport = transport;
      const client = this.newClient();
      await client.connect(transport);
      this.pid = transport.pid;
      if (this.pid) livePids.add(this.pid);
      this.adopt(client);
      return;
    }
    if (!c.url) throw new Error('no "url" configured');
    const url = new URL(expandEnv(c.url));
    const requestInit = { headers: expandRecord(c.headers) };
    const attempt = async (t: Transport) => {
      this.transport = t;
      const client = this.newClient();
      await client.connect(t);
      this.adopt(client);
    };
    if (type === 'sse') return attempt(new SSEClientTransport(url, { requestInit }));
    try {
      await attempt(new StreamableHTTPClientTransport(url, { requestInit }));
    } catch (err) {
      // older servers only speak the legacy SSE transport
      if (c.type) throw err;
      await attempt(new SSEClientTransport(url, { requestInit }));
    }
  }

  private adopt(client: Client) {
    this.client = client;
    this.instructions = client.getInstructions();
    const v = client.getServerVersion();
    this.serverInfo = v ? { name: v.name, version: v.version } : undefined;
  }

  async refreshTools() {
    if (!this.client) return;
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as RemoteTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  async call(tool: string, args: Record<string, unknown>, opts: { signal: AbortSignal; onProgress?: (msg: string) => void }) {
    if (!this.client || this.status !== 'connected')
      throw new ToolError(`MCP server "${this.name}" is not connected${this.error ? ` (${this.error})` : ''}. The user can run /mcp to check it.`);
    return this.client.callTool({ name: tool, arguments: args }, undefined, {
      signal: opts.signal,
      timeout: this.entry.config.timeout ?? 600_000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => opts.onProgress?.(`${p.message ?? 'working'}${p.total ? ` (${p.progress}/${p.total})` : p.progress ? ` (${p.progress})` : ''}`),
    });
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (this.pid) livePids.delete(this.pid);
    this.pid = null;
    if (client) await client.close().catch(() => {});
    else if (transport) await transport.close().catch(() => {});
  }
}

// Last-resort cleanup: never leave stdio servers running after wisp exits.
const livePids = new Set<number>();
process.on('exit', () => {
  for (const pid of livePids) {
    try {
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch {}
  }
});

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}

function errorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'ENOENT') return 'command not found';
  const msg = e?.message ?? String(err);
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

// --- manager ------------------------------------------------------------------

export class McpManager {
  readonly servers: McpServer[];
  private listeners = new Set<() => void>();

  constructor(entries: McpServerEntry[], private cwd: string) {
    this.servers = entries.map((e) => new McpServer(e, cwd, () => this.emit()));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Connect every enabled server in parallel. Resolves when all have settled. */
  start(): Promise<void> {
    return Promise.all(this.servers.map((s) => s.connect())).then(() => {});
  }

  /** Wait until all servers settle, or `ms` passes. */
  async ready(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.servers.some((s) => s.status === 'connecting') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  get(name: string) {
    return this.servers.find((s) => s.name === name);
  }

  /** Wisp tool adapters for every tool of every connected server. */
  tools(): Tool[] {
    const taken = new Set<string>();
    const out: Tool[] = [];
    for (const server of this.servers) {
      if (server.status !== 'connected') continue;
      for (const t of server.tools) out.push(adaptTool(server, t, mcpToolName(server.name, t.name, taken)));
    }
    return out;
  }

  /** Server-provided usage instructions, for the system prompt. */
  instructions(): { server: string; text: string }[] {
    return this.servers.filter((s) => s.status === 'connected' && s.instructions?.trim()).map((s) => ({ server: s.name, text: s.instructions!.trim() }));
  }

  get summary() {
    const active = this.servers.filter((s) => s.status !== 'disabled');
    return {
      total: active.length,
      connected: active.filter((s) => s.status === 'connected').length,
      failed: active.filter((s) => s.status === 'failed').length,
      connecting: active.filter((s) => s.status === 'connecting').length,
    };
  }

  async close() {
    await Promise.all(this.servers.map((s) => s.close()));
  }
}

function adaptTool(server: McpServer, t: RemoteTool, name: string): Tool<Record<string, unknown>> {
  const auto = server.entry.config.autoApprove ?? [];
  const approved = auto.includes('*') || auto.includes(t.name);
  const schema = (t.inputSchema?.type === 'object' ? t.inputSchema : { type: 'object', properties: {}, ...t.inputSchema }) as unknown as JSONSchema;
  const description = [t.title && t.title !== t.name ? t.title : '', t.description ?? ''].filter(Boolean).join(': ');
  return {
    name,
    description: `[MCP server "${server.name}"] ${description}`.slice(0, 4000),
    inputSchema: schema,
    permission: approved ? 'none' : 'exec',
    mcp: { server: server.name, tool: t.name, readOnly: Boolean(t.annotations?.readOnlyHint) },
    label: (input) => summarizeArgs(input),
    async preview(input) {
      const json = JSON.stringify(input, null, 2).split('\n');
      const shown = json.length > 40 ? [...json.slice(0, 40), `… ${json.length - 40} more lines`] : json;
      const hint = t.annotations?.readOnlyHint ? ' (read-only)' : t.annotations?.destructiveHint ? ' (may change or delete data)' : '';
      return `MCP tool ${server.name} › ${t.name}${hint}\n${shown.join('\n')}`;
    },
    async run(input, ctx) {
      const result = await server.call(t.name, input, { signal: ctx.signal, onProgress: ctx.onUpdate });
      const out = convertResult(result as Parameters<typeof convertResult>[0]);
      if (out.isError) throw new ToolError(out.content);
      return { content: out.content, images: out.images };
    },
  };
}

/** A compact label for the transcript: the most telling argument. */
function summarizeArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {});
  if (!entries.length) return '';
  const firstString = entries.find(([, v]) => typeof v === 'string');
  if (entries.length === 1 || firstString) {
    const [k, v] = firstString ?? entries[0];
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    return entries.length === 1 ? val : `${k}: ${val}`;
  }
  return JSON.stringify(input);
}
