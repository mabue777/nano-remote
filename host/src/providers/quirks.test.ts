// The quirks table, one test per rule, through the relay against the fake provider over real HTTP. Vendor
// hosts (api.openai.com, openrouter.ai, Google) are redirected to the fake by the relay's fetch, so the
// table sees the real hostname while the request lands on loopback.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderChatOptions } from '../generated/common.js';
import { applyShaping, QUIRKS, shapingFor, thinkingFields } from './quirks.js';
import { ProviderRelay, type ChatOutcome } from './relay.js';
import { FakeProvider, json, stream } from './testing/fake-provider.js';
import type { ProviderKind } from './url.js';

let fake: FakeProvider;

beforeEach(async () => {
  fake = await FakeProvider.start();
  fake
    .on('POST /v1/chat/completions', stream('sse', [{ choices: [{ delta: { content: 'ok' } }] }, 'data: [DONE]\n\n']))
    .on('POST /api/v1/chat/completions', stream('sse', [{ choices: [{ delta: { content: 'ok' } }] }, 'data: [DONE]\n\n']))
    .on('POST /v1beta/openai/chat/completions', stream('sse', [{ choices: [{ delta: { content: 'ok' } }] }, 'data: [DONE]\n\n']))
    .on('POST /api/chat', stream('ndjson', [{ message: { content: 'ok' }, done: true }]))
    .on('POST /v1/messages', stream('sse', [{ type: 'message_stop' }]));
});

afterEach(async () => {
  await fake.close();
});

/** Sends one chat through the relay and returns the JSON body the fake received. */
async function bodyFor(baseURL: string, kind: ProviderKind, model: string, options: ProviderChatOptions): Promise<Record<string, unknown>> {
  const redirect: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return globalThis.fetch(`${fake.url}${url.pathname}${url.search}`, init);
  };
  const relay = new ProviderRelay({ http: { fetch: redirect, maxRetries: 0 } });
  const outcome: ChatOutcome = await relay.chat(
    { baseURL, kind },
    { model, messages: [{ role: 'user', content: 'Hi' }], options },
    { delta: () => {}, usage: () => {} },
    new AbortController().signal,
  );
  expect(outcome).toEqual({ status: 'completed' });
  const last = fake.requests.at(-1)!;
  return JSON.parse(last.body) as Record<string, unknown>;
}

const strip = ({ model: _m, messages: _x, stream: _s, stream_options: _o, ...rest }: Record<string, unknown>) => rest;

