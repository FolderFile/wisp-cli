// Provider-neutral conversation model. Each provider adapter translates to and
// from these shapes, so the agent loop, sessions and UI never see vendor types.

export type TextBlock = { type: 'text'; text: string };

export type ImageBlock = {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** base64, no data: prefix */
  data: string;
};

/**
 * Model reasoning. `signature`/`redacted` are opaque provider data that must be
 * sent back unchanged (Anthropic requires this for thinking + tool use). `provider`
 * and `model` record who produced it so we don't replay it to a different vendor.
 */
export type ThinkingBlock = {
  type: 'thinking';
  thinking: string;
  signature?: string;
  redacted?: string;
  provider?: string;
  model?: string;
};

export type ToolCallBlock = {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: 'tool_result';
  id: string;
  content: string;
  images?: ImageBlock[];
  isError?: boolean;
};

export type UserContent = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock;

export type UserMessage = { role: 'user'; content: UserContent[] };
export type AssistantMessage = { role: 'assistant'; content: AssistantContent[] };
export type Message = UserMessage | AssistantMessage;

export type JSONSchema = {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
};

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** Total prompt size of a request: what occupies the context window. */
export const contextTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  thinking: ThinkingLevel;
  signal: AbortSignal;
}

export interface CompletionResult {
  content: AssistantContent[];
  stopReason: StopReason;
  usage: Usage;
  /** Human-readable detail for refusals and odd stops. */
  stopDetail?: string;
}

export interface StreamHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
  /** A tool call has started streaming (name known, input still arriving). */
  onToolCallStart?(id: string, name: string): void;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult>;
}
