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
 * Append-only matters: providers (notably Anthropic) bind reasoning blocks to
 * the exact history that produced them, so we never rewrite earlier turns.
 */
export type SessionEntry =
  | { type: 'header'; version: 1; id: string; cwd: string; created: string; forkedFrom?: string }
  | { type: 'message'; ts: string; message: Message }
  | { type: 'compaction'; ts: string; summary: string; tokensBefore: number }
  | { type: 'name'; ts: string; name: string }
  | { type: 'model'; ts: string; provider: string; model: string; thinking: ThinkingLevel }
  | { type: 'usage'; ts: string; usage: Usage; costUSD: number; contextUsed: number };

export const SESSIONS_DIR = process.env.WISP_SESSION_DIR || join(AGENT_DIR, 'sessions');

export const cwdSlug = (cwd: string) => cwd.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'root';

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: Date;
}

export class Session {
  readonly id: string;
  readonly path: string | null;
  name?: string;
  /** Everything appended so far (also for in-memory sessions). */
  entries: SessionEntry[] = [];
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
    const header: SessionEntry = { type: 'header', version: 1, id, cwd, created: new Date().toISOString(), forkedFrom: opts.forkedFrom };
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
    for (const e of entries) if (e.type === 'name') s.name = e.name;
    return { session: s, entries };
  }

  append(entry: SessionEntry) {
    if (entry.type === 'name') this.name = entry.name;
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

/** Rebuild the conversation from entries (compaction replaces everything before it). */
export function restore(entries: SessionEntry[]): RestoredState {
  const state: RestoredState = { messages: [], usage: emptyUsage(), costUSD: 0, contextUsed: 0 };
  for (const e of entries) {
    if (e.type === 'message') state.messages.push(e.message);
    else if (e.type === 'compaction') {
      state.messages = [compactionMessage(e.summary)];
      state.contextUsed = 0;
    } else if (e.type === 'usage') {
      state.usage = e.usage;
      state.costUSD = e.costUSD;
      state.contextUsed = e.contextUsed;
    } else if (e.type === 'model') state.model = { provider: e.provider, model: e.model, thinking: e.thinking };
  }
  return state;
}

export function firstUserText(m: Message | undefined): string {
  if (!m || m.role !== 'user') return '';
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
 * Copy a session up to (not including) the `messageIndex`-th message entry into
 * a new session: a branch point to explore a different direction.
 */
export function forkSession(entries: SessionEntry[], cwd: string, messageIndex: number, persist: boolean): Session {
  const header = entries.find((e) => e.type === 'header') as Extract<SessionEntry, { type: 'header' }> | undefined;
  const fork = Session.create(cwd, { persist, forkedFrom: header?.id });
  let seen = 0;
  for (const e of entries) {
    if (e.type === 'header') continue;
    if (e.type === 'message') {
      if (seen === messageIndex) break;
      seen++;
    }
    fork.append(e);
  }
  return fork;
}
