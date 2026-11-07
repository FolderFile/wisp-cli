import { writeFileSync } from 'node:fs';
import { marked } from 'marked';
import type { Message } from './types.js';

function messageMarkdown(m: Message): string {
  const parts: string[] = [];
  for (const b of m.content) {
    switch (b.type) {
      case 'text':
        parts.push(b.text);
        break;
      case 'image':
        parts.push('*[image]*');
        break;
      case 'thinking':
        if (b.thinking.trim()) parts.push(`<details><summary>Thinking</summary>\n\n${b.thinking}\n\n</details>`);
        break;
      case 'tool_call':
        parts.push(`**Tool: \`${b.name}\`**\n\n\`\`\`json\n${JSON.stringify(b.input, null, 2)}\n\`\`\``);
        break;
      case 'tool_result': {
        const body = b.content.length > 4000 ? b.content.slice(0, 4000) + '\n… (truncated)' : b.content;
        parts.push(`<details><summary>${b.isError ? 'Tool error' : 'Tool result'}</summary>\n\n\`\`\`\n${body.replace(/```/g, '`​``')}\n\`\`\`\n\n</details>`);
        break;
      }
    }
  }
  return parts.join('\n\n');
}

export function toMarkdown(messages: Message[], title: string): string {
  const out = [`# ${title}`, ''];
  for (const m of messages) {
    const body = messageMarkdown(m).trim();
    if (!body) continue;
    const onlyResults = m.role === 'user' && m.content.every((b) => b.type === 'tool_result');
    out.push(onlyResults ? body : `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${body}`, '');
  }
  return out.join('\n');
}

const CSS = `
:root { color-scheme: light dark; --bg: #fdfcff; --fg: #1d1b26; --muted: #6b6880; --card: #f3f1fa; --accent: #7c5cd6; --border: #e2def0; }
@media (prefers-color-scheme: dark) { :root { --bg: #15141b; --fg: #e8e6f0; --muted: #9a97ab; --card: #1e1c27; --accent: #b39dff; --border: #2d2a3a; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 1.4rem; } h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin: 2rem 0 .4rem; }
pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
details { border-left: 3px solid var(--border); padding-left: 12px; margin: 8px 0; color: var(--muted); }
summary { cursor: pointer; } table { border-collapse: collapse; } td, th { border: 1px solid var(--border); padding: 4px 8px; }
`;

export function exportSession(path: string, messages: Message[], title: string) {
  const md = toMarkdown(messages, title);
  if (path.endsWith('.md')) return writeFileSync(path, md);
  const body = marked.parse(md, { async: false }) as string;
  const esc = title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  writeFileSync(
    path,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title><style>${CSS}</style></head><body>${body}</body></html>\n`,
  );
}
