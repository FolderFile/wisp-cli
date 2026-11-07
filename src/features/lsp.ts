import type { Feature, FeatureHost } from '../core/hooks.js';
import { formatForModel, LspManager } from '../lsp/manager.js';
import type { ServerSpec } from '../lsp/servers.js';

/**
 * Code diagnostics: after the model edits or writes a file, ask the language
 * server for that file (typescript-language-server, pyright, rust-analyzer,
 * gopls, ... whichever is installed) and append its errors to the tool
 * result, so the model sees and fixes them in the same turn. Reading a file
 * starts its server in the background. Nothing happens for languages without
 * an installed server.
 */
const WARM_TOOLS = new Set(['read_file', 'edit_file', 'write_file']);
const CHECK_TOOLS = new Set(['edit_file', 'write_file']);

export function lspFeature(o: { specs?: ServerSpec[] } = {}): Feature {
  let host: FeatureHost;
  let manager: LspManager | undefined;
  const warned = new Set<string>();

  const enabled = () => host.settings.get<boolean>('lsp') !== false;
  const lsp = () =>
    (manager ??= new LspManager({
      cwd: host.cwd,
      specs: o.specs,
      warn: (m) => {
        if (warned.has(m)) return;
        warned.add(m);
        host.ui.notice(m, 'warn');
      },
    }));
  const pathOf = (input: Record<string, unknown>) => (typeof input.path === 'string' && input.path ? input.path : undefined);

  return {
    name: 'lsp',
    settings: [
      {
        key: 'lsp',
        label: 'Code diagnostics',
        description: 'After an edit, ask the language server for the file and show its errors to the model.',
        type: 'boolean',
        values: [true, false],
        default: true,
        apply: (v) => {
          if (v === false && manager) void manager.stopAll();
        },
      },
    ],
    setup(h) {
      host = h;
    },
    beforeToolCall(call) {
      if (!enabled() || !WARM_TOOLS.has(call.name)) return;
      const path = pathOf(call.input);
      try {
        if (path && lsp().handles(path)) lsp().warm(path);
      } catch {}
    },
    async afterToolResult(call, result, ctx) {
      if (!enabled() || result.isError || !CHECK_TOOLS.has(call.name)) return;
      const path = pathOf(call.input);
      if (!path || !lsp().handles(path)) return;
      const report = await lsp().check(path, ctx.toolContext.signal);
      const text = report && formatForModel(report);
      if (!report || !text) return;
      host.ui.flash(report.fixed ? `✓ ${report.path}: no errors` : `✗ ${report.path}: ${report.total} error${report.total === 1 ? '' : 's'}`);
      return { append: text };
    },
    async shutdown() {
      await manager?.stopAll(true);
    },
  };
}
