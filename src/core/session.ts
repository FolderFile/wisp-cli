import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compactionMessage } from './agent.js';
import { AGENT_DIR } from './settings.js';
import { emptyUsage, type Message, type ThinkingLevel, type Usage } from './types.js';

/**
 * Sessions are append-only JSONL files, one per conversation, grouped by
 * working directory: ~/.wisp/sessions/<cwd-slug>/<timestamp>_<id>.jsonl
 *
 * A session is a tree. Every message (and compaction) entry has an `id` and
 * the `parent` it continues from; the conversation is the path from the root
 * to the current head. Going back to an earlier point (/tree) appends a
 * `head` entry, and new messages then branch off from there — nothing is ever
 * rewritten, which also keeps provider reasoning blocks valid (Anthropic binds
 * them to the exact history that produced them).
 *
 * Files from before branching existed have no ids; they load as one straight line.
 */
export type SessionEntry =
  | { type: 'header'; version: 1 | 2; id: string; cwd: string; created: string; forkedFrom?: string }
  | { type: 'message'; ts: string; message: Message; id?: string; parent?: string | null }
  | { type: 'compaction'; ts: string; summary: string; tokensBefore: number; id?: string; parent?: string | null }
  | { type: 'head'; ts: string; id: string | null }
  | { type: 'name'; ts: string; name: string }
  | { type: 'model'; ts: string; provider: string; model: string; thinking: ThinkingLevel }
  | { type: 'usage'; ts: string; usage: Usage; costUSD: number; contextUsed: number }
  /** Feature data (e.g. checkpoints), attached to the node that was the head (`at`) when it was logged. Not part of the conversation. */
  | { type: 'custom'; ts: string; id: string; customType: string; data: unknown; at: string | null };

type NodeEntry = Extract<SessionEntry, { type: 'message' | 'compaction' }> & { id: string; parent: string | null };

export const SESSIONS_DIR = process.env.WISP_SESSION_DIR || join(AGENT_DIR, 'sessions');

export const cwdSlug = (cwd: string) => cwd.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'root';

const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);
const isNode = (e: SessionEntry): e is NodeEntry => e.type === 'message' || e.type === 'compaction';

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: Date;
}

/**
 * Give legacy entries ids and parents, and find the head. Returns the node
 * entries (in file order) and the id of the current head (null = empty).
 */
export function linkNodes(entries: SessionEntry[]): { nodes: NodeEntry[]; byId: Map<string, NodeEntry>; head: string | null } {
  const nodes: NodeEntry[] = [];
  const byId = new Map<string, NodeEntry>();
  let head: string | null = null;
  entries.forEach((e, i) => {
    if (e.type === 'head') {
      head = e.id;
      return;
    }
    if (!isNode(e)) return;
    if (!e.id) {
      e.id = `n${i}`;
      e.parent = head;
    }
    if (e.parent === undefined) e.parent = head;
    nodes.push(e);
    byId.set(e.id, e);
    head = e.id;
  });
  return { nodes, byId, head };
}

/** Node entries from the root to `head`. */
function pathTo(head: string | null, byId: Map<string, NodeEntry>): NodeEntry[] {
  const path: NodeEntry[] = [];
  const seen = new Set<string>();
  for (let id = head; id && !seen.has(id); id = byId.get(id)?.parent ?? null) {
    seen.add(id);
    const n = byId.get(id);
    if (!n) break;
    path.push(n);
  }
  return path.reverse();
}

export class Session {
  readonly id: string;
  readonly path: string | null;
  name?: string;
  /** Everything appended so far (also for in-memory sessions). */
  entries: SessionEntry[] = [];
  /** Id of the last node on the active branch. */
  head: string | null = null;
  private written = false;
  private pending: SessionEntry[] = [];

  /** path null = in-memory (--no-session). */
  private constructor(id: string, path: string | null, public readonly cwd: string) {
    this.id = id;
    this.path = path;
  }

