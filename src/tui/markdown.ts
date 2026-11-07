import { highlight } from './highlight.js';
import { stringWidth, stripAnsi, wrap } from './text.js';
import { theme } from './theme.js';

/** Inline markdown: **bold**, *italic*, `code`, ~~strike~~, [text](url), bare URLs. */
export function inline(s: string): string {
  const codes: string[] = [];
  // protect code spans first so their contents aren't formatted
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(theme.code(c));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, (_, t) => theme.bold(theme.italic(t)))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => theme.bold(t))
    .replace(/__([^_\n]+)__/g, (_, t) => theme.bold(t))
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (_, pre, t) => pre + theme.italic(t))
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, (_, pre, t) => pre + theme.italic(t))
    .replace(/~~([^~\n]+)~~/g, (_, t) => `\x1b[9m${t}\x1b[29m`)
    .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, url) => (t === url ? theme.link(url) : `${theme.link(t)} ${theme.dim(`(${url})`)}`));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

/**
 * Streaming markdown → terminal lines. Feed deltas with `push`; complete
 * lines become available via `take()` to commit to scrollback, while `preview()`
 * renders the unfinished tail (current line, open code block, pending table).
 */
export class MarkdownStream {
  private buf = '';
  private out: string[] = [];
  private fence: { marker: string; lang: string; lines: string[]; indent: string } | null = null;
  private table: string[] | null = null;
  private lastBlank = true;
  private inList = false;

  constructor(private width: () => number, private prefix = '') {}

  push(delta: string) {
    this.buf += delta;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
  }

  /** Finish: process the partial line and close any open block. */
  end() {
    if (this.buf) this.line(this.buf);
    this.buf = '';
    if (this.fence) this.emitFence();
    if (this.table) this.emitTable();
    // drop trailing blank lines
    const bare = stripAnsi(this.prefix).trim();
    const isBlank = (l: string) => {
      const t = stripAnsi(l).trim();
      return t === '' || t === bare;
    };
    while (this.out.length && isBlank(this.out.at(-1)!)) this.out.pop();
  }

