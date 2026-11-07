import type { Terminal } from './terminal.js';
import { stringWidth, truncate } from './text.js';
import { theme } from './theme.js';

const FRAME_MS = 16;

/**
 * Fullscreen renderer for the alternate screen. The transcript fills a
 * scrollable viewport; the bottom area (status, editor, footer) is pinned.
 * Each frame is diffed against the previous one row by row, so only changed
 * rows are rewritten.
 */
export class FullScreen {
  private prev: string[] = [];
  private transcript: string[] = [];
  private source: () => string[] = () => [];
  private bottom: string[] = [];
  private cursor: { row: number; col: number } | null = null;
  private scheduled = false;
  private lastFlush = 0;
  /** First transcript line shown; null = follow the end. */
  private scrollTop: number | null = null;
  private lastTop = 0;
  private lastMaxTop = 0;
  private viewH = 0;

  constructor(private term: Terminal) {}

  get width() {
    return this.term.columns;
  }

  get height() {
    return this.term.rows;
  }

  get following() {
    return this.scrollTop === null;
  }

  /** Lines below the viewport when scrolled up. */
  get hiddenBelow() {
    return this.scrollTop === null ? 0 : Math.max(0, this.transcript.length - (this.lastTop + this.viewH));
  }

  /** `transcript` is evaluated lazily, once per frame actually drawn. */
  draw(transcript: () => string[], bottom: string[], cursor: { row: number; col: number } | null) {
    this.source = transcript;
    this.bottom = bottom;
    this.cursor = cursor;
    this.schedule();
  }

  scrollBy(lines: number) {
    const top = (this.scrollTop ?? this.lastMaxTop) + lines;
    this.scrollTop = top >= this.lastMaxTop ? null : Math.max(0, top);
    this.schedule();
  }

  page(dir: 1 | -1) {
    this.scrollBy(dir * Math.max(1, this.viewH - 2));
  }

  toBottom() {
    this.scrollTop = null;
    this.schedule();
  }

  toTop() {
    this.scrollTop = 0;
    this.schedule();
  }

  resized() {
    this.prev = [];
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    // coalesce bursts (streaming deltas) into at most ~60 frames per second
    const wait = Math.max(0, FRAME_MS - (Date.now() - this.lastFlush));
    setTimeout(() => {
      this.scheduled = false;
      this.flush();
    }, wait);
  }

  flush() {
    this.lastFlush = Date.now();
    this.transcript = this.source();
    const rows = this.height;
    const w = this.width;
    let bottom = this.bottom;
    let cursor = this.cursor;
    // the bottom area may take at most all but 3 rows
    const maxBottom = Math.max(1, rows - 3);
    if (bottom.length > maxBottom) {
      const drop = bottom.length - maxBottom;
      bottom = bottom.slice(drop);
      if (cursor) cursor = cursor.row >= drop ? { row: cursor.row - drop, col: cursor.col } : null;
    }
    const viewH = rows - bottom.length;
    this.viewH = viewH;
    const total = this.transcript.length;
    const maxTop = Math.max(0, total - viewH);
    if (this.scrollTop !== null && this.scrollTop >= maxTop) this.scrollTop = null;
    const top = this.scrollTop ?? maxTop;
    this.lastTop = top;
    this.lastMaxTop = maxTop;

    const view = this.transcript.slice(top, top + viewH);
    while (view.length < viewH) view.push('');
    const below = total - (top + viewH);
    if (this.scrollTop !== null && below > 0 && viewH > 0) {
      const label = ` ↓ ${below} more line${below === 1 ? '' : 's'} · scroll, PgDn or End to return `;
      const side = Math.max(0, Math.floor((w - stringWidth(label)) / 2));
      view[viewH - 1] = theme.border('─'.repeat(side)) + theme.accent(label) + theme.border('─'.repeat(Math.max(0, w - side - stringWidth(label))));
    }

    const frame = [...view, ...bottom];
    let out = '\x1b[?2026h\x1b[?25l';
    for (let i = 0; i < rows; i++) {
      const line = frame[i] ?? '';
      if (this.prev[i] === line) continue;
      const fitted = stringWidth(line) > w ? truncate(line, w) : line;
      // clear first, then write: never erase after a full-width line (that would eat its last column)
      out += `\x1b[${i + 1};1H\x1b[2K${fitted}\x1b[0m`;
    }
    this.prev = frame.slice(0, rows);
    if (cursor) out += `\x1b[${viewH + cursor.row + 1};${Math.min(w, cursor.col + 1)}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.term.write(out);
  }

  close() {
    this.term.write('\x1b[?25h');
  }
}
