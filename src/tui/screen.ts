import type { Terminal } from './terminal.js';
import { stringWidth, wrap } from './text.js';

/**
 * Inline renderer. Finished output is written once into the terminal's normal
 * scrollback (so native scrolling, search and copy keep working); a small live
 * region at the bottom (streaming text, running tools, editor, footer) is
 * redrawn in place. Every line handed to us is pre-wrapped to the terminal
 * width, so we always know exactly how many rows the live region occupies.
 */
export class Screen {
  private liveRows = 0; // rows the live region currently occupies
  private cursorRow = 0; // row (within live region) where the cursor sits
  private pendingCommit: string[] = [];
  private live: string[] = [];
  private cursor: { row: number; col: number } | null = null;
  private lastFrame = '';
  private scheduled = false;
  private lastWidth: number;

  constructor(private term: Terminal) {
    this.lastWidth = term.columns;
  }

  get width() {
    return this.term.columns;
  }

  get height() {
    return this.term.rows;
  }

  /** Append lines permanently above the live region. Lines may contain \n and will be wrapped. */
  commit(lines: string | string[]) {
    const arr = Array.isArray(lines) ? lines : [lines];
    for (const l of arr) this.pendingCommit.push(...wrap(l, this.width));
    this.schedule();
  }

  /** Replace the live region. `cursor` positions the real terminal cursor (for the editor). */
  setLive(lines: string[], cursor: { row: number; col: number } | null) {
    this.live = lines;
    this.cursor = cursor;
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /** Width changed: the old live region reflowed, so clear generously. */
  resized() {
    const w = this.width;
    if (w !== this.lastWidth) {
      // Estimate how many rows the old live content occupies after reflow.
      const factor = Math.ceil(this.lastWidth / w);
      this.cursorRow = Math.min(this.height - 1, this.cursorRow * Math.max(1, factor));
      this.lastWidth = w;
    }
    this.lastFrame = '';
    this.schedule();
  }

  flush() {
    const maxLive = Math.max(3, this.height - 1);
    let live = this.live.map((l) => (stringWidth(l) > this.width ? wrap(l, this.width) : [l])).flat();
    let cursor = this.cursor;
    if (live.length > maxLive) {
      // Keep the bottom (editor/footer) visible; drop the top of the live region.
      const drop = live.length - maxLive;
      live = live.slice(drop);
      if (cursor) cursor = { row: Math.max(0, cursor.row - drop), col: cursor.col };
    }
    const frame = live.join('\n') + `|${cursor?.row},${cursor?.col}`;
    if (!this.pendingCommit.length && frame === this.lastFrame) return;

    let out = '\x1b[?2026h\x1b[?25l'; // synchronized update, hide cursor while drawing
    // move to the top of the live region and clear it
    if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
    out += '\r\x1b[J';
    // (no \x1b[K per line: after a full-width line it would erase the last column;
    // the region below was already cleared with \x1b[J)
    for (const l of this.pendingCommit) out += l + '\r\n';
    this.pendingCommit = [];
    out += live.join('\r\n');
    // the cursor is now at the end of the last live line
    let row = live.length - 1;
    if (cursor) {
      const up = row - cursor.row;
      if (up > 0) out += `\x1b[${up}A`;
      out += `\r${cursor.col > 0 ? `\x1b[${cursor.col}C` : ''}`;
      row = cursor.row;
      out += '\x1b[?25h';
    }
    out += '\x1b[?2026l';
    this.term.write(out);
    this.cursorRow = Math.max(0, row);
    this.liveRows = live.length;
    this.lastFrame = frame;
  }

  /** Clear the live region and leave the cursor below committed output (on exit). */
  close() {
    this.live = [];
    this.cursor = null;
    this.flush();
    let out = '';
    if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
    out += '\r\x1b[J\x1b[?25h';
    this.term.write(out);
    this.cursorRow = 0;
    this.liveRows = 0;
  }
}
