import Anthropic from '@anthropic-ai/sdk';
import { clampThinking, modelInfo } from '../core/models.js';
import type {
  AssistantContent,
  CompletionRequest,
  CompletionResult,
  Message,
  Provider,
  StopReason,
  StreamHandlers,
  ThinkingLevel,
} from '../core/types.js';

type AMessage = Anthropic.MessageParam;
type ABlock = Anthropic.ContentBlockParam;

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;

  // apiKey / baseURL fall back to ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL inside the SDK.
  constructor(
    readonly model: string,
    private opts: { apiKey?: string; baseURL?: string; fallbacks?: boolean } = {},
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async complete(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
    const messages = toAnthropicMessages(req.messages);
    markCacheBreakpoint(messages);

    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: req.maxTokens,
      // System prompt and tools are stable across turns: cache them.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        // Stream large inputs (file contents) as they're generated. The API no
        // longer validates them, so the agent validates before running.
        eager_input_streaming: true,
      })),
      messages,
      ...thinkingParams(this.model, req.thinking),
    };

    // Both stream flavours emit the same events; type them through a common shape.
    type AnyStream = {
      on(event: 'text' | 'thinking', fn: (delta: string) => void): unknown;
      on(event: 'streamEvent', fn: (ev: { type: string; content_block?: { type: string; id?: string; name?: string } }) => void): unknown;
      finalMessage(): Promise<unknown>;
    };
    const stream = (
      this.opts.fallbacks
        ? this.client.beta.messages.stream(
            { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
            { signal: req.signal },
          )
        : this.client.messages.stream(params, { signal: req.signal })
    ) as unknown as AnyStream;

    stream.on('text', (d) => handlers.onText(d));
    stream.on('thinking', (d) => handlers.onThinking(d));
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use')
        handlers.onToolCallStart?.(ev.content_block.id!, ev.content_block.name!);
    });
    const msg = (await stream.finalMessage()) as Anthropic.Message;

    const content: AssistantContent[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'thinking')
        content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature, provider: 'anthropic', model: this.model });
      else if (block.type === 'redacted_thinking')
        content.push({ type: 'thinking', thinking: '', redacted: block.data, provider: 'anthropic', model: this.model });
      else if (block.type === 'tool_use')
        content.push({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          input: normalizeInput(block.input),
        });
    }

    const u = msg.usage;
    const stopDetails = (msg as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
    return {
      content,
      stopReason: mapStop(msg.stop_reason),
      stopDetail:
        msg.stop_reason === 'refusal'
          ? `The model declined this request${stopDetails?.category ? ` (${stopDetails.category})` : ''}.${stopDetails?.explanation ? ' ' + stopDetails.explanation : ''}`
          : msg.stop_reason === 'model_context_window_exceeded'
            ? 'The conversation no longer fits in the context window. Run /compact.'
            : undefined,
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function normalizeInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const v = JSON.parse(input);
      if (v && typeof v === 'object') return v;
    } catch {}
    return { _invalid_arguments: input };
  }
  return {};
}

/**
 * Current Claude models think adaptively and take effort as the depth control.
 * Most can't disable thinking at all, so "off" maps to the lowest effort unless
 * the model supports turning it off.
 */
function thinkingParams(model: string, level: ThinkingLevel): Partial<Anthropic.MessageStreamParams> {
  const info = modelInfo('anthropic', model);
  const l = clampThinking(level, info);
  if (l === 'off') return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: l },
  } as Partial<Anthropic.MessageStreamParams>;
}

function mapStop(r: string | null): StopReason {
  if (r === 'end_turn' || r === 'stop_sequence') return 'end';
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  if (r === 'refusal') return 'refusal';
  return 'other';
}

function toAnthropicMessages(messages: Message[]): AMessage[] {
  const out: AMessage[] = [];
  for (const m of messages) {
    const blocks: ABlock[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text) blocks.push({ type: 'text', text: b.text });
          break;
        case 'image':
          blocks.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } });
          break;
        case 'thinking':
          // Replay Claude's own reasoning unchanged (required with tool use).
          // Reasoning from other providers can't be verified, so it is dropped.
          if (b.provider !== 'anthropic') break;
          if (b.redacted) blocks.push({ type: 'redacted_thinking', data: b.redacted });
          else if (b.signature) blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
          break;
        case 'tool_call':
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
          break;
        case 'tool_result': {
          const content: Anthropic.ToolResultBlockParam['content'] = [
            { type: 'text', text: b.content || '(empty)' },
            ...(b.images ?? []).map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
            })),
          ];
          blocks.push({ type: 'tool_result', tool_use_id: b.id, content, is_error: b.isError || undefined });
          break;
        }
      }
    }
    if (blocks.length) out.push({ role: m.role, content: blocks });
  }
  return out;
}

// Cache breakpoint on the last block so the whole conversation prefix is
// reused by the next request (each agent step re-sends the full history).
function markCacheBreakpoint(messages: AMessage[]) {
  const last = messages.at(-1);
  if (!last || typeof last.content === 'string') return;
  for (let i = last.content.length - 1; i >= 0; i--) {
    const block = last.content[i] as { type: string; cache_control?: unknown };
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    block.cache_control = { type: 'ephemeral' };
    return;
  }
}
