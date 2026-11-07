import type { Key } from './keys.js';
import { graphemes, stringWidth } from './text.js';
import { theme } from './theme.js';

const LARGE_PASTE_LINES = 8;
const LARGE_PASTE_CHARS = 800;
const PASTE_TOKEN = /\[Pasted #(\d+) (?:\+\d+ lines|\d+ chars)\]/g;

type Snapshot = { lines: string[]; row: number; col: number };

/**
 * Multi-line prompt editor with readline/emacs keys, prompt history, undo,
 * a kill ring, and collapsed large pastes.
 */
export class Editor {
  lines: string[] = [''];
  row = 0;
  col = 0; // string index within lines[row], always on a grapheme boundary
  private history: string[] = [];
  private histIdx = -1; // -1 = editing a fresh draft
  private draft = '';
  private pastes = new Map<number, string>();
  private pasteSeq = 0;
  private undoStack: Snapshot[] = [];
  private lastOp: 'insert' | 'other' = 'other';
  private killed = '';
  /** Called whenever the text changes (for autocomplete). */
  onChange: () => void = () => {};

  setHistory(h: string[]) {
    this.history = h;
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === '';
  }

  /** Text with paste placeholders expanded back to their content. */
  expandedText(): string {
    return this.text.replace(PASTE_TOKEN, (m, n) => this.pastes.get(Number(n)) ?? m);
  }

  setText(s: string, opts: { keepPastes?: boolean } = {}) {
    this.snapshot();
    this.lines = s.split('\n');
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    if (!opts.keepPastes) this.pastes.clear();
    this.onChange();
  }

  clear() {
    this.setText('');
    this.histIdx = -1;
    this.undoStack = [];
  }

  /** Text before the cursor on the current line (autocomplete looks at this). */
  get beforeCursor(): string {
    return this.lines[this.row].slice(0, this.col);
  }

  /** Replace `len` characters before the cursor with `text`. */
  replaceBeforeCursor(len: number, text: string) {
    this.snapshot();
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col - len) + text + line.slice(this.col);
    this.col = this.col - len + text.length;
    this.onChange();
  }

  insert(text: string) {
    if (this.lastOp !== 'insert' || /\s/.test(text)) this.snapshot();
    this.lastOp = 'insert';
    const parts = text.split('\n');
    const line = this.lines[this.row];
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    if (parts.length === 1) {
      this.lines[this.row] = before + text + after;
      this.col += text.length;
    } else {
      const newLines = [before + parts[0], ...parts.slice(1, -1), parts.at(-1)! + after];
      this.lines.splice(this.row, 1, ...newLines);
      this.row += parts.length - 1;
      this.col = parts.at(-1)!.length;
    }
    this.onChange();
  }

  paste(text: string) {
    const t = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    const lineCount = t.split('\n').length;
    if (lineCount > LARGE_PASTE_LINES || t.length > LARGE_PASTE_CHARS) {
      const n = ++this.pasteSeq;
      this.pastes.set(n, t);
      this.snapshot();
      this.lastOp = 'other';
      this.insert(lineCount > 1 ? `[Pasted #${n} +${lineCount} lines]` : `[Pasted #${n} ${t.length} chars]`);
    } else {
      this.snapshot();
      this.lastOp = 'other';
      this.insert(t);
    }
  }

  private snapshot() {
    this.undoStack.push({ lines: [...this.lines], row: this.row, col: this.col });
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.lines = s.lines;
    this.row = s.row;
    this.col = s.col;
    this.lastOp = 'other';
    this.onChange();
  }

  addToHistory(entry: string) {
    if (!entry.trim()) return;
    if (this.history.at(-1) !== entry) this.history.push(entry);
    this.histIdx = -1;
  }

  // --- key handling -----------------------------------------------------------

  /** Returns false if the key isn't an editing key (so the app can handle it). */
  handleKey(k: Key): boolean {
    const id = `${k.ctrl ? 'C-' : ''}${k.alt ? 'M-' : ''}${k.name}`;
    const edit = (fn: () => void) => {
      this.snapshot();
      this.lastOp = 'other';
      fn();
      this.onChange();
      return true;
    };
    switch (id) {
      case 'left':
      case 'C-b':
        return this.move(this.prevBoundary());
      case 'right':
      case 'C-f':
        return this.move(this.nextBoundary());
      case 'C-left':
      case 'M-left':
      case 'M-b':
        return this.move(this.wordLeft());
      case 'C-right':
      case 'M-right':
      case 'M-f':
        return this.move(this.wordRight());
      case 'home':
      case 'C-a':
        return this.move(0);
      case 'end':
      case 'C-e':
        return this.move(this.lines[this.row].length);
      case 'up':
        return this.vertical(-1);
      case 'down':
        return this.vertical(1);
      case 'C-home':
        this.row = 0;
        return this.move(0);
      case 'C-end':
        this.row = this.lines.length - 1;
        return this.move(this.lines[this.row].length);
      case 'backspace':
      case 'C-h':
        if (this.col > 0) return edit(() => this.deleteRange(this.prevBoundary(), this.col));
        if (this.row > 0)
          return edit(() => {
            const prev = this.lines[this.row - 1];
            this.lines[this.row - 1] = prev + this.lines[this.row];
            this.lines.splice(this.row, 1);
            this.row--;
            this.col = prev.length;
          });
        return true;
      case 'delete':
      case 'C-d':
        if (this.col < this.lines[this.row].length) return edit(() => this.deleteRange(this.col, this.nextBoundary()));
        if (this.row < this.lines.length - 1)
          return edit(() => {
            this.lines[this.row] += this.lines[this.row + 1];
            this.lines.splice(this.row + 1, 1);
          });
        return true;
      case 'C-w':
      case 'M-backspace':
        return edit(() => this.kill(this.wordLeft(), this.col));
      case 'M-d':
      case 'M-delete':
      case 'C-delete':
        return edit(() => this.kill(this.col, this.wordRight()));
      case 'C-u':
        return edit(() => this.kill(0, this.col));
      case 'C-k':
        return edit(() => {
          if (this.col === this.lines[this.row].length && this.row < this.lines.length - 1) {
            this.lines[this.row] += this.lines[this.row + 1];
            this.lines.splice(this.row + 1, 1);
          } else this.kill(this.col, this.lines[this.row].length);
        });
      case 'C-y':
        if (this.killed) this.insert(this.killed);
        return true;
      case 'C--':
        this.undo();
        return true;
      case 'C-j':
      case 'M-enter':
        this.insert('\n');
        return true;
      case 'tab':
        if (k.shift) return false;
        return false; // the app decides (completion)
    }
    if (k.name === 'enter' && k.shift) {
      this.insert('\n');
      return true;
    }
    if (k.text && !k.ctrl && !k.alt) {
      this.insert(k.text);
      return true;
    }
    if (k.name === 'space' && !k.ctrl && !k.alt) {
      this.insert(' ');
      return true;
    }
    return false;
  }

  private move(col: number) {
    this.col = Math.max(0, Math.min(col, this.lines[this.row].length));
    this.lastOp = 'other';
    this.onChange();
    return true;
  }

  private vertical(dir: -1 | 1): boolean {
    const target = this.row + dir;
    if (target >= 0 && target < this.lines.length) {
      const visualCol = stringWidth(this.lines[this.row].slice(0, this.col));
      this.row = target;
      this.col = this.colForWidth(this.lines[target], visualCol);
      this.onChange();
      return true;
    }
    // past the first/last line: walk history
    if (!this.history.length) return true;
    if (dir === -1) {
      if (this.histIdx === -1) {
        this.draft = this.text;
        this.histIdx = this.history.length - 1;
      } else if (this.histIdx > 0) this.histIdx--;
      else return true;
      this.loadHistory(this.history[this.histIdx], 'end');
    } else {
      if (this.histIdx === -1) return true;
      if (this.histIdx < this.history.length - 1) {
        this.histIdx++;
        this.loadHistory(this.history[this.histIdx], 'start');
      } else {
        this.histIdx = -1;
        this.loadHistory(this.draft, 'start');
      }
    }
    return true;
  }

  private loadHistory(text: string, at: 'start' | 'end') {
    this.lines = text.split('\n');
    this.row = at === 'end' ? 0 : this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.onChange();
  }

  private colForWidth(line: string, width: number): number {
    let w = 0;
    let i = 0;
    for (const g of graphemes(line)) {
      const gw = stringWidth(g);
      if (w + gw > width) break;
      w += gw;
      i += g.length;
    }
    return i;
  }

  private prevBoundary(): number {
    const before = graphemes(this.lines[this.row].slice(0, this.col));
    return this.col - (before.at(-1)?.length ?? 0);
  }

  private nextBoundary(): number {
    const after = graphemes(this.lines[this.row].slice(this.col));
    return this.col + (after[0]?.length ?? 0);
  }

  private wordLeft(): number {
    const before = this.lines[this.row].slice(0, this.col);
    const m = /(\w+|[^\w\s]+)\s*$/.exec(before);
    return m ? m.index : 0;
  }

  private wordRight(): number {
    const after = this.lines[this.row].slice(this.col);
    const m = /^\s*(\w+|[^\w\s]+)/.exec(after);
    return this.col + (m ? m[0].length : after.length);
  }

  private deleteRange(from: number, to: number) {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, from) + line.slice(to);
    this.col = from;
  }

  private kill(from: number, to: number) {
    this.killed = this.lines[this.row].slice(from, to) || this.killed;
    this.deleteRange(from, to);
  }

  // --- rendering --------------------------------------------------------------

  /**
   * Render into rows of at most `width` columns. Returns the rows and where the
   * cursor is. `maxRows` scrolls the view to keep the cursor visible.
   */
  render(width: number, maxRows: number, prompt: string, cont = '  '): { lines: string[]; cursor: { row: number; col: number } } {
    const pw = stringWidth(prompt);
    const w = Math.max(4, width - pw - 1);
    const rows: string[] = [];
    let cursor = { row: 0, col: pw };
    this.lines.forEach((line, li) => {
      const segs = segment(line, w);
      segs.forEach((seg, si) => {
        if (li === this.row && this.col >= seg.start && (this.col < seg.end || si === segs.length - 1)) {
          cursor = { row: rows.length, col: pw + stringWidth(line.slice(seg.start, this.col)) };
        }
        const pre = li === 0 && si === 0 ? prompt : cont.padEnd(pw);
        rows.push(pre + highlightTokens(line.slice(seg.start, seg.end)));
      });
    });
    if (rows.length <= maxRows) return { lines: rows, cursor };
    const top = Math.min(Math.max(0, cursor.row - maxRows + 1), rows.length - maxRows);
    return { lines: rows.slice(top, top + maxRows), cursor: { row: cursor.row - top, col: cursor.col } };
  }
}

/** Split a line into segments that fit `w` columns (hard wrap on graphemes). */
function segment(line: string, w: number): { start: number; end: number }[] {
  const segs: { start: number; end: number }[] = [];
  let start = 0;
  let width = 0;
  let i = 0;
  for (const g of graphemes(line)) {
    const gw = stringWidth(g);
    if (width + gw > w) {
      segs.push({ start, end: i });
      start = i;
      width = 0;
    }
    width += gw;
    i += g.length;
  }
  segs.push({ start, end: line.length });
  // cursor at the end of an exactly-full last segment needs its own row
  if (width >= w) segs.push({ start: line.length, end: line.length });
  return segs;
}

function highlightTokens(s: string): string {
  return s
    .replace(PASTE_TOKEN, (m) => theme.accent2(m))
    .replace(/(^|\s)(@[^\s]+)/g, (_, pre, at) => pre + theme.accent(at));
}
