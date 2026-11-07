import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { THINKING_LEVELS, type ThinkingLevel } from './types.js';
import { PROVIDERS, type ModelInfo, type ProviderName } from './models.js';

export type PermissionMode = 'ask' | 'auto-edit' | 'yolo';
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto-edit', 'yolo'];

export interface ProviderSettings {
  apiKey?: string;
  baseURL?: string;
}

export interface Settings {
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
  permissionMode?: PermissionMode;
  maxTokens?: number;
  /** Models offered in Ctrl+P cycling, as "provider/id". */
  favoriteModels?: string[];
  /** Extra models (e.g. local Ollama ones) with context windows and prices. */
  models?: ModelInfo[];
  providers?: Partial<Record<ProviderName, ProviderSettings>>;
  /** Summarize automatically when the context is this full (0-1). 0 disables. */
  autoCompactAt?: number;
  showThinking?: boolean;
  /** Anthropic: retry refused requests on a fallback model server-side. */
  anthropicFallbacks?: boolean;
  quietStartup?: boolean;
  /** fullscreen (alternate screen, scrollable) or inline (normal scrollback). */
  tuiMode?: 'fullscreen' | 'inline';
  /** Fullscreen: capture the mouse wheel for scrolling. */
  mouse?: boolean;
}

export const AGENT_DIR = process.env.WISP_HOME || join(homedir(), '.wisp');
export const GLOBAL_SETTINGS = join(AGENT_DIR, 'settings.json');
export const projectSettingsPath = (cwd: string) => join(cwd, '.wisp', 'settings.json');

function readJson(path: string): Settings {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
  }
}

function validate(s: Settings, path: string): Settings {
  if (s.provider && !PROVIDERS.includes(s.provider)) throw new Error(`${path}: unknown provider "${s.provider}"`);
  if (s.thinking && !THINKING_LEVELS.includes(s.thinking)) throw new Error(`${path}: unknown thinking level "${s.thinking}"`);
  return s;
}

export class SettingsStore {
  global: Settings;
  project: Settings;

  constructor(private cwd: string) {
    this.global = validate(readJson(GLOBAL_SETTINGS), GLOBAL_SETTINGS);
    this.project = validate(readJson(projectSettingsPath(cwd)), projectSettingsPath(cwd));
  }

  /** Re-read both files (throws on invalid JSON, leaving the old values in place). */
  reload() {
    const global = validate(readJson(GLOBAL_SETTINGS), GLOBAL_SETTINGS);
    const project = validate(readJson(projectSettingsPath(this.cwd)), projectSettingsPath(this.cwd));
    this.global = global;
    this.project = project;
  }

  /** Project settings override global ones (provider maps are merged). */
  get merged(): Settings {
    const providers: Settings['providers'] = { ...this.global.providers };
    for (const [k, v] of Object.entries(this.project.providers ?? {}))
      providers[k as ProviderName] = { ...providers[k as ProviderName], ...v };
    return {
      ...this.global,
      ...this.project,
      providers,
      models: [...(this.project.models ?? []), ...(this.global.models ?? [])],
    };
  }

  /** Persist preferences (last model, thinking level...) to the global file. */
  saveGlobal(patch: Partial<Settings>) {
    this.global = { ...this.global, ...patch };
    try {
      mkdirSync(dirname(GLOBAL_SETTINGS), { recursive: true });
      writeFileSync(GLOBAL_SETTINGS, JSON.stringify(this.global, null, 2) + '\n');
    } catch {
      // read-only home etc.: preferences just won't persist
    }
  }
}
