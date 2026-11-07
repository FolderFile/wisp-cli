import { InputParser, type InputEvent } from './keys.js';

const ESC_TIMEOUT_MS = 40;
// button events + SGR encoding (wheel scrolling); 1000 keeps motion events off
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/**
 * Owns the TTY: raw mode, bracketed paste, the kitty keyboard protocol, and
 * restoring everything on exit (including crashes and Ctrl+Z suspend).
 */
export class Terminal {
  private parser = new InputParser();
  private escTimer: NodeJS.Timeout | null = null;
  private active = false;
  private onInput: ((e: InputEvent) => void) | null = null;
  private onResize: (() => void) | null = null;

  /** Fullscreen: use the alternate screen buffer (and optionally capture the mouse wheel). */
  altScreen = false;
  mouse = false;

  constructor(
    readonly input: NodeJS.ReadStream = process.stdin,
    readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  /** Toggle mouse capture at runtime (off = the terminal's own text selection works). */
  setMouse(on: boolean) {
    this.mouse = on;
    if (this.active) this.write(on ? MOUSE_ON : MOUSE_OFF);
  }

  get columns() {
    return Math.max(20, this.output.columns || 80);
  }

  get rows() {
    return Math.max(8, this.output.rows || 24);
  }

  write(s: string) {
    this.output.write(s);
  }

  start(onInput: (e: InputEvent) => void, onResize: () => void) {
    this.onInput = onInput;
    this.onResize = onResize;
    this.enable();
    this.input.on('data', this.handleData);
    this.output.on('resize', this.handleResize);
    process.on('exit', this.restore);
    process.on('SIGCONT', this.handleCont);
  }

  stop() {
    this.input.off('data', this.handleData);
    this.output.off('resize', this.handleResize);
    process.off('SIGCONT', this.handleCont);
    this.restore();
  }

  private enable() {
    if (this.active) return;
    this.active = true;
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    this.input.resume();
    // alternate screen (fullscreen), bracketed paste, kitty keyboard protocol ("disambiguate")
    this.write((this.altScreen ? '\x1b[?1049h\x1b[2J\x1b[H' : '') + '\x1b[?2004h\x1b[>1u' + (this.mouse ? MOUSE_ON : ''));
  }

  restore = () => {
    if (!this.active) return;
    this.active = false;
    this.write((this.mouse ? MOUSE_OFF : '') + '\x1b[<u\x1b[?2004l\x1b[?25h' + (this.altScreen ? '\x1b[?1049l' : ''));
    if (this.input.isTTY) this.input.setRawMode(false);
  };

  /** Hand the terminal to another program (e.g. $EDITOR), then take it back. */
  async suspendFor<T>(fn: () => Promise<T> | T): Promise<T> {
    this.input.off('data', this.handleData);
    this.restore();
    this.input.pause();
    try {
      return await fn();
    } finally {
      this.enable();
      this.input.on('data', this.handleData);
      this.onResize?.();
    }
  }

  /** Ctrl+Z: restore the terminal and stop like a normal job. */
  suspend() {
    this.restore();
    process.kill(process.pid, 'SIGTSTP');
  }

  private handleCont = () => {
    this.enable();
    this.onResize?.();
  };

  private handleResize = () => this.onResize?.();

  private handleData = (data: string) => {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    for (const e of this.parser.feed(data)) this.onInput?.(e);
    // A lone ESC may be the start of a sequence; resolve it after a short wait.
    if (this.parser.pending) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        for (const e of this.parser.feed('', true)) this.onInput?.(e);
      }, ESC_TIMEOUT_MS);
    }
  };
}
