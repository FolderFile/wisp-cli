import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../src/core/types.ts';
import {
  createTodoTool,
  currentIndex,
  renderTodoWidget,
  summarizeTodos,
  todosFromMessages,
  validateTodos,
  type TodoItem,
} from '../src/todo-state.ts';
import { ToolError, type ToolContext } from '../src/tools/types.ts';

const ctx: ToolContext = { cwd: '/', signal: new AbortController().signal, readFiles: new Map() };

const list: TodoItem[] = [
  { content: 'Read the parser', status: 'completed' },
  { content: 'Write tests', status: 'completed' },
  { content: 'Fix the bug', status: 'in_progress' },
  { content: 'Update docs', status: 'pending' },
  { content: 'Release', status: 'pending' },
];

const call = (id: string, todos: unknown): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_call', id, name: 'todo', input: { todos } }],
});
const result = (id: string, isError = false): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', id, content: 'ok', isError }],
});

test('validateTodos tidies text and accepts a JSON string', () => {
  assert.deepEqual(validateTodos([{ content: '  a \n b ', status: 'pending' }]), [{ content: 'a b', status: 'pending' }]);
  assert.deepEqual(validateTodos('[{"content":"x","status":"completed"}]'), [{ content: 'x', status: 'completed' }]);
  assert.deepEqual(validateTodos([]), []);
});

test('validateTodos rejects bad input', () => {
  assert.throws(() => validateTodos({}), ToolError);
  assert.throws(() => validateTodos([{ content: '', status: 'pending' }]), /no content/);
  assert.throws(() => validateTodos([{ content: 'a', status: 'done' }]), /status "done"/);
  assert.throws(
    () => validateTodos([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]),
    /at most one/,
  );
});

test('summarizeTodos', () => {
  assert.equal(summarizeTodos([]), 'Todo list cleared.');
  assert.equal(summarizeTodos([{ content: 'a', status: 'completed' }]), 'All 1 todos completed.');
  assert.equal(summarizeTodos(list), 'Todos updated: 2/5 completed, 1 in progress, 2 pending. In progress: "Fix the bug".');
});

test('currentIndex falls back to the first pending item', () => {
  assert.equal(currentIndex(list), 2);
  assert.equal(currentIndex([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]), 1);
  assert.equal(currentIndex([{ content: 'a', status: 'completed' }]), -1);
});

test('renderTodoWidget shows progress and the current item', () => {
  assert.equal(renderTodoWidget(list), '◐ 2/5 · Fix the bug');
  assert.equal(renderTodoWidget([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]), '○ 1/2 · b');
  assert.equal(renderTodoWidget([]), '');
  assert.equal(renderTodoWidget([{ content: 'a', status: 'completed' }]), '');
  assert.equal(renderTodoWidget(list, {}, 14), '◐ 2/5 · Fix t…');
  assert.equal(renderTodoWidget(list, { accent: (s) => `[${s}]` }), '[◐] 2/5 · Fix the bug');
});

test('todosFromMessages takes the latest successful todo call', () => {
  const messages: Message[] = [
    call('1', [{ content: 'a', status: 'in_progress' }]),
    result('1'),
    call('2', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]),
    result('2'),
    call('3', [{ content: 'bad', status: 'nope' }]),
    result('3', true),
    call('4', [{ content: 'pending result', status: 'pending' }]),
  ];
  assert.deepEqual(todosFromMessages(messages), [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
  ]);
  assert.deepEqual(todosFromMessages([]), []);
  assert.deepEqual(todosFromMessages([...messages, call('5', []), result('5')]), []);
});

test('todosFromMessages ignores other tools', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 'x', name: 'bash', input: { todos: [] } }] },
    result('x'),
  ];
  assert.deepEqual(todosFromMessages(messages), []);
});

test('todo tool replaces the list and reports a summary', async () => {
  const seen: TodoItem[][] = [];
  const tool = createTodoTool((t) => seen.push(t));
  assert.equal(tool.name, 'todo');
  assert.equal(tool.permission, 'none');
  const out = await tool.run({ todos: list }, ctx);
  assert.equal(typeof out === 'string' ? out : out.content, summarizeTodos(list));
  assert.deepEqual(tool.current(), list);
  assert.equal(tool.label({ todos: list }), '2/5');
  await assert.rejects(tool.run({ todos: 'nope' }, ctx), ToolError);
  assert.deepEqual(tool.current(), list);
  assert.deepEqual(tool.reset([call('1', []), result('1')]), []);
  assert.equal(seen.length, 2);
});

test('feature: widget line follows the list, is rebuilt on load, and the setting removes the tool', async () => {
  const { Agent } = await import('../src/core/agent.ts');
  const { modelInfo } = await import('../src/core/models.ts');
  const { SettingsStore } = await import('../src/core/settings.ts');
  const { installFeatures, featureWidgets } = await import('../src/features/index.ts');
  const { todoFeature } = await import('../src/features/todo.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const stripAnsi = (await import('strip-ansi')).default;
  const cwd = mkdtempSync(join(tmpdir(), 'wisp-todo-'));
  const todos = [
    { content: 'Read the code', status: 'completed' },
    { content: 'Fix the bug', status: 'in_progress' },
  ];
  const script: any[] = [[{ type: 'tool_call', id: 't1', name: 'todo', input: { todos } }], [{ type: 'text', text: 'ok' }]];
  const provider = {
    name: 'anthropic',
    model: 'claude-haiku-5-5',
    async complete() {
      const content = script.shift();
      return { content, stopReason: content[0].type === 'tool_call' ? 'tool_use' : 'end', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  } as never;
  const agent = new Agent({ cwd, provider, model: modelInfo('anthropic', 'claude-haiku-5-5'), tools: [], system: 'sys', thinking: 'off' });
  const settings = new SettingsStore(cwd, { global: join(cwd, 'g.json'), project: join(cwd, 'p.json') });
  const ui = { interactive: true, notice: () => {}, flash: () => {}, render: () => {}, height: 24, select: async () => undefined, input: async () => undefined } as never;
  const f = todoFeature();
  installFeatures({ cwd, agent, settings, ui, session: () => null as never, refreshTools: () => agent.refreshTools() }, [f]);
  await agent.run([{ type: 'text', text: 'go' }], new AbortController().signal);
  assert.deepEqual(featureWidgets([f]).map((l) => stripAnsi(l)), ['◐ 1/2 · Fix the bug']);
  agent.load([]);
  f.sessionLoaded!({ session: null as never, reason: 'new' });
  assert.deepEqual(featureWidgets([f]), []);
  settings.set('todo', false);
  assert.ok(!agent.tools.some((t) => t.name === 'todo'));
});
