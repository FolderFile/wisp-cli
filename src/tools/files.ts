import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import pc from 'picocolors';
import type { ImageBlock } from '../core/types.js';
import { diffStats, renderDiff } from './diff.js';
import { ToolError, type Tool, type ToolContext } from './types.js';

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, ImageBlock['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function resolvePath(p: string, ctx: { cwd: string }): string {
  if (p.startsWith('~/')) p = join(process.env.HOME ?? '', p.slice(2));
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

export function displayPath(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export async function loadImage(abs: string): Promise<ImageBlock | null> {
  const mediaType = IMAGE_TYPES[extname(abs).toLowerCase()];
  if (!mediaType) return null;
  const buf = await readFile(abs);
  if (buf.length > MAX_IMAGE_BYTES) throw new ToolError(`Image is too large (${Math.round(buf.length / 1024)} KB, max 5 MB).`);
  return { type: 'image', mediaType, data: buf.toString('base64') };
}

async function mtime(abs: string): Promise<number | null> {
  try {
    return (await stat(abs)).mtimeMs;
  } catch {
    return null;
  }
}

/** Refuse to modify an existing file the model hasn't seen in its current state. */
async function assertFresh(abs: string, ctx: ToolContext) {
  const current = await mtime(abs);
  if (current === null) return; // new file
  const seen = ctx.readFiles.get(abs);
  if (seen === undefined)
    throw new ToolError(`You must read ${displayPath(abs, ctx.cwd)} with read_file before modifying it.`);
  if (seen !== current)
    throw new ToolError(`${displayPath(abs, ctx.cwd)} has changed since you last read it. Read it again before modifying it.`);
}

async function recordWrite(abs: string, ctx: ToolContext) {
  const m = await mtime(abs);
  if (m !== null) ctx.readFiles.set(abs, m);
}

// ---------------------------------------------------------------------------

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description:
    'Read a text file (returned with line numbers, cat -n style) or an image (png/jpg/gif/webp, returned as an image). ' +
    `Reads up to ${MAX_LINES} lines by default; use offset/limit for large files.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      offset: { type: 'integer', description: '1-based line number to start from' },
      limit: { type: 'integer', description: 'Maximum number of lines to return' },
    },
    required: ['path'],
  },
  permission: 'none',
  label: (i) => (i.offset || i.limit ? `${i.path}:${i.offset ?? 1}${i.limit ? `-${(i.offset ?? 1) + i.limit - 1}` : ''}` : i.path),
  async run({ path, offset = 1, limit = MAX_LINES }, ctx) {
    const abs = resolvePath(path, ctx);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new ToolError(`File not found: ${path}`);
    }
    if (st.isDirectory()) throw new ToolError(`${path} is a directory. Use the ls tool to list it.`);
    const image = await loadImage(abs);
    if (image) return { content: `Image ${path} (${Math.round(st.size / 1024)} KB)`, images: [image] };

    const buf = await readFile(abs);
    if (isBinary(buf)) throw new ToolError(`${path} appears to be a binary file.`);
    ctx.readFiles.set(abs, st.mtimeMs);

    const lines = buf.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) return '(empty file)';
    const start = Math.max(1, Math.floor(offset));
    if (start > lines.length) throw new ToolError(`offset ${start} is past the end of the file (${lines.length} lines).`);
    const end = Math.min(lines.length, start - 1 + Math.max(1, Math.floor(limit)));
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => {
        const text = l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…[truncated]' : l;
        return `${String(start + i).padStart(width)}\t${text}`;
      })
      .join('\n');
    const more = end < lines.length ? `\n\n(showing lines ${start}-${end} of ${lines.length}; use offset to read more)` : '';
    return { content: body + more, display: pc.dim(`${end - start + 1} lines`) };
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create a new file or completely overwrite an existing one. Parent directories are created. ' +
    'Existing files must be read first. Prefer edit_file for changes to existing files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      content: { type: 'string', description: 'Full file contents' },
    },
    required: ['path', 'content'],
  },
  permission: 'edit',
  label: (i) => i.path,
  async preview({ path, content }, ctx) {
    const abs = resolvePath(path, ctx);
    const old = await readFile(abs, 'utf8').catch(() => null);
    if (old !== null) return `${pc.yellow('Overwrite')} ${path}\n${renderDiff(old, content, 2, 40)}`;
    const lines = content.split('\n');
    const shown = lines.slice(0, 30).map((l, i) => pc.green(`${String(i + 1).padStart(3)} + ${l}`));
    if (lines.length > 30) shown.push(pc.dim(`    … ${lines.length - 30} more lines`));
    return `${pc.green('Create')} ${path} ${pc.dim(`(${lines.length} lines)`)}\n${shown.join('\n')}`;
  },
  async run({ path, content }, ctx) {
    const abs = resolvePath(path, ctx);
    await assertFresh(abs, ctx);
    const old = await readFile(abs, 'utf8').catch(() => null);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    await recordWrite(abs, ctx);
    const n = content.split('\n').length;
    if (old === null) return { content: `Created ${path} (${n} lines)`, display: pc.dim(`created, ${n} lines`) };
    const s = diffStats(old, content);
    return {
      content: `Overwrote ${path} (${n} lines)`,
      display: `${pc.green(`+${s.added}`)} ${pc.red(`-${s.removed}`)}\n${renderDiff(old, content, 2, 30)}`,
    };
  },
};

type EditInput = { path: string; old_string: string; new_string: string; replace_all?: boolean };

async function planEdit({ path, old_string, new_string, replace_all }: EditInput, ctx: { cwd: string }) {
  const abs = resolvePath(path, ctx);
  let original: string;
  try {
    original = await readFile(abs, 'utf8');
  } catch {
    throw new ToolError(`File not found: ${path}`);
  }
  if (old_string === new_string) throw new ToolError('old_string and new_string are identical.');
  if (old_string === '') throw new ToolError('old_string must not be empty. Use write_file to create files.');
  const count = original.split(old_string).length - 1;
  if (count === 0)
    throw new ToolError('old_string was not found in the file. It must match exactly, including whitespace and indentation.');
  if (count > 1 && !replace_all)
    throw new ToolError(`old_string appears ${count} times. Include more surrounding context to make it unique, or set replace_all.`);
  const at = original.indexOf(old_string);
  // split/join (not String.replace) so `$&` etc. in new_string are taken literally.
  const updated = replace_all
    ? original.split(old_string).join(new_string)
    : original.slice(0, at) + new_string + original.slice(at + old_string.length);
  const line = original.slice(0, at).split('\n').length;
  return { abs, original, updated, count: replace_all ? count : 1, line };
}

export const editFileTool: Tool<EditInput> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) ' +
    'and be unique unless replace_all is true. The file must have been read first.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  permission: 'edit',
  label: (i) => i.path,
  async preview(input, ctx) {
    const { original, updated } = await planEdit(input, ctx);
    return `${pc.yellow('Edit')} ${input.path}\n${renderDiff(original, updated, 2, 60)}`;
  },
  async run(input, ctx) {
    const abs = resolvePath(input.path, ctx);
    await assertFresh(abs, ctx);
    const { original, updated, count, line } = await planEdit(input, ctx);
    await writeFile(abs, updated, 'utf8');
    await recordWrite(abs, ctx);
    const s = diffStats(original, updated);
    return {
      content: count > 1 ? `Replaced ${count} occurrences in ${input.path}` : `Edited ${input.path} at line ${line}`,
      display: `${pc.green(`+${s.added}`)} ${pc.red(`-${s.removed}`)}\n${renderDiff(original, updated, 2, 30)}`,
    };
  },
};

export const lsTool: Tool<{ path?: string }> = {
  name: 'ls',
  description: 'List a directory: entries with a trailing / are directories; files show their size.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory (default: working directory)' } },
  },
  permission: 'none',
  label: (i) => i.path ?? '.',
  async run({ path = '.' }, ctx) {
    const abs = resolvePath(path, ctx);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      throw new ToolError(`Not a directory: ${path}`);
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = await Promise.all(
      entries.slice(0, 500).map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`;
        const size = await stat(join(abs, e.name)).then((s) => s.size, () => 0);
        return `${e.name}  (${formatSize(size)})`;
      }),
    );
    if (!lines.length) return '(empty directory)';
    const more = entries.length > 500 ? `\n… ${entries.length - 500} more entries` : '';
    return { content: lines.join('\n') + more, display: pc.dim(`${entries.length} entries`) };
  },
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
