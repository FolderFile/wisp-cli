import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
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
  const ps = s.providers?.[p];
  if (p === 'anthropic') return Boolean(ps?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (p === 'openai') return Boolean(ps?.apiKey || process.env.OPENAI_API_KEY);
  return true; // ollama: local, no key
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
    throw new Error(`No credentials for ${ref.provider}: set ${v} or providers.${ref.provider}.apiKey in settings.`);
  }
  switch (ref.provider) {
    case 'anthropic':
      return new AnthropicProvider(ref.id, { ...ps, fallbacks: s.anthropicFallbacks ?? false });
    case 'openai':
      return new OpenAIProvider('openai', ref.id, ps);
    case 'ollama':
      return new OpenAIProvider('ollama', ref.id, {
        apiKey: ps.apiKey ?? 'ollama',
        baseURL: ps.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      });
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
