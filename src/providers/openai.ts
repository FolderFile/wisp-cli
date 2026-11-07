import OpenAI from 'openai';
import type {
  AssistantContent,
  CompletionRequest,
  CompletionResult,
  ImageBlock,
  Message,
  Provider,
  StopReason,
  StreamHandlers,
} from '../core/types.js';

type OAMessage = OpenAI.Chat.ChatCompletionMessageParam;
type OAUserPart = OpenAI.Chat.ChatCompletionContentPart;

/**
 * Chat Completions adapter. Covers OpenAI itself plus anything that speaks the
 * same protocol (Ollama, LM Studio, vLLM, OpenRouter, ...) via `baseURL`.
 */
export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(
    readonly name: string,
    readonly model: string,
    opts: { apiKey?: string; baseURL?: string } = {},
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  /** List models served by the endpoint (used for Ollama discovery). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const page = await this.client.models.list({ signal });
    return page.data.map((m) => m.id);
  }

  async complete(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
    const reasoning =
      this.name === 'openai' && req.thinking !== 'off'
        ? { reasoning_effort: (req.thinking === 'xhigh' || req.thinking === 'max' ? 'high' : req.thinking) as 'low' | 'medium' | 'high' }
        : {};
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: req.system }, ...toOpenAIMessages(req.messages)],
        tools: req.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        ...reasoning,
      },
      { signal: req.signal },
    );

    let text = '';
    let thinking = '';
    let finish: string | null = null;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // Tool calls arrive as fragments keyed by index.
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = {
          input: (chunk.usage.prompt_tokens ?? 0) - cached,
          output: chunk.usage.completion_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: 0,
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string };
      // Ollama / vLLM / DeepSeek-style servers stream reasoning separately.
      const r = delta?.reasoning ?? delta?.reasoning_content;
      if (r) {
        thinking += r;
        handlers.onThinking(r);
      }
      if (delta?.content) {
        text += delta.content;
        handlers.onText(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) {
          if (!cur.name) handlers.onToolCallStart?.(tc.id ?? '', tc.function.name);
          cur.name += tc.function.name;
        }
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }

    const content: AssistantContent[] = [];
    if (thinking) content.push({ type: 'thinking', thinking, provider: this.name, model: this.model });
    if (text) content.push({ type: 'text', text });
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({
        type: 'tool_call',
        id: c.id || `call_${Date.now()}_${i}`,
        name: c.name,
        input: parseArgs(c.args),
      });
    }

    return { content, stopReason: mapStop(finish, calls.size > 0), usage };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { _invalid_arguments: raw };
  } catch {
    return { _invalid_arguments: raw };
  }
}

function mapStop(r: string | null, hasCalls: boolean): StopReason {
  if (hasCalls || r === 'tool_calls') return 'tool_use';
  if (r === 'stop') return 'end';
  if (r === 'length') return 'max_tokens';
  if (r === 'content_filter') return 'refusal';
  return 'other';
}

const imagePart = (img: ImageBlock): OAUserPart => ({
  type: 'image_url',
  image_url: { url: `data:${img.mediaType};base64,${img.data}` },
});

function toOpenAIMessages(messages: Message[]): OAMessage[] {
  const out: OAMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_call')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // Tool results must immediately follow the assistant message that
      // requested them, so emit them first, then any user text/images.
      const toolImages: ImageBlock[] = [];
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: b.id,
          content: (b.isError ? 'ERROR: ' : '') + (b.content || '(empty)'),
        });
        toolImages.push(...(b.images ?? []));
      }
      // Tool messages can't carry images in Chat Completions; attach them to a user turn.
      const parts: OAUserPart[] = toolImages.map(imagePart);
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') parts.push(imagePart(b));
      }
      if (parts.length === 1 && parts[0].type === 'text') out.push({ role: 'user', content: parts[0].text });
      else if (parts.length) out.push({ role: 'user', content: parts });
    }
  }
  return out;
}