  /** Rendered lines ready to commit. */
  take(): string[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  /** Render what isn't committable yet (for the live region). */
  preview(maxLines = 12): string[] {
    const w = this.width() - this.prefix.length;
    const lines: string[] = [];
    if (this.fence) {
      const body = this.fence.lines.slice(-maxLines).map((l) => theme.border('│ ') + theme.code(l));
      lines.push(theme.border(`╭─ ${this.fence.lang || 'code'}`), ...body);
      if (this.buf) lines.push(theme.border('│ ') + theme.code(this.buf));
    } else if (this.table) {
      lines.push(...this.table.slice(-maxLines).map((l) => theme.dim(l)));
      if (this.buf) lines.push(theme.dim(this.buf));
    } else if (this.buf) {
      lines.push(...this.render(this.buf));
    }
    return lines.flatMap((l) => wrap(l, w)).map((l) => this.prefix + l);
  }

  private emit(lines: string[]) {
    const w = this.width() - this.prefix.length;
    for (const l of lines) this.out.push(...wrap(l, w).map((x) => this.prefix + x));
  }

  private line(raw: string) {
    // inside a code fence
    if (this.fence) {
      const close = raw.trim();
      if (close.startsWith(this.fence.marker) && close.replace(/[`~]/g, '') === '') return this.emitFence();
      this.fence.lines.push(raw.startsWith(this.fence.indent) ? raw.slice(this.fence.indent.length) : raw);
      return;
    }
    const open = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(raw);
    if (open) {
      if (this.table) this.emitTable();
      this.fence = { marker: open[2], lang: open[3], lines: [], indent: open[1] };
      return;
    }
    if (isTableRow(raw) || (this.table && isTableSep(raw))) {
      (this.table ??= []).push(raw);
      return;
    }
    if (this.table) this.emitTable();

    const blank = raw.trim() === '';
    if (blank) {
      if (!this.lastBlank) this.emit(['']);
      this.lastBlank = true;
      this.inList = false;
      return;
    }
    this.lastBlank = false;
    this.emitRendered(raw);
  }

  private emitRendered(raw: string) {
    const w = this.width() - this.prefix.length;
    const list = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw);
    if (list) {
      this.inList = true;
      const depth = Math.floor(list[1].replace(/\t/g, '  ').length / 2);
      const indent = '  '.repeat(depth);
      let bullet = /\d/.test(list[2]) ? list[2] : ['•', '◦', '▪'][depth % 3];
      if (list[3]) bullet = list[3].toLowerCase().includes('x') ? theme.success('☑') : '☐';
      const head = `${indent}${theme.accent(bullet)} `;
      const hang = ' '.repeat(stringWidth(indent) + stringWidth(stripAnsi(bullet)) + 1);
      this.out.push(...wrap(head + inline(list[4]), w, { indent: hang }).map((x) => this.prefix + x));
      return;
    }
    this.emit(this.render(raw));
  }

  private render(raw: string): string[] {
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(raw);
    if (h) {
      const text = inline(h[2]);
      return [h[1].length <= 2 ? theme.heading(text) : theme.bold(text)];
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return [theme.border('─'.repeat(Math.min(40, this.width() - this.prefix.length)))];
    const q = /^\s*>\s?(.*)$/.exec(raw);
    if (q) return [theme.border('│ ') + theme.italic(inline(q[1]))];
    return [inline(raw)];
  }

  private emitFence() {
    const f = this.fence!;
    this.fence = null;
    const lang = f.lang;
    const code = f.lines.join('\n');
    const highlighted = lang === 'diff' ? f.lines.map(colorDiffLine) : highlight(code, lang || undefined);
    const w = this.width() - this.prefix.length;
    const out: string[] = [theme.border(`╭─ ${lang || 'code'}`)];
    for (const l of highlighted) for (const part of wrap(l, w - 2)) out.push(theme.border('│ ') + part);
    out.push(theme.border('╰─'));
    for (const l of out) this.out.push(this.prefix + l);
    this.lastBlank = false;
  }

  private emitTable() {
    const rows = this.table!;
    this.table = null;
    const cells = rows.filter((r) => !isTableSep(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
    const cols = Math.max(...cells.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...cells.map((r) => stringWidth(r[i] ?? ''))));
    const avail = this.width() - this.prefix.length - (cols * 3 + 1);
    // If it doesn't fit, fall back to "key: value" style rows.
    if (widths.reduce((a, b) => a + b, 0) > avail) {
      const header = cells[0];
      for (const r of cells.slice(1)) {
        this.emit(r.map((c, i) => `${theme.bold(header[i] ?? '')}: ${c}`));
        this.emit(['']);
      }
      return;
    }
    const line = (l: string, m: string, r: string) => theme.border(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
    const row = (r: string[]) =>
      theme.border('│') + widths.map((w, i) => ` ${(r[i] ?? '') + ' '.repeat(w - stringWidth(r[i] ?? ''))} `).join(theme.border('│')) + theme.border('│');
    const out = [line('┌', '┬', '┐'), row(cells[0].map((c) => theme.bold(c))), line('├', '┼', '┤'), ...cells.slice(1).map(row), line('└', '┴', '┘')];
    for (const l of out) this.out.push(this.prefix + l);
  }
}

function colorDiffLine(l: string): string {
  if (l.startsWith('+')) return theme.success(l);
  if (l.startsWith('-')) return theme.error(l);
  if (l.startsWith('@@')) return theme.accent2(l);
  return l;
}

/** Render a complete markdown string at once (used when replaying sessions). */
export function renderMarkdown(text: string, width: number, prefix = ''): string[] {
  const md = new MarkdownStream(() => width, prefix);
  md.push(text);
  md.end();
  return md.take();
}
