#!/usr/bin/env node
import { existsSync, fstatSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { Agent } from './core/agent.js';
import { availableModels, createProvider, getModelInfo, parseModelRef, resolveModel, type ModelRef } from './core/config.js';
import { buildSystemPrompt, discoverContextFiles, discoverSkills } from './core/context.js';
import { describeError } from './core/errors.js';
import { exportSession } from './core/export.js';
import { isProjectTrusted, loadMcpConfig, McpManager } from './core/mcp.js';
import { BUILTIN_MODELS, PROVIDERS } from './core/models.js';
import { findSession, forkSession, listSessions, readEntries, restore, Session, type RestoredState } from './core/session.js';
import { GLOBAL_SETTINGS, PERMISSION_MODES, SettingsStore, type PermissionMode } from './core/settings.js';
import { THINKING_LEVELS, type ThinkingLevel } from './core/types.js';
import { runPrint } from './modes/print.js';
import { selectTools } from './tools/index.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `${pc.bold('wisp')} — a coding agent for your terminal

${pc.bold('Usage')}
  wisp [options] [@files...] [prompt]

${pc.bold('Modes')}
  (default)                    interactive session
  -p, --print                  run the prompt, print the answer, exit (also when stdin/stdout aren't a terminal)
  --json                       like --print, but stream JSON events (one per line)

${pc.bold('Model')}
  -m, --model <name>           model id or provider/id; a :level suffix sets thinking (claude-sonnet-5-5:high)
  --provider <name>            ${PROVIDERS.join(' | ')}
  --thinking <level>           ${THINKING_LEVELS.join(' | ')}
  --list-models                list available models and exit

${pc.bold('Sessions')}
  -c, --continue               continue the most recent session in this directory
  -r, --resume                 pick a session to resume
  --session <id|path>          open a specific session
  --fork <id|path>             start a new session branched from another one
  -n, --name <name>            name the session
  --no-session                 don't save this session
  --export <id|path> [out]     export a session to HTML (or .md) and exit

${pc.bold('Behaviour')}
  --auto-edit                  approve file edits automatically; still ask before commands
  -y, --yes                    approve everything (use in a sandbox)
  --permission <mode>          ${PERMISSION_MODES.join(' | ')}
  -t, --tools <list>           tools to enable, e.g. read_file,grep or +ls,-bash
  --system-prompt <text|file>  replace the system prompt
  --append-system-prompt <t>   append to the system prompt (repeatable)
  --no-context-files           don't load AGENTS.md / CLAUDE.md
  --tui-mode <mode>            fullscreen (default: own screen, scrollable) | inline (normal scrollback)
  --no-mcp                     don't start MCP servers
  --mcp-config <file>          load MCP servers from this file too (repeatable)
  --trust-project              start this project's MCP servers without asking

${pc.bold('MCP')}
  wisp mcp list|get|add|remove manage MCP servers (wisp mcp --help)
  -h, --help · -v, --version

${pc.bold('Files')}
  settings   ~/.wisp/settings.json, .wisp/settings.json
  context    AGENTS.md or CLAUDE.md (cwd and parents), ~/.wisp/AGENTS.md
  prompts    ~/.wisp/prompts/*.md, .wisp/prompts/*.md  → /name
  skills     ~/.wisp/skills/<name>/SKILL.md, .wisp/skills/…
  sessions   ~/.wisp/sessions/
  mcp        ~/.wisp/mcp.json, .mcp.json, .wisp/mcp.json
`;

/** Pipes and redirected files carry input; other non-TTY handles may never close. */
function shouldReadStdin(hasArgPrompt: boolean): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const st = fstatSync(0);
    if (st.isFIFO() || st.isFile()) return true;
    if (st.isCharacterDevice()) return false;
  } catch {
    return false;
  }
  return !hasArgPrompt;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const textOrFile = (v: string) => (existsSync(v) ? readFileSync(v, 'utf8') : v);

async function main(): Promise<number> {
  if (process.argv[2] === 'mcp') {
    const { mcpCli } = await import('./mcp-cli.js');
    return mcpCli(process.argv.slice(3), process.cwd());
  }
  const { values: f, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      json: { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      provider: { type: 'string' },
      thinking: { type: 'string' },
      'list-models': { type: 'boolean' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'boolean', short: 'r' },
      session: { type: 'string' },
      fork: { type: 'string' },
      name: { type: 'string', short: 'n' },
      'no-session': { type: 'boolean' },
      export: { type: 'string' },
      'auto-edit': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      permission: { type: 'string' },
      tools: { type: 'string', short: 't' },
      'system-prompt': { type: 'string' },
      'append-system-prompt': { type: 'string', multiple: true },
      'no-context-files': { type: 'boolean' },
      'tui-mode': { type: 'string' },
      'no-mcp': { type: 'boolean' },
      'mcp-config': { type: 'string', multiple: true },
      'trust-project': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (f.help) return void process.stdout.write(HELP), 0;
  if (f.version) return console.log(VERSION), 0;

  const cwd = process.cwd();
  const store = new SettingsStore(cwd);
  const settings = store.merged;

  if (f.export) {
    const info = findSession(f.export, cwd);
    if (!info) throw new Error(`No session matches "${f.export}".`);
    const out = positionals[0] ?? `wisp-${info.id}.html`;
    exportSession(out, restore(readEntries(info.path)).messages, info.name ?? `wisp session ${info.id}`);
    console.log(`Exported to ${out}`);
    return 0;
  }

  // model + thinking (a ":level" suffix on the model sets thinking)
  let modelFlag = f.model;
  let thinking: ThinkingLevel = (f.thinking as ThinkingLevel) ?? settings.thinking ?? 'medium';
  const suffix = modelFlag && /:(off|low|medium|high|xhigh|max)$/.exec(modelFlag);
  if (suffix && modelFlag) {
    if (!f.thinking) thinking = suffix[1] as ThinkingLevel;
    modelFlag = modelFlag.slice(0, -suffix[0].length);
  }
  if (!THINKING_LEVELS.includes(thinking)) throw new Error(`Unknown thinking level "${thinking}". Use one of: ${THINKING_LEVELS.join(', ')}`);
  let ref: ModelRef = resolveModel({ provider: f.provider, model: modelFlag }, settings);

  if (f['list-models']) {
    for (const m of availableModels(settings, BUILTIN_MODELS))
      console.log(`${m.provider}/${m.id}`.padEnd(34) + pc.dim(`${m.name} · ${m.contextWindow.toLocaleString()} ctx${m.price ? ` · $${m.price.input}/$${m.price.output} per M` : ''}`));
    console.log(pc.dim('ollama/<model>                    any model served by your Ollama'));
    return 0;
  }

  const permission: PermissionMode = f.yes ? 'yolo' : f['auto-edit'] ? 'auto-edit' : ((f.permission as PermissionMode) ?? settings.permissionMode ?? 'ask');
  if (!PERMISSION_MODES.includes(permission)) throw new Error(`Unknown permission mode "${permission}".`);
  const tools = selectTools(f.tools);
  const persist = !f['no-session'];

  // --- session ----------------------------------------------------------------
  let session: Session;
  let restored: RestoredState | undefined;
  const openExisting = (path: string) => {
    const opened = Session.open(path);
    if (opened.session.cwd !== cwd)
      throw new Error(`Session ${opened.session.id} belongs to ${opened.session.cwd}. Run wisp there, or use --fork ${opened.session.id} to copy it here.`);
    session = opened.session;
    restored = restore(opened.entries);
  };
  if (f.fork) {
    const info = findSession(f.fork, cwd);
    if (!info) throw new Error(`No session matches "${f.fork}".`);
    const entries = readEntries(info.path);
    session = forkSession(entries, cwd, Number.MAX_SAFE_INTEGER, persist);
    restored = restore(session.entries);
  } else if (f.session) {
    const info = findSession(f.session, cwd);
    if (!info) throw new Error(`No session matches "${f.session}".`);
    openExisting(info.path);
  } else if (f.continue) {
    const last = listSessions(cwd)[0];
    if (last) openExisting(last.path);
    else session = Session.create(cwd, { persist });
  } else if (f.resume) {
    const picked = await pickSession(cwd);
    if (!picked) return 0;
    openExisting(picked);
  } else session = Session.create(cwd, { persist });
  session = session!;
  if (f.name) session.log({ type: 'name', name: f.name });
  // a resumed session keeps its model unless one was given explicitly
  if (restored?.model && !modelFlag && !f.provider) {
    ref = parseModelRef(`${restored.model.provider}/${restored.model.model}`);
    if (!f.thinking) thinking = restored.model.thinking;
  }
  if (!restored?.model) session.log({ type: 'model', provider: ref.provider, model: ref.id, thinking });

  // --- prompt -------------------------------------------------------------------
  let prompt = positionals.join(' ');
  const nonInteractive = f.print || f.json || !process.stdin.isTTY || !process.stdout.isTTY;
  if (shouldReadStdin(Boolean(prompt))) {
    const piped = (await readStdin()).trim();
    if (piped) prompt = [prompt, piped].filter(Boolean).join('\n\n');
  }

  const appendSystem = (f['append-system-prompt'] ?? []).map(textOrFile);
  const mcpServers = f['no-mcp'] ? [] : loadMcpConfig(cwd, f['mcp-config'] ?? []);
  const systemOverride = f['system-prompt'] ? textOrFile(f['system-prompt']) : undefined;

  if (nonInteractive) {
    if (!prompt.trim()) throw new Error('No prompt given. Usage: wisp -p "your prompt"');
    const model = getModelInfo(ref, settings);
    const agent = new Agent({
      cwd,
      provider: createProvider(ref, settings),
      model,
      tools,
      system: buildSystemPrompt({
        cwd,
        tools,
        contextFiles: f['no-context-files'] ? [] : discoverContextFiles(cwd),
        skills: discoverSkills(cwd),
        override: systemOverride,
        append: appendSystem,
      }),
      maxTokens: settings.maxTokens,
      thinking,
      permissionMode: permission,
      approver: null,
      autoCompactAt: settings.autoCompactAt,
    });
    if (restored) agent.load(restored.messages, restored);
    // MCP: no one to ask here, so untrusted project servers are skipped
    let mcp: McpManager | null = null;
    if (mcpServers.length) {
      const trusted = f['trust-project'] || isProjectTrusted(cwd, mcpServers);
      const runnable = mcpServers.filter((e) => trusted || e.scope !== 'project');
      if (runnable.length < mcpServers.length)
        process.stderr.write(pc.yellow('Skipping project MCP servers: approve them once in interactive wisp, or pass --trust-project.\n'));
      if (runnable.length) {
        mcp = new McpManager(runnable, cwd);
        await mcp.start();
        for (const s of mcp.servers) if (s.status === 'failed') process.stderr.write(pc.red(`MCP ${s.name} failed: ${s.error}\n`));
        agent.setTools([...tools, ...mcp.tools()]);
        agent.opts.system = buildSystemPrompt({
          cwd,
          tools: agent.tools,
          contextFiles: f['no-context-files'] ? [] : discoverContextFiles(cwd),
          skills: discoverSkills(cwd),
          override: systemOverride,
          append: appendSystem,
          mcpInstructions: mcp.instructions(),
        });
      }
    }
    try {
      return await runPrint(agent, session, prompt, cwd, f.json ? 'json' : 'text');
    } finally {
      await mcp?.close();
    }
  }

  const tuiMode = (f['tui-mode'] ?? process.env.WISP_TUI_MODE ?? settings.tuiMode ?? 'fullscreen') as 'fullscreen' | 'inline';
  if (tuiMode !== 'fullscreen' && tuiMode !== 'inline') throw new Error(`Unknown --tui-mode "${tuiMode}". Use fullscreen or inline.`);
  const { App } = await import('./tui/app.js');
  const app = new App({
    cwd,
    settings: store,
    model: ref,
    thinking,
    permissionMode: permission,
    tools,
    systemOverride,
    appendSystem,
    useContextFiles: !f['no-context-files'],
    session,
    restored,
    initialPrompt: prompt || undefined,
    persistSessions: persist,
    tuiMode,
    mouse: settings.mouse ?? true,
    mcpServers,
    trustProjectMcp: Boolean(f['trust-project']),
  });
  await app.run();
  await app.shutdown();
  return 0;
}

/** Minimal pre-TUI session picker for --resume. */
async function pickSession(cwd: string): Promise<string | null> {
  const sessions = listSessions(cwd);
  if (!sessions.length) {
    console.log('No saved sessions for this directory.');
    return null;
  }
  const { Terminal } = await import('./tui/terminal.js');
  const { Screen } = await import('./tui/screen.js');
  const { SelectList } = await import('./tui/select.js');
  const term = new Terminal();
  const screen = new Screen(term);
  const list = new SelectList(
    sessions.map((s) => ({ label: (s.name ?? s.firstMessage).slice(0, 70), keywords: s.firstMessage, detail: `${s.modified.toLocaleString()} · ${s.messageCount} msgs`, value: s.path })),
    { title: 'Resume session', filterable: true },
  );
  return new Promise((resolve) => {
    const draw = () => screen.setLive(list.render(screen.width, Math.min(15, screen.height - 4)), null);
    term.start((e) => {
      if (e.type !== 'key') return;
      const r = list.handleKey(e.key);
      if (r === 'select' || r === 'cancel') {
        screen.close();
        term.stop();
        resolve(r === 'select' ? list.selected!.value : null);
      } else draw();
    }, draw);
    draw();
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(pc.red(describeError(err)) + '\n');
    if (String((err as Error)?.message).includes(GLOBAL_SETTINGS)) process.stderr.write(pc.dim('Fix or delete the settings file and try again.\n'));
    process.exit(1);
  });
