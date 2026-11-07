/**
 * Todo list: a `todo` tool the model uses to keep a visible checklist for multi-step work.
 *
 * Every call sends the whole list (it replaces the previous one): items with `content` and a
 * `status` of pending, in_progress or completed, at most one in progress. The model gets a
 * one-line summary back. While anything is unfinished, a one-line widget shows the progress and
 * the current item ("◐ 2/5 · Writing tests").
 *
 * No state is stored separately: the list in effect is the input of the latest successful todo
 * call on the branch, so `todosFromMessages` rebuilds it after resume, fork or /tree.
 */

import type { JSONSchema, Message } from './core/types.js';
import { ToolError, type Tool, type ToolOutput } from './tools/types.js';

export const TODO_TOOL = 'todo';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface TodoInput {
  todos: unknown;
}

export const TODO_DESCRIPTION = `Keep a checklist of the steps of the current task. The user sees it while you work, as your plan and your progress.

Use it when a task has 3 or more distinct steps, or when the user gives you several things to do. Skip it for a single simple change, a question, or anything you can finish in a step or two.

- Send the whole list on every call; it replaces the previous one.
- Exactly one item is in_progress while you work on it: mark it before you start, and mark it completed as soon as it is done (not in a batch at the end).
- Add items you discover, and remove ones that no longer apply.
- Call it only when the list changes. If the user changes direction, update the list, or send an empty list to clear it.`;

// The flat JSONSchema type has no `items`; the full schema is still sent to the provider as-is.
export const TODO_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The complete list, in order. An empty list clears it.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The step, in a few words (imperative, e.g. "Add tests for the parser").' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        },
        required: ['content', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
} as unknown as JSONSchema;

// --- List logic ------------------------------------------------------------------------------

/** Some models send the array as a JSON string. */
function coerce(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/** Check a list sent by the model; returns it with tidied text, or throws a ToolError for the model. */
export function validateTodos(input: unknown): TodoItem[] {
  input = coerce(input);
  if (!Array.isArray(input)) throw new ToolError('todos must be an array of {content, status} items.');
  const todos: TodoItem[] = [];
  for (const [index, raw] of input.entries()) {
    const item = raw as Partial<TodoItem> | null;
    const content = typeof item?.content === 'string' ? item.content.replace(/\s+/g, ' ').trim() : '';
    if (!content) throw new ToolError(`Item ${index + 1} has no content.`);
    const status = item?.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new ToolError(`Item ${index + 1} has status ${JSON.stringify(status)}; use pending, in_progress or completed.`);
    }
    todos.push({ content, status });
  }
  const active = todos.filter((t) => t.status === 'in_progress').length;
  if (active > 1) throw new ToolError(`${active} items are in_progress; at most one can be. Mark the others pending or completed.`);
  return todos;
}

export function unfinished(todos: readonly TodoItem[]): boolean {
  return todos.some((t) => t.status !== 'completed');
}

/** The item being worked on: the one in progress, else the first pending one (-1 if none). */
export function currentIndex(todos: readonly TodoItem[]): number {
  const active = todos.findIndex((t) => t.status === 'in_progress');
  return active >= 0 ? active : todos.findIndex((t) => t.status === 'pending');
}

/** What the model gets back: 'Todos updated: 2/5 completed, 1 in progress, 2 pending. In progress: "…".' */
export function summarizeTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Todo list cleared.';
  const done = todos.filter((t) => t.status === 'completed').length;
  if (done === todos.length) return `All ${todos.length} todos completed.`;
  const active = todos.find((t) => t.status === 'in_progress');
  const pending = todos.filter((t) => t.status === 'pending').length;
  const counts = [`${done}/${todos.length} completed`, ...(active ? ['1 in progress'] : []), ...(pending ? [`${pending} pending`] : [])];
  return `Todos updated: ${counts.join(', ')}.${active ? ` In progress: ${JSON.stringify(active.content)}.` : ''}`;
}

/**
 * The list in effect at the end of `messages` (the current branch): the input of the last todo
 * call whose result is not an error. Calls without a result yet, or with invalid input, are skipped.
 */
export function todosFromMessages(messages: readonly Message[]): TodoItem[] {
  const calls = new Map<string, unknown>();
  let todos: TodoItem[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call' && block.name === TODO_TOOL) calls.set(block.id, block.input?.todos);
      else if (block.type === 'tool_result' && calls.has(block.id)) {
        const input = calls.get(block.id);
        calls.delete(block.id);
        if (block.isError) continue;
        try {
          todos = validateTodos(input);
        } catch {
          // Not a list we would have accepted; keep the previous one.
        }
      }
    }
  }
  return todos;
}

// --- Rendering -------------------------------------------------------------------------------

/** Optional coloring for the widget line; identity by default. */
export interface TodoStyle {
  accent?(s: string): string;
  muted?(s: string): string;
  dim?(s: string): string;
  text?(s: string): string;
}

const id = (s: string) => s;

/** "◐ 2/5 · Writing tests" (○ when nothing is in progress); '' when nothing is unfinished. */
export function renderTodoWidget(todos: readonly TodoItem[], style: TodoStyle = {}, width?: number): string {
  if (!unfinished(todos)) return '';
  const { accent = id, muted = id, dim = id, text = id } = style;
  const index = currentIndex(todos);
  const done = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos[index]?.status === 'in_progress';
  const head = inProgress ? accent('◐') : dim('○');
  const prefix = `◐ ${done}/${todos.length} · `;
  let content = todos[index]?.content ?? '';
  if (width !== undefined && width > 0) {
    const room = Math.max(1, width - [...prefix].length);
    const chars = [...content];
    if (chars.length > room) content = chars.slice(0, Math.max(0, room - 1)).join('') + '…';
  }
  return `${head} ${muted(`${done}/${todos.length}`)}${dim(' · ')}${text(content)}`;
}

/** The whole list, one line per item (for an expanded transcript view). */
export function renderTodoList(todos: readonly TodoItem[]): string[] {
  if (todos.length === 0) return ['Cleared'];
  return todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`);
}

// --- Tool ------------------------------------------------------------------------------------

/**
 * The todo tool. `onChange` receives each accepted list (to refresh the widget); the list is
 * also returned by `current()`, and `reset(messages)` rebuilds it from a branch.
 */
export function createTodoTool(onChange?: (todos: TodoItem[]) => void): Tool<TodoInput> & {
  current(): TodoItem[];
  reset(messages: readonly Message[]): TodoItem[];
} {
  let todos: TodoItem[] = [];
  return {
    name: TODO_TOOL,
    description: TODO_DESCRIPTION,
    inputSchema: TODO_SCHEMA,
    permission: 'none',
    label(input) {
      const list = coerce(input?.todos);
      if (!Array.isArray(list)) return '';
      if (list.length === 0) return 'cleared';
      const done = list.filter((t) => t?.status === 'completed').length;
      return `${done}/${list.length}`;
    },
    async run(input): Promise<ToolOutput> {
      const next = validateTodos(input?.todos);
      todos = next;
      onChange?.(next);
      return { content: summarizeTodos(next), display: renderTodoList(next).join('\n') };
    },
    current: () => todos,
    reset(messages) {
      todos = todosFromMessages(messages);
      onChange?.(todos);
      return todos;
    },
  };
}
