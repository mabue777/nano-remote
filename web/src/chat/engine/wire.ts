// The three wire formats the phone speaks on the direct route (provider-connection.md section 1, protocol
// section 15's table): one entry per format, no class per vendor. Each entry knows its endpoint, headers,
// body and framing, and turns one frame into unified events. Vendor quirks come from quirks.ts.
import type { ProviderKind } from '../providers/types';
import type { Frame, Framing } from './framing';
import { applyShaping, type Shaping } from './quirks';
import type { ChatOptions, ChatTurn } from './types';

export const ANTHROPIC_VERSION = '2023-06-01';

/** What one frame means, whatever the vendor. */
export type WireEvent =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  /** The stream's own end marker. */
  | { type: 'done' }
  /** The model finished (OpenAI `finish_reason`); the usage chunk and `[DONE]` may still follow. */
  | { type: 'finish' }
  /** An error the server sent in the stream; `malformed` when the frame itself could not be read. */
  | { type: 'error'; detail: string; malformed?: boolean };

export interface ChatRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WireFormat {
  framing: Framing;
  request(baseURL: string, apiKey: string | null, model: string, turns: readonly ChatTurn[], options: ChatOptions, shaping: Shaping): ChatRequest;
  parse(frame: Frame): WireEvent[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

function bearer(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function delta(type: 'text' | 'reasoning', text: unknown): WireEvent[] {
  return typeof text === 'string' && text !== '' ? [{ type, text }] : [];
}

function usage(inputTokens: unknown, outputTokens: unknown): WireEvent[] {
  const input = count(inputTokens);
  const output = count(outputTokens);
  if (input === undefined && output === undefined) return [];
  const event: WireEvent = { type: 'usage' };
  if (input !== undefined) event.inputTokens = input;
  if (output !== undefined) event.outputTokens = output;
  return [event];
}

/** The server's words for an error value, for logs. */
export function errorDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isObject(value) && typeof value.message === 'string') return value.message;
  if (isObject(value) && isObject(value.error)) return errorDetail(value.error);
  return JSON.stringify(value) ?? String(value);
}

function json(frame: Frame): Json | WireEvent[] {
  try {
    const value: unknown = JSON.parse(frame.data);
    return isObject(value) ? value : [{ type: 'error', detail: 'a stream frame is not a JSON object', malformed: true }];
  } catch {
    return [{ type: 'error', detail: 'a stream frame is not JSON', malformed: true }];
  }
}

const POST = { 'Content-Type': 'application/json' };

const openai: WireFormat = {
  framing: 'sse',
  request(baseURL, apiKey, model, turns, options, shaping) {
    const body = applyShaping({ model, messages: turns, stream: true, stream_options: { include_usage: true } }, shaping, options);
    return {
      url: `${baseURL}${shaping.chatPath ?? '/chat/completions'}`,
      headers: { ...POST, Accept: 'text/event-stream', ...bearer(apiKey) },
      body: JSON.stringify(body),
    };
  },
  parse(frame) {
    if (frame.data.trim() === '[DONE]') return [{ type: 'done' }];
    const value = json(frame);
    if (Array.isArray(value)) return value;
    if (value.error !== undefined) return [{ type: 'error', detail: errorDetail(value.error) }];
    const events: WireEvent[] = [];
    const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
    if (isObject(choice)) {
      const d = isObject(choice.delta) ? choice.delta : {};
      events.push(...delta('reasoning', d.reasoning_content ?? d.reasoning), ...delta('text', d.content));
      if (typeof choice.finish_reason === 'string') events.push({ type: 'finish' });
    }
    if (isObject(value.usage)) events.push(...usage(value.usage.prompt_tokens, value.usage.completion_tokens));
    return events;
  },
};

const ollama: WireFormat = {
  framing: 'ndjson',
  request(baseURL, apiKey, model, turns, options, shaping) {
    const body = applyShaping({ model, messages: turns, stream: true }, shaping, options);
    return {
      url: `${baseURL}${shaping.chatPath ?? '/api/chat'}`,
      headers: { ...POST, Accept: 'application/x-ndjson', ...bearer(apiKey) },
      body: JSON.stringify(body),
    };
  },
  parse(frame) {
    const value = json(frame);
    if (Array.isArray(value)) return value;
    if (value.error !== undefined) return [{ type: 'error', detail: errorDetail(value.error) }];
    const events: WireEvent[] = [];
    if (isObject(value.message)) events.push(...delta('reasoning', value.message.thinking), ...delta('text', value.message.content));
    if (value.done === true) events.push(...usage(value.prompt_eval_count, value.eval_count), { type: 'done' });
    return events;
  },
};

const anthropic: WireFormat = {
  framing: 'sse',
  request(baseURL, apiKey, model, turns, options, shaping) {
    const system = turns.filter((t) => t.role === 'system').map((t) => t.content);
    const body: Json = { model, messages: turns.filter((t) => t.role !== 'system'), stream: true };
    if (system.length > 0) body.system = system.join('\n\n');
    applyShaping(body, shaping, options);
    const versioned = new URL(baseURL).pathname.endsWith('/v1');
    return {
      url: `${baseURL}${shaping.chatPath ?? `${versioned ? '' : '/v1'}/messages`}`,
      headers: {
        ...POST,
        Accept: 'text/event-stream',
        'anthropic-version': ANTHROPIC_VERSION,
        // Anthropic answers CORS only with this header (direct route from the browser).
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(body),
    };
  },
  parse(frame) {
    const value = json(frame);
    if (Array.isArray(value)) return value;
    switch (value.type) {
      case 'message_start': {
        const u = isObject(value.message) && isObject(value.message.usage) ? value.message.usage : {};
        return usage(u.input_tokens, undefined);
      }
      case 'content_block_delta': {
        const d = isObject(value.delta) ? value.delta : {};
        if (d.type === 'text_delta') return delta('text', d.text);
        if (d.type === 'thinking_delta') return delta('reasoning', d.thinking);
        return [];
      }
      case 'message_delta':
        return isObject(value.usage) ? usage(undefined, value.usage.output_tokens) : [];
      case 'message_stop':
        return [{ type: 'done' }];
      case 'error':
        return [{ type: 'error', detail: errorDetail(value.error) }];
      default:
        return [];
    }
  },
};

/** The wire format for each Provider kind. Gemini is reached through its OpenAI-compatible endpoint. */
export const WIRE: Readonly<Record<ProviderKind, WireFormat>> = {
  'openai-compatible': openai,
  gemini: openai,
  ollama,
  anthropic,
};
