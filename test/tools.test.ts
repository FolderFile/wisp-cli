import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { bashTool } from '../src/tools/bash.ts';
import { editFileTool, readFileTool, writeFileTool } from '../src/tools/files.ts';
import { globTool, grepTool } from '../src/tools/search.ts';
import { toOutput, validateInput, type ToolContext } from '../src/tools/types.ts';
import { lsTool } from '../src/tools/files.ts';

const text = async (p: Promise<any>) => toOutput(await p).content;

let ctx: ToolContext;
beforeEach(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'wisp-test-'));
  ctx = { cwd, signal: new AbortController().signal, readFiles: new Map() };
});

test('read_file numbers lines and supports offset/limit', async () => {
  await writeFile(join(ctx.cwd, 'a.txt'), 'one\ntwo\nthree\n');
  assert.equal(await text(readFileTool.run({ path: 'a.txt' }, ctx)), '1\tone\n2\ttwo\n3\tthree');
  const part = await text(readFileTool.run({ path: 'a.txt', offset: 2, limit: 1 }, ctx));
  assert.match(part, /^2\ttwo/);
  assert.match(part, /showing lines 2-2 of 3/);
});

test('edit_file requires a prior read', async () => {
  await writeFile(join(ctx.cwd, 'a.ts'), 'const x = 1;\n');
  await assert.rejects(
    editFileTool.run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx),
    /must read/,
  );
});

test('edit_file rejects stale reads', async () => {
  const p = join(ctx.cwd, 'a.ts');
  await writeFile(p, 'const x = 1;\n');
  await readFileTool.run({ path: 'a.ts' }, ctx);
  await writeFile(p, 'const x = 5;\n');
  const later = new Date(Date.now() + 5000);
  await utimes(p, later, later);
  await assert.rejects(
    editFileTool.run({ path: 'a.ts', old_string: '5', new_string: '2' }, ctx),
    /changed since/,
  );
});

test('edit_file: unique match, ambiguity, replace_all, literal $', async () => {
  const p = join(ctx.cwd, 'a.ts');
  await writeFile(p, 'a = 1;\nb = 1;\n');
  await readFileTool.run({ path: 'a.ts' }, ctx);
  await assert.rejects(editFileTool.run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx), /appears 2 times/);
  await assert.rejects(editFileTool.run({ path: 'a.ts', old_string: 'zzz', new_string: '2' }, ctx), /not found/);
  await editFileTool.run({ path: 'a.ts', old_string: 'b = 1', new_string: "b = '$&'" }, ctx);
  assert.equal(await readFile(p, 'utf8'), "a = 1;\nb = '$&';\n");
  // our own write updates the freshness record, so chained edits work
  await editFileTool.run({ path: 'a.ts', old_string: ';', new_string: '', replace_all: true }, ctx);
  assert.equal(await readFile(p, 'utf8'), "a = 1\nb = '$&'\n");
});

test('write_file creates new files and parent dirs without a read', async () => {
  const out = await text(writeFileTool.run({ path: 'deep/dir/new.txt', content: 'hi' }, ctx));
  assert.match(out, /Created/);
  assert.equal(await readFile(join(ctx.cwd, 'deep/dir/new.txt'), 'utf8'), 'hi');
});

test('bash returns output, reports failures, times out, aborts', async () => {
  assert.equal(await text(bashTool.run({ command: 'echo hi; echo err >&2' }, ctx)), 'hi\nerr');
  await assert.rejects(bashTool.run({ command: 'echo nope; exit 3' }, ctx), /nope\n\[exit code 3\]/);
  await assert.rejects(bashTool.run({ command: 'sleep 5', timeout_ms: 1000 }, ctx), /timed out/);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(bashTool.run({ command: 'sleep 10' }, { ...ctx, signal: ac.signal }), /Interrupted/);
  assert.ok(Date.now() - t0 < 3000);
});

test('glob and grep find files, skip node_modules', async () => {
  await bashTool.run(
    { command: 'mkdir -p src/lib node_modules/x && echo "export const foo = 1" > src/lib/a.ts && echo "foo" > node_modules/x/b.ts && echo "# Foo" > README.md' },
    ctx,
  );
  assert.equal(await text(globTool.run({ pattern: '*.ts' }, ctx)), join('src', 'lib', 'a.ts'));
  assert.equal(await text(grepTool.run({ pattern: 'foo' }, ctx)), 'src/lib/a.ts:1: export const foo = 1');
  assert.match(await text(grepTool.run({ pattern: 'foo', ignore_case: true, files_only: true }, ctx)), /README\.md/);
  assert.equal(await text(grepTool.run({ pattern: 'foo', glob: '*.md' }, ctx)), 'No matches.');
  assert.match(await text(lsTool.run({}, ctx)), /^node_modules\/\nsrc\/\nREADME\.md  \(\d+ B\)$/);
});

test('validateInput catches missing/wrong-typed args', () => {
  assert.match(validateInput(readFileTool, {})!, /Missing required parameter "path"/);
  assert.match(validateInput(readFileTool, { path: 1 })!, /must be of type string/);
  assert.match(validateInput(readFileTool, { _invalid_arguments: '{bad' })!, /not valid JSON/);
  assert.equal(validateInput(readFileTool, { path: 'x', offset: 3 }), null);
});

test('edit_file reports a diff for the transcript', async () => {
  await writeFile(join(ctx.cwd, 'a.ts'), 'one\ntwo\nthree\n');
  await readFileTool.run({ path: 'a.ts' }, ctx);
  const out = toOutput(await editFileTool.run({ path: 'a.ts', old_string: 'two', new_string: 'TWO' }, ctx));
  assert.equal(out.content, 'Edited a.ts at line 2');
  const plain = out.display!.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /\+1 -1/);
  assert.match(plain, /2 - two/);
  assert.match(plain, /2 \+ TWO/);
});

test('read_file returns images as image blocks', async () => {
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(ctx.cwd, 'dot.png'), png);
  const out = toOutput(await readFileTool.run({ path: 'dot.png' }, ctx));
  assert.equal(out.images?.[0].mediaType, 'image/png');
  assert.equal(out.images?.[0].data, png.toString('base64'));
});