  static create(cwd: string, opts: { persist: boolean; forkedFrom?: string; id?: string }): Session {
    const id = opts.id ?? randomUUID().slice(0, 8);
    const dir = join(SESSIONS_DIR, cwdSlug(cwd));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const s = new Session(id, opts.persist ? join(dir, `${stamp}_${id}.jsonl`) : null, cwd);
    // The header is buffered until the first real entry, so opening wisp and
    // quitting doesn't leave empty session files behind.
    const header: SessionEntry = { type: 'header', version: 2, id, cwd, created: new Date().toISOString(), forkedFrom: opts.forkedFrom };
    s.pending.push(header);
    s.entries.push(header);
    return s;
  }

  static open(path: string): { session: Session; entries: SessionEntry[] } {
    const entries = readEntries(path);
    const header = entries[0];
    if (header?.type !== 'header') throw new Error(`${path} is not a wisp session file.`);
    const s = new Session(header.id, path, header.cwd);
    s.written = true;
    s.entries = entries;
    s.head = linkNodes(entries).head;
    for (const e of entries) if (e.type === 'name') s.name = e.name;
    return { session: s, entries };
  }

  append(entry: SessionEntry) {
    if (entry.type === 'name') this.name = entry.name;
    if (isNode(entry)) {
      entry.id ??= newId();
      if (entry.parent === undefined) entry.parent = this.head;
      this.head = entry.id;
    } else if (entry.type === 'head') this.head = entry.id;
    this.entries.push(entry);
    if (!this.path) return;
    this.pending.push(entry);
    const meaningful = this.written || this.pending.some((e) => e.type === 'message');
    if (!meaningful) return;
    mkdirSync(join(this.path, '..'), { recursive: true });
    appendFileSync(this.path, this.pending.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.pending = [];
    this.written = true;
  }

  log(entry: DistributiveOmit<SessionEntry, 'ts'>) {
    this.append({ ...entry, ts: new Date().toISOString() } as SessionEntry);
  }

  /** Log feature data at the current head; returns the entry's id. */
  custom(customType: string, data: unknown): string {
    const id = newId();
    this.log({ type: 'custom', id, customType, data, at: this.head });
    return id;
  }

  /** Make `id` the head: the next message continues from there (a new branch). */
  moveHead(id: string | null) {
    if (id === this.head) return;
    this.log({ type: 'head', id });
  }
}

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export function readEntries(path: string): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn final line from a crash: ignore it
    }
  }
  return out;
}

export interface RestoredState {
  messages: Message[];
  usage: Usage;
  costUSD: number;
  contextUsed: number;
  model?: { provider: string; model: string; thinking: ThinkingLevel };
}

/** Rebuild the active branch's conversation (a compaction replaces everything before it). */
export function restore(entries: SessionEntry[]): RestoredState {
  const state: RestoredState = { messages: [], usage: emptyUsage(), costUSD: 0, contextUsed: 0 };
  const { byId, head } = linkNodes(entries);
  let movedSinceUsage = false;
  for (const e of entries) {
    if (e.type === 'usage') {
      state.usage = e.usage;
      state.costUSD = e.costUSD;
      state.contextUsed = e.contextUsed;
      movedSinceUsage = false;
    } else if (e.type === 'head') movedSinceUsage = true;
    else if (e.type === 'model') state.model = { provider: e.provider, model: e.model, thinking: e.thinking };
  }
  // after jumping to another branch the last measured context size no longer applies
  if (movedSinceUsage) state.contextUsed = 0;
  for (const n of pathTo(head, byId)) {
    if (n.type === 'message') state.messages.push(n.message);
    else state.messages = [compactionMessage(n.summary)];
  }
  return state;
}

