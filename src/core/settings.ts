import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROVIDERS, type ModelInfo, type ProviderName } from './models.js';
import { THINKING_LEVELS, type ThinkingLevel } from './types.js';

export type PermissionMode = 'ask' | 'auto-edit' | 'yolo';
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto-edit', 'yolo'];

export const AGENT_DIR = process.env.WISP_HOME || join(homedir(), '.wisp');
export const GLOBAL_SETTINGS = join(AGENT_DIR, 'settings.json');
export const projectSettingsPath = (cwd: string) => join(cwd, '.wisp', 'settings.json');

export type Scope = 'global' | 'project';

/**
 * One settings row. `values` (for enums and booleans) is what Enter cycles
 * through in /settings; `hidden` keys are validated and stored but have no row
 * (they are edited elsewhere, e.g. /model, or by hand).
 */
export interface SettingDef<T = unknown> {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'enum' | 'number' | 'string' | 'json';
  values?: readonly T[];
  default: T;
  /** Extra check beyond type/values; return false for invalid. */
  validate?: (v: unknown) => boolean;
  /** How a value is shown in /settings. */
  format?: (v: T) => string;
  /** Applies a new value live. Hosts may set/replace this at runtime (see SettingsStore.onApply). */
  apply?: (v: T) => void;
  hidden?: boolean;
}

const autoCompactLabel = (v: number) => (v === 0 ? 'off' : `at ${Math.round(v * 100)}% full`);

/** Core settings. Features add theirs through Feature.settings. */
export const CORE_SETTINGS: SettingDef<any>[] = [
  {
    key: 'thinking',
    label: 'Thinking',
    description: 'Default thinking level (also set by /thinking and shift+tab)',
    type: 'enum',
    values: THINKING_LEVELS,
    default: 'medium' as ThinkingLevel,
  },
  {
    key: 'permissionMode',
    label: 'Ask before acting',
    description: 'Default for new runs: yolo never asks, auto-edit asks before commands, ask asks before edits and commands. /mode changes only this run.',
    type: 'enum',
    values: ['yolo', 'auto-edit', 'ask'] as PermissionMode[],
    default: 'yolo' as PermissionMode,
    format: (v: PermissionMode) => (v === 'yolo' ? 'never (yolo)' : v === 'auto-edit' ? 'before commands (auto-edit)' : 'before edits and commands (ask)'),
  },
  { key: 'showThinking', label: 'Show thinking', description: 'Show the model’s reasoning in the conversation (ctrl+t)', type: 'boolean', values: [true, false], default: true },
  { key: 'mouse', label: 'Mouse wheel scrolling', description: 'Capture the mouse for scrolling (off: select text natively)', type: 'boolean', values: [true, false], default: true },
  {
    key: 'autoCompactAt',
    label: 'Auto-compact',
    description: 'Summarize the conversation automatically when the context is this full',
    type: 'number',
    values: [0.85, 0.9, 0.95, 0.7, 0.8, 0],
    default: 0.85,
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
    format: autoCompactLabel,
  },
  { key: 'quietStartup', label: 'Quiet startup', description: 'Hide the loaded-files line and the welcome text', type: 'boolean', values: [false, true], default: false },
  // set by /model (Ctrl+L); a resumed conversation uses its own model without changing these
  { key: 'provider', label: 'Provider', description: 'Default provider', type: 'enum', values: PROVIDERS, default: undefined, hidden: true },
  { key: 'model', label: 'Model', description: 'Default model id', type: 'string', default: undefined, hidden: true },
  {
    key: 'favoriteModels',
    label: 'Favorite models',
    description: 'Models cycled by ctrl+p, as "provider/id"',
    type: 'json',
    default: [] as string[],
    validate: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    hidden: true,
  },
  {
    key: 'models',
    label: 'Custom models',
    description: 'Extra models (context window, price, thinking levels)',
    type: 'json',
    default: [] as ModelInfo[],
    validate: (v) => Array.isArray(v) && v.every((m) => m && typeof m.id === 'string' && PROVIDERS.includes(m.provider)),
    hidden: true,
  },
  {
    key: 'providers',
    label: 'Provider endpoints',
    description: 'Per-provider base URLs: { "ollama": { "baseURL": "…" } }. API keys live in auth.json (/login) or env vars.',
    type: 'json',
    default: {} as Partial<Record<ProviderName, { baseURL?: string }>>,
    validate: (v) =>
      Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as object).every(([k, p]) => PROVIDERS.includes(k as ProviderName) && p && typeof p === 'object' && !('apiKey' in p)),
    hidden: true,
  },
];

