import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OpenAIProvider } from '../src/providers/openai.ts';
import type { Message } from '../src/core/types.ts';

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

test('OpenAI adapter: reasoning, streamed tool calls, history serialization', async () => {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', reasoning: 'hmm. ' }));
      res.write(chunk({ content: 'Let me look.' }));
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }));
      res.write(chunk({}, 'tool_calls'));
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const provider = new OpenAIProvider('ollama', 'm', { apiKey: 'x', baseURL: `http://127.0.0.1:${port}/v1` });

  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 's', provider: 'anthropic' }, { type: 'tool_call', id: 'old', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'old', content: 'boom', isError: true }, { type: 'text', text: 'try again' }] },
  ];
  let streamed = '';
  let thought = '';
  const res = await provider.complete(
    { system: 'sys', messages: history, tools: [], maxTokens: 100, thinking: 'off', signal: new AbortController().signal },
    { onText: (d) => (streamed += d), onThinking: (d) => (thought += d) },
  );
  server.close();

  assert.equal(streamed, 'Let me look.');
  assert.equal(thought, 'hmm. ');
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.usage, { input: 10, output: 7, cacheRead: 2, cacheWrite: 0 });
  assert.deepEqual(res.content, [
    { type: 'thinking', thinking: 'hmm. ', provider: 'ollama', model: 'm' },
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
  ]);
  assert.deepEqual(bodies[0].messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'ERROR: boom' },
    { role: 'user', content: 'try again' },
  ]);
  assert.equal(bodies[0].reasoning_effort, undefined, 'no reasoning_effort for non-OpenAI servers');
});
