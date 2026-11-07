import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Isolate ~/.wisp before modules read it.
const home = await mkdtemp(join(tmpdir(), 'wisp-home-'));
process.env.WISP_HOME = home;
process.env.WISP_SESSION_DIR = join(home, 'sessions');

const { Session, forkSession, listSessions, readEntries, restore, findSession, buildTurnTree, countBranches } = await import('../src/core/session.ts');
const { discoverContextFiles, discoverPromptTemplates, discoverSkills, expandTemplate, buildSystemPrompt } = await import('../src/core/context.ts');
const { buildUserContent, droppedImagePath } = await import('../src/core/input.ts');
const { parseModelRef, resolveModel } = await import('../src/core/config.ts');
const { clampThinking, modelInfo } = await import('../src/core/models.ts');

const msg = (role: 'user' | 'assistant', text: string) => ({ role, content: [{ type: 'text' as const, text }] }) as any;

test('sessions: lazy file creation, restore, list, find, fork, compaction', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-proj-'));
  const s = Session.create(cwd, { persist: true });
  s.log({ type: 'model', provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' });
  assert.equal(listSessions(cwd).length, 0, 'no file until there is a message');
  s.log({ type: 'message', message: msg('user', 'first question') });
  s.log({ type: 'message', message: msg('assistant', 'answer 1') });
  s.log({ type: 'name', name: 'my session' });
  s.log({ type: 'message', message: msg('user', 'second question') });
  s.log({ type: 'message', message: msg('assistant', 'answer 2') });

  const [info] = listSessions(cwd);
  assert.equal(info.name, 'my session');
  assert.equal(info.firstMessage, 'first question');
  assert.equal(info.messageCount, 4);
  assert.equal(findSession(s.id.slice(0, 4), cwd)?.path, s.path);

  const state = restore(readEntries(s.path!));
  assert.equal(state.messages.length, 4);
  assert.equal(state.model?.thinking, 'high');

  const secondId = (s.entries.filter((e: any) => e.type === 'message')[2] as any).id;
  const fork = forkSession(s.entries, cwd, true, secondId);
  assert.deepEqual(restore(fork.entries).messages.map((m: any) => m.content[0].text), ['first question', 'answer 1']);
  assert.equal(fork.name, 'my session');
  assert.equal(listSessions(cwd).length, 2);

  s.log({ type: 'compaction', summary: 'they asked two things', tokensBefore: 1000 });
  s.log({ type: 'message', message: msg('user', 'third') });
  const after = restore(readEntries(s.path!));
  assert.equal(after.messages.length, 2);
  assert.match(after.messages[0].content[0].text, /they asked two things/);
});

test('session tree: branch from an earlier turn, navigate, legacy files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-tree-'));
  const s = Session.create(cwd, { persist: true });
  const say = (role: 'user' | 'assistant', text: string) => s.log({ type: 'message', message: msg(role, text) });
  say('user', 'A');
  say('assistant', 'a');
  say('user', 'B');
  say('assistant', 'b');

  let tree = buildTurnTree(s.entries);
  assert.equal(tree.length, 1);
  const turnA = tree[0];
  assert.equal(turnA.label, 'A');
  assert.equal(turnA.children[0].label, 'B');
  assert.ok(turnA.children[0].current);

  // go back to the end of turn A and take a different path
  s.moveHead(turnA.endId);
  assert.deepEqual(restore(s.entries).messages.map((m: any) => m.content[0].text), ['A', 'a']);
  say('user', 'C');
  say('assistant', 'c');
  tree = buildTurnTree(s.entries);
  assert.deepEqual(tree[0].children.map((t: any) => [t.label, t.onPath, t.current]), [['B', false, false], ['C', true, true]]);
  assert.equal(countBranches(tree), 1);

  // "edit B": continue from just before B
  const B = tree[0].children[0];
  s.moveHead(B.parentId);
  say('user', 'B2');
  assert.deepEqual(buildTurnTree(s.entries)[0].children.map((t: any) => t.label), ['B', 'C', 'B2']);

  // the file restores to the same branch
  assert.deepEqual(restore(readEntries(s.path!)).messages.map((m: any) => m.content[0].text), ['A', 'a', 'B2']);
  // forking copies only the active branch
  assert.deepEqual(restore(forkSession(s.entries, cwd, false).entries).messages.map((m: any) => m.content[0].text), ['A', 'a', 'B2']);

  // tool-result messages and replies belong to their turn, not new turns
  const t = Session.create(cwd, { persist: false });
  t.log({ type: 'message', message: msg('user', 'run it') });
  t.log({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'x', name: 'ls', input: {} }] } as any });
  t.log({ type: 'message', message: { role: 'user', content: [{ type: 'tool_result', id: 'x', content: 'ok' }] } as any });
  t.log({ type: 'message', message: msg('assistant', 'done') });
  const [turn] = buildTurnTree(t.entries);
  assert.equal(turn.size, 4);
  assert.equal(turn.children.length, 0);

  // legacy (pre-branching) entries without ids read as a straight line
  const legacy = [
    { type: 'header', version: 1, id: 'old', cwd, created: '' },
    { type: 'message', ts: '', message: msg('user', 'x') },
    { type: 'message', ts: '', message: msg('assistant', 'y') },
  ] as any[];
  assert.equal(restore(legacy).messages.length, 2);
  assert.equal(buildTurnTree(legacy)[0].size, 2);
});

