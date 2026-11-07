import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';

export { stringWidth, stripAnsi };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

/**
 * wrap-ansi with trim:false keeps the space a line was broken at, so
 * continuation rows would start with it. Drop exactly that one space (after
 * any leading color codes) without touching real indentation on the first row.
 */
function wrapRows(line: string, w: number): string[] {
  const rows = wrapAnsi(line, w, { hard: true, trim: false, wordWrap: true }).split('\n');
  for (let i = 1; i < rows.length; i++) rows[i] = rows[i].replace(/^((?:\x1b\[[0-9;]*m)*) /, '$1');
  return rows;
}

/** Wrap (ANSI-aware) to exactly `width` columns per line; always returns ≥1 line. */
export function wrap(s: string, width: number, opts: { indent?: string } = {}): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of s.replace(/\t/g, '    ').split('\n')) {
    if (!opts.indent) {
      out.push(...wrapRows(line, w));
      continue;
    }
    const first = wrapRows(line, w);
    if (first.length === 1) {
      out.push(first[0]);
      continue;
    }
    // hanging indent for continuation lines
    const head = first[0];
    const rest = stripAnsi(head).length < stripAnsi(line).length ? line.slice(sliceIndex(line, head)) : '';
    out.push(head);
    out.push(
      ...wrapRows(rest.trimStart(), Math.max(1, w - stringWidth(opts.indent))).map((l) => opts.indent + l),
    );
  }
  return out;
}

/** Find where `head` (a wrapped prefix of `line`) ends inside `line`. */
function sliceIndex(line: string, head: string): number {
  const plainHead = stripAnsi(head);
  let visible = 0;
  let i = 0;
  // walk `line`, skipping ANSI sequences, until we've consumed plainHead's length
  const ansi = /\x1b\[[0-9;]*m/y;
  while (i < line.length && visible < plainHead.length) {
    ansi.lastIndex = i;
    const m = ansi.exec(line);
    if (m) {
      i += m[0].length;
      continue;
    }
    i++;
    visible++;
  }
  return i;
}

/** Truncate to `width` columns (ANSI-aware), adding an ellipsis. */
export function truncate(s: string, width: number): string {
  if (stringWidth(s) <= width) return s;
  const plain = stripAnsi(s);
  let out = '';
  let w = 0;
  for (const g of graphemes(plain)) {
    const gw = stringWidth(g);
    if (w + gw > width - 1) break;
    out += g;
    w += gw;
  }
  return out + '…';
}

export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - stringWidth(s)));
}

/** Place `right` flush right on a line of `width` after `left`. */
export function spread(left: string, right: string, width: number): string {
  const gap = width - stringWidth(left) - stringWidth(right);
  if (gap < 1) return truncate(left, Math.max(1, width - stringWidth(right) - 1)) + ' ' + right;
  return left + ' '.repeat(gap) + right;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
