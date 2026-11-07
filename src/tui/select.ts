import { fuzzyFilter } from './fuzzy.js';
import type { Key } from './keys.js';
import { padEnd, stringWidth, truncate } from './text.js';
import { theme } from './theme.js';

export interface Option<T> {
  label: string;
  detail?: string;
  /** Extra text matched by the filter but not shown. */
  keywords?: string;
  value: T;
  /** Single-key shortcut, e.g. 'y'. */
  hotkey?: string;
}

/** A list with arrow navigation and (optionally) type-to-filter. */
export class SelectList<T> {
  filter = '';
  index = 0;
  private filtered: Option<T>[];

  constructor(
    private options: Option<T>[],
    public opts: { title?: string; filterable?: boolean; initial?: number; hint?: string } = {},
  ) {
    this.filtered = options;
    this.index = Math.max(0, Math.min(opts.initial ?? 0, options.length - 1));
  }

  get selected(): Option<T> | undefined {
    return this.filtered[this.index];
  }

  setOptions(options: Option<T>[]) {
    this.options = options;
    this.refilter();
  }

  private refilter() {
    this.filtered = this.filter
      ? fuzzyFilter(this.filter, this.options, (o) => `${o.label} ${o.keywords ?? ''} ${o.detail ?? ''}`, 500)
      : this.options;
    this.index = Math.min(this.index, Math.max(0, this.filtered.length - 1));
  }

  handleKey(k: Key): 'select' | 'cancel' | 'handled' {
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return 'cancel';
    if (k.name === 'enter') return this.selected ? 'select' : 'handled';
    if (k.name === 'up' || (k.ctrl && k.name === 'p')) this.index = (this.index - 1 + this.filtered.length) % Math.max(1, this.filtered.length);
    else if (k.name === 'down' || (k.ctrl && k.name === 'n') || (k.name === 'tab' && !k.shift))
      this.index = (this.index + 1) % Math.max(1, this.filtered.length);
    else if (k.name === 'pageup') this.index = Math.max(0, this.index - 10);
    else if (k.name === 'pagedown') this.index = Math.min(this.filtered.length - 1, this.index + 10);
    else if (k.name === 'backspace' && this.opts.filterable) {
      this.filter = this.filter.slice(0, -1);
      this.refilter();
    } else if (k.text && !k.ctrl && !k.alt) {
      if (!this.opts.filterable) {
        const hit = this.filtered.findIndex((o) => o.hotkey === k.text!.toLowerCase());
        if (hit >= 0) {
          this.index = hit;
          return 'select';
        }
        return 'handled';
      }
      this.filter += k.text;
      this.index = 0;
      this.refilter();
    }
    return 'handled';
  }

  /** Just the option rows (for use inside a Dialog, which draws title and hints). */
  renderRows(width: number, maxRows = 10): string[] {
    const out: string[] = [];
    if (!this.filtered.length) return [theme.dim(this.filter ? 'no matches' : 'nothing here yet')];
    const count = this.filtered.length > maxRows;
    const rows = count ? Math.max(1, maxRows - 1) : maxRows;
    const start = Math.max(0, Math.min(this.index - Math.floor(rows / 2), this.filtered.length - rows));
    const visible = this.filtered.slice(start, start + rows);
    const detailW = Math.max(0, ...visible.map((o) => (o.detail ? stringWidth(o.detail) + 2 : 0)));
    const maxLabel = Math.max(...visible.map((o) => stringWidth(o.label)), 4);
    // labels get what the details leave, but never less than 60% of the row
    const labelW = Math.min(maxLabel, Math.max(Math.floor(width * 0.6), width - detailW - 5));
    visible.forEach((o, i) => {
      const active = start + i === this.index;
      const label = padEnd(truncate(o.label, labelW), labelW);
      const detail = o.detail ? '  ' + theme.dim(truncate(o.detail, Math.max(4, width - labelW - 5))) : '';
      out.push(truncate(active ? theme.accent('› ') + theme.selected(` ${label} `) + detail : `   ${label} ${detail}`, width));
    });
    if (count) out.push(theme.dim(`${this.index + 1} of ${this.filtered.length}`));
    return out;
  }
}
