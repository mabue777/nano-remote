// The three wire formats the relay speaks (protocol-v1.md section 15, provider-connection.md section 1):
// one table keyed by kind, no class per vendor. Each entry knows its endpoints and headers, how to shape a
// chat request, how its stream is framed, and how one frame becomes unified events.
import type { ProviderChatOptions, ProviderMessage, ProviderModel } from '../generated/common.js';
import type { ProviderKind } from './url.js';

export type DeltaKind = 'text' | 'reasoning';

/** What one upstream frame means, whatever the vendor. */
export type WireEvent =
  | { type: 'delta'; kind: DeltaKind; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ChatInput {
  model: string;
  messages: readonly ProviderMessage[];
  options?: ProviderChatOptions | undefined;
}

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface WireFormat {
  /** `sse`: `data:` lines, events separated by a blank line. `ndjson`: one JSON object per line. */
  framing: 'sse' | 'ndjson';
  modelsRequest(baseURL: string, apiKey?: string): HttpRequest;
  /** The model list, or null when the body is not one. */
  parseModels(body: unknown): ProviderModel[] | null;
  chatRequest(baseURL: string, apiKey: string | undefined, input: ChatInput): HttpRequest;
  /** One parsed frame to events. The SSE `[DONE]` sentinel never reaches here (the framing ends the stream). */
  parse(frame: unknown): WireEvent[];
}

/** Anthropic requires max_tokens; this is used when the client sets none. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
/** Anthropic's smallest extended-thinking budget. */
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
export const ANTHROPIC_VERSION = '2023-06-01';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const path = (baseURL: string) => new URL(baseURL).pathname;

function bearer(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

const JSON_HEADERS = { Accept: 'application/json' };
const POST_HEADERS = { 'Content-Type': 'application/json' };

function delta(kind: DeltaKind, text: unknown): WireEvent[] {
  return typeof text === 'string' && text !== '' ? [{ type: 'delta', kind, text }] : [];
}

function usage(inputTokens: unknown, outputTokens: unknown): WireEvent[] {
  const event: WireEvent = { type: 'usage' };
  const input = count(inputTokens);
  const output = count(outputTokens);
  if (input !== undefined) event.inputTokens = input;
  if (output !== undefined) event.outputTokens = output;
  return input === undefined && output === undefined ? [] : [event];
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isObject(value) && typeof value.message === 'string') return value.message;
  return JSON.stringify(value);
}

function list(items: unknown, toModel: (item: Json) => ProviderModel | null): ProviderModel[] | null {
  if (!Array.isArray(items)) return null;
  const models: ProviderModel[] = [];
  for (const item of items) {
    const model = isObject(item) ? toModel(item) : null;
    if (model) models.push(model);
  }
  return models;
}

const openai: WireFormat = {
  framing: 'sse',
  modelsRequest: (baseURL, apiKey) => ({ url: `${baseURL}/models`, method: 'GET', headers: { ...JSON_HEADERS, ...bearer(apiKey) } }),
  parseModels: (body) =>
    list(Array.isArray(body) ? body : isObject(body) ? body.data : undefined, (item) => {
      const id = str(item.id);
      return id ? { id } : null;
    }),
  chatRequest(baseURL, apiKey, { model, messages, options }) {
    const body: Json = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options?.thinking === true) body.reasoning_effort = 'medium';
    return {
      url: `${baseURL}/chat/completions`,
      method: 'POST',
      headers: { ...POST_HEADERS, Accept: 'text/event-stream', ...bearer(apiKey) },
      body: JSON.stringify(body),
    };
  },
  parse(frame) {
    if (!isObject(frame)) return [{ type: 'error', message: 'frame is not an object' }];
    if (frame.error !== undefined) return [{ type: 'error', message: errorMessage(frame.error) }];
    const events: WireEvent[] = [];
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
    const d = isObject(choice) && isObject(choice.delta) ? choice.delta : undefined;
    if (d) events.push(...delta('reasoning', d.reasoning_content ?? d.reasoning), ...delta('text', d.content));
    if (isObject(frame.usage)) events.push(...usage(frame.usage.prompt_tokens, frame.usage.completion_tokens));
    return events;
  },
};

