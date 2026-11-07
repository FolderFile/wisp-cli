import { readFile, readdir, stat } from 'node:fs/promises';
import { displayPath, IMAGE_TYPES, isBinary, loadImage, resolvePath } from '../tools/files.js';
import type { UserContent } from './types.js';
import { extname } from 'node:path';

const MAX_ATTACH_BYTES = 256 * 1024;

export const MENTION = /(^|\s)@(?:"([^"]+)"|([^\s"]+))/g;

export interface Attachment {
  path: string;
  kind: 'file' | 'image' | 'dir';
  note?: string;
}

/**
 * Turn a prompt into message content: the text itself, plus the contents of
 * every @mentioned file (text inline, images as image blocks, directories as
 * listings). Unresolvable mentions are left as plain text.
 */
export async function buildUserContent(
  text: string,
  cwd: string,
  opts: { images: boolean; readFiles?: Map<string, number> },
): Promise<{ content: UserContent[]; attachments: Attachment[] }> {
  const content: UserContent[] = [{ type: 'text', text }];
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const raw = (m[2] ?? m[3]).replace(/[),.;:!?]+$/, '');
    const abs = resolvePath(raw, { cwd });
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    const shown = displayPath(abs, cwd);
    if (st.isDirectory()) {
      const entries = (await readdir(abs, { withFileTypes: true })).slice(0, 300);
      const listing = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort().join('\n');
      content.push({ type: 'text', text: `<directory path="${shown}">\n${listing}\n</directory>` });
      attachments.push({ path: shown, kind: 'dir' });
      continue;
    }
    if (IMAGE_TYPES[extname(abs).toLowerCase()]) {
      if (!opts.images) {
        attachments.push({ path: shown, kind: 'image', note: 'skipped: model has no image support' });
        continue;
      }
      const img = await loadImage(abs);
      if (img) {
        content.push(img);
        attachments.push({ path: shown, kind: 'image' });
      }
      continue;
    }
    if (st.size > MAX_ATTACH_BYTES) {
      attachments.push({ path: shown, kind: 'file', note: `too large to attach (${Math.round(st.size / 1024)} KB); the model can read it with read_file` });
      continue;
    }
    const buf = await readFile(abs);
    if (isBinary(buf)) {
      attachments.push({ path: shown, kind: 'file', note: 'binary, not attached' });
      continue;
    }
    content.push({ type: 'text', text: `<file path="${shown}">\n${buf.toString('utf8')}\n</file>` });
    // The model has now seen this exact content, so it may edit it directly.
    opts.readFiles?.set(abs, st.mtimeMs);
    attachments.push({ path: shown, kind: 'file' });
  }
  return { content, attachments };
}

/** A pasted/dropped path to an image: terminals paste file paths on drag-and-drop. */
export function droppedImagePath(text: string): string | null {
  let t = text.trim();
  if (t.includes('\n')) return null;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1);
  t = t.replace(/\\ /g, ' ');
  if (t.startsWith('file://')) t = decodeURIComponent(t.slice(7));
  return IMAGE_TYPES[extname(t).toLowerCase()] && (t.startsWith('/') || t.startsWith('~/')) ? t : null;
}
