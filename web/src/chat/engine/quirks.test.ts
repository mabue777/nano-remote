import { describe, expect, it } from 'vitest';

import type { ProviderKind } from '../providers/types';
import { applyShaping, QUIRKS, shapingFor, thinkingFields } from './quirks';
import type { ChatOptions } from './types';
import { WIRE } from './wire';

const TURNS = [{ role: 'user' as const, content: 'Hi' }];

/** The request body and URL the direct route would send. */
function request(baseURL: string, kind: ProviderKind, model: string, options: ChatOptions) {
  const r = WIRE[kind].request(baseURL, 'key', model, TURNS, options, shapingFor({ baseURL, kind }, model));
  const { model: _m, messages: _msgs, stream: _s, stream_options: _so, ...shaped } = JSON.parse(r.body) as Record<string, unknown>;
  return { url: r.url, headers: r.headers, shaped };
}

describe('the thinking switch per vendor (provider-connection.md section 4)', () => {
  it('OpenRouter: the reasoning object, on and off; it wins over the Qwen row for a Qwen model', () => {
    const base = 'https://openrouter.ai/api/v1';
    expect(request(base, 'openai-compatible', 'anthropic/claude-sonnet-4.5', { thinking: true }).shaped).toEqual({ reasoning: { effort: 'medium' } });
    expect(request(base, 'openai-compatible', 'anthropic/claude-sonnet-4.5', { thinking: false }).shaped).toEqual({ reasoning: { enabled: false } });
    expect(request(base, 'openai-compatible', 'qwen/qwen3-235b-a22b', { thinking: true }).shaped).toEqual({ reasoning: { effort: 'medium' } });
  });

  it('OpenAI: reasoning_effort for reasoning models only, with max_completion_tokens and no temperature', () => {
    const base = 'https://api.openai.com/v1';
    expect(request(base, 'openai-compatible', 'gpt-5-mini', { thinking: true, temperature: 0.3, maxTokens: 500 }).shaped).toEqual({
      reasoning_effort: 'medium',
      max_completion_tokens: 500,
    });
    expect(request(base, 'openai-compatible', 'o4-mini', { thinking: false, temperature: 0.3 }).shaped).toEqual({});
    expect(request(base, 'openai-compatible', 'gpt-4o', { thinking: true, temperature: 0.3, maxTokens: 500 }).shaped).toEqual({
      temperature: 0.3,
      max_completion_tokens: 500,
    });
  });

  it('Anthropic: extended thinking with a budget of half of max_tokens (at least 1024), temperature dropped', () => {
    const base = 'https://api.anthropic.com';
    expect(request(base, 'anthropic', 'claude-sonnet-4-5', { thinking: true, temperature: 0.5 }).shaped).toEqual({
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
    expect(request(base, 'anthropic', 'claude-sonnet-4-5', { thinking: true, maxTokens: 1500 }).shaped).toEqual({
      max_tokens: 1500,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    // No room for the minimum budget: thinking is left off and the temperature stays.
    expect(request(base, 'anthropic', 'claude-sonnet-4-5', { thinking: true, maxTokens: 1024, temperature: 0.5 }).shaped).toEqual({
      max_tokens: 1024,
      temperature: 0.5,
    });
    expect(request(base, 'anthropic', 'claude-3-7-sonnet-latest', { thinking: false, temperature: 0.5 }).shaped).toEqual({
      max_tokens: 4096,
      temperature: 0.5,
    });
  });

  it('Anthropic: adaptive thinking for Claude 4.6 and later', () => {
    const base = 'https://api.anthropic.com';
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-7', 'claude-opus-5-5', 'claude-haiku-5']) {
      expect(request(base, 'anthropic', model, { thinking: true, temperature: 1 }).shaped).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' } });
    }
    expect(request(base, 'anthropic', 'claude-opus-4-1', { thinking: true }).shaped).toMatchObject({ thinking: { type: 'enabled' } });
  });

  it('Ollama: think on and off, token limit and temperature under options', () => {
    const base = 'https://ollama.com';
    expect(request(base, 'ollama', 'gpt-oss:120b', { thinking: true, maxTokens: 256, temperature: 0.1 }).shaped).toEqual({
      think: true,
      options: { num_predict: 256, temperature: 0.1 },
    });
    expect(request(base, 'ollama', 'qwen3:4b', { thinking: false }).shaped).toEqual({ think: false });
  });

  it('Qwen-style servers: enable_thinking, top level and as a chat template argument', () => {
    const base = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    expect(request(base, 'openai-compatible', 'qwen3-max', { thinking: false }).shaped).toEqual({
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(request('https://vllm.example.org/v1', 'openai-compatible', 'Qwen/Qwen3-8B', { thinking: true }).shaped).toEqual({
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  it("Gemini: Google's OpenAI-compatible endpoint with reasoning_effort and a bearer key", () => {
    const r = request('https://generativelanguage.googleapis.com/v1beta', 'gemini', 'gemini-2.5-flash', { thinking: true });
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(r.headers.Authorization).toBe('Bearer key');
    expect(r.shaped).toEqual({ reasoning_effort: 'medium' });
  });

  it('unknown OpenAI-compatible servers get no thinking field (an unknown field may be rejected)', () => {
    expect(request('https://api.groq.com/openai/v1', 'openai-compatible', 'llama-3.3-70b', { thinking: true, maxTokens: 10 }).shaped).toEqual({
      max_tokens: 10,
    });
  });

  it('leaves every vendor default alone when the switch is not set', () => {
    const cases: [string, ProviderKind, string][] = [
      ['https://openrouter.ai/api/v1', 'openai-compatible', 'x/y'],
      ['https://api.openai.com/v1', 'openai-compatible', 'gpt-5'],
      ['https://api.anthropic.com', 'anthropic', 'claude-opus-5-5'],
      ['https://ollama.com', 'ollama', 'qwen3:4b'],
      ['https://vllm.example.org/v1', 'openai-compatible', 'qwen3'],
    ];
    for (const [base, kind, model] of cases) {
      const { shaped } = request(base, kind, model, {});
      expect(Object.keys(shaped).filter((k) => k !== 'max_tokens')).toEqual([]);
    }
  });
});

describe('the quirks table', () => {
  it('matches hosts exactly or as a subdomain, never as a look-alike', () => {
    expect(shapingFor({ baseURL: 'https://eu.openrouter.ai/api/v1', kind: 'openai-compatible' }, 'm').thinking).toBe('openrouter');
    expect(shapingFor({ baseURL: 'https://openrouter.ai.evil.example/v1', kind: 'openai-compatible' }, 'm').thinking).toBe('none');
    expect(shapingFor({ baseURL: 'https://notopenrouter.ai/v1', kind: 'openai-compatible' }, 'm').thinking).toBe('none');
  });

  it('names every row', () => {
    for (const quirk of QUIRKS) expect(quirk.name).not.toBe('');
  });

  it('thinkingFields covers every style', () => {
    expect(thinkingFields('none', true, undefined)).toEqual({});
    expect(thinkingFields('reasoning-effort', false, undefined)).toEqual({});
    expect(thinkingFields('anthropic-budget', true, undefined)).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(thinkingFields('anthropic-budget', false, 8000)).toEqual({});
    expect(thinkingFields('anthropic-adaptive', false, undefined)).toEqual({});
  });

  it('applyShaping writes nested paths into an existing object', () => {
    const body = { options: { seed: 1 } };
    applyShaping(body, { ...shapingFor({ baseURL: 'https://ollama.com', kind: 'ollama' }, 'm') }, { maxTokens: 5 });
    expect(body).toEqual({ options: { seed: 1, num_predict: 5 } });
  });
});
