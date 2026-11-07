import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, matchesGlob, relative } from 'node:path';
import { promisify } from 'node:util';
import { displayPath, isBinary, resolvePath } from './files.js';
import { ToolError, type Tool } from './types.js';

const execFileP = promisify(execFile);

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv',
  '__pycache__', '.cache', 'coverage', '.turbo', '.idea', '.vscode',
]);

/**
 * List files under `root` (absolute paths). Inside a git repo we ask git, which
 * respects .gitignore; otherwise walk the tree skipping well-known junk dirs.
 */
export async function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, signal },
    );
    const files = stdout.split('\0').filter(Boolean).map((f) => join(root, f));
    // ls-files lists deleted-but-tracked files too; drop those lazily at read time.
    return files;
  } catch {
    // not a git repo (or git missing): fall through
  }
  const out: string[] = [];
  async function walk(dir: string) {
    if (signal?.aborted) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (e.isFile()) out.push(join(dir, e.name));
    }
  }
  await walk(root);
  return out;
}

function globMatcher(pattern: string): (rel: string) => boolean {
  // "*.ts" means "any .ts file", like most tools treat a slash-less pattern.
  const p = pattern.includes('/') ? pattern : `**/${pattern}`;
  return (rel) => matchesGlob(rel, p);
}

async function searchRoot(path: string | undefined, ctx: Parameters<Tool['run']>[1]) {
  const root = resolvePath(path ?? '.', ctx);
  try {
    return { root, st: await stat(root) };
  } catch {
    throw new ToolError(`Path not found: ${path}`);
  }
}

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "*.md"). A pattern without "/" matches at any depth. ' +
    'Respects .gitignore in git repos. Returns paths relative to the working directory, newest first.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to path' },
      path: { type: 'string', description: 'Directory to search (default: working directory)' },
    },
    required: ['pattern'],
  },
  permission: 'none',
  label: (i) => (i.path ? `${i.pattern} in ${i.path}` : i.pattern),
  async run({ pattern, path }, ctx) {
    const { root, st } = await searchRoot(path, ctx);
    if (!st.isDirectory()) throw new ToolError(`${path} is not a directory.`);
    const match = globMatcher(pattern);
    const files = (await listFiles(root, ctx.signal)).filter((f) => match(relative(root, f)));
    const withTimes = await Promise.all(
      files.map(async (f) => ({ f, t: await stat(f).then((s) => s.mtimeMs, () => -1) })),
    );
    const existing = withTimes.filter((x) => x.t >= 0).sort((a, b) => b.t - a.t);
    if (!existing.length) return { content: 'No files matched.', display: 'no files' };
    const shown = existing.slice(0, MAX_RESULTS).map((x) => displayPath(x.f, ctx.cwd));
    const more = existing.length > MAX_RESULTS ? `\n… and ${existing.length - MAX_RESULTS} more` : '';
    return { content: shown.join('\n') + more, display: `${existing.length} file${existing.length === 1 ? '' : 's'}` };
  },
};

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  files_only?: boolean;
};

export const grepTool: Tool<GrepInput> = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. Returns "path:line: text" matches, ' +
    'or just file paths with files_only. Respects .gitignore in git repos; skips binary files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (JavaScript syntax)' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
      files_only: { type: 'boolean', description: 'Return only the paths of matching files' },
    },
    required: ['pattern'],
  },
  permission: 'none',
  label: (i) => `${i.pattern}${i.path ? ` in ${i.path}` : ''}${i.glob ? ` (${i.glob})` : ''}`,
  async run({ pattern, path, glob, ignore_case, files_only }, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignore_case ? 'i' : '');
    } catch (e) {
      throw new ToolError(`Invalid regex: ${(e as Error).message}`);
    }
    const { root, st } = await searchRoot(path, ctx);
    let files = st.isDirectory() ? await listFiles(root, ctx.signal) : [root];
    if (glob && st.isDirectory()) {
      const match = globMatcher(glob);
      files = files.filter((f) => match(relative(root, f)));
    }

    const results: string[] = [];
    let total = 0;
    for (const file of files) {
      if (ctx.signal.aborted) throw new ToolError('Interrupted by user.');
      let buf: Buffer;
      try {
        const s = await stat(file);
        if (s.size > MAX_FILE_BYTES) continue;
        buf = await readFile(file);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      const rel = displayPath(file, ctx.cwd);
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hit = true;
        if (files_only) break;
        total++;
        if (results.length < MAX_RESULTS) {
          const text = lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i];
          results.push(`${rel}:${i + 1}: ${text}`);
        }
      }
      if (hit && files_only) {
        total++;
        if (results.length < MAX_RESULTS) results.push(rel);
      }
    }
    if (!results.length) return { content: 'No matches.', display: 'no matches' };
    const more = total > results.length ? `\n… ${total - results.length} more matches not shown` : '';
    const fileCount = new Set(results.map((r) => (files_only ? r : r.slice(0, r.indexOf(':'))))).size;
    const display = files_only ? `${total} file${total === 1 ? '' : 's'}` : `${total} match${total === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`;
    return { content: results.join('\n') + more, display };
  },
};
