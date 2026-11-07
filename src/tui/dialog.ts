import type { Key } from './keys.js';
import type { SelectList } from './select.js';
import { padEnd, stringWidth, truncate, wrap } from './text.js';
import { SPINNER, theme } from './theme.js';

/** A one-line text field (optionally masked, for API keys). */
export class TextInput {
  value = '';
  cursor = 0;

  constructor(public opts: { placeholder?: string; mask?: boolean; initial?: string } = {}) {
    this.value = opts.initial ?? '';
    this.cursor = this.value.length;
  }

  insert(s: string) {
    const clean = s.replace(/[\r\n\t]/g, '');
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
    this.cursor += clean.length;
  }

  handleKey(k: Key): boolean {
    const id = `${k.ctrl ? 'C-' : ''}${k.alt ? 'M-' : ''}${k.name}`;
    switch (id) {
      case 'left':
      case 'C-b':
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case 'right':
      case 'C-f':
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        return true;
      case 'home':
      case 'C-a':
        this.cursor = 0;
        return true;
      case 'end':
      case 'C-e':
        this.cursor = this.value.length;
        return true;
      case 'backspace':
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        return true;
      case 'delete':
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        return true;
      case 'C-u':
        this.value = this.value.slice(this.cursor);
        this.cursor = 0;
        return true;
      case 'C-w': {
        const before = this.value.slice(0, this.cursor).replace(/\S+\s*$/, '');
        this.value = before + this.value.slice(this.cursor);
        this.cursor = before.length;
        return true;
      }
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

  /** Rendered field (with a leading "› ") and the cursor column within it. */
  render(width: number): { line: string; col: number } {
    const shown = this.opts.mask ? maskKey(this.value) : this.value;
    const prefix = theme.accent('› ');
    if (!this.value) return { line: prefix + theme.dim(this.opts.placeholder ?? ''), col: 2 };
    const avail = Math.max(4, width - 3);
    // keep the cursor visible in long values
    const cursorAt = this.opts.mask ? Math.min(shown.length, this.cursor) : this.cursor;
    const start = Math.max(0, cursorAt - avail + 1);
    const view = shown.slice(start, start + avail);
    return { line: prefix + view, col: 2 + stringWidth(shown.slice(start, cursorAt)) };
  }
}

/** "sk-ant-api03-abcd…wxyz" → "sk-ant-••••••••wxyz": enough to recognise, not to read. */
export function maskKey(v: string): string {
  if (v.length <= 8) return '•'.repeat(v.length);
  const head = v.match(/^[a-z]+-(?:[a-z]+-)?/i)?.[0] ?? '';
  return head + '•'.repeat(Math.min(24, v.length - head.length - 4)) + v.slice(-4);
}

export interface DialogKey<T> {
  /** Key name as typed, e.g. "e" or "d". */
  key: string;
  label: string;
  /** Return true to keep the dialog open. */
  run: (value: T | undefined) => void | boolean;
}

export interface DialogOptions<T> {
  title: string;
  /** Lines above the list (wrapped to the box). Can change between renders. */
  body?: () => string[];
  list?: SelectList<T>;
  input?: TextInput;
  /** Preferred box width (columns). */
  width?: number;
  /** center: floating over the conversation; bottom: in place of the editor. */
  anchor?: 'center' | 'bottom';
  keys?: DialogKey<T>[];
  /** Enter on a list item. Return true to keep the dialog open. */
  onSelect?: (value: T) => void | boolean;
  /** Enter in the text field. Return true to keep the dialog open. */
  onSubmit?: (text: string) => void | boolean;
  onCancel?: () => void;
  /** Overrides the default hint line in the bottom border. */
  hint?: string;
}

/** A bordered, titled popup: optional text, an optional field, an optional list. */
export class Dialog<T = unknown> {
  status: { text: string; kind: 'info' | 'error' | 'busy' | 'success' } | null = null;
  frame = 0;

  constructor(public o: DialogOptions<T>) {}

  get anchor() {
    return this.o.anchor ?? 'center';
  }

  setStatus(text: string, kind: 'info' | 'error' | 'busy' | 'success' = 'info') {
    this.status = { text, kind };
  }

  /** Returns 'close' when the dialog is done. */
  handleKey(k: Key): 'close' | 'keep' {
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) {
      this.o.onCancel?.();
      return 'close';
    }
    if (this.status?.kind === 'busy') return 'keep';
    if (this.o.input) {
      if (k.name === 'enter') return this.o.onSubmit?.(this.o.input.value) ? 'keep' : 'close';
      // editing the field clears an old error
      if (this.o.input.handleKey(k) && this.status?.kind === 'error') this.status = null;
      return 'keep';
    }
    // extra single-key actions (unless the list is being filtered by typing)
    if (k.text && !k.ctrl && !k.alt && this.o.keys?.length && !(this.o.list?.opts.filterable && this.o.list.filter)) {
      const action = this.o.keys.find((a) => a.key === k.text!.toLowerCase());
      if (action) return action.run(this.o.list?.selected?.value) ? 'keep' : 'close';
    }
    if (this.o.list) {
      const r = this.o.list.handleKey(k);
      if (r === 'select') return this.o.onSelect?.(this.o.list.selected!.value) ? 'keep' : 'close';
      if (r === 'cancel') {
        this.o.onCancel?.();
        return 'close';
      }
    }
    return 'keep';
  }

  paste(text: string) {
    if (!this.o.input) return;
    this.o.input.insert(text.trim());
    if (this.status?.kind === 'error') this.status = null;
  }

  private defaultHint(): string {
    const parts: string[] = [];
    if (this.o.list) parts.push('↑↓ move', 'enter select');
    if (this.o.input) parts.push('enter confirm');
    for (const k of this.o.keys ?? []) parts.push(`${k.key} ${k.label}`);
    parts.push('esc close');
    return parts.join(' · ');
  }

  /**
   * Render the box. `maxW`/`maxH` are the space available. Returns the lines
   * (all exactly the box width) and, for text fields, where the cursor goes.
   */
  render(maxW: number, maxH: number): { lines: string[]; cursor: { row: number; col: number } | null } {
    const boxW = Math.max(24, Math.min(maxW, this.o.width ?? 72));
    const inner = boxW - 4;
    const b = theme.border;
    const lines: string[] = [];
    const row = (content = '') => b('│ ') + padEnd(truncate(content, inner), inner) + b(' │');

    const title = ` ${this.o.title} `;
    lines.push(b('╭─') + theme.bold(truncate(title, boxW - 4)) + b('─'.repeat(Math.max(0, boxW - 3 - stringWidth(truncate(title, boxW - 4)))) + '╮'));

    let cursor: { row: number; col: number } | null = null;
    const body = this.o.body?.() ?? [];
    for (const l of body) for (const w of wrap(l, inner)) lines.push(row(w));
    if (body.length) lines.push(row());

    if (this.o.input) {
      const f = this.o.input.render(inner);
      cursor = { row: lines.length, col: 2 + f.col };
      lines.push(row(f.line));
    }

    if (this.o.list) {
      const list = this.o.list;
      if (list.opts.filterable) {
        lines.push(row(list.filter ? theme.accent('⌕ ') + list.filter : theme.dim('⌕ type to search')));
      }
      // leave room for the status line and bottom border
      const reserve = 2 + (this.status ? 2 : 0);
      const rows = Math.max(3, maxH - lines.length - reserve);
      for (const r of list.renderRows(inner, rows)) lines.push(row(r));
    }

    if (this.status) {
      const { text, kind } = this.status;
      const color = kind === 'error' ? theme.error : kind === 'success' ? theme.success : kind === 'busy' ? theme.accent : theme.dim;
      const icon = kind === 'busy' ? SPINNER[this.frame % SPINNER.length] + ' ' : kind === 'error' ? '✗ ' : kind === 'success' ? '✓ ' : '';
      lines.push(row());
      for (const w of wrap(icon + text, inner)) lines.push(row(color(w)));
    }

    const hint = ` ${this.o.hint ?? this.defaultHint()} `;
    const hintShown = truncate(hint, boxW - 4);
    lines.push(b('╰' + '─'.repeat(Math.max(0, boxW - 3 - stringWidth(hintShown))) + theme.dim(hintShown) + b('─╯')));

    // too tall: keep the top (title, field) and the bottom border
    if (lines.length > maxH && maxH > 3) {
      const keep = lines.slice(0, maxH - 2);
      keep.push(row(theme.dim('…')), lines.at(-1)!);
      if (cursor && cursor.row >= keep.length - 2) cursor = null;
      return { lines: keep, cursor };
    }
    return { lines, cursor };
  }
}
