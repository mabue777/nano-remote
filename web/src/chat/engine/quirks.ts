// Request shaping for the direct route (provider-connection.md section 4): the thinking switch per vendor,
// max_completion_tokens vs max_tokens, and temperature omission. Every vendor and model quirk lives in the
// QUIRKS table below; nothing else in the engine branches on a vendor. (The host route sends the options
// as they are and the host shapes them; protocol section 15.)
import type { ProviderKind } from '../providers/types';
import type { ChatOptions } from './types';

/** How a vendor turns the single thinking switch on or off. */
export type ThinkingStyle =
  /** Unknown servers: send nothing; an unknown field may be rejected. */
  | 'none'
  /** OpenAI and Gemini's OpenAI endpoint: `reasoning_effort`. */
  | 'reasoning-effort'
  /** OpenRouter: the `reasoning` object. */
  | 'openrouter'
  /** Anthropic extended thinking with a token budget. */
  | 'anthropic-budget'
  /** Anthropic models that only take adaptive thinking (the budget form is deprecated for them). */
  | 'anthropic-adaptive'
  /** Ollama: `think`. */
  | 'ollama-think'
  /** Qwen-style servers (vLLM, SGLang, llama.cpp, DashScope): `enable_thinking`. */
  | 'enable-thinking';

export interface Shaping {
  thinking: ThinkingStyle;
  /** Dotted body path for the token limit, e.g. `max_tokens` or `options.num_predict`. */
  maxTokensField: string;
  /** Dotted body path for the temperature. */
  temperatureField: string;
  /** `always`: the model rejects a custom temperature; `when-thinking`: only with thinking on. */
  dropTemperature: 'never' | 'always' | 'when-thinking';
  /** A token limit the vendor requires; used when the caller sets none. */
  defaultMaxTokens?: number;
  /** Chat endpoint relative to the base URL, when it differs from the wire format's default. */
  chatPath?: string;
}

interface Quirk {
  /** For readers and test names only. */
  name: string;
  kind?: ProviderKind;
  /** Exact host or a subdomain of it. */
  host?: string;
  model?: RegExp;
  set: Partial<Shaping>;
}

const BASE: Shaping = {
  thinking: 'none',
  maxTokensField: 'max_tokens',
  temperatureField: 'temperature',
  dropTemperature: 'never',
};

/** Anthropic requires max_tokens; this is used when the caller sets none (same as the host). */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
/** Anthropic's smallest extended-thinking budget. */
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

/**
 * The one table. Every matching row applies in order, later rows overriding earlier ones, so generic rows
 * come first and host-specific rows last (a Qwen model on OpenRouter gets OpenRouter's switch).
 */
export const QUIRKS: readonly Quirk[] = [
  {
    name: 'Ollama',
    kind: 'ollama',
    set: { thinking: 'ollama-think', maxTokensField: 'options.num_predict', temperatureField: 'options.temperature' },
  },
  {
    name: 'Anthropic',
    kind: 'anthropic',
    set: { thinking: 'anthropic-budget', defaultMaxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS, dropTemperature: 'when-thinking' },
  },
  {
    name: 'Anthropic adaptive-thinking models (Claude 4.6 and later)',
    kind: 'anthropic',
    model: /^claude-(?:opus|sonnet|haiku)-(?:4-[6-9]|[5-9])/,
    set: { thinking: 'anthropic-adaptive' },
  },
  {
    name: "Gemini through Google's OpenAI-compatible endpoint",
    kind: 'gemini',
    set: { thinking: 'reasoning-effort', chatPath: '/openai/chat/completions' },
  },
  { name: 'Qwen-style servers', kind: 'openai-compatible', model: /qwen/i, set: { thinking: 'enable-thinking' } },
  { name: 'OpenAI', host: 'api.openai.com', set: { maxTokensField: 'max_completion_tokens' } },
  {
    name: 'OpenAI reasoning models',
    host: 'api.openai.com',
    model: /^(?:o\d|gpt-5)/,
    set: { thinking: 'reasoning-effort', dropTemperature: 'always' },
  },
  { name: 'OpenRouter', host: 'openrouter.ai', set: { thinking: 'openrouter' } },
];

/** The shaping for one provider and model: every matching QUIRKS row merged over the base. */
export function shapingFor(provider: { baseURL: string; kind: ProviderKind }, model: string): Shaping {
  const host = new URL(provider.baseURL).hostname.toLowerCase();
  let shaping = { ...BASE };
  for (const quirk of QUIRKS) {
    if (quirk.kind !== undefined && quirk.kind !== provider.kind) continue;
    if (quirk.host !== undefined && host !== quirk.host && !host.endsWith(`.${quirk.host}`)) continue;
    if (quirk.model !== undefined && !quirk.model.test(model)) continue;
    shaping = { ...shaping, ...quirk.set };
  }
  return shaping;
}

type Json = Record<string, unknown>;

/** The body fields for the thinking switch; empty when the style sends nothing for this value. */
export function thinkingFields(style: ThinkingStyle, on: boolean, maxTokens: number | undefined): Json {
  switch (style) {
    case 'none':
      return {};
    case 'reasoning-effort':
      return on ? { reasoning_effort: 'medium' } : {};
    case 'openrouter':
      return { reasoning: on ? { effort: 'medium' } : { enabled: false } };
    case 'anthropic-budget': {
      const limit = maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
      const budget = Math.max(ANTHROPIC_MIN_THINKING_BUDGET, Math.floor(limit / 2));
      return on && budget < limit ? { thinking: { type: 'enabled', budget_tokens: budget } } : {};
    }
    case 'anthropic-adaptive':
      return on ? { thinking: { type: 'adaptive' } } : {};
    case 'ollama-think':
      return { think: on };
    case 'enable-thinking':
      return { enable_thinking: on, chat_template_kwargs: { enable_thinking: on } };
  }
}

/**
 * Applies the caller's options to a request body under the shaping: the token limit under its field (or
 * the vendor's required default), the thinking fields, and the temperature unless the model rejects it.
 */
export function applyShaping(body: Json, shaping: Shaping, options: ChatOptions): Json {
  const maxTokens = options.maxTokens ?? shaping.defaultMaxTokens;
  if (maxTokens !== undefined) setPath(body, shaping.maxTokensField, maxTokens);
  const thinking = options.thinking === undefined ? {} : thinkingFields(shaping.thinking, options.thinking, maxTokens);
  Object.assign(body, thinking);
  const thinkingOn = options.thinking === true && Object.keys(thinking).length > 0;
  const drop = shaping.dropTemperature === 'always' || (shaping.dropTemperature === 'when-thinking' && thinkingOn);
  if (options.temperature !== undefined && !drop) setPath(body, shaping.temperatureField, options.temperature);
  return body;
}

function setPath(body: Json, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let target = body;
  for (const key of keys) {
    const next = target[key];
    if (typeof next !== 'object' || next === null) target[key] = {};
    target = target[key] as Json;
  }
  target[last] = value;
}
