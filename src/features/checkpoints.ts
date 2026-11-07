import {
  type CheckpointLog,
  type CommandOutcome,
  describeRestore,
  type LogEntry,
  pendingPlan,
  PromptCheckpoints,
  restorePlan,
} from '../checkpoints.js';
import type { Feature, FeatureHost } from '../core/hooks.js';
import { branchEntries, type Session, type SessionEntry } from '../core/session.js';
import type { Tool } from '../tools/types.js';

/**
 * Checkpoints: /undo and /redo for the files a prompt changed, and restoring
 * files when /tree moves to another point. The engine (../checkpoints.ts)
 * keeps snapshots in a shadow git repository under ~/.wisp/checkpoints and
 * its records as `custom` entries in the session, attached to the node that
 * was the head when they were logged.
 */

const toLog = (e: SessionEntry): LogEntry =>
  e.type === 'custom' ? { id: e.id, type: 'custom', customType: e.customType, data: e.data } : { id: (e as { id: string }).id, type: e.type };

/** The session as the checkpoint engine sees it. */
export function checkpointLog(session: Session): CheckpointLog {
  return {
    getEntries: () => session.entries.filter((e) => e.type === 'custom').map(toLog),
    getBranch: (leafId?: string) => branchEntries(session.entries, leafId).map(toLog),
  };
}

/** Tools that cannot change files (the same rule the agent uses to run calls in parallel). */
const isReadOnly = (t: Tool) => t.permission === 'none' && (!t.mcp || t.mcp.readOnly);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function checkpointsFeature(o: { home?: string } = {}): Feature & { idle(): Promise<void> } {
  let host: FeatureHost;
  const bySession = new WeakMap<Session, PromptCheckpoints>();
  let offering: Promise<void> = Promise.resolve();

  const enabled = () => host.settings.get<boolean>('checkpoints') !== false;
  const cpFor = (session: Session) => {
    let cp = bySession.get(session);
    if (!cp) {
      cp = new PromptCheckpoints({
        cwd: host.cwd,
        agentDir: o.home,
        log: checkpointLog(session),
        leafId: () => session.head,
        append: (kind, data) => session.custom(kind, data),
        warn: (m) => host.ui.notice(m, 'warn'),
      });
      bySession.set(session, cp);
    }
    return cp;
  };
  const cp = () => cpFor(host.session());

  const report = (r: CommandOutcome) => {
    host.ui.notice(r.message, r.level === 'error' ? 'error' : r.level === 'warning' ? 'warn' : r.result ? 'success' : 'info');
    if (r.modelNote) host.agent.note(`${r.modelNote} Re-read them before editing.`);
  };

  const command = (name: 'undo' | 'redo', description: string) => ({
    name,
    description,
    async run() {
      if (!enabled()) return host.ui.notice(`/${name} is unavailable while Checkpoints are off. Turn them on in /settings.`);
      if (host.agent.running) return host.ui.notice(`wisp is still working. Press Esc to stop it, then /${name}.`, 'warn');
      await offering;
      report(await (name === 'undo' ? cp().undo() : cp().redo()));
    },
  });

  /** After /tree moved from `from`: offer to restore the files to the new point. */
  const offerRestore = async (session: Session, from: string | null) => {
    const c = cpFor(session);
    await c.flush();
    const repo = await c.repo();
    if (!repo) return;
    const to = session.head;
    const plan = await pendingPlan(repo, restorePlan(checkpointLog(session), repo.root, from, to));
    if (!plan.size || host.session() !== session || session.head !== to) return;
    const files = [...plan.keys()];
    const yes = await host.ui.select<boolean>({
      title: 'Restore files to that point too?',
      body: () => [
        'Prompts that changed these files are not part of this point of the conversation:',
        ...files.slice(0, 8).map((f) => `  ${f}`),
        ...(files.length > 8 ? [`  … and ${files.length - 8} more`] : []),
      ],
      options: [
        { label: `Yes, restore ${plural(plan.size, 'file')}`, value: true, hotkey: 'y' },
        { label: 'No, conversation only', value: false, hotkey: 'n' },
      ],
    });
    if (!yes || host.session() !== session) return;
    const r = await c.restoreTo(from, session.head);
    const changed = [...r.restored, ...r.removed];
    if (changed.length)
      host.agent.note(`The user moved to an earlier point of the conversation and restored the files to that point. Files affected: ${changed.slice(0, 50).join(', ')}. Re-read them before editing.`);
    host.ui.notice(`Files back to that point: ${describeRestore(r)}.`, r.failed.length ? 'warn' : 'success');
  };

  return {
    name: 'checkpoints',
    settings: [
      {
        key: 'checkpoints',
        label: 'Checkpoints',
        description: 'Snapshot files before a prompt changes them, so /undo, /redo and /tree can restore them.',
        type: 'boolean',
        values: [true, false],
        default: true,
      },
    ],
    setup(h) {
      host = h;
    },
    /** Resolves when background snapshots and restores are done (tests). */
    async idle() {
      await offering;
      await cp().flush();
    },
    turnStart() {
      if (enabled()) cp().beginPrompt();
    },
    async beforeToolCall(call, ctx) {
      if (!enabled() || isReadOnly(ctx.tool)) return;
      try {
        await cp().beforeToolCall(call.name);
      } catch {
        // a safety net: never block a tool call
      }
    },
    async turnEnd() {
      const c = cp();
      c.settle();
      // print mode exits right after the turn
      if (!host.ui.interactive) await c.flush(5000);
    },
    sessionLoaded({ session, reason }) {
      if (enabled() && (reason === 'startup' || reason === 'resume')) cpFor(session).recover();
    },
    branchChanged({ session, from }) {
      if (!enabled() || !host.ui.interactive || from === session.head) return;
      offering = offerRestore(session, from).catch(() => undefined);
    },
    async shutdown() {
      const c = cp();
      c.settle();
      await c.flush(5000);
    },
    commands: [command('undo', 'Undo the file changes of the last prompt'), command('redo', 'Bring back the file changes /undo reverted')],
  };
}
