import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'wisp-mcp-home-'));
process.env.WISP_HOME = home;
const { McpManager, loadMcpConfig, isProjectTrusted, trustProject, expandEnv, mcpToolName, convertResult } = await import('../src/core/mcp.ts');
const { ToolError, validateInput } = await import('../src/tools/types.ts');

const FIXTURE = join(import.meta.dirname, 'fixtures', 'mcp-server.mjs');
const ctx = (signal = new AbortController().signal, onUpdate?: (s: string) => void) => ({ cwd: process.cwd(), signal, readFiles: new Map(), onUpdate });
const managers: InstanceType<typeof McpManager>[] = [];
after(async () => {
  for (const m of managers) await m.close();
});

test('stdio server: tools, results, errors, images, progress, abort, stderr', async () => {
  const m = new McpManager([{ name: 'fx', scope: 'global', source: 'test', config: { command: process.execPath, args: [FIXTURE], autoApprove: ['echo'] } }], process.cwd());
  managers.push(m);
  await m.start();
  const server = m.get('fx')!;
  assert.equal(server.status, 'connected', server.error);
  assert.equal(server.instructions, 'Use echo to repeat things.');
  assert.match(server.stderr.join('\n'), /goes to stderr/);

  const tools = m.tools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp__fx__broken', 'mcp__fx__echo', 'mcp__fx__picture', 'mcp__fx__shape', 'mcp__fx__slow']);
  const byName = Object.fromEntries(tools.map((t) => [t.mcp!.tool, t]));
  const echo = byName.echo;
  assert.equal(echo.permission, 'none', 'autoApprove skips the prompt');
  assert.equal(byName.broken.permission, 'exec', 'others ask');
  assert.deepEqual(echo.mcp, { server: 'fx', tool: 'echo', readOnly: true });

  assert.deepEqual(await echo.run({ text: 'hi' }, ctx()), { content: 'echo: hi', images: undefined });
  assert.equal(validateInput(byName.shape, { items: [1, 2], opts: { sum: true } }), null, 'arrays/objects validate');
  assert.equal((await byName.shape.run({ items: [1, 2, 3], opts: { sum: true } }, ctx()) as any).content, '6');
  const pic = (await byName.picture.run({}, ctx())) as any;
  assert.equal(pic.content, 'a dot');
  assert.equal(pic.images[0].mediaType, 'image/png');
  await assert.rejects(byName.broken.run({}, ctx()), (e: Error) => e instanceof ToolError && /it broke/.test(e.message));

  const ac = new AbortController();
  const updates: string[] = [];
  const slow = byName.slow.run({}, ctx(ac.signal, (u) => updates.push(u)));
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  await assert.rejects(slow);
  assert.deepEqual(updates, ['step one (1/3)']);

  await m.close();
  await assert.rejects(echo.run({ text: 'x' }, ctx()), /not connected/);
});

test('http server with headers from env; failures are reported, not thrown', async () => {
  const child = spawn(process.execPath, [FIXTURE, '--http', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve) => child.stdout!.on('data', (d) => resolve(Number(/PORT (\d+)/.exec(String(d))![1]))));
  process.env.FX_TOKEN = 'secret';
  const m = new McpManager(
    [
      { name: 'remote', scope: 'global', source: 't', config: { url: `http://127.0.0.1:${port}/mcp`, headers: { 'x-token': '${FX_TOKEN}' } } },
      { name: 'denied', scope: 'global', source: 't', config: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } },
      { name: 'missing', scope: 'global', source: 't', config: { command: 'definitely-not-a-command-xyz' } },
      { name: 'off', scope: 'global', source: 't', config: { command: 'x', disabled: true } },
    ],
    process.cwd(),
  );
  managers.push(m);
  try {
    await m.start();
    assert.equal(m.get('remote')!.status, 'connected', m.get('remote')!.error);
    assert.equal(m.get('denied')!.status, 'failed');
    assert.equal(m.get('missing')!.status, 'failed');
    assert.equal(m.get('off')!.status, 'disabled');
    assert.deepEqual(m.summary, { total: 3, connected: 1, failed: 2, connecting: 0 });
    const echo = m.tools().find((t) => t.name === 'mcp__remote__echo')!;
    assert.equal((await echo.run({ text: 'over http' }, ctx()) as any).content, 'echo: over http');
  } finally {
    await m.close();
    child.kill();
  }
});

test('config files, project trust, env expansion, naming, result conversion', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'wisp-mcp-proj-'));
  await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'global-a' }, b: { command: 'global-b' } } }));
  await writeFile(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { b: { command: 'project-b' } } }));
  const entries = loadMcpConfig(proj);
  assert.deepEqual(entries.map((e) => [e.name, e.scope, e.config.command]), [['a', 'global', 'global-a'], ['b', 'project', 'project-b']]);

  assert.equal(isProjectTrusted(proj, entries), false);
  trustProject(proj, entries);
  assert.equal(isProjectTrusted(proj, entries), true);
  await writeFile(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { b: { command: 'something-else' } } }));
  assert.equal(isProjectTrusted(proj, loadMcpConfig(proj)), false, 'a changed config needs approval again');

  assert.equal(expandEnv('Bearer ${TOK}', { TOK: 'abc' }), 'Bearer abc');
  assert.equal(expandEnv('${NOPE:-fallback}', {}), 'fallback');
  const taken = new Set<string>();
  assert.equal(mcpToolName('my server', 'do.thing', taken), 'mcp__my_server__do_thing');
  const long = mcpToolName('s', 'x'.repeat(80), taken);
  assert.ok(long.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(long));

  assert.deepEqual(convertResult({ content: [], structuredContent: { ok: 1 } }), { content: '{\n  "ok": 1\n}', images: undefined, isError: false });
  assert.match(convertResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } }] }).content, /<resource uri="file:\/\/\/a.txt">\nbody/);
});
