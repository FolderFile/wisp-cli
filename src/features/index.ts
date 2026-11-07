import type { Feature, FeatureHost, SlashCommand } from '../core/hooks.js';
import type { PermissionMode } from '../core/settings.js';
import { checkpointsFeature } from './checkpoints.js';
import { lspFeature } from './lsp.js';
import { permissionsFeature } from './permissions.js';
import { subagentsFeature } from './subagents.js';
import { todoFeature } from './todo.js';

export type { Feature, FeatureHost, SlashCommand } from '../core/hooks.js';

/**
 * The features wisp ships with. To add one: write src/features/<name>.ts
 * exporting a factory that returns a Feature, and add it here.
 */
export function builtinFeatures(o: { permissionMode: PermissionMode }): Feature[] {
  // permissions first: the others' hooks only see calls it let through
  return [permissionsFeature(o.permissionMode), checkpointsFeature(), lspFeature(), todoFeature(), subagentsFeature()];
}

/** Register settings, run setup(), then hand each feature to the agent (tools + hooks). */
export function installFeatures(host: FeatureHost, features: Feature[]) {
  for (const f of features) {
    for (const def of f.settings ?? []) host.settings.define(def);
    f.setup?.(host);
    host.agent.register(f);
  }
}

export function featureCommands(features: readonly Feature[]): SlashCommand[] {
  return features.flatMap((f) => f.commands ?? []);
}

/** Widget lines for above the editor; a broken widget is skipped. */
export function featureWidgets(features: readonly Feature[]): string[] {
  const out: string[] = [];
  for (const f of features) {
    try {
      const w = f.widget?.();
      if (w) out.push(...(Array.isArray(w) ? w : [w]));
    } catch {}
  }
  return out;
}

export function featureStatus(features: readonly Feature[]): string[] {
  const out: string[] = [];
  for (const f of features) {
    try {
      const s = f.status?.();
      if (s) out.push(s);
    } catch {}
  }
  return out;
}

/** Run every feature's shutdown hook, at most `ms` in all. */
export async function shutdownFeatures(features: readonly Feature[], ms = 3000) {
  const all = Promise.all(features.map((f) => Promise.resolve().then(() => f.shutdown?.()).catch(() => undefined)));
  await Promise.race([all, new Promise((r) => setTimeout(r, ms).unref())]);
}
