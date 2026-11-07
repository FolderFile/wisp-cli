import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor } from '../src/tui/editor.ts';
import { fuzzyFilter } from '../src/tui/fuzzy.ts';
import { InputParser, type Key } from '../src/tui/keys.ts';
import { MarkdownStream } from '../src/tui/markdown.ts';
import { diffLines } from '../src/tools/diff.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const keys = (s: string) => new InputParser().feed(s, true).map((e) => (e.type === 'key' ? e.key : e));
const k = (name: string, m: Partial<Key> = {}): Key => ({ name, ctrl: false, alt: false, shift: false, ...m });

test('key parser: legacy, xterm modifiers, kitty CSI u, alt, paste', () => {
  assert.deepEqual(keys('a')[0], { name: 'a', ctrl: false, alt: false, shift: false, text: 'a' });
  assert.equal((keys('\x03')[0] as Key).name, 'c');
  assert.equal((keys('\x03')[0] as Key).ctrl, true);
  assert.equal((keys('\r')[0] as Key).name, 'enter');
  assert.deepEqual(keys('\x1b[13;2u')[0], { name: 'enter', ctrl: false, alt: false, shift: true, text: undefined });
  assert.deepEqual(keys('\x1b[99;5u')[0], { name: 'c', ctrl: true, alt: false, shift: false, text: undefined });
  assert.deepEqual(keys('\x1b[1;5C')[0], { name: 'right', ctrl: true, alt: false, shift: false });
  assert.deepEqual(keys('\x1b[Z')[0], { name: 'tab', ctrl: false, alt: false, shift: true });
  assert.deepEqual(keys('\x1b\r')[0], { name: 'enter', ctrl: false, alt: true, shift: false });
  assert.equal((keys('\x1bb')[0] as Key).alt, true);
  assert.equal((keys('\x1b')[0] as Key).name, 'escape');
  assert.deepEqual(keys('\x1b[27;2;13~')[0], { name: 'enter', ctrl: false, alt: false, shift: true, text: undefined });
  assert.deepEqual(new InputParser().feed('\x1b[200~line1\r\nline2\x1b[201~x'), [
    { type: 'paste', text: 'line1\nline2' },
    { type: 'key', key: { name: 'x', ctrl: false, alt: false, shift: false, text: 'x' } },
  ]);
  // a lone ESC waits for more input unless flushed
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b'), []);
  assert.equal((p.feed('[A')[0] as any).key.name, 'up');
  // emoji stays one key
  assert.equal((keys('👍')[0] as Key).text, '👍');
});

test('editor: typing, newlines, word ops, undo, history', () => {
  const e = new Editor();
  for (const ch of 'hello world') e.handleKey(k(ch, { text: ch }));
  e.handleKey(k('w', { ctrl: true }));
  assert.equal(e.text, 'hello ');
  e.handleKey(k('-', { ctrl: true })); // undo
  assert.equal(e.text, 'hello world');
  e.handleKey(k('enter', { shift: true }));
  e.insert('line2');
  assert.equal(e.text, 'hello world\nline2');
  e.handleKey(k('a', { ctrl: true }));
  e.handleKey(k('k', { ctrl: true }));
  assert.equal(e.text, 'hello world\n');
  e.handleKey(k('y', { ctrl: true }));
  assert.equal(e.text, 'hello world\nline2');
  e.handleKey(k('backspace'));
  assert.equal(e.text, 'hello world\nline');

  const h = new Editor();
  h.setHistory(['first', 'second']);
  h.insert('draft');
  h.handleKey(k('up'));
  assert.equal(h.text, 'second');
  h.handleKey(k('up'));
  assert.equal(h.text, 'first');
  h.handleKey(k('down'));
  h.handleKey(k('down'));
  assert.equal(h.text, 'draft');
});

test('editor: large pastes collapse to a placeholder and expand on submit', () => {
  const e = new Editor();
  const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  e.insert('see: ');
  e.paste(big);
  assert.equal(e.text, 'see: [Pasted #1 +20 lines]');
  assert.equal(e.expandedText(), 'see: ' + big);
});

test('editor render: wraps long lines and places the cursor', () => {
  const e = new Editor();
  e.insert('x'.repeat(25));
  const r = e.render(12, 10, '› ');
  assert.equal(r.lines.length, 3);
  assert.equal(strip(r.lines[0]), '› ' + 'x'.repeat(9));
  assert.deepEqual(r.cursor, { row: 2, col: 2 + 7 });
});

test('fuzzy filter ranks file-name matches first', () => {
  const files = ['src/tui/app.ts', 'src/core/agent.ts', 'docs/api.md', 'src/tui/autocomplete.ts'];
  assert.deepEqual(fuzzyFilter('agent', files, (f) => f), ['src/core/agent.ts']);
  assert.equal(fuzzyFilter('app', files, (f) => f)[0], 'src/tui/app.ts');
  assert.equal(fuzzyFilter('auc', files, (f) => f)[0], 'src/tui/autocomplete.ts');
});

test('markdown stream: commits complete lines, holds code blocks until closed', () => {
  const md = new MarkdownStream(() => 80);
  md.push('# Title\n\nSome **bold** text');
  assert.deepEqual(md.take().map(strip), ['Title', '']);
  assert.equal(strip(md.preview()[0]), 'Some bold text');
  md.push(' here.\n```js\nconst x = 1;\n');
  assert.deepEqual(md.take().map(strip), ['Some bold text here.']);
  assert.match(strip(md.preview().join('\n')), /const x = 1;/);
  md.push('```\n- item\n');
  const lines = md.take().map(strip);
  assert.deepEqual(lines, ['╭─ js', '│ const x = 1;', '╰─', '• item']);
});

