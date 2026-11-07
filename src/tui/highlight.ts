import hljs from 'highlight.js/lib/common';

const fg = (n: number) => `\x1b[38;5;${n}m`;
const RESET = '\x1b[39m';

// highlight.js scope -> 256-color
const COLORS: Record<string, string> = {
  keyword: fg(176),
  built_in: fg(117),
  type: fg(117),
  literal: fg(209),
  number: fg(209),
  string: fg(150),
  regexp: fg(180),
  subst: fg(252),
  symbol: fg(209),
  class: fg(222),
  function: fg(75),
  title: fg(75),
  params: fg(252),
  comment: fg(244),
  doctag: fg(244),
  meta: fg(244),
  attr: fg(222),
  attribute: fg(222),
  name: fg(176),
  tag: fg(176),
  variable: fg(252),
  property: fg(117),
  selector: fg(176),
  addition: fg(114),
  deletion: fg(203),
  section: fg(75),
  bullet: fg(209),
};

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/** Convert highlight.js HTML to ANSI, keeping a color stack for nested spans. */
function htmlToAnsi(html: string): string {
  const stack: string[] = [];
  let out = '';
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const scope = m[1].split(' ')[0].replace(/^hljs-/, '').split('.')[0].replace(/_$/, '');
      const color = COLORS[scope] ?? stack.at(-1) ?? '';
      stack.push(color);
      out += color;
    } else if (m[0] === '</span>') {
      stack.pop();
      out += RESET + (stack.at(-1) ?? '');
    } else {
      out += decode(m[2]);
    }
  }
  return out + RESET;
}

const ALIASES: Record<string, string> = { ts: 'typescript', js: 'javascript', sh: 'bash', shell: 'bash', zsh: 'bash', py: 'python', rs: 'rust', yml: 'yaml', md: 'markdown', console: 'bash' };

/** Highlight a code block; returns one ANSI string per source line. */
export function highlight(code: string, lang?: string): string[] {
  const l = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
  let html: string | null = null;
  try {
    if (l && hljs.getLanguage(l)) html = hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    else if (!l && code.length < 20_000) html = hljs.highlightAuto(code).value;
  } catch {
    html = null;
  }
  if (html === null) return code.split('\n');
  // Spans can cross newlines; re-open the active color at each line start.
  const ansi = htmlToAnsi(html);
  const lines = ansi.split('\n');
  let carry = '';
  return lines.map((line) => {
    const withCarry = carry + line;
    const opens = [...line.matchAll(/\x1b\[38;5;\d+m|\x1b\[39m/g)];
    const last = opens.at(-1)?.[0];
    if (last) carry = last === RESET ? '' : last;
    return withCarry + RESET;
  });
}
