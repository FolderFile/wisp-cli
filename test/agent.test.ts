import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, type AgentEvent, type Approval } from '../src/core/agent.ts';
import { modelInfo } from '../src/core/models.ts';
import type { CompletionRequest, CompletionResult, Message, Provider } from '../src/core/types.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';

type Script = CompletionResult['content'] | ((req: CompletionRequest) => CompletionResult['content']);

/** Replays scripted responses and records what it was sent. */
class FakeProvider implements Provider {
  name = 'anthropic';
  model = 'claude-opus-5-5';
  seen: Message[][] = [];
  constructor(private script: Script[], private usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }) {}
  async complete(req: CompletionRequest, h: { onText(d: string): void }): Promise<CompletionResult> {
    this.seen.push(structuredClone(req.messages));
    const next = this.script.shift() ?? [{ type: 'text' as const, text: 'done' }];
    const content = typeof next === 'function' ? next(req) : next;
    for (const b of content) if (b.type === 'text') h.onText(b.text);
    const hasCalls = content.some((b) => b.type === 'tool_call');
    return { content, stopReason: hasCalls ? 'tool_use' : 'end', usage: this.usage };
  }
}

async function setup(script: Script[], answer: Approval | null, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-agent-'));
  await writeFile(join(cwd, 'app.js'), 'console.log("hello")\n');
  const provider = new FakeProvider(script);
  const agent = new Agent({
    cwd,
    provider,
    model: modelInfo('anthropic', 'claude-opus-5-5'),
    tools: ALL_TOOLS,
    system: 'sys',
    thinking: 'medium',
    permissionMode: 'ask',
    approver: answer === null ? null : async () => answer,
    ...extra,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return { cwd, provider, agent, events };
}

const user = (text: string) => [{ type: 'text' as const, text }];

test('tool round trip: read, approved edit, final answer; usage and cost tracked', async () => {
  const { cwd, provider, agent, events } = await setup(
    [
      [{ type: 'thinking', thinking: 'plan', signature: 'sig', provider: 'anthropic' }, { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'app.js' } }],
      [{ type: 'text', text: 'Editing.' }, { type: 'tool_call', id: 't2', name: 'edit_file', input: { path: 'app.js', old_string: 'hello', new_string: 'world' } }],
      [{ type: 'text', text: 'All done.' }],
    ],
    'yes',
  );
  await agent.run(user('change hello to world'), new AbortController().signal);
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'console.log("world")\n');
  assert.equal(provider.seen.length, 3);
  // thinking blocks are kept in history (they must be replayed to the API)
  assert.equal(provider.seen[1][1].content[0].type, 'thinking');
  assert.equal((provider.seen[1].at(-1)!.content[0] as any).content, '1\tconsole.log("hello")');
  assert.equal(agent.messages.length, 6);
  assert.deepEqual(agent.usage, { input: 300, output: 30, cacheRead: 0, cacheWrite: 0 });
  assert.ok(Math.abs(agent.costUSD - (300 * 4 + 30 * 20) / 1e6) < 1e-12);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('tool_start') && types.includes('tool_end') && types.at(-1) === 'turn_end');
  assert.equal(events.filter((e) => e.type === 'message').length, 6);
});

test('denial halts the turn; history stays valid for the next turn', async () => {
  const { cwd, provider, agent } = await setup(
    [[
      { type: 'tool_call', id: 'b1', name: 'bash', input: { command: 'rm app.js' } },
      { type: 'tool_call', id: 'b2', name: 'bash', input: { command: 'echo second' } },
    ]],
    'no',
  );
  await agent.run(user('delete it'), new AbortController().signal);
  assert.equal(provider.seen.length, 1, 'model not called again after denial');
  await readFile(join(cwd, 'app.js')); // still exists
  const last = agent.messages.at(-1)!;
  assert.match((last.content[0] as any).content, /denied/);
  assert.equal((last.content[1] as any).content, 'Skipped.');
  await agent.run(user('ok, never mind'), new AbortController().signal);
  assert.deepEqual(agent.messages.map((m) => m.role), ['user', 'assistant', 'user', 'user', 'assistant']);
});