test('diff: minimal line changes', () => {
  const ops = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(ops.filter((o) => o.kind !== ' ').map((o) => o.kind + o.text), ['-b', '+B', '+e']);
});

test('mouse: SGR wheel and click events', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b[<64;10;5M'), [{ type: 'mouse', button: 0, wheel: 'up', x: 10, y: 5, release: false, shift: false }]);
  assert.equal((p.feed('\x1b[<65;1;1M')[0] as any).wheel, 'down');
  assert.deepEqual(p.feed('\x1b[<0;3;4m'), [{ type: 'mouse', button: 0, wheel: undefined, x: 3, y: 4, release: true, shift: false }]);
});

test('transcript blocks reflow on resize and react to display toggles', async () => {
  const { Transcript } = await import('../src/tui/transcript.ts');
  let verbose = false;
  let showThinking = true;
  const t = new Transcript({ showThinking: () => showThinking, verbose: () => verbose });
  t.handle({ type: 'request_start' });
  t.handle({ type: 'thinking_delta', delta: 'pondering the problem' });
  t.handle({ type: 'text_delta', delta: 'word '.repeat(30) });
  const call = { type: 'tool_call' as const, id: 'c1', name: 'bash', input: { command: 'seq 20' } };
  t.handle({ type: 'tool_call_streaming', id: 'c1', name: 'bash' });
  assert.match(strip(t.render(80).join('\n')), /preparing/);
  t.handle({ type: 'tool_start', call, label: 'seq 20' });
  t.handle({ type: 'tool_end', call, output: { content: Array.from({ length: 20 }, (_, i) => String(i + 1)).join('\n') }, isError: false, ms: 5 });
  t.handle({ type: 'turn_end' });

  const wide = t.render(100).map(strip);
  const narrow = t.render(40).map(strip);
  assert.ok(narrow.length > wide.length, 'narrower width wraps into more lines');
  assert.ok(narrow.every((l) => l.length <= 40));
  assert.ok(wide.some((l) => l.includes('∴ Thinking')));
  showThinking = false;
  assert.ok(t.render(100).map(strip).some((l) => /∴ Thought for/.test(l)));
  const collapsed = t.render(100).map(strip).filter((l) => /^\s+(⎿\s+)?\d+$/.test(l)).length;
  verbose = true;
  const expanded = t.render(100).map(strip).filter((l) => /^\s+(⎿\s+)?\d+$/.test(l)).length;
  assert.equal(collapsed, 6);
  assert.equal(expanded, 20);
});

test('fullscreen view: scrolls and only rewrites changed rows', async () => {
  const { FullScreen } = await import('../src/tui/fullscreen.ts');
  let written = '';
  const term = { columns: 40, rows: 10, write: (s: string) => (written += s) } as any;
  const fs = new FullScreen(term);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  fs.draw(() => lines, ['> editor'], { row: 0, col: 2 });
  fs.flush();
  // follows the end: last 9 transcript lines + 1 bottom row
  assert.match(written, /line 29/);
  assert.doesNotMatch(written, /line 20\b/);
  assert.match(written, /\x1b\[10;3H/); // cursor in the editor row
  written = '';
  fs.flush();
  assert.doesNotMatch(written, /line/, 'unchanged frame rewrites nothing');
  fs.scrollBy(-5);
  fs.flush();
  assert.match(written, /line 16/);
  assert.match(written, /5 more lines/);
  assert.equal(fs.following, false);
  fs.toBottom();
  fs.flush();
  assert.equal(fs.following, true);
});

test('wrap: no stray space at the start of continuation rows; indentation kept', async () => {
  const { wrap } = await import('../src/tui/text.ts');
  assert.deepEqual(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
  assert.deepEqual(wrap('    indented code', 40), ['    indented code']);
  assert.ok(wrap('\x1b[2mone two three four\x1b[22m', 9).every((r) => !strip(r).startsWith(' ')));
});

test('footer hints drop whole items (lowest priority first) instead of cutting words', async () => {
  const { fitHints } = await import('../src/tui/app.ts');
  const hints: [string, number][] = [['enter send', 3], ['/ commands', 4], ['@ files', 2], ['! shell', 1], ['? help', 5]];
  assert.equal(fitHints(hints, 80), 'enter send · / commands · @ files · ! shell · ? help');
  assert.equal(fitHints(hints, 40), 'enter send · / commands · ? help');
  assert.equal(fitHints(hints, 22), '/ commands · ? help');
});

test('fullscreen: the input stays pinned to the bottom even when the conversation is short', async () => {
  const { FullScreen } = await import('../src/tui/fullscreen.ts');
  let written = '';
  const term = { columns: 40, rows: 12, write: (s: string) => (written += s) } as any;
  const fs = new FullScreen(term);
  fs.draw(() => ['header'], ['─ border', '› ', '─ border', 'footer'], { row: 1, col: 2 });
  fs.flush();
  assert.match(written, /\x1b\[9;1H\x1b\[2K─ border/, 'bottom area starts at row 9 of 12');
  assert.match(written, /\x1b\[10;3H/, 'cursor on the input row');
});

test('replay shows what the user typed, not the contents of attached files', async () => {
  const { Transcript } = await import('../src/tui/transcript.ts');
  const t = new Transcript({ showThinking: () => true, verbose: () => false });
  t.replay([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'explain @src/a.ts' },
        { type: 'text', text: '<file path="src/a.ts">\nSECRET_FILE_BODY\n</file>' },
      ],
    },
  ]);
  const out = t.render(80).map(strip).join('\n');
  assert.match(out, /explain @src\/a\.ts/);
  assert.match(out, /attached src\/a\.ts/);
  assert.doesNotMatch(out, /SECRET_FILE_BODY/);
});