/** The typed view the rest of the code reads (always valid, defaults filled in). */
export interface Settings {
  provider?: ProviderName;
  model?: string;
  thinking: ThinkingLevel;
  permissionMode: PermissionMode;
  showThinking: boolean;
  mouse: boolean;
  autoCompactAt: number;
  quietStartup: boolean;
  favoriteModels: string[];
  models: ModelInfo[];
  providers: Partial<Record<ProviderName, { baseURL?: string }>>;
  [key: string]: unknown;
}

type Raw = Record<string, unknown>;

function typeOk(def: SettingDef, v: unknown): boolean {
  if ((def.type === 'enum' || def.type === 'boolean') && def.values && !def.values.includes(v)) return false;
  switch (def.type) {
    case 'boolean':
      if (typeof v !== 'boolean') return false;
      break;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      break;
    case 'string':
    case 'enum':
      if (typeof v !== 'string') return false;
      break;
  }
  return def.validate ? def.validate(v) : true;
}

/**
 * Global (~/.wisp/settings.json) and project (.wisp/settings.json) settings,
 * project winning. Every value is validated against its definition: a bad
 * value produces one warning and the default is used instead. A file that
 * doesn't parse is ignored (with a warning) and never overwritten.
 */
export class SettingsStore {
  readonly defs = new Map<string, SettingDef<any>>();
  global: Raw = {};
  project: Raw = {};
  /** Human-readable problems found while loading; the UI shows each once. */
  warnings: string[] = [];
  private broken = new Set<Scope>();
  private warned = new Set<string>();
  private listeners = new Map<string, Set<(v: any) => void>>();

  constructor(
    private cwd: string,
    private paths: Record<Scope, string> = { global: GLOBAL_SETTINGS, project: projectSettingsPath(cwd) },
  ) {
    for (const d of CORE_SETTINGS) this.define(d);
    this.reload();
  }

  define(def: SettingDef<any>) {
    this.defs.set(def.key, def);
    // re-check values already loaded for this key
    for (const scope of ['global', 'project'] as Scope[]) this.check(scope, def.key);
  }

  path(scope: Scope) {
    return this.paths[scope];
  }

