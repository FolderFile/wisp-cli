import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, type AgentEvent } from '../src/core/agent.ts';
import type { FeatureUI } from '../src/core/hooks.ts';
import { modelInfo } from '../src/core/models.ts';
import { SettingsStore } from '../src/core/settings.ts';
import type { CompletionRequest, CompletionResult, Provider } from '../src/core/types.ts';
import { installFeatures } from '../src/features/index.ts';
import { permissionsFeature } from '../src/features/permissions.ts';
import { subagentsFeature, summaryLine } from '../src/features/subagents.ts';
import { Limiter } from '../src/subagent-runner.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';

type Content = CompletionResult['content'];
const USAGE = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
const isChild = (req: CompletionRequest) => req.system.startsWith('You are a subagent');
const lastUserText = (req: CompletionRequest) => {
  const m = req.messages[0];
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
};

/** Parent and children share one provider; `parent` and `child` script each side. */
class RoutingProvider implements Provider {
  name = 'anthropic';
  model = 'claude-haiku-5-5';
  childRequests: CompletionRequest[] = [];
  constructor(
    private parent: Content[],
    private child: (req: CompletionRequest) => Content | Promise<Content>,
  ) {}
  async complete(req: CompletionRequest, h: { onText(d: string): void }): Promise<CompletionResult> {
    let content: Content;
    if (isChild(req)) {
      this.childRequests.push({ ...req, messages: structuredClone(req.messages) });
      content = await this.child(req);
    } else content = this.parent.shift() ?? [{ type: 'text', text: 'parent done' }];
    for (const b of content) if (b.type === 'text') h.onText(b.text);
    return { content, stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end', usage: USAGE };
  }
}

function fakeUI(select?: () => Promise<unknown>): FeatureUI & { asked: number } {
  const ui = {
    asked: 0,
    interactive: true,
    notice: () => {},
    flash: () => {},
    render: () => {},
    height: 40,
    select: (async () => {
      ui.asked++;
      return select ? select() : undefined;
    }) as FeatureUI['select'],
    input: async () => undefined,
  };
  return ui;
}

async function setup(provider: RoutingProvider, o: { mode?: 'yolo' | 'ask'; ui?: FeatureUI; maxConcurrent?: number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-sub-'));
  await writeFile(join(cwd, 'app.js'), 'console.log("hello")\n');
  const agent = new Agent({ cwd, provider, model: modelInfo('anthropic', 'claude-haiku-5-5'), tools: ALL_TOOLS, system: 'sys', thinking: 'low' });
  const settings = new SettingsStore(cwd, { global: join(cwd, 'g.json'), project: join(cwd, 'p.json') });
  const sub = subagentsFeature({ maxConcurrent: o.maxConcurrent });
  const ui = o.ui ?? fakeUI();
  installFeatures({ cwd, agent, settings, ui, session: () => null as any, refreshTools: () => agent.refreshTools() }, [permissionsFeature(o.mode ?? 'yolo'), sub]);
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return { cwd, agent, settings, sub, events };
}

const call = (id: string, input: Record<string, unknown>) => ({ type: 'tool_call' as const, id, name: 'subagent', input });
const user = (text: string) => [{ type: 'text' as const, text }];
const toolResults = (agent: Agent) =>
  agent.messages.flatMap((m) => m.content).filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result');

test('read subagent: fresh context, read-only tools, answer returned, cost added', async () => {
  let step = 0;
  const provider = new RoutingProvider([[call('s1', { description: 'look at app', prompt: 'What does app.js print?' })]], (req) => {
    step++;
    if (step === 1) return [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'app.js' } }];
    return [{ type: 'text', text: 'It prints hello (app.js:1).' }];
  });
  const { agent, events } = await setup(provider);
  assert.ok(agent.tools.some((t) => t.name === 'subagent'));
  await agent.run(user('go'), new AbortController().signal);

  const first = provider.childRequests[0];
  assert.equal(first.messages.length, 1, 'child starts with only the prompt');
  assert.equal(lastUserText(first), 'What does app.js print?');
  assert.deepEqual(first.tools.map((t) => t.name).sort(), ['glob', 'grep', 'ls', 'read_file']);
  assert.equal(first.thinking, 'low');

  const [r] = toolResults(agent);
  assert.match(r.content, /^It prints hello \(app\.js:1\)\.\n\n\[subagent: 1 tool call/);
  assert.ok(!r.isError);
  const end = events.find((e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end')!;
  assert.match(end.output.display!, /^done · 1 tool · .* · \$/);
  assert.ok(events.some((e) => e.type === 'tool_update'));

  // parent: 2 requests, child: 2 requests, all counted
  assert.equal(agent.usage.input, 4 * USAGE.input);
  assert.ok(agent.costUSD > 0);
});

test('write subagent: gets write tools and its edits go through approvals', async () => {
  let step = 0;
  const provider = new RoutingProvider([[call('s1', { description: 'fix app', prompt: 'Change hello to world in app.js', access: 'write' })]], () => {
    step++;
    if (step === 1) return [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'app.js' } }];
    if (step === 2) return [{ type: 'tool_call', id: 'c2', name: 'edit_file', input: { path: 'app.js', old_string: 'hello', new_string: 'world' } }];
    return [{ type: 'text', text: 'Changed app.js.' }];
  });
  const ui = fakeUI(async () => 'yes');
  const { agent, cwd } = await setup(provider, { mode: 'ask', ui });
  await agent.run(user('go'), new AbortController().signal);
  assert.ok(provider.childRequests[0].tools.some((t) => t.name === 'edit_file'));
  assert.ok(!provider.childRequests[0].tools.some((t) => t.name === 'subagent'), 'no nesting');
  assert.equal(ui.asked, 1);
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'console.log("world")\n');
  assert.match(toolResults(agent)[0].content, /^Changed app\.js\./);
});

