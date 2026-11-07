# wisp

A coding agent for your terminal that works with any provider. Wisp reads your code, edits files and runs commands. It works with Claude, OpenAI, or a local model through Ollama, and it puts the comfort into the interactive experience:

- **A real editor that stays live while the agent works.** You can type ahead, steer mid-task, or queue a follow-up.
- **Autocomplete** for `/` commands, `@` file mentions and Tab paths.
- **Streaming Markdown** with syntax-highlighted code blocks, tables and inline diffs.
- **Sessions** that save automatically and can be continued, resumed, forked, compacted and exported.
- **A model picker and thinking-level control**, plus a footer showing context use, tokens and cost.
- **Project context files and extensions:** `AGENTS.md`/`CLAUDE.md`, skills, and prompt templates.
- **MCP servers** over stdio, Streamable HTTP or SSE, using the `mcpServers` config format other tools already use.

```
▌ node test.js fails. Fix it.

● Read math.js
  ⎿  6 lines
● Edit math.js
  ⎿  +1 -1
     2     let sum = 0;
     3 -   for (let i = 0; i <= xs.length; i++) sum += xs[i];
     3 +   for (let i = 0; i < xs.length; i++) sum += xs[i];
     4     return sum / xs.length;
● Bash $ node test.js
  ⎿  ok

The loop at math.js:3 ran one step past the end of the array, so the sum became NaN. I changed it to i < xs.length, and the test passes.

───────────────────────────────────────────────────────────── thinking medium ──
›
────────────────────────────────────────────────────────────────────────────────
~/proj (main) · fix-average                                     claude-opus-5-5
ctx 3.1k/1M · ↑13k ↓598 · $0.029                 / commands · @ files · ! shell
```

## Install

```sh
npm install && npm run build && npm link   # puts `wisp` on your PATH
```

Requires Node 22+. The first time you run `wisp`, a setup dialog asks how to connect a model:

