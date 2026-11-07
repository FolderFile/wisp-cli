// A small MCP server for tests. `node mcp-server.mjs` speaks stdio;
// `node mcp-server.mjs --http <port>` serves Streamable HTTP (stateless).
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function build() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' }, { instructions: 'Use echo to repeat things.' });
  server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }));
  server.registerTool('shape', { description: 'Takes nested arguments', inputSchema: { items: z.array(z.number()), opts: z.object({ sum: z.boolean() }) } }, async ({ items, opts }) => ({
    content: [{ type: 'text', text: opts.sum ? String(items.reduce((a, b) => a + b, 0)) : items.join(',') }],
  }));
  server.registerTool('picture', { description: 'Returns an image' }, async () => ({
    content: [{ type: 'text', text: 'a dot' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
  }));
  server.registerTool('broken', { description: 'Always fails' }, async () => ({ isError: true, content: [{ type: 'text', text: 'it broke' }] }));
  server.registerTool('slow', { description: 'Reports progress, then waits' }, async (extra) => {
    const token = extra._meta?.progressToken;
    if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 3, message: 'step one' } });
    await new Promise((r, reject) => {
      const t = setTimeout(r, 5000);
      extra.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))));
    });
    return { content: [{ type: 'text', text: 'finished' }] };
  });
  return server;
}

if (process.argv[2] === '--http') {
  const port = Number(process.argv[3] ?? 0);
  const http = createServer(async (req, res) => {
    if (req.headers['x-token'] !== 'secret') {
      res.writeHead(401).end('unauthorized');
      return;
    }
    let body = '';
    for await (const c of req) body += c;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await build().connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  http.listen(port, '127.0.0.1', () => console.log(`PORT ${http.address().port}`));
} else {
  console.error('fixture server starting (this goes to stderr)');
  await build().connect(new StdioServerTransport());
}
