/**
 * Terminal input parsing: turns raw stdin bytes into key and paste events.
 * Handles legacy sequences, xterm modifiers, the kitty keyboard protocol
 * (CSI u, which makes Shift+Enter distinguishable), and bracketed paste.
 */

export interface Key {
  name: string; // 'a', 'enter', 'up', 'escape', 'f1', ...
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Printable text this key inserts, if any. */
  text?: string;
}

export interface MouseEvent {
  type: 'mouse';
  /** 0 left, 1 middle, 2 right; wheel events use `wheel` instead */
  button: number;
  wheel?: 'up' | 'down';
  x: number; // 1-based column
  y: number; // 1-based row
  release: boolean;
  shift: boolean;
}

export type InputEvent = { type: 'key'; key: Key } | { type: 'paste'; text: string } | MouseEvent;

const key = (name: string, mods: Partial<Key> = {}): InputEvent => ({
  type: 'key',
  key: { name, ctrl: false, alt: false, shift: false, ...mods },
});

const CSI_TILDE: Record<string, string> = {
  '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown',
  '7': 'home', '8': 'end', '15': 'f5', '17': 'f6', '18': 'f7', '19': 'f8', '20': 'f9', '21': 'f10', '23': 'f11', '24': 'f12',
};
const CSI_LETTER: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4', Z: 'tab',
};
const KITTY_SPECIAL: Record<number, string> = {
  13: 'enter', 9: 'tab', 27: 'escape', 127: 'backspace', 8: 'backspace', 32: 'space',
  57399: '0', 57414: 'enter', // keypad
};

function mods(n: number): Pick<Key, 'ctrl' | 'alt' | 'shift'> {
  const m = Math.max(0, n - 1);
  return { shift: Boolean(m & 1), alt: Boolean(m & 2), ctrl: Boolean(m & 4) };
}

function fromCodepoint(code: number, m: Pick<Key, 'ctrl' | 'alt' | 'shift'>): InputEvent {
  const special = KITTY_SPECIAL[code];
  if (special) return key(special, { ...m, text: special === 'space' && !m.ctrl && !m.alt ? ' ' : undefined });
  const ch = String.fromCodePoint(code);
  const name = ch.toLowerCase();
  const text = m.ctrl || m.alt ? undefined : m.shift ? ch.toUpperCase() : ch;
  return key(name, { ...m, text });
}

function controlChar(c: string, alt = false): InputEvent | null {
  const code = c.charCodeAt(0);
  if (c === '\r') return key('enter', { alt });
  if (c === '\n') return key('j', { ctrl: true, alt }); // Ctrl+J: a reliable "newline" everywhere
  if (c === '\t') return key('tab', { alt });
  if (c === '\x7f' || c === '\b') return key('backspace', { alt });
  if (c === '\x1b') return key('escape', { alt });
  if (c === '\x00') return key('space', { ctrl: true, alt });
  if (c === '\x1f') return key('-', { ctrl: true, alt }); // Ctrl+_ / Ctrl+-
  if (code >= 1 && code <= 26) return key(String.fromCharCode(code + 96), { ctrl: true, alt });
  return null;
}

export class InputParser {
  private buf = '';
  private pasting: string | null = null;