- **Anthropic** or **OpenAI:** paste an API key. Wisp checks it, then saves it to `~/.wisp/auth.json`, which only you can read.
- **Ollama:** wisp finds the models on your local Ollama.

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` work too. Run `/login` any time to add or change a provider, and `/logout` to remove a saved key.

## Usage

```sh
wisp                              # interactive session
wisp "add a --verbose flag"       # start with a prompt
wisp @src/app.ts "explain this"   # attach files
wisp -c                           # continue the last session in this directory
wisp -r                           # pick a session to resume
wisp -p "summarize the README"    # one-shot: print the answer and exit
git diff | wisp -p "review this"  # piped input joins the prompt
wisp --json "…"                   # JSON event stream (one event per line)
wisp -m ollama/qwen3-coder        # any provider/model; "claude-sonnet-5-5:high" also sets thinking
```

Run `wisp --help` for all flags. They include `--thinking`, `--auto-edit`, `-y/--yes`, `--tools`, `--session`, `--fork`, `--no-session`, `--name`, `--export`, `--system-prompt`, `--append-system-prompt`, `--no-context-files` and `--list-models`.

## Display

Wisp runs **fullscreen** by default. It takes over the terminal's alternate screen, like vim or htop, and gives you your shell back unchanged when you quit.

- **Scrolling:** the conversation scrolls in its own viewport while the editor and status bar stay pinned at the bottom. Scroll with the mouse wheel, `PgUp`/`PgDn` or `shift+↑/↓`. `Esc` or `End` jumps back to the newest output.
- **Reflow:** everything re-wraps when you resize the window.
- **Retroactive toggles:** `ctrl+o` (expand tool output) and `ctrl+t` (show thinking) apply to the whole conversation, not just new output.
- **Selecting text:** while wisp captures the mouse, hold `shift` and drag to select. Or run `/mouse` to release the mouse entirely, then scroll with `PgUp`/`PgDn`.

Prefer your terminal's normal scrollback? Use `wisp --tui-mode inline`, or set `"tuiMode": "inline"` in settings. To keep fullscreen but leave the mouse alone, set `"mouse": false`.

## Getting around

Press `?` on an empty prompt for a help dialog that shows every shortcut and lets you search all commands. Pickers open as dialogs you can type into to search. That covers models (`ctrl+l`), conversations (`/resume`), thinking levels, permission modes and `/tree`. The bottom line of the screen always shows the keys that matter right now.

## In the editor

| Key | |
|---|---|
| `enter` | send. While wisp is working, a message sent this way steers it and is delivered after the current tool calls |
| `alt+enter` | while working: queue a follow-up for when the task finishes |
| `shift+enter`, `ctrl+j`, trailing `\` | new line |
| `esc` | stop the task. Queued messages return to the editor |
| `ctrl+c` | clear the input, or stop the task. Press twice on an empty prompt to quit |
| `↑` `↓` | prompt history (saved across sessions) |
| `@` | fuzzy-find a file to attach. Directories and images work too, and you can drag in screenshots |
| `tab` | complete a path, or accept a suggestion |
| `!cmd` / `!!cmd` | run a shell command and add its output to the conversation (`!!`: don't add it) |
| `shift+tab` | cycle the thinking level. The editor border color shows the current level |
| `ctrl+l` / `ctrl+p` | open the model picker / cycle favorite models |
| `ctrl+t` / `ctrl+o` | show or hide thinking / expand the last tool output |
| `ctrl+g` | edit the prompt in `$EDITOR` |
| `ctrl+x` | copy the last response |
| `alt+↑` | pull queued messages back into the editor |
| `ctrl+_`, `ctrl+w/u/k/y`, `alt+b/f` | undo, readline-style kill and yank, word movement |
| `ctrl+z` | suspend |
| wheel, `pgup`/`pgdn`, `shift+↑/↓` | scroll the conversation (fullscreen). `esc`/`end` returns to the bottom |

Large pastes collapse into a `[Pasted #1 +120 lines]` placeholder. The full text is sent when you submit.

## Commands

`/help` (or `?`), `/model`, `/login`, `/logout`, `/tree`, `/thinking`, `/mode` (ask, auto-edit, yolo), `/new`, `/resume [all]`, `/fork`, `/name`, `/session`, `/compact [focus]`, `/copy`, `/export [file.html|file.md]`, `/reload`, `/settings` (opens `$EDITOR`, falling back to nano or vim, then reloads), `/mouse`, `/mcp` and `/exit`. Prompt templates and skills also add commands (see below).

## Sessions

Every conversation is saved automatically as an append-only JSONL file under `~/.wisp/sessions/<project>/`, so you can quit at any time.

- **Continue and resume:** `wisp -c` picks up the last session in this directory, and `wisp -r` or `/resume` opens a picker.
- **Branches (`/tree`):** each conversation is a tree. `/tree` shows every message you've sent, with side branches indented under `├─`. Pick a point and press `enter` to carry on from there, or `e` to edit that message and resend it. Either way the new path becomes a branch, and nothing is deleted, so you can always switch back. Only the conversation moves; files on disk stay as they are.
- **Fork:** `/fork` copies the current branch, or the part before a chosen message, into a separate new conversation.
- **Compaction:** `/compact` summarizes the conversation to free context. Wisp also compacts automatically at 85% of the model's context window.
- **Export:** `/export` writes the session as a standalone HTML page or as Markdown.

## Project context, skills, prompt templates

- **Context files:** `AGENTS.md` (or `CLAUDE.md`) in the current directory and every parent, plus `~/.wisp/AGENTS.md`, are added to the system prompt. `.wisp/SYSTEM.md` replaces the default prompt, and `APPEND_SYSTEM.md` appends to it.
- **Skills:** a skill is a `<dir>/<name>/SKILL.md` file with `name` and `description` frontmatter, kept in `~/.wisp/skills`, `.wisp/skills` or `.claude/skills`. The model sees each skill's description and reads the file when a task matches. You can force a skill with `/skill:<name>`.
- **Prompt templates:** `~/.wisp/prompts/review.md` or `.wisp/prompts/review.md` becomes the command `/review`. Templates support `$ARGUMENTS` and `$1`…`$9`.

## MCP servers

Wisp can use tools from any [MCP](https://modelcontextprotocol.io) server: local ones that run as a process (stdio), and remote ones (Streamable HTTP, falling back to SSE for older servers).

```sh
wisp mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code
wisp mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN='${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github
wisp mcp add docs --url https://example.com/mcp --header 'Authorization: Bearer ${DOCS_TOKEN}'
wisp mcp list            # connect to each server and show its status and tool count
wisp mcp get fs          # list one server's tools
wisp mcp remove fs
```

Servers live in `~/.wisp/mcp.json` (global), `.mcp.json` (project, shared with other tools), or `.wisp/mcp.json` (project, wisp only). They all use the standard `mcpServers` format, so configs from Claude Desktop, Cursor or Claude Code work as they are:

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/code"] },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }, "autoApprove": ["search"] }
  }
}
```

- **Tool names:** each server's tools appear to the model as `mcp__<server>__<tool>` and show in the transcript as `server › tool`.
- **Approvals:** every MCP tool call asks first and shows the full arguments. List tools in `autoApprove` (or use `"*"`) to skip the prompt for them.
- **Results:** text, images and embedded resources go back to the model. A server's own usage instructions are added to the system prompt.
- **Server options:** `${VAR}` and `${VAR:-default}` expand in commands, arguments, `env`, `url` and `headers`. Per-server options are `disabled`, `startupTimeout` (default 60s) and `timeout` per call (default 10 minutes).
- **Project trust:** a repository's MCP config can launch any command, so wisp asks before starting project servers and asks again whenever that config changes. Print mode never asks; it skips untrusted project servers unless you pass `--trust-project`.
- **In a session:** `/mcp` shows server status (with the server's error output if it failed), `/mcp tools [server]` lists tools, and `/mcp reconnect [server]` restarts one or all. The footer shows how many servers are connected.
- **Flags:** `--no-mcp` disables MCP for one run, and `--mcp-config <file>` loads an extra config file.

## Models and providers

| Provider | Needs | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Opus 5.5 (default), Sonnet 5.5, Haiku 5.5 and Fable 5.1. Adaptive thinking with effort levels, prompt caching, and summarized thinking shown live |
| `openai` | `OPENAI_API_KEY` | GPT-5 family through Chat Completions, with `reasoning_effort` |
| `ollama` | `ollama serve` | Local models are discovered automatically and appear in the picker. Any OpenAI-compatible server works through `baseURL` |

Thinking levels are `off`, `low`, `medium`, `high`, `xhigh` and `max`. Each model is limited to the levels it supports. For example, Claude Opus 5.5 always thinks, so `off` maps to `low`.

## Settings

`~/.wisp/settings.json` holds global settings and `.wisp/settings.json` holds project settings, which take precedence. Wisp remembers your last model, thinking level and mode.

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "thinking": "high",
  "permissionMode": "ask",
  "favoriteModels": ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "ollama/qwen3-coder"],
  "autoCompactAt": 0.85,
  "showThinking": true,
  "tuiMode": "fullscreen",
  "mouse": true,
  "anthropicFallbacks": false,
  "providers": { "ollama": { "baseURL": "http://gpu-box:11434/v1" } },
  "models": [{ "provider": "ollama", "id": "qwen3-coder", "name": "Qwen3 Coder", "contextWindow": 262144, "maxOutput": 32768, "thinking": ["off"], "images": false }]
}
```

