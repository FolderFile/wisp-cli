# Changelog

## Unreleased

### Added
- Checkpoints: `/undo` and `/redo` restore the files a prompt changed, from snapshots in a shadow git repository under `~/.wisp/checkpoints/`. They follow the `/tree` branch, survive a crash mid-prompt, and `/tree` offers to restore files along with the conversation.
- Subagents: a `subagent` tool that runs a separate in-process agent with a fresh context (read or write access, up to 4 in parallel, cost added to the session, one line in the transcript).
- Todo list: a `todo` tool whose open items show as one line above the input; rebuilt on resume and `/tree`.
- Code diagnostics: language-server errors are appended to `edit_file`/`write_file` results; reading a file warms its server.
- Settings rows `checkpoints`, `subagents`, `todo` and `lsp` (on by default, applied live).
- Feature hooks: `shutdown()`, and `branchChanged` now receives the previous head. Sessions can hold `custom` entries for feature data.

### Changed
- The engine is wisp's own (agent loop, hooks, schema-driven settings, `/settings` dialog); features live in `src/features/`.
