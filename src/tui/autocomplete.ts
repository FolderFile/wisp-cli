import { readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { listFiles } from '../tools/search.js';
import type { Editor } from './editor.js';
import { fuzzyFilter } from './fuzzy.js';
import { padEnd, truncate } from './text.js';
import { theme } from './theme.js';

export interface CommandInfo {
  name: string;
  description: string;
}

interface Suggestion {
  /** Text inserted in place of the token. */
  insert: string;
  label: string;
  detail?: string;
}

/** Keeps a cached list of project files (git-aware) for @mentions. */
export class FileIndex {
  private files: string[] = [];
  private dirs: string[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private cwd: string) {}

  refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = listFiles(this.cwd)
      .then((abs) => {
        const rel = abs.map((f) => relative(this.cwd, f)).filter((f) => !f.startsWith('..'));
        const dirs = new Set<string>();
        for (const f of rel) for (let d = dirname(f); d !== '.' && !dirs.has(d); d = dirname(d)) dirs.add(d);
        this.files = rel;
        this.dirs = [...dirs].map((d) => d + '/');
        this.loadedAt = Date.now();
      })
      .catch(() => {})
      .finally(() => (this.loading = null));
    return this.loading;
  }

  get entries(): string[] {
    if (Date.now() - this.loadedAt > 15_000) void this.refresh();
    return [...this.dirs, ...this.files];
  }
}

/**
 * Popup suggestions under the editor: /commands at the start of the input,
 * @file mentions anywhere, and Tab path completion.
 */
export class Autocomplete {
  items: Suggestion[] = [];
  index = 0;
  private tokenLen = 0;
  private kind: 'command' | 'file' | 'path' | null = null;
  /** Set when the user pressed Esc, until the token changes. */
  private dismissedFor: string | null = null;

  constructor(
    private cwd: string,
    private files: FileIndex,
    private commands: () => CommandInfo[],
  ) {}

  get open() {
    return this.items.length > 0;
  }

  close() {
    this.items = [];
    this.kind = null;
  }

  dismiss(editor: Editor) {
    this.dismissedFor = editor.beforeCursor;
    this.close();
  }

  /** Recompute suggestions from the text before the cursor. */
  update(editor: Editor) {
    const before = editor.beforeCursor;
    if (this.dismissedFor !== null && before === this.dismissedFor) return this.close();
    this.dismissedFor = null;

    const cmd = editor.row === 0 && /^\/([\w:-]*)$/.exec(before);
    if (cmd) {
      const q = cmd[1];
      const list = this.commands();
      const matches = q ? fuzzyFilter(q, list, (c) => c.name, 30) : list;
      this.set('command', before.length, matches.map((c) => ({ insert: `/${c.name} `, label: `/${c.name}`, detail: c.description })));
      return;
    }
    const at = /(?:^|\s)@("[^"]*|[^\s]*)$/.exec(before);
    if (at) {
      const q = at[1].replace(/^"/, '');
      const matches = fuzzyFilter(q, this.files.entries, (f) => f, 30);
      this.set('file', at[1].length + 1, matches.map((f) => ({ insert: '@' + (f.includes(' ') ? `"${f}"` : f) + (f.endsWith('/') ? '' : ' '), label: f })));
      return;
    }
    if (this.kind === 'path') return; // keep Tab results until the user types
    this.close();
  }

  private set(kind: Autocomplete['kind'], tokenLen: number, items: Suggestion[]) {
    this.kind = kind;
    this.tokenLen = tokenLen;
    this.items = items;
    this.index = Math.min(this.index, Math.max(0, items.length - 1));
    if (!items.length) this.kind = null;
  }

  /** Tab with no popup: complete a filesystem path. Returns true if it did something. */
  completePath(editor: Editor): boolean {
    const token = /(\S*)$/.exec(editor.beforeCursor)?.[1] ?? '';
    const slash = token.lastIndexOf('/');
    const dirPart = slash >= 0 ? token.slice(0, slash + 1) : ''; // as typed: "src/", "~/x/"
    const prefix = token.slice(slash + 1);
    const home = process.env.HOME ?? '';
    const dirAbs = dirPart.startsWith('~/')
      ? join(home, dirPart.slice(2))
      : isAbsolute(dirPart)
        ? dirPart
        : join(this.cwd, dirPart || '.');
    let names: string[];
    try {
      names = readdirSync(dirAbs);
    } catch {
      return false;
    }
    const matches = names.filter((n) => n.startsWith(prefix) && (prefix.startsWith('.') || !n.startsWith('.'))).sort();
    if (!matches.length) return false;
    const display = (n: string) => {
      try {
        return statSync(join(dirAbs, n)).isDirectory() ? n + '/' : n;
      } catch {
        return n;
      }
    };
    if (matches.length === 1) {
      editor.replaceBeforeCursor(token.length, dirPart + display(matches[0]));
      return true;
    }
    // extend to the longest common prefix, then offer the choices
    let common = matches[0];
    for (const n of matches) while (!n.startsWith(common)) common = common.slice(0, -1);
    const typed = dirPart + (common.length > prefix.length ? common : prefix);
    if (typed !== token) editor.replaceBeforeCursor(token.length, typed);
    this.set('path', typed.length, matches.slice(0, 50).map((n) => ({ insert: dirPart + display(n), label: display(n) })));
    return true;
  }

  move(d: 1 | -1) {
    if (!this.items.length) return;
    this.index = (this.index + d + this.items.length) % this.items.length;
  }

  /** Insert the selected suggestion. Returns the inserted text. */
  accept(editor: Editor): string | null {
    const s = this.items[this.index];
    if (!s) return null;
    editor.replaceBeforeCursor(this.tokenLen, s.insert);
    const kind = this.kind;
    this.close();
    this.index = 0;
    // a directory mention keeps the popup open to drill down
    if (kind === 'file' && s.insert.endsWith('/')) this.update(editor);
    return s.insert;
  }

  render(width: number, maxRows = 8): string[] {
    if (!this.items.length) return [];
    const start = Math.max(0, Math.min(this.index - Math.floor(maxRows / 2), this.items.length - maxRows));
    const visible = this.items.slice(start, start + maxRows);
    const labelW = Math.min(Math.max(...visible.map((s) => s.label.length)), Math.floor(width * 0.45));
    const rows = visible.map((s, i) => {
      const active = start + i === this.index;
      const label = padEnd(truncate(s.label, labelW), labelW);
      const detail = s.detail ? '  ' + theme.dim(truncate(s.detail, Math.max(4, width - labelW - 6))) : '';
      return truncate(`${active ? theme.accent('› ') + theme.bold(label) : '  ' + label}${detail}`, width);
    });
    if (this.items.length > maxRows) rows.push(theme.dim(`  ${this.index + 1}/${this.items.length} · tab/enter to insert`));
    return rows;
  }
}
