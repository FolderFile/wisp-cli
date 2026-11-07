import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { describeServer, GLOBAL_MCP_CONFIG, isProjectTrusted, loadMcpConfig, McpManager, writeServer, type McpServerConfig } from './core/mcp.js';

const USAGE = `${pc.bold('wisp mcp')} — manage MCP servers

  wisp mcp list                                   show servers, connect, count tools
  wisp mcp get <name>                             show one server and its tools
  wisp mcp add <name> [options] -- <command> [args…]   add a local (stdio) server
  wisp mcp add <name> --url <url> [options]       add a remote (HTTP/SSE) server
  wisp mcp remove <name>                          remove a server

${pc.bold('Options for add')}
  --env KEY=VALUE        environment variable for the server (repeatable; \${VAR} expands)
  --header "Name: value" HTTP header (repeatable; \${VAR} expands)
  --transport http|sse   force the remote transport (default: try http, fall back to sse)
  --auto-approve <list>  tools that run without asking, comma-separated, or "*"
  --project              write to ./.mcp.json instead of ~/.wisp/mcp.json (add/remove)

${pc.bold('Examples')}
  wisp mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code
  wisp mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=\${GITHUB_TOKEN} -- npx -y @modelcontextprotocol/server-github
  wisp mcp add docs --url https://example.com/mcp --header "Authorization: Bearer \${DOCS_TOKEN}"
`;

export async function mcpCli(argv: string[], cwd: string): Promise<number> {
  const dash = argv.indexOf('--');
  const before = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const { values: f, positionals } = parseArgs({
    args: before,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      env: { type: 'string', multiple: true },
      header: { type: 'string', multiple: true },
      transport: { type: 'string' },
      'auto-approve': { type: 'string' },
      project: { type: 'boolean', short: 'l' },
      'trust-project': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [sub, name] = positionals;
  const file = f.project ? join(cwd, '.mcp.json') : GLOBAL_MCP_CONFIG;
  if (!sub || f.help) {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }

  switch (sub) {
    case 'add': {
      if (!name) throw new Error('Usage: wisp mcp add <name> -- <command> [args…]   or   wisp mcp add <name> --url <url>');
      if (!f.url && !command.length) throw new Error('Give a command after "--", or --url for a remote server.');
      if (f.url && command.length) throw new Error('Use either --url or a command, not both.');
      const config: McpServerConfig = f.url ? { url: f.url } : { command: command[0], args: command.slice(1) };
      if (f.transport) {
        if (!['http', 'sse'].includes(f.transport)) throw new Error('--transport must be http or sse');
        config.type = f.transport;
      }
      if (f.env?.length) config.env = Object.fromEntries(f.env.map(splitOn('=', '--env KEY=VALUE')));
      if (f.header?.length) config.headers = Object.fromEntries(f.header.map(splitOn(':', '--header "Name: value"')));
      if (f['auto-approve']) config.autoApprove = f['auto-approve'].split(',').map((s) => s.trim()).filter(Boolean);
      writeServer(file, name, config);
      console.log(`Added ${pc.bold(name)} to ${file}`);
      console.log(pc.dim(`  ${describeServer(config)}`));
      console.log(pc.dim('  Check it with: wisp mcp get ' + name));
      return 0;
    }
    case 'remove':
    case 'rm': {
      if (!name) throw new Error('Usage: wisp mcp remove <name>');
      const exists = loadMcpConfig(cwd).find((e) => e.name === name && e.source === file);
      if (!exists) throw new Error(`No server "${name}" in ${file}${f.project ? '' : ' (use --project for ./.mcp.json)'}`);
      writeServer(file, name, null);
      console.log(`Removed ${name} from ${file}`);
      return 0;
    }
    case 'list':
    case 'ls':
    case 'get': {
      let entries = loadMcpConfig(cwd);
      if (sub === 'get') {
        entries = entries.filter((e) => e.name === name);
        if (!entries.length) throw new Error(`No MCP server named "${name}".`);
      }
      if (!entries.length) {
        console.log('No MCP servers configured.\n');
        process.stdout.write(USAGE);
        return 0;
      }
      // project servers are not started unless the project was trusted in wisp (or --trust-project)
      const trusted = f['trust-project'] || isProjectTrusted(cwd, entries);
      const runnable = entries.filter((e) => trusted || e.scope !== 'project');
      const m = new McpManager(runnable, cwd);
      process.stderr.write(pc.dim(`Connecting to ${runnable.filter((e) => !e.config.disabled).length} server(s)…\n`));
      await m.start();
      for (const e of entries) {
        const s = m.get(e.name);
        const status = !s
          ? pc.yellow('not started (project not trusted yet: run wisp here, or pass --trust-project)')
          : s.status === 'connected'
            ? pc.green(`connected · ${s.tools.length} tools`)
            : s.status === 'disabled'
              ? pc.dim('disabled')
              : pc.red(`failed: ${s.error}`);
        console.log(`${pc.bold(e.name)} ${pc.dim(`(${e.scope}: ${e.source})`)}\n  ${pc.dim(describeServer(e.config))}\n  ${status}`);
        if (s?.status === 'failed' && s.stderr.length) for (const l of s.stderr.slice(-5)) console.log(pc.dim(`  │ ${l}`));
        if (sub === 'get' && s?.status === 'connected') for (const t of s.tools) console.log(`    ${t.name}  ${pc.dim((t.description ?? '').split('\n')[0].slice(0, 100))}`);
      }
      await m.close();
      return 0;
    }
    default:
      throw new Error(`Unknown subcommand "${sub}". Run: wisp mcp --help`);
  }
}

function splitOn(sep: string, usage: string) {
  return (s: string): [string, string] => {
    const i = s.indexOf(sep);
    if (i <= 0) throw new Error(`Expected ${usage}, got "${s}"`);
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
  };
}