## Tools and safety

The tools are `read_file` (text and images), `write_file`, `edit_file` (exact replace, with a diff), `bash` (live output, timeout, killed on Esc), `grep`, `glob` and `ls`. Search respects `.gitignore`. Read-only tools run in parallel.

- **Permission modes:** `ask` (the default) shows a diff or the command before running it. Answer **y**, **a** (always, for this session) or **n**. `auto-edit` lets file edits run without asking, and `yolo` approves everything.
- **Edit safeguard:** edits are refused unless the model has read the file and the file hasn't changed on disk since that read.
- **Denials:** if you deny a call, wisp stops and waits for you instead of retrying.

## Layout

```
src/
  index.ts            CLI flags, mode dispatch
  core/               agent loop (events, steering, compaction), sessions, settings, MCP client,
                      model catalog, context files/skills/templates, @mentions, export
  mcp-cli.ts          `wisp mcp list|get|add|remove`
  providers/          anthropic.ts, openai.ts (also Ollama & compatible servers)
  tools/              files, bash, search, diff
  tui/                terminal + key/mouse parsing, fullscreen + inline renderers, editor,
                      autocomplete, select lists, markdown + highlighting, transcript blocks, app
  modes/print.ts      --print / --json
test/                 node:test suites (no network)
```

## Development

```sh
npm run dev -- -p "hello"   # run from source
npm test                    # 37 tests, no API calls
npm run typecheck
```