const ollama: WireFormat = {
  framing: 'ndjson',
  modelsRequest: (baseURL, apiKey) => ({ url: `${baseURL}/api/tags`, method: 'GET', headers: { ...JSON_HEADERS, ...bearer(apiKey) } }),
  parseModels: (body) =>
    list(isObject(body) ? body.models : undefined, (item) => {
      const id = str(item.name) ?? str(item.model);
      return id ? { id } : null;
    }),
  chatRequest(baseURL, apiKey, { model, messages, options }) {
    const body: Json = { model, messages, stream: true };
    const modelOptions: Json = {};
    if (options?.temperature !== undefined) modelOptions.temperature = options.temperature;
    if (options?.maxTokens !== undefined) modelOptions.num_predict = options.maxTokens;
    if (Object.keys(modelOptions).length > 0) body.options = modelOptions;
    if (options?.thinking !== undefined) body.think = options.thinking;
    return {
      url: `${baseURL}/api/chat`,
      method: 'POST',
      headers: { ...POST_HEADERS, Accept: 'application/x-ndjson', ...bearer(apiKey) },
      body: JSON.stringify(body),
    };
  },
  parse(frame) {
    if (!isObject(frame)) return [{ type: 'error', message: 'frame is not an object' }];
    if (frame.error !== undefined) return [{ type: 'error', message: errorMessage(frame.error) }];
    const events: WireEvent[] = [];
    if (isObject(frame.message)) events.push(...delta('reasoning', frame.message.thinking), ...delta('text', frame.message.content));
    if (frame.done === true) events.push(...usage(frame.prompt_eval_count, frame.eval_count), { type: 'done' });
    return events;
  },
};

/** `{base}/v1/<endpoint>`, without doubling a `/v1` the base URL already ends in. */
function anthropicURL(baseURL: string, endpoint: string): string {
  return `${baseURL}${path(baseURL).endsWith('/v1') ? '' : '/v1'}/${endpoint}`;
}

function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return { 'anthropic-version': ANTHROPIC_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) };
}

const anthropic: WireFormat = {
  framing: 'sse',
  modelsRequest: (baseURL, apiKey) => ({
    url: `${anthropicURL(baseURL, 'models')}?limit=1000`,
    method: 'GET',
    headers: { ...JSON_HEADERS, ...anthropicHeaders(apiKey) },
  }),
  parseModels: (body) =>
    list(isObject(body) ? body.data : undefined, (item) => {
      const id = str(item.id);
      if (!id) return null;
      const displayName = str(item.display_name);
      return displayName ? { id, displayName } : { id };
    }),
  chatRequest(baseURL, apiKey, { model, messages, options }) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const maxTokens = options?.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
    const body: Json = {
      model,
      max_tokens: maxTokens,
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (system.length > 0) body.system = system.join('\n\n');
    const budget = Math.max(ANTHROPIC_MIN_THINKING_BUDGET, Math.floor(maxTokens / 2));
    const thinking = options?.thinking === true && budget < maxTokens;
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: budget };
    // Extended thinking rejects a custom temperature.
    else if (options?.temperature !== undefined) body.temperature = options.temperature;
    return {
      url: anthropicURL(baseURL, 'messages'),
      method: 'POST',
      headers: { ...POST_HEADERS, Accept: 'text/event-stream', ...anthropicHeaders(apiKey) },
      body: JSON.stringify(body),
    };
  },
  parse(frame) {
    if (!isObject(frame)) return [{ type: 'error', message: 'frame is not an object' }];
    switch (frame.type) {
      case 'message_start': {
        const u = isObject(frame.message) && isObject(frame.message.usage) ? frame.message.usage : {};
        return usage(u.input_tokens, undefined);
      }
      case 'content_block_delta': {
        const d = isObject(frame.delta) ? frame.delta : {};
        if (d.type === 'text_delta') return delta('text', d.text);
        if (d.type === 'thinking_delta') return delta('reasoning', d.thinking);
        return [];
      }
      case 'message_delta':
        return isObject(frame.usage) ? usage(undefined, frame.usage.output_tokens) : [];
      case 'message_stop':
        return [{ type: 'done' }];
      case 'error':
        return [{ type: 'error', message: errorMessage(frame.error) }];
      default:
        return [];
    }
  },
};

/** The adapter table. */
export const WIRE: Readonly<Record<ProviderKind, WireFormat>> = {
  'openai-compatible': openai,
  ollama,
  anthropic,
};
