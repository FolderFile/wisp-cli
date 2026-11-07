import type { Agent } from '../core/agent.js';
import type { Feature, FeatureHost } from '../core/hooks.js';
import { addUsage } from '../core/types.js';
import { answerText, formatElapsed, Limiter, MAX_CONCURRENT, runSubagent, SUBAGENT_TOOL, SUBAGENT_TOOL_SPEC, type SubagentAccess, type SubagentResult } from '../subagent-runner.js';
import { ToolError, type Tool, type ToolOutput } from '../tools/types.js';

/**
 * Subagents: the `subagent` tool hands a focused job to a separate in-process
 * Agent with a fresh context (../subagent-runner.ts) and returns its answer.
 *
 * - The child runs on the parent's current provider, model and thinking level.
 * - The parent's tool hooks (permissions, checkpoints, diagnostics) run for the
 *   child's calls too; hooks of calls that can change things run one at a time,
 *   so approval dialogs never overlap.
 * - The transcript shows one line per call ("done · 3 tools · 12s · $0.004");
 *   the child's usage and cost count toward the session's totals.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

/** The transcript line: "done · 2 tools · 12s · $0.012". */
export function summaryLine(r: { status: string; toolCount: number; ms: number; cost: number }): string {
  const parts = [r.status, plural(r.toolCount, 'tool'), formatElapsed(r.ms)];
  if (r.cost > 0) parts.push(formatCost(r.cost));
  return parts.join(' · ');
}

export function subagentsFeature(o: { maxConcurrent?: number } = {}): Feature & { running: number } {
  let host: FeatureHost | undefined;
  let enabled = true;
  const limiter = new Limiter(o.maxConcurrent ?? MAX_CONCURRENT);
  let chain: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  /** The parent's tool hooks, for the child (not this feature, not tools-only ones). */
  const forwarded = (parent: Agent): Feature[] =>
    parent.features
      .filter((f) => f !== self && (f.beforeToolCall || f.afterToolResult))
      .map((f) => ({
        name: f.name,
        beforeToolCall: f.beforeToolCall
          ? (call, ctx) => (ctx.tool.permission === 'none' ? f.beforeToolCall!(call, ctx) : oneAtATime(async () => f.beforeToolCall!(call, ctx)))
          : undefined,
        afterToolResult: f.afterToolResult?.bind(f),
      }));

  const tool: Tool<{ description: string; prompt: string; access?: SubagentAccess }> = {
    ...SUBAGENT_TOOL_SPEC,
    name: SUBAGENT_TOOL,
    // the child's own calls go through the hooks, so the call itself needs no approval (and runs in parallel)
    permission: 'none',
    label: (i) => `${i.description ?? ''}${i.access === 'write' ? ' (write)' : ''}`,
    async run(input, ctx): Promise<ToolOutput> {
      if (!host) throw new ToolError('Subagents are not set up.');
      const parent = host.agent;
      self.running++;
      host.ui.render();
      let r: SubagentResult;
      try {
        r = await runSubagent({
          description: input.description,
          prompt: input.prompt,
          access: input.access === 'write' ? 'write' : 'read',
          provider: parent.opts.provider,
          model: parent.opts.model,
          thinking: parent.opts.thinking,
          tools: parent.tools,
          features: forwarded(parent),
          cwd: ctx.cwd,
          signal: ctx.signal,
          limiter,
          onProgress: (p) => ctx.onUpdate?.(p.status === 'waiting' ? 'waiting for a free slot' : summaryLine(p)),
        });
      } finally {
        self.running--;
      }
      // the child's spend counts toward the session's totals (footer, /session, the session file)
      parent.usage = addUsage(parent.usage, r.usage);
      parent.costUSD += r.cost;
      try {
        host.session().log({ type: 'usage', usage: parent.usage, costUSD: parent.costUSD, contextUsed: parent.contextUsed });
      } catch {}
      host.ui.render();
      if (r.status === 'stopped' && ctx.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      if (r.status === 'failed') throw new ToolError(answerText(r));
      return { content: answerText(r), display: summaryLine(r) };
    },
  };

  const self: Feature & { running: number } = {
    name: 'subagents',
    running: 0,
    settings: [
      {
        key: 'subagents',
        label: 'Subagents',
        description: 'Let the model hand self-contained tasks to subagents with a fresh context (the subagent tool).',
        type: 'boolean',
        values: [true, false],
        default: true,
        apply: (v) => {
          enabled = v !== false;
          host?.refreshTools();
        },
      },
    ],
    setup(h) {
      host = h;
      enabled = h.settings.get<boolean>('subagents') !== false;
    },
    tools: () => (enabled ? [tool] : []),
    status: () => (self.running > 0 ? plural(self.running, 'subagent') : null),
  };
  return self;
}