export function firstUserText(m: Message | undefined): string {
  if (!m || m.role !== 'user') return '';
  return m.content
    .filter((b) => b.type === 'text' && !b.text.startsWith('<wisp-note>'))
    .map((b) => (b as { text: string }).text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The entries on the branch ending at `leaf` (default: the head), root first: each node
 * followed by the custom entries logged while it was the head.
 */
export function branchEntries(entries: SessionEntry[], leaf?: string | null): Array<NodeEntry | Extract<SessionEntry, { type: 'custom' }>> {
  const { byId, head } = linkNodes(entries);
  const customs = new Map<string | null, Extract<SessionEntry, { type: 'custom' }>[]>();
  for (const e of entries) if (e.type === 'custom') customs.set(e.at, [...(customs.get(e.at) ?? []), e]);
  const out: Array<NodeEntry | Extract<SessionEntry, { type: 'custom' }>> = [...(customs.get(null) ?? [])];
  for (const n of pathTo(leaf === undefined ? head : leaf, byId)) out.push(n, ...(customs.get(n.id) ?? []));
  return out;
}

// --- tree view ------------------------------------------------------------------

export interface TurnNode {
  /** Id of the node that starts this turn (a user message or a compaction). */
  id: string;
  kind: 'prompt' | 'shell' | 'compaction';
  label: string;
  /** Full prompt text, for "edit and resend". */
  text: string;
  ts: string;
  /** Head to move to for "continue from here": the end of this turn's reply. */
  endId: string;
  /** Head to move to for "edit this message": the node before it. */
  parentId: string | null;
  /** Number of messages in the turn (prompt + replies + tool results). */
  size: number;
  onPath: boolean;
  current: boolean;
  children: TurnNode[];
}

/** A user message that starts a turn (as opposed to tool results or steering). */
function turnKind(n: NodeEntry): TurnNode['kind'] | null {
  if (n.type === 'compaction') return 'compaction';
  if (n.message.role !== 'user') return null;
  if (n.message.content.some((b) => b.type === 'tool_result')) return null;
  const text = firstUserText(n.message);
  if (!text) return null;
  return text.startsWith('I ran a shell command:') ? 'shell' : 'prompt';
}

/**
 * Group the node tree into turns (prompt → replies) and nest turns by where
 * they branched from. The active path and current turn are marked.
 */
export function buildTurnTree(entries: SessionEntry[]): TurnNode[] {
  const { nodes, byId, head } = linkNodes(entries);
  const children = new Map<string | null, NodeEntry[]>();
  for (const n of nodes) {
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }
  const onPath = new Set(pathTo(head, byId).map((n) => n.id));

  const turns = new Map<string, TurnNode>();
  for (const n of nodes) {
    const kind = turnKind(n);
    if (!kind) continue;
    // follow the reply chain (non-turn children) to the end of the turn
    let end = n;
    let size = 1;
    for (;;) {
      const next = (children.get(end.id) ?? []).filter((c) => !turnKind(c));
      if (!next.length) break;
      end = next.find((c) => onPath.has(c.id)) ?? next.at(-1)!;
      size++;
    }
    const text = kind === 'compaction' ? (n as Extract<NodeEntry, { type: 'compaction' }>).summary : firstUserText((n as Extract<NodeEntry, { type: 'message' }>).message);
    const fullText =
      n.type === 'message'
        ? n.message.content
            .filter((b) => b.type === 'text' && !b.text.startsWith('<wisp-note>'))
            .map((b) => (b as { text: string }).text)
            .join('\n')
        : text;
    const label =
      kind === 'compaction' ? '⟳ compacted conversation' : kind === 'shell' ? '$ ' + (/^I ran a shell command:\s*\$ (.*)/.exec(text)?.[1] ?? text) : text;
    turns.set(n.id, { id: n.id, kind, label, text: fullText, ts: n.ts, endId: end.id, parentId: n.parent, size, onPath: onPath.has(n.id), current: false, children: [] });
  }

  const roots: TurnNode[] = [];
  for (const t of turns.values()) {
    // nearest ancestor that starts a turn
    let p = t.parentId;
    while (p && !turns.has(p)) p = byId.get(p)?.parent ?? null;
    if (p) turns.get(p)!.children.push(t);
    else roots.push(t);
  }
  const lastOnPath = [...turns.values()].filter((t) => t.onPath).at(-1);
  if (lastOnPath) lastOnPath.current = true;
  return roots;
}

/** Number of branch points (turns with more than one continuation). */
export function countBranches(roots: TurnNode[]): number {
  let n = 0;
  const walk = (t: TurnNode) => {
    if (t.children.length > 1) n += t.children.length - 1;
    t.children.forEach(walk);
  };
  roots.forEach(walk);
  return n + Math.max(0, roots.length - 1);
}

// --- listing & forking ------------------------------------------------------------

/** Sessions for a directory (or all), newest first. */
export function listSessions(cwd: string | null): SessionInfo[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const dirs = cwd ? [join(SESSIONS_DIR, cwdSlug(cwd))] : readdirSync(SESSIONS_DIR).map((d) => join(SESSIONS_DIR, d));
  const out: SessionInfo[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      try {
        const entries = readEntries(path);
        const header = entries[0];
        if (header?.type !== 'header') continue;
        const msgs = entries.filter((e) => e.type === 'message') as Extract<SessionEntry, { type: 'message' }>[];
        const first = msgs.find((e) => e.message.role === 'user' && firstUserText(e.message));
        const name = [...entries].reverse().find((e) => e.type === 'name') as { name: string } | undefined;
        out.push({
          path,
          id: header.id,
          cwd: header.cwd,
          name: name?.name,
          firstMessage: first ? firstUserText(first.message) : '(no messages)',
          messageCount: msgs.length,
          modified: statSync(path).mtime,
        });
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Find a session by path, full id or id prefix. */
export function findSession(ref: string, cwd: string): SessionInfo | null {
  if (existsSync(ref) && ref.endsWith('.jsonl')) {
    return listSessions(null).find((s) => s.path === ref) ?? { path: ref, id: basename(ref), cwd, firstMessage: '', messageCount: 0, modified: new Date() };
  }
  const all = listSessions(null);
  const local = all.filter((s) => s.cwd === cwd);
  return local.find((s) => s.id.startsWith(ref)) ?? all.find((s) => s.id.startsWith(ref)) ?? null;
}

/**
 * Copy the active branch into a new session — the whole branch, or only what
 * came before node `beforeId`. Other branches are left behind.
 */
export function forkSession(entries: SessionEntry[], cwd: string, persist: boolean, beforeId?: string | null): Session {
  const header = entries.find((e) => e.type === 'header') as Extract<SessionEntry, { type: 'header' }> | undefined;
  const fork = Session.create(cwd, { persist, forkedFrom: header?.id });
  const { byId, head } = linkNodes(entries);
  let path = pathTo(head, byId);
  if (beforeId !== undefined) {
    const cut = path.findIndex((n) => n.id === beforeId);
    if (cut >= 0) path = path.slice(0, cut);
  }
  const name = [...entries].reverse().find((e) => e.type === 'name');
  const model = [...entries].reverse().find((e) => e.type === 'model');
  if (name) fork.append(name);
  if (model) fork.append(model);
  for (const n of path) fork.append({ ...n, id: undefined, parent: undefined } as SessionEntry);
  return fork;
}

/** Record what the agent did (messages, usage, compactions). Shared by the TUI and print mode. */
export function logAgentEvent(session: Session, agent: { usage: import('./types.js').Usage; costUSD: number; contextUsed: number }, e: { type: string; message?: Message; summary?: string; tokensBefore?: number }) {
  if (e.type === 'message' && e.message) {
    session.log({ type: 'message', message: e.message });
    if (e.message.role === 'assistant') session.log({ type: 'usage', usage: agent.usage, costUSD: agent.costUSD, contextUsed: agent.contextUsed });
  } else if (e.type === 'compaction_end') {
    session.log({ type: 'compaction', summary: e.summary!, tokensBefore: e.tokensBefore! });
    session.log({ type: 'usage', usage: agent.usage, costUSD: agent.costUSD, contextUsed: 0 });
  }
}
