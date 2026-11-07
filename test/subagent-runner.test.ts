import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { modelInfo } from '../src/core/models.ts';
import type { CompletionRequest, CompletionResult, Provider } from '../src/core/types.ts';
import {
  createSubagentTool,
  Limiter,
  READ_TOOLS,
  runSubagent,
  SUBAGENT_TOOL_SPEC,
  type SubagentProgress,
} from '../src/subagent-runner.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';

type Step = CompletionResult['content'] | ((req: CompletionRequest) => CompletionResult['content'] | Promise<CompletionResult['content']>);

/** Replays scripted responses; records the tool specs it was offered. */
class FakeProvider implements Provider {
  name = 'anthropic';
  model = 'claude-opus-5-5';
  offered: string[][] = [];
  constructor(private script: Step[]) {}
  async complete(req: CompletionRequest, h: { onText(d: string): void }): Promise<CompletionResult> {
    this.offered.push(req.tools.map((t) => t.name));
    if (req.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const next = this.script.shift() ?? [{ type: 'text' as const, text: 'done' }];
    const content = typeof next === 'function' ? await next(req) : next;
    for (const b of content) if (b.type === 'text') h.onText(b.text);
    return { content, stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
  }
}

const model = modelInfo('anthropic', 'claude-opus-5-5');

async function tmp() {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-sub-'));
  await writeFile(join(cwd, 'app.js'), 'console.log("hello")\n');
  return cwd;
}

test('tool spec is well-formed', () => {
  assert.equal(SUBAGENT_TOOL_SPEC.name, 'subagent');
  assert.deepEqual(SUBAGENT_TOOL_SPEC.inputSchema.required, ['description', 'prompt']);
  assert.deepEqual(SUBAGENT_TOOL_SPEC.inputSchema.properties.access.enum, ['read', 'write']);
  assert.match(SUBAGENT_TOOL_SPEC.description, /Do not use it for/);
});

test('child runs tools and returns its final answer, usage and cost', async () => {
  const cwd = await tmp();
  const provider = new FakeProvider([
    [{ type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'app.js' } }],
    (req) => {
      const last = req.messages.at(-1)!;
      const r = last.content.find((b) => b.type === 'tool_result') as { content: string };
      assert.match(r.content, /hello/);
      return [{ type: 'text', text: 'app.js logs hello' }];
    },
  ]);
  const seen: SubagentProgress[] = [];
  const r = await runSubagent({ description: 'look', prompt: 'what does app.js do', provider, model, thinking: 'low', tools: ALL_TOOLS, cwd, onProgress: (p) => seen.push(p) });
  assert.equal(r.status, 'done');
  assert.equal(r.text, 'app.js logs hello');
  assert.equal(r.toolCount, 1);
  assert.equal(r.usage.input, 200);
  assert.ok(r.cost > 0);
  assert.ok(r.activity[0].startsWith('read_file'));
  assert.equal(seen.at(-1)!.status, 'done');
  assert.ok(seen.some((p) => p.status === 'running' && p.toolCount === 1));
});

test('read access offers only read tools and rejects write calls', async () => {
  const cwd = await tmp();
  const provider = new FakeProvider([
    [{ type: 'tool_call', id: 't1', name: 'write_file', input: { path: 'app.js', content: 'pwned' } }],
    (req) => {
      const r = req.messages.at(-1)!.content.find((b) => b.type === 'tool_result') as { content: string; isError?: boolean };
      assert.equal(r.isError, true);
      assert.match(r.content, /Unknown tool/);
      return [{ type: 'text', text: 'could not write' }];
    },
  ]);
  const r = await runSubagent({ description: 'x', prompt: 'write', provider, model, thinking: 'off', tools: ALL_TOOLS, cwd });
  assert.equal(r.status, 'done');
  assert.deepEqual([...provider.offered[0]].sort(), [...READ_TOOLS].sort());
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'console.log("hello")\n');
});

test('write access gets mutating tools; refused without any; never gets subagent', async () => {
  const cwd = await tmp();
  const sub = createSubagentTool({ context: () => ({ provider, model, thinking: 'off', tools: [] }) });
  const provider = new FakeProvider([
    [{ type: 'tool_call', id: 't1', name: 'write_file', input: { path: 'new.txt', content: 'hi' } }],
    [{ type: 'text', text: 'wrote new.txt' }],
  ]);
  const r = await runSubagent({ description: 'x', prompt: 'write', access: 'write', provider, model, thinking: 'off', tools: [...ALL_TOOLS, sub], cwd });
  assert.equal(r.status, 'done');
  assert.ok(provider.offered[0].includes('write_file'));
  assert.ok(!provider.offered[0].includes('subagent'));
  assert.equal(await readFile(join(cwd, 'new.txt'), 'utf8'), 'hi');

  const readOnly = ALL_TOOLS.filter((t) => READ_TOOLS.includes(t.name));
  const refused = await runSubagent({ description: 'x', prompt: 'write', access: 'write', provider: new FakeProvider([]), model, thinking: 'off', tools: readOnly, cwd });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error!, /No write tools/);
});

test('concurrency is capped by the limiter', async () => {
  const cwd = await tmp();
  const limiter = new Limiter(2);
  let active = 0;
  let peak = 0;
  const gate = () => async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return [{ type: 'text' as const, text: 'ok' }];
  };
  const waiting: string[] = [];
  const runs = Array.from({ length: 5 }, (_, i) =>
    runSubagent({
      description: `t${i}`,
      prompt: 'p',
      provider: new FakeProvider([gate()]),
      model,
      thinking: 'off',
      tools: ALL_TOOLS,
      cwd,
      limiter,
      onProgress: (p) => p.status === 'waiting' && waiting.push(p.description),
    }),
  );
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.status === 'done'));
  assert.equal(peak, 2);
  assert.equal(waiting.length, 3);
  assert.equal(limiter.active, 0);
});

test('abort stops a running child and a queued one', async () => {
  const cwd = await tmp();
  const limiter = new Limiter(1);
  const ac = new AbortController();
  const hang: Step = (req) =>
    new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))));
  const running = runSubagent({ description: 'a', prompt: 'p', provider: new FakeProvider([hang]), model, thinking: 'off', tools: ALL_TOOLS, cwd, limiter, signal: ac.signal });
  const queued = runSubagent({ description: 'b', prompt: 'p', provider: new FakeProvider([]), model, thinking: 'off', tools: ALL_TOOLS, cwd, limiter, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(limiter.waiting, 1);
  ac.abort();
  const [a, b] = await Promise.all([running, queued]);
  assert.equal(a.status, 'stopped');
  assert.equal(b.status, 'stopped');
  assert.equal(limiter.active, 0);
  assert.equal(limiter.waiting, 0);
});

test('subagent tool returns the answer with a usage note and reports usage', async () => {
  const cwd = await tmp();
  let billed = 0;
  const tool = createSubagentTool({
    context: () => ({ provider: new FakeProvider([[{ type: 'text', text: 'the answer' }]]), model, thinking: 'off', tools: ALL_TOOLS }),
    onUsage: (u) => (billed += u.input),
  });
  const out = await tool.run({ description: 'd', prompt: 'p' }, { cwd, signal: new AbortController().signal, readFiles: new Map() });
  const content = typeof out === 'string' ? out : out.content;
  assert.match(content, /^the answer\n\n\[subagent: 0 tool calls, 0s, 110 tokens\]$/);
  assert.equal(billed, 100);
});