describe('the thinking switch per rule', () => {
  it('unknown openai-compatible server: no thinking field at all', async () => {
    expect(strip(await bodyFor('http://127.0.0.1:8000/v1', 'openai-compatible', 'llama-3', { thinking: true, temperature: 0.2, maxTokens: 64 }))).toEqual({
      temperature: 0.2,
      max_tokens: 64,
    });
  });

  it('OpenAI reasoning models: reasoning_effort, max_completion_tokens, temperature dropped', async () => {
    expect(strip(await bodyFor('https://api.openai.com/v1', 'openai-compatible', 'o4-mini', { thinking: true, temperature: 0.2, maxTokens: 64 }))).toEqual({
      reasoning_effort: 'medium',
      max_completion_tokens: 64,
    });
    expect(strip(await bodyFor('https://api.openai.com/v1', 'openai-compatible', 'gpt-5', { thinking: false }))).toEqual({});
  });

  it('OpenAI non-reasoning models: max_completion_tokens and temperature, no thinking field', async () => {
    expect(strip(await bodyFor('https://api.openai.com/v1', 'openai-compatible', 'gpt-4.1', { thinking: true, temperature: 0.3, maxTokens: 10 }))).toEqual({
      max_completion_tokens: 10,
      temperature: 0.3,
    });
  });

  it("Gemini's OpenAI endpoint: reasoning_effort", async () => {
    expect(
      strip(await bodyFor('https://generativelanguage.googleapis.com/v1beta/openai', 'openai-compatible', 'gemini-2.5-flash', { thinking: true })),
    ).toEqual({ reasoning_effort: 'medium' });
  });

  it('OpenRouter: the reasoning object, on and off, even for a Qwen model', async () => {
    expect(strip(await bodyFor('https://openrouter.ai/api/v1', 'openai-compatible', 'qwen/qwen3-32b', { thinking: true }))).toEqual({ reasoning: { effort: 'medium' } });
    expect(strip(await bodyFor('https://openrouter.ai/api/v1', 'openai-compatible', 'openai/gpt-5', { thinking: false }))).toEqual({ reasoning: { enabled: false } });
  });

  it('Qwen-style servers: enable_thinking and chat_template_kwargs', async () => {
    expect(strip(await bodyFor('http://192.168.1.5:9931/v1', 'openai-compatible', 'Qwen3-8B-GGUF', { thinking: false }))).toEqual({
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('Ollama: think, options.num_predict and options.temperature', async () => {
    expect(strip(await bodyFor('http://127.0.0.1:11434', 'ollama', 'qwen3:8b', { thinking: true, temperature: 0.5, maxTokens: 10 }))).toEqual({
      think: true,
      options: { temperature: 0.5, num_predict: 10 },
    });
  });

  it('Anthropic before 4.6: budget_tokens, temperature dropped while thinking', async () => {
    expect(strip(await bodyFor('https://api.anthropic.com', 'anthropic', 'claude-sonnet-4-5', { thinking: true, temperature: 1 }))).toEqual({
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
  });

  it('Anthropic 4.6 and later: adaptive thinking, no budget', async () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-7-20261001', 'claude-haiku-5']) {
      expect(strip(await bodyFor('https://api.anthropic.com', 'anthropic', model, { thinking: true, temperature: 1, maxTokens: 2000 }))).toEqual({
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
      });
    }
    expect(strip(await bodyFor('https://api.anthropic.com', 'anthropic', 'claude-opus-4-6', { thinking: false, temperature: 0.4 }))).toEqual({
      max_tokens: 4096,
      temperature: 0.4,
    });
  });
});

describe('a retired model', () => {
  it('HTTP 410 is not_found, not upstream, and is not retried', async () => {
    fake.on('POST /v1/chat/completions', json(410, { error: { message: 'model retired' } }));
    const relay = new ProviderRelay();
    const outcome = await relay.chat(
      { baseURL: `${fake.url}/v1`, kind: 'openai-compatible' },
      { model: 'old', messages: [{ role: 'user', content: 'Hi' }] },
      { delta: () => {}, usage: () => {} },
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'failed', error: { reason: 'not_found', status: 410 } });
    if (outcome.status === 'failed') expect(outcome.error.message).toContain('model retired');
    expect(fake.to('/v1/chat/completions')).toHaveLength(1);
  });
});

describe('the table itself', () => {
  it('a subdomain matches a host row; a lookalike host does not', () => {
    expect(shapingFor({ baseURL: 'https://eu.api.openai.com/v1', kind: 'openai-compatible' }, 'o3').thinking).toBe('reasoning-effort');
    expect(shapingFor({ baseURL: 'https://notapi.openai.com.evil/v1', kind: 'openai-compatible' }, 'o3').thinking).toBe('none');
  });

  it('every row names itself and narrows by at least one of kind, host or model', () => {
    for (const quirk of QUIRKS) {
      expect(quirk.name).not.toBe('');
      expect(quirk.kind ?? quirk.host ?? quirk.model).toBeDefined();
    }
  });

  it('no options leave the body alone except a required default', () => {
    expect(applyShaping({}, shapingFor({ baseURL: 'http://h', kind: 'openai-compatible' }, 'm'))).toEqual({});
    expect(applyShaping({}, shapingFor({ baseURL: 'http://h', kind: 'anthropic' }, 'claude-3'))).toEqual({ max_tokens: 4096 });
  });

  it('the budget form needs room: no budget when the limit is at or below the minimum', () => {
    expect(thinkingFields('anthropic-budget', true, 1024)).toEqual({});
    expect(thinkingFields('anthropic-budget', true, undefined)).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(thinkingFields('anthropic-adaptive', false, 10)).toEqual({});
  });
});
