import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/** Turn provider/network errors into one actionable sentence. */
export function describeError(err: unknown, ctx: { provider?: string; baseURL?: string } = {}): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError)
    return `Authentication failed for ${ctx.provider ?? 'the provider'}: check your API key.`;
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError)
    return 'Rate limited by the provider. Wait a moment and try again.';
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError)
    return `Not found: ${(err as Error).message}. Is the model name right? (ctrl+l to pick another)`;
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    const hint = ctx.provider === 'ollama' ? ' Is Ollama running? (ollama serve)' : '';
    return `Could not connect to ${ctx.baseURL ?? `the ${ctx.provider ?? 'model'} API`}.${hint}`;
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const e = err as { status?: number; message: string };
    return `API error${e.status ? ` ${e.status}` : ''}: ${e.message}`;
  }
  return (err as Error)?.message ?? String(err);
}

export const isAbortError = (err: unknown) =>
  (err as Error)?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError;
