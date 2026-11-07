import { bashTool } from './bash.js';
import { editFileTool, lsTool, readFileTool, writeFileTool } from './files.js';
import { globTool, grepTool } from './search.js';
import type { Tool } from './types.js';

export const ALL_TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, bashTool, grepTool, globTool, lsTool];

/** Apply a --tools list: plain names replace the set; +name/-name modify the default. */
export function selectTools(spec: string | undefined): Tool[] {
  if (!spec) return ALL_TOOLS;
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
  const unknown = parts.map((p) => p.replace(/^[+-]/, '')).filter((n) => !byName.has(n));
  if (unknown.length) throw new Error(`Unknown tool(s): ${unknown.join(', ')}. Available: ${[...byName.keys()].join(', ')}`);
  if (parts.every((p) => p.startsWith('+') || p.startsWith('-'))) {
    const set = new Set(ALL_TOOLS.map((t) => t.name));
    for (const p of parts) p.startsWith('+') ? set.add(p.slice(1)) : set.delete(p.slice(1));
    return ALL_TOOLS.filter((t) => set.has(t.name));
  }
  return parts.map((p) => byName.get(p)!);
}
