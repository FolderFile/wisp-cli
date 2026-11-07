import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { credentialSource, savedApiKey, savedBaseURL } from './auth.js';
import { DEFAULT_MODEL, PROVIDERS, modelInfo, type ModelInfo, type ProviderName } from './models.js';
import type { Settings } from './settings.js';
import type { Provider } from './types.js';

export interface ModelRef {
  provider: ProviderName;
  id: string;
}

export function parseModelRef(s: string, fallbackProvider?: ProviderName): ModelRef {
  const slash = s.indexOf('/');
  if (slash > 0 && PROVIDERS.includes(s.slice(0, slash) as ProviderName))
    return { provider: s.slice(0, slash) as ProviderName, id: s.slice(slash + 1) };
  if (fallbackProvider) return { provider: fallbackProvider, id: s };
  // Guess from well-known prefixes.
  if (s.startsWith('claude')) return { provider: 'anthropic', id: s };
  if (/^(gpt|o\d|chatgpt)/.test(s)) return { provider: 'openai', id: s };
  return { provider: 'ollama', id: s };
}

export const formatRef = (r: ModelRef) => `${r.provider}/${r.id}`;

export function hasCredentials(p: ProviderName, s: Settings): boolean {
  if (p === 'ollama') return true; // local, no key
  return credentialSource(p, s.providers?.[p]?.apiKey) !== null;
}

export function ollamaBaseURL(s: Settings): string {
  return s.providers?.ollama?.baseURL ?? savedBaseURL('ollama') ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
}

/** Is a local Ollama answering? (Short timeout: used at startup.) */
export async function ollamaReachable(s: Settings, ms = 800): Promise<boolean> {
  try {
    const res = await fetch(ollamaBaseURL(s).replace(/\/v1\/?$/, '') + '/api/tags', { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Was a provider chosen on purpose (flag, env, settings) rather than guessed? */
export function providerChosen(flags: { provider?: string; model?: string }, s: Settings): boolean {
  return Boolean(flags.provider || flags.model || process.env.WISP_PROVIDER || process.env.WISP_MODEL || s.provider);
}

/** Stand-in used until a provider is set up (first run): every request explains how to fix it. */
export class UnconfiguredProvider implements Provider {
  readonly name = 'none';
  readonly model = 'not set up';
  async complete(): Promise<never> {
    throw new NotConfiguredError();
  }
}

export class NotConfiguredError extends Error {
  constructor() {
    super('No model is set up yet. Run /login to connect Anthropic, OpenAI or a local Ollama.');
    this.name = 'NotConfiguredError';
  }
}

/** Precedence: CLI flags > env vars > settings (project > global) > auto-detect. */
export function resolveModel(flags: { provider?: string; model?: string }, s: Settings): ModelRef {
  const providerFlag = flags.provider ?? process.env.WISP_PROVIDER;
  if (providerFlag && !PROVIDERS.includes(providerFlag as ProviderName))
    throw new Error(`Unknown provider "${providerFlag}". Choose one of: ${PROVIDERS.join(', ')}`);
  const modelFlag = flags.model ?? process.env.WISP_MODEL;
  if (modelFlag) return parseModelRef(modelFlag, providerFlag as ProviderName | undefined);
  if (providerFlag) {
    const p = providerFlag as ProviderName;
    return { provider: p, id: s.provider === p && s.model ? s.model : DEFAULT_MODEL[p] };
  }
  if (s.provider && s.model) return { provider: s.provider, id: s.model };
  if (s.provider) return { provider: s.provider, id: DEFAULT_MODEL[s.provider] };
  for (const p of ['anthropic', 'openai'] as const) if (hasCredentials(p, s)) return { provider: p, id: DEFAULT_MODEL[p] };
  return { provider: 'ollama', id: DEFAULT_MODEL.ollama };
}

export function getModelInfo(ref: ModelRef, s: Settings): ModelInfo {
  return modelInfo(ref.provider, ref.id, s.models ?? []);
}

export function createProvider(ref: ModelRef, s: Settings): Provider {
  const ps = s.providers?.[ref.provider] ?? {};
  if (!hasCredentials(ref.provider, s)) {
    const v = ref.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(`No ${ref.provider} API key yet. Run /login in wisp, or set ${v}.`);
  }
  const apiKey = ps.apiKey ?? savedApiKey(ref.provider);
  switch (ref.provider) {
    case 'anthropic':
      return new AnthropicProvider(ref.id, { apiKey, baseURL: ps.baseURL, fallbacks: s.anthropicFallbacks ?? false });
    case 'openai':
      return new OpenAIProvider('openai', ref.id, { apiKey, baseURL: ps.baseURL });
    case 'ollama':
      return new OpenAIProvider('ollama', ref.id, { apiKey: apiKey ?? 'ollama', baseURL: ollamaBaseURL(s) });
  }
}

/** Models shown in the selector: built-ins + custom, for providers we can use. */
export function availableModels(s: Settings, builtins: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of [...(s.models ?? []), ...builtins]) {
    const key = `${m.provider}/${m.id}`;
    if (seen.has(key) || !hasCredentials(m.provider, s)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