test('"always" approval is remembered per tool; auto-edit and yolo modes', async () => {
  let asked = 0;
  const { agent } = await setup(
    [
      [{ type: 'tool_call', id: 'a', name: 'bash', input: { command: 'true' } }],
      [{ type: 'tool_call', id: 'b', name: 'bash', input: { command: 'true' } }],
      [{ type: 'tool_call', id: 'c', name: 'write_file', input: { path: 'x.txt', content: 'x' } }],
    ],
    'always',
    { approver: async () => (asked++, 'always'), permissionMode: 'auto-edit' },
  );
  await agent.run(user('go'), new AbortController().signal);
  assert.equal(asked, 1, 'bash asked once, then remembered; write_file auto-approved');
});

test('steering messages are delivered with the next tool results; queued text at the end continues the turn', async () => {
  let agentRef: Agent;
  const { provider, agent } = await setup(
    [
      () => {
        agentRef.steer('also check README');
        return [{ type: 'tool_call', id: 'r', name: 'ls', input: {} }];
      },
      () => {
        agentRef.steer('and say bye');
        return [{ type: 'text', text: 'checked' }];
      },
      [{ type: 'text', text: 'bye' }],
    ],
    'yes',
  );
  agentRef = agent;
  await agent.run(user('list files'), new AbortController().signal);
  const second = provider.seen[1].at(-1)!;
  assert.equal(second.content[0].type, 'tool_result');
  assert.deepEqual(second.content[1], { type: 'text', text: 'also check README' });
  assert.deepEqual(provider.seen[2].at(-1)!.content, [{ type: 'text', text: 'and say bye' }]);
  assert.equal(provider.seen.length, 3);
});

test('non-interactive mode: approval-requiring tools report how to allow them; bad calls become errors', async () => {
  const { cwd, agent } = await setup(
    [
      [
        { type: 'tool_call', id: 'x1', name: 'nope', input: {} },
        { type: 'tool_call', id: 'x2', name: 'read_file', input: {} },
      ],
      [{ type: 'tool_call', id: 'x3', name: 'write_file', input: { path: 'new.txt', content: 'x' } }],
    ],
    null,
  );
  await agent.run(user('go'), new AbortController().signal);
  const results = agent.messages[2].content as any[];
  assert.match(results[0].content, /Unknown tool/);
  assert.match(results[1].content, /Missing required/);
  assert.match((agent.messages[4].content[0] as any).content, /--auto-edit or --yes/);
  await assert.rejects(readFile(join(cwd, 'new.txt')));
});

test('read-only tools run in parallel', async () => {
  const { agent, events } = await setup(
    [[
      { type: 'tool_call', id: 'g1', name: 'glob', input: { pattern: '*.js' } },
      { type: 'tool_call', id: 'g2', name: 'ls', input: {} },
    ]],
    'yes',
  );
  await agent.run(user('look'), new AbortController().signal);
  const order = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => e.type);
  assert.deepEqual(order.slice(0, 2), ['tool_start', 'tool_start']);
});

test('compaction replaces history with a summary; auto-compacts near the context limit', async () => {
  const { agent, provider, events } = await setup(
    [
      [{ type: 'text', text: 'first answer' }],
      [{ type: 'text', text: 'SUMMARY: user wants X' }],
      [{ type: 'text', text: 'continuing' }],
    ],
    'yes',
    { autoCompactAt: 0.5, model: { ...modelInfo('anthropic', 'claude-opus-5-5'), contextWindow: 150 } },
  );
  agent.messages.push(...Array.from({ length: 5 }, (_, i): Message => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `m${i}` }] })));
  await agent.run(user('hi'), new AbortController().signal); // usage 110 > 75 → next run compacts first
  await agent.run(user('more'), new AbortController().signal);
  assert.ok(events.some((e) => e.type === 'compaction_end'));
  const sent = provider.seen[2];
  assert.match((sent[0].content[0] as any).text, /SUMMARY: user wants X/);
  assert.equal((sent.at(-1)!.content[0] as any).text, 'Continue with the task where you left off.');
});
