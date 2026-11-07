import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ProviderName } from './models.js';
import { AGENT_DIR } from './settings.js';

/**
 * API keys saved with /login live in ~/.wisp/auth.json (readable only by you).
 * Lookup order: settings.providers.<p>.apiKey → auth.json → environment.
 * A key saved with /login wins over the environment because it is the more
 * deliberate choice; /logout removes it again.
 */
export const AUTH_FILE = join(AGENT_DIR, 'auth.json');

type AuthFile = Partial<Record<ProviderName, { apiKey?: string; baseURL?: string; savedAt?: string }>>;

export function readAuth(): AuthFile {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAuth(a: AuthFile) {
  mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
}

export function saveCredential(p: ProviderName, cred: { apiKey?: string; baseURL?: string }) {
  const a = readAuth();
  a[p] = { ...cred, savedAt: new Date().toISOString() };
  writeAuth(a);
}

export function removeCredential(p: ProviderName): boolean {
  const a = readAuth();
  if (!a[p]) return false;
  delete a[p];
  writeAuth(a);
  return true;
}

export const ENV_KEYS: Partial<Record<ProviderName, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

/** Where a provider's credentials come from, if anywhere. */
export function credentialSource(p: ProviderName, settingsKey?: string): 'settings' | 'login' | 'env' | null {
  if (settingsKey) return 'settings';
  if (readAuth()[p]?.apiKey) return 'login';
  const env = ENV_KEYS[p];
  if (env && process.env[env]) return 'env';
  if (p === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) return 'env';
  return null;
}

export function savedApiKey(p: ProviderName): string | undefined {
  return readAuth()[p]?.apiKey;
}

export function savedBaseURL(p: ProviderName): string | undefined {
  return readAuth()[p]?.baseURL;
}

/** Check a key by listing models. Resolves to the model ids, or throws a readable error. */
export async function verifyCredential(p: ProviderName, cred: { apiKey?: string; baseURL?: string }, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(15_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    if (p === 'anthropic') {
      const client = new Anthropic({ apiKey: cred.apiKey, baseURL: cred.baseURL, maxRetries: 0 });
      const page = await client.models.list({ limit: 100 }, { signal: sig });
      return page.data.map((m) => m.id);
    }
    const client = new OpenAI({ apiKey: cred.apiKey ?? 'ollama', baseURL: cred.baseURL, maxRetries: 0 });
    const page = await client.models.list({ signal: sig });
    return page.data.map((m) => m.id);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) throw new Error('That key was rejected. Check that you copied all of it.');
    if (err instanceof Anthropic.PermissionDeniedError || err instanceof OpenAI.PermissionDeniedError) throw new Error('The key works but lacks permission to list models.');
    if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError || (err as Error).name === 'TimeoutError')
      throw new Error(p === 'ollama' ? `Couldn't reach Ollama at ${cred.baseURL}.` : 'Could not reach the API. Check your network connection.');
    throw new Error((err as Error).message);
  }
}