test('at most N subagents run at once', async () => {
  let active = 0;
  let peak = 0;
  const calls = Array.from({ length: 6 }, (_, i) => call(`s${i}`, { description: `job ${i}`, prompt: `job ${i}` }));
  const provider = new RoutingProvider([calls], async (req) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return [{ type: 'text', text: `answer for ${lastUserText(req)}` }];
  });
  const { agent } = await setup(provider, { maxConcurrent: 4 });
  await agent.run(user('go'), new AbortController().signal);
  assert.equal(peak, 4);
  assert.deepEqual(
    toolResults(agent).map((r) => r.content.split('\n')[0]),
    calls.map((_, i) => `answer for job ${i}`),
  );
});

test('esc aborts running subagents', async () => {
  const ac = new AbortController();
  const provider = new RoutingProvider([[call('s1', { description: 'slow', prompt: 'slow' })]], (req) =>
    new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })))),
  );
  const { agent, sub } = await setup(provider);
  const run = agent.run(user('go'), ac.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sub.running, 1);
  ac.abort();
  await run;
  assert.equal(sub.running, 0);
  assert.equal(toolResults(agent)[0].content, 'Interrupted by user.');
});

test('the Subagents setting adds and removes the tool live', async () => {
  const { agent, settings } = await setup(new RoutingProvider([], () => []));
  assert.ok(agent.tools.some((t) => t.name === 'subagent'));
  settings.set('subagents', false);
  assert.ok(!agent.tools.some((t) => t.name === 'subagent'));
  settings.set('subagents', true);
  assert.ok(agent.tools.some((t) => t.name === 'subagent'));
});

test('limiter releases waiters in order and on abort', async () => {
  const l = new Limiter(1);
  const r1 = await l.acquire();
  const ac = new AbortController();
  const waiting = l.acquire(ac.signal);
  ac.abort();
  await assert.rejects(waiting, /Aborted/);
  const next = l.acquire();
  r1();
  (await next)();
  assert.equal(l.active, 0);
  assert.equal(summaryLine({ status: 'done', toolCount: 2, ms: 1500, cost: 0.0123 }), 'done · 2 tools · 1s · $0.012');
});