  /** Feed raw input; returns parsed events. `flush` treats a trailing lone ESC as Escape. */
  feed(data: string, flush = false): InputEvent[] {
    this.buf += data;
    const out: InputEvent[] = [];
    while (this.buf.length) {
      if (this.pasting !== null) {
        const end = this.buf.indexOf('\x1b[201~');
        if (end === -1) {
          this.pasting += this.buf;
          this.buf = '';
          break;
        }
        this.pasting += this.buf.slice(0, end);
        out.push({ type: 'paste', text: this.pasting.replace(/\r\n?/g, '\n') });
        this.pasting = null;
        this.buf = this.buf.slice(end + 6);
        continue;
      }
      if (this.buf.startsWith('\x1b[200~')) {
        this.pasting = '';
        this.buf = this.buf.slice(6);
        continue;
      }
      const c = this.buf[0];
      if (c === '\x1b') {
        if (this.buf.length === 1) {
          if (!flush) break; // might be the start of a sequence: wait
          out.push(key('escape'));
          this.buf = '';
          break;
        }
        const r = this.parseEscape();
        if (r === 'incomplete') {
          if (!flush) break;
          out.push(key('escape'));
          this.buf = this.buf.slice(1);
          continue;
        }
        if (r) out.push(r);
        continue;
      }
      const ctl = controlChar(c);
      if (ctl) {
        out.push(ctl);
        this.buf = this.buf.slice(1);
        continue;
      }
      // Printable run: take one code point at a time so keys stay separate.
      const cp = this.buf.codePointAt(0)!;
      const ch = String.fromCodePoint(cp);
      this.buf = this.buf.slice(ch.length);
      out.push(key(ch.length === 1 ? ch.toLowerCase() : ch, { text: ch, shift: ch !== ch.toLowerCase() }));
    }
    return out;
  }

  get pending() {
    return this.buf.length > 0 && this.pasting === null;
  }

  private parseEscape(): InputEvent | null | 'incomplete' {
    const b = this.buf;
    const second = b[1];
    if (second === '[') {
      // CSI: params (0x30-0x3f), intermediates (0x20-0x2f), final (0x40-0x7e)
      let i = 2;
      while (i < b.length && b.charCodeAt(i) >= 0x30 && b.charCodeAt(i) <= 0x3f) i++;
      while (i < b.length && b.charCodeAt(i) >= 0x20 && b.charCodeAt(i) <= 0x2f) i++;
      if (i >= b.length) return 'incomplete';
      const final = b[i];
      const params = b.slice(2, i);
      this.buf = b.slice(i + 1);
      return this.csi(params, final);
    }
    if (second === 'O') {
      if (b.length < 3) return 'incomplete';
      this.buf = b.slice(3);
      const name = CSI_LETTER[b[2]];
      return name ? key(name) : null;
    }
    // Alt+<key>
    this.buf = b.slice(1);
    const ctl = controlChar(this.buf[0], true);
    if (ctl) {
      this.buf = this.buf.slice(1);
      return ctl;
    }
    const cp = this.buf.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    this.buf = this.buf.slice(ch.length);
    return key(ch.toLowerCase(), { alt: true, shift: ch !== ch.toLowerCase() });
  }

  private csi(params: string, final: string): InputEvent | null {
    // SGR mouse: CSI < button ; x ; y (M = press, m = release)
    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      const [b, x, y] = params.slice(1).split(';').map(Number);
      const wheel = b & 64 ? (b & 1 ? 'down' : 'up') : undefined;
      return { type: 'mouse', button: b & 3, wheel, x, y, release: final === 'm', shift: Boolean(b & 4) };
    }
    const parts = params.split(';');
    if (final === 'u') {
      // kitty: CSI code[:shifted[:base]] ; mods[:event] [; text] u
      const code = Number(parts[0].split(':')[0]);
      const m = mods(Number((parts[1] ?? '1').split(':')[0]));
      const event = (parts[1] ?? '').split(':')[1];
      if (event === '3') return null; // key release
      return fromCodepoint(code, m);
    }
    if (final === '~') {
      // xterm modifyOtherKeys: CSI 27 ; mods ; code ~
      if (parts[0] === '27' && parts.length >= 3) return fromCodepoint(Number(parts[2]), mods(Number(parts[1])));
      const name = CSI_TILDE[parts[0]];
      if (!name) return null;
      return key(name, mods(Number(parts[1] ?? '1')));
    }
    const name = CSI_LETTER[final];
    if (!name) return null; // focus events, cursor reports, etc.
    const m = mods(Number(parts[1] ?? '1'));
    if (final === 'Z') m.shift = true;
    return key(name, m);
  }
}

/** Human-readable key description, e.g. "ctrl+shift+p", for matching bindings. */
export function keyId(k: Key): string {
  return `${k.ctrl ? 'ctrl+' : ''}${k.alt ? 'alt+' : ''}${k.shift && k.name.length > 1 ? 'shift+' : ''}${k.name}`;
}
