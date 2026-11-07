import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Tool } from '../tools/types.js';
import { AGENT_DIR } from './settings.js';

export interface ContextFile {
  path: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export interface PromptTemplate {
  name: string;
  description: string;
  body: string;
  path: string;
}

export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

const readIf = (p: string) => {
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};

/**
 * Project instructions: ~/.wisp/AGENTS.md, then AGENTS.md (or CLAUDE.md) in
 * every directory from the filesystem root down to cwd, most general first.
 */
export function discoverContextFiles(cwd: string): ContextFile[] {
  const out: ContextFile[] = [];
  const global = join(AGENT_DIR, 'AGENTS.md');
  const g = readIf(global);
  if (g?.trim()) out.push({ path: global, content: g });

  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    dirs.unshift(d);
    if (dirname(d) === d) break;
  }
  for (const d of dirs) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const p = join(d, name);
      const c = readIf(p);
      if (c?.trim()) {
        out.push({ path: p, content: c });
        break; // one per directory, AGENTS.md preferred
      }
    }
  }
  return out;
}

function skillDirs(cwd: string): string[] {
  return [
    join(AGENT_DIR, 'skills'),
    join(homedir(), '.claude', 'skills'),
    join(cwd, '.wisp', 'skills'),
    join(cwd, '.claude', 'skills'),
  ];
}

/** Skills: <dir>/<name>/SKILL.md with `name` and `description` frontmatter. */
export function discoverSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of skillDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry, 'SKILL.md');
      const src = readIf(path);
      if (!src) continue;
      const { meta } = parseFrontmatter(src);
      const name = meta.name || entry;
      if (!meta.description) continue; // the model needs a description to know when to use it
      byName.set(name, { name, description: meta.description, path }); // later dirs (project) win
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Prompt templates: ~/.wisp/prompts/*.md and .wisp/prompts/*.md, invoked as /name. */
export function discoverPromptTemplates(cwd: string): PromptTemplate[] {
  const byName = new Map<string, PromptTemplate>();
  for (const dir of [join(AGENT_DIR, 'prompts'), join(cwd, '.wisp', 'prompts')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, f);
      const src = readIf(path);
      if (src === null) continue;
      const { meta, body } = parseFrontmatter(src);
      const name = basename(f, '.md');
      const description = meta.description || body.trim().split('\n')[0].slice(0, 80);
      byName.set(name, { name, description, body, path });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Expand $ARGUMENTS / $1..$9 in a template. */
export function expandTemplate(t: PromptTemplate, args: string): string {
  const parts = args.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, '')) ?? [];
  let out = t.body.replace(/\$ARGUMENTS|\$@/g, args);
  out = out.replace(/\$(\d)/g, (_, n) => parts[Number(n) - 1] ?? '');
  if (args && !/\$ARGUMENTS|\$@|\$\d/.test(t.body)) out = `${out.trimEnd()}\n\n${args}`;
  return out;
}

function gitInfo(cwd: string): string {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return `yes (branch: ${branch})`;
  } catch {
    return 'no';
  }
}

export const DEFAULT_SYSTEM_PROMPT = `You are Wisp, a coding agent running in the user's terminal. You help with software engineering tasks: understanding code, fixing bugs, adding features, refactoring, and running commands and tests.

# How to work
- Investigate before answering. Use grep, glob, ls and read_file to look at the actual code instead of guessing.
- Read a file before editing it. Use edit_file for targeted changes and write_file for new files or full rewrites.
- Keep changes focused on what was asked, and match the existing code style and conventions.
- After changing code, verify it when practical: build, run the tests, or run the program.
- bash runs each command in a fresh shell in the working directory; cd does not persist, and stdin is closed.
- Destructive or irreversible actions (deleting files, force-pushing, dropping data) need the user's explicit go-ahead.
- If the user denies a tool call, do not retry it. Stop and ask how they'd like to proceed.
- The user may send you messages while you work; take them into account as soon as you see them.

# Communication
- Your output is rendered as Markdown in a terminal. Be concise and direct.
- Refer to code locations as path:line.
- When you finish a task, briefly say what you changed and how you verified it, and mention anything you could not verify.`;

export interface SystemPromptParts {
  cwd: string;
  tools: Tool[];
  contextFiles: ContextFile[];
  skills: Skill[];
  override?: string;
  append?: string[];
  mcpInstructions?: { server: string; text: string }[];
}

/**
 * The system prompt is kept byte-stable within a session (no timestamps that
 * change per request) so that prompt caching keeps working.
 */
export function buildSystemPrompt(p: SystemPromptParts): string {
  const sysFile = readIf(join(p.cwd, '.wisp', 'SYSTEM.md')) ?? readIf(join(AGENT_DIR, 'SYSTEM.md'));
  const base = p.override ?? sysFile ?? DEFAULT_SYSTEM_PROMPT;
  const sections = [base.trim()];

  sections.push(`# Environment
- Working directory: ${p.cwd}
- Platform: ${process.platform}
- Git repository: ${gitInfo(p.cwd)}
- Today's date: ${new Date().toISOString().slice(0, 10)}
- Available tools: ${describeTools(p.tools)}`);

  if (p.mcpInstructions?.length) {
    sections.push(
      '# MCP servers\nTools named mcp__<server>__<tool> come from these connected MCP servers. Their own usage notes:\n\n' +
        p.mcpInstructions.map((i) => `<server name="${i.server}">\n${i.text}\n</server>`).join('\n\n'),
    );
  }

  if (p.contextFiles.length) {
    sections.push(
      '# Project instructions\nThe user provided these instruction files. Follow them.\n\n' +
        p.contextFiles.map((f) => `<instructions path="${f.path}">\n${f.content.trim()}\n</instructions>`).join('\n\n'),
    );
  }

  if (p.skills.length) {
    sections.push(
      '# Skills\nSkills are instruction files for specialised tasks. When a task matches a skill, read its SKILL.md with read_file before starting, then follow it.\n\n' +
        p.skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`).join('\n'),
    );
  }

  const appendFile = readIf(join(p.cwd, '.wisp', 'APPEND_SYSTEM.md')) ?? readIf(join(AGENT_DIR, 'APPEND_SYSTEM.md'));
  for (const extra of [appendFile, ...(p.append ?? [])]) if (extra?.trim()) sections.push(extra.trim());
  return sections.join('\n\n');
}

/** Built-in tools by name; MCP tools summarized per server (there can be dozens). */
function describeTools(tools: Tool[]): string {
  const builtin = tools.filter((t) => !t.mcp).map((t) => t.name);
  const perServer = new Map<string, number>();
  for (const t of tools) if (t.mcp) perServer.set(t.mcp.server, (perServer.get(t.mcp.server) ?? 0) + 1);
  const mcp = [...perServer].map(([s, n]) => `${n} from MCP server "${s}"`);
  return [...builtin, ...mcp].join(', ');
}
