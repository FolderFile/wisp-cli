import type { Feature, FeatureHost } from '../core/hooks.js';
import type { PermissionMode } from '../core/settings.js';
import { ToolError } from '../tools/types.js';

type Answer = 'yes' | 'always' | 'no';

const DESCRIBE: Record<PermissionMode, string> = {
  yolo: 'never asks',
  'auto-edit': 'edits files freely, asks before commands',
  ask: 'asks before edits and commands',
};

/**
 * Asks before edits and commands, depending on the mode. The mode starts from
 * the `permissionMode` setting (or -y / --auto-edit / --permission) and /mode
 * changes it for this run only: it is never saved.
 */
export function permissionsFeature(initial: PermissionMode): Feature & { mode: PermissionMode } {
  let host: FeatureHost;
  const always = new Set<string>();

  const f: Feature & { mode: PermissionMode } = {
    name: 'permissions',
    mode: initial,
    setup(h) {
      host = h;
    },
    status: () => (f.mode === 'yolo' ? null : f.mode),

    async beforeToolCall(call, ctx) {
      const { tool } = ctx;
      if (tool.permission === 'none' || f.mode === 'yolo') return;
      if (f.mode === 'auto-edit' && tool.permission === 'edit') return;
      if (always.has(tool.name)) return;
      if (!host.ui.interactive)
        return {
          block: `This action needs the user's approval, but wisp is running non-interactively. Tell the user to re-run with --auto-edit or --yes if they want to allow it.`,
          halt: true,
        };
      let preview: string;
      try {
        preview = tool.preview ? await tool.preview(call.input, ctx.toolContext) : `${tool.name}: ${tool.label(call.input)}`;
      } catch (e) {
        // e.g. edit target not found: just run it so the model gets the error
        if (e instanceof ToolError) return;
        throw e;
      }
      ctx.setStatus('waiting');
      const name = tool.mcp ? `${tool.mcp.server} › ${tool.mcp.tool}` : tool.name;
      const what = tool.mcp ? 'calls' : tool.permission === 'exec' ? 'commands' : 'edits';
      const title = tool.mcp ? `Allow ${name}?` : tool.permission === 'exec' ? 'Run this command?' : tool.name === 'write_file' ? 'Write this file?' : 'Make this edit?';
      const answer = await host.ui.select<Answer>({
        title,
        anchor: 'bottom',
        signal: ctx.toolContext.signal,
        body: () => {
          const max = Math.max(4, host.ui.height - 14);
          const lines = preview.split('\n');
          return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`] : lines;
        },
        options: [
          { label: 'Yes', value: 'yes', hotkey: 'y', detail: 'y' },
          { label: `Yes, and don’t ask again for ${name} ${what} this session`, value: 'always', hotkey: 'a', detail: 'a' },
          { label: 'No, and tell wisp what to do instead', value: 'no', hotkey: 'n', detail: 'n' },
        ],
        hint: 'y yes · a always · n no · esc no',
      });
      if (ctx.toolContext.signal.aborted) return { block: 'Interrupted by user.', halt: true };
      if (!answer || answer === 'no') return { block: 'The user denied this action. Do not retry it; wait for their instructions.', halt: true };
      if (answer === 'always') always.add(tool.name);
      ctx.setStatus('approved');
    },

    commands: [
      {
        name: 'mode',
        description: 'When to ask before edits and commands (this run only)',
        whileBusy: true,
        async run(args) {
          const typed = args.trim() as PermissionMode;
          const mode =
            typed in DESCRIBE
              ? typed
              : await host.ui.select<PermissionMode>({
                  title: 'When should wisp ask first? (this run only)',
                  options: (['yolo', 'auto-edit', 'ask'] as PermissionMode[]).map((m) => ({ label: m, value: m, detail: DESCRIBE[m] })),
                  initial: ['yolo', 'auto-edit', 'ask'].indexOf(f.mode),
                  body: () => ['The default for new runs is in /settings.'],
                });
          if (!mode) return;
          f.mode = mode;
          host.ui.notice(`Mode: ${mode} — ${DESCRIBE[mode]} (this run only; the default is in /settings)`);
        },
      },
    ],
  };
  return f;
}
