import pc from 'picocolors';
import type { ThinkingLevel } from '../core/types.js';

// 256-color helpers; picocolors covers the basic 16.
const fg = (n: number) => (s: string) => `\x1b[38;5;${n}m${s}\x1b[39m`;

export const theme = {
  accent: fg(141), // soft violet: wisp
  accent2: fg(117),
  user: fg(117),
  muted: pc.dim,
  dim: fg(244),
  border: fg(240),
  success: pc.green,
  error: pc.red,
  warn: pc.yellow,
  bold: pc.bold,
  italic: pc.italic,
  code: fg(180),
  link: fg(75),
  heading: (s: string) => pc.bold(fg(141)(s)),
  selected: (s: string) => `\x1b[7m${s}\x1b[27m`,
  toolName: (s: string) => pc.bold(s),
};

/** Editor border color reflects the thinking level, like a "heat" gauge. */
export const thinkingColor: Record<ThinkingLevel, (s: string) => string> = {
  off: fg(240),
  low: fg(67),
  medium: fg(73),
  high: fg(141),
  xhigh: fg(176),
  max: fg(203),
};

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