  /** Re-read both files. */
  reload() {
    for (const scope of ['global', 'project'] as Scope[]) {
      this.broken.delete(scope);
      const path = this.paths[scope];
      let raw: Raw = {};
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
        else this.warn(`${path}: expected a JSON object; ignoring it.`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.broken.add(scope);
          this.warn(`${path} is not valid JSON (${(err as Error).message}); using defaults and not writing to it until fixed.`);
        }
      }
      this[scope] = raw;
      for (const key of Object.keys(raw)) this.check(scope, key);
    }
  }

  private warn(text: string) {
    if (this.warned.has(text)) return;
    this.warned.add(text);
    this.warnings.push(text);
  }

  /** Take the warnings not yet shown. */
  takeWarnings(): string[] {
    const w = this.warnings;
    this.warnings = [];
    return w;
  }

  private check(scope: Scope, key: string): boolean {
    const raw = this[scope];
    if (!(key in raw)) return false;
    const def = this.defs.get(key);
    if (!def) return true; // unknown keys may belong to a feature that isn't loaded; leave them alone
    if (raw[key] === undefined || raw[key] === null || typeOk(def, raw[key])) return true;
    const hint = key === 'providers' ? ' (API keys belong in auth.json via /login, or env vars)' : def.values ? ` (expected one of: ${def.values.map(String).join(', ')})` : '';
    this.warn(`${this.paths[scope]}: invalid "${key}": ${JSON.stringify(raw[key])}${hint}; using ${scope === 'project' ? 'the global value' : 'the default'}.`);
    return false;
  }

  private valid(scope: Scope, key: string): boolean {
    const v = this[scope][key];
    if (v === undefined || v === null) return false;
    const def = this.defs.get(key);
    return !def || typeOk(def, v);
  }

  /** Which file the effective value comes from. */
  source(key: string): Scope | 'default' {
    if (this.valid('project', key)) return 'project';
    if (this.valid('global', key)) return 'global';
    return 'default';
  }

  get<T = unknown>(key: string): T {
    const src = this.source(key);
    if (src !== 'default') return this[src][key] as T;
    return this.defs.get(key)?.default as T;
  }

  /** All known keys with effective values. Custom models from both files are combined. */
  get merged(): Settings {
    const out: Raw = {};
    for (const key of this.defs.keys()) out[key] = this.get(key);
    const models = [...(this.valid('project', 'models') ? (this.project.models as ModelInfo[]) : []), ...(this.valid('global', 'models') ? (this.global.models as ModelInfo[]) : [])];
    out.models = models;
    return out as Settings;
  }

  /**
   * Persist a value and apply it live. Writes the global file unless scope is
   * 'project'. Returns `overridden: true` when a project value still wins.
   */
  set(key: string, value: unknown, scope: Scope = 'global'): { saved: boolean; overridden: boolean; error?: string } {
    const def = this.defs.get(key);
    if (def && value !== undefined && !typeOk(def, value)) return { saved: false, overridden: false, error: `invalid value for ${key}` };
    const before = this.get(key);
    const next = { ...this[scope] };
    if (value === undefined) delete next[key];
    else next[key] = value;
    let saved = false;
    let error: string | undefined;
    if (this.broken.has(scope)) error = `${this.paths[scope]} is not valid JSON; fix it to save settings`;
    else {
      try {
        mkdirSync(dirname(this.paths[scope]), { recursive: true });
        writeFileSync(this.paths[scope], JSON.stringify(next, null, 2) + '\n');
        saved = true;
      } catch (err) {
        error = `could not write ${this.paths[scope]}: ${(err as Error).message}`;
      }
    }
    // keep the change in memory for this run even if it couldn't be written
    this[scope] = next;
    const after = this.get(key);
    if (after !== before) this.applyKey(key, after);
    return { saved, overridden: scope === 'global' && this.source(key) === 'project', error };
  }

  /** Register a live-apply callback for a key (in addition to def.apply). */
  onApply(key: string, fn: (v: any) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private applyKey(key: string, value: unknown) {
    try {
      this.defs.get(key)?.apply?.(value);
    } catch {}
    for (const fn of this.listeners.get(key) ?? []) {
      try {
        fn(value);
      } catch {}
    }
  }

  /** Re-read the files and apply every key whose effective value changed. */
  reloadAndApply() {
    const before = new Map([...this.defs.keys()].map((k) => [k, JSON.stringify(this.get(k))]));
    this.reload();
    for (const [k, v] of before) if (JSON.stringify(this.get(k)) !== v) this.applyKey(k, this.get(k));
  }

  /** Next value when Enter is pressed on a row. */
  nextValue(key: string): unknown {
    const def = this.defs.get(key);
    if (!def?.values?.length) return this.get(key);
    const i = def.values.indexOf(this.get(key));
    return def.values[(i + 1) % def.values.length];
  }

  format(key: string, v = this.get(key)): string {
    const def = this.defs.get(key);
    if (def?.format) return def.format(v);
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    return String(v);
  }
}
