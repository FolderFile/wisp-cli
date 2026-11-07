import type { ImageBlock, JSONSchema } from '../core/types.js';

/**
 * - none: runs without asking (read-only)
 * - edit: modifies files
 * - exec: runs arbitrary commands
 */
export type PermissionLevel = 'none' | 'edit' | 'exec';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** absolute path -> mtimeMs at last read/write; guards against blind or stale edits. */
  readFiles: Map<string, number>;
  /** Live progress (e.g. streaming command output) for the UI. */
  onUpdate?: (partial: string) => void;
}

export interface ToolOutput {
  /** What the model sees. */
  content: string;
  images?: ImageBlock[];
  /** Optional richer rendering for the transcript (e.g. a colored diff). */
  display?: string;
}

export interface Tool<I = any> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: PermissionLevel;
  /** Set for tools that come from an MCP server. */
  mcp?: { server: string; tool: string; readOnly: boolean };
  /** Short label for the transcript, e.g. the file path or command. */
  label(input: I): string;
  /** What the user sees when asked to approve (e.g. a diff). */
  preview?(input: I, ctx: ToolContext): Promise<string>;
  run(input: I, ctx: ToolContext): Promise<string | ToolOutput>;
}

export class ToolError extends Error {}

export const toOutput = (r: string | ToolOutput): ToolOutput => (typeof r === 'string' ? { content: r } : r);

/** Minimal validation against our flat schemas: required keys + primitive types. */
export function validateInput(tool: Tool, input: Record<string, unknown>): string | null {
  if ('_invalid_arguments' in input)
    return `Arguments were not valid JSON: ${String(input._invalid_arguments).slice(0, 200)}`;
  for (const key of tool.inputSchema.required ?? []) {
    if (input[key] === undefined || input[key] === null) return `Missing required parameter "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = tool.inputSchema.properties?.[key];
    if (!prop || value === undefined || value === null) continue;
    // Only check simple top-level types; complex schemas (anyOf, unions) are left to the tool.
    if (typeof prop.type === 'string' && !matchesType(value, prop.type)) return `Parameter "${key}" must be of type ${prop.type}`;
    if (prop.enum && !prop.enum.includes(value as string))
      return `Parameter "${key}" must be one of: ${prop.enum.join(', ')}`;
  }
  return null;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}
