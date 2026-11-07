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

  render(width: number, maxRows = 10): string[] {
    const out: string[] = [];
    if (this.opts.title) {
      const filter = this.opts.filterable ? theme.dim(this.filter ? `  filter: ${this.filter}` : '  type to filter') : '';
      out.push(theme.bold(this.opts.title) + filter);
    }
    if (!this.filtered.length) out.push(theme.dim('  no matches'));
    const start = Math.max(0, Math.min(this.index - Math.floor(maxRows / 2), this.filtered.length - maxRows));
    const visible = this.filtered.slice(start, start + maxRows);
    const labelW = Math.min(Math.max(...visible.map((o) => stringWidth(o.label)), 8), Math.floor(width * 0.55));
    visible.forEach((o, i) => {
      const active = start + i === this.index;
      const marker = active ? theme.accent('› ') : '  ';
      const label = padEnd(truncate(o.label, labelW), labelW);
      const detail = o.detail ? theme.dim(truncate(o.detail, Math.max(4, width - labelW - 6))) : '';
      const row = `${marker}${active ? theme.bold(label) : label}  ${detail}`;
      out.push(truncate(row, width));
    });
    if (this.filtered.length > maxRows) out.push(theme.dim(`  ${this.index + 1}/${this.filtered.length}`));
    out.push(theme.dim(truncate(this.opts.hint ?? '↑↓ navigate · enter select · esc cancel', width)));
    return out;
  }
}