test('context files, skills, prompt templates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-ctx-'));
  const sub = join(root, 'pkg');
  await mkdir(join(sub, '.wisp', 'prompts'), { recursive: true });
  await mkdir(join(sub, '.wisp', 'skills', 'deploy'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'root rules');
  await writeFile(join(sub, 'CLAUDE.md'), 'pkg rules');
  await writeFile(join(home, 'AGENTS.md'), 'global rules');
  await writeFile(join(sub, '.wisp', 'prompts', 'review.md'), '---\ndescription: Review code\n---\nReview $1 carefully. Focus: $ARGUMENTS');
  await writeFile(join(sub, '.wisp', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app\n---\nSteps...');

  const files = discoverContextFiles(sub);
  assert.deepEqual(files.map((f: any) => f.content), ['global rules', 'root rules', 'pkg rules']);
  const [tpl] = discoverPromptTemplates(sub);
  assert.equal(tpl.description, 'Review code');
  assert.equal(expandTemplate(tpl, 'src/a.ts perf'), 'Review src/a.ts carefully. Focus: src/a.ts perf');
  const skills = discoverSkills(sub);
  assert.deepEqual(skills.map((s: any) => s.name), ['deploy']);
  const sys = buildSystemPrompt({ cwd: sub, tools: [], contextFiles: files, skills, append: ['EXTRA'] });
  assert.match(sys, /pkg rules/);
  assert.match(sys, /deploy: Deploy the app/);
  assert.ok(sys.endsWith('EXTRA'));
});

test('@mentions attach files, directories and images', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-in-'));
  await writeFile(join(cwd, 'a.ts'), 'export const a = 1;');
  await mkdir(join(cwd, 'lib'));
  await writeFile(join(cwd, 'lib', 'b.ts'), '');
  await writeFile(join(cwd, 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const readFiles = new Map();
  const { content, attachments } = await buildUserContent('look at @a.ts, @lib and @pic.png and @missing.ts', cwd, { images: true, readFiles });
  assert.deepEqual(attachments.map((a: any) => a.kind), ['file', 'dir', 'image']);
  assert.match((content[1] as any).text, /<file path="a.ts">\nexport const a = 1;/);
  assert.match((content[2] as any).text, /b.ts/);
  assert.equal(content[3].type, 'image');
  assert.equal(readFiles.size, 1, 'attached files count as read');
  assert.equal(droppedImagePath("'/Users/me/Screen Shot.png'"), '/Users/me/Screen Shot.png');
  assert.equal(droppedImagePath('/tmp/my\\ shot.jpg'), '/tmp/my shot.jpg');
  assert.equal(droppedImagePath('hello'), null);
});

test('model refs and thinking clamping', () => {
  assert.deepEqual(parseModelRef('ollama/qwen3-coder:30b'), { provider: 'ollama', id: 'qwen3-coder:30b' });
  assert.deepEqual(parseModelRef('claude-sonnet-5-5'), { provider: 'anthropic', id: 'claude-sonnet-5-5' });
  assert.deepEqual(parseModelRef('gpt-5'), { provider: 'openai', id: 'gpt-5' });
  assert.deepEqual(resolveModel({ model: 'anthropic/claude-haiku-5-5' }, {}), { provider: 'anthropic', id: 'claude-haiku-5-5' });
  // Opus 5.5 cannot turn thinking off; it falls to the lowest effort
  assert.equal(clampThinking('off', modelInfo('anthropic', 'claude-opus-5-5')), 'low');
  assert.equal(clampThinking('off', modelInfo('anthropic', 'claude-haiku-5-5')), 'off');
  assert.equal(clampThinking('max', modelInfo('openai', 'gpt-5')), 'high');
});
