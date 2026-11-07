import type { ThinkingLevel, Usage } from './types.js';

export const PROVIDERS = ['anthropic', 'openai', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ModelInfo {
  provider: ProviderName;
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  /** USD per million tokens */
  price?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Thinking levels the model accepts; the first is used for "off" if it can't turn off. */
  thinking: readonly ThinkingLevel[];
  images: boolean;
}

const ALL: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const ALWAYS_ON: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const M = 1_000_000;

// Anthropic first-party prices. Cache writes (5-minute TTL) bill at 1.25x input.
const anthropic = (id: string, name: string, input: number, output: number, cacheRead: number, thinking = ALWAYS_ON): ModelInfo => ({
  provider: 'anthropic',
  id,
  name,
  contextWindow: M,
  maxOutput: 128_000,
  price: { input, output, cacheRead, cacheWrite: input * 1.25 },
  thinking,
  images: true,
});

export const BUILTIN_MODELS: ModelInfo[] = [
  anthropic('claude-opus-5-5', 'Claude Opus 5.5', 4, 20, 0.2),
  anthropic('claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 10, 0.2),
  anthropic('claude-haiku-5-5', 'Claude Haiku 5.5', 0.1, 0.5, 0.01, ALL),
  anthropic('claude-fable-5-1', 'Claude Fable 5.1', 10, 50, 0.25),
  {
    provider: 'openai', id: 'gpt-5', name: 'GPT-5', contextWindow: 400_000, maxOutput: 128_000,
    thinking: ['off', 'low', 'medium', 'high'], images: true,
  },
  {
    provider: 'openai', id: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 400_000, maxOutput: 128_000,
    thinking: ['off', 'low', 'medium', 'high'], images: true,
  },
];

export const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  ollama: 'qwen3-coder',
};

/** Look up a model; unknown models get conservative defaults so anything works. */
export function modelInfo(provider: ProviderName, id: string, extra: ModelInfo[] = []): ModelInfo {
  const found = [...extra, ...BUILTIN_MODELS].find((m) => m.provider === provider && m.id === id);
  if (found) return found;
  return {
    provider,
    id,
    name: id,
    contextWindow: provider === 'ollama' ? 32_000 : 200_000,
    maxOutput: provider === 'ollama' ? 8_192 : 32_000,
    thinking: provider === 'anthropic' ? ALWAYS_ON : ['off'],
    images: provider !== 'ollama',
  };
}

/** Pick the nearest supported thinking level. */
export function clampThinking(level: ThinkingLevel, m: ModelInfo): ThinkingLevel {
  if (m.thinking.includes(level)) return level;
  const order = ALL;
  const idx = order.indexOf(level);
  // walk down, then up
  for (let i = idx; i >= 0; i--) if (m.thinking.includes(order[i])) return order[i];
  for (let i = idx; i < order.length; i++) if (m.thinking.includes(order[i])) return order[i];
  return m.thinking[0] ?? 'off';
}

export function cost(u: Usage, m: ModelInfo): number | null {
  if (!m.price) return null;
  const p = m.price;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / M;
}
