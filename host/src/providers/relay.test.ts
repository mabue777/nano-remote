// The relay against a fake provider over real HTTP: streaming in each wire format, usage, errors in the
// stream, abort, retries with Retry-After, the dead-host cooldown and the first-token watchdog.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '../stream/router.js';
import { ProviderFailure } from './http.js';
import { ProviderRelay, type ChatOutcome, type ResolvedProvider } from './relay.js';
import { closedPort, FakeProvider, hang, json, silent, stream, text } from './testing/fake-provider.js';
import type { DeltaKind } from './wire.js';

let fake: FakeProvider;

beforeEach(async () => {
  fake = await FakeProvider.start();
});

afterEach(async () => {
  await fake.close();
});

/** Fast timings so retries and the watchdog run in milliseconds. */
function relay(overrides: { firstTokenTimeoutMs?: number; modelsTimeoutMs?: number; maxRetryAfterMs?: number } = {}): ProviderRelay {
  return new ProviderRelay({
    providers: [
      { id: 'local', name: 'Local', baseURL: fake.url },
      { id: 'keyed', name: 'Keyed', baseURL: `${fake.url}/v1`, apiKey: 'sk-secret' },
    ],
    http: { backoffBaseMs: 5, backoffMaxMs: 20, random: () => 0.5, maxRetryAfterMs: overrides.maxRetryAfterMs ?? 30_000 },
    firstTokenTimeoutMs: overrides.firstTokenTimeoutMs ?? 10_000,
    modelsTimeoutMs: overrides.modelsTimeoutMs ?? 10_000,
  });
}

interface Run {
  deltas: { kind: DeltaKind; text: string }[];
  usage: { inputTokens?: number; outputTokens?: number }[];
  outcome: Promise<ChatOutcome>;
  controller: AbortController;
}

function run(r: ProviderRelay, provider: ResolvedProvider, options = {}): Run {
  const deltas: Run['deltas'] = [];
  const usage: Run['usage'] = [];
  const controller = new AbortController();
  const outcome = r.chat(
    provider,
    { model: 'm1', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], options },
    { delta: (kind, t) => deltas.push({ kind, text: t }), usage: (u) => usage.push(u) },
    controller.signal,
  );
  return { deltas, usage, outcome, controller };
}

const textOf = (deltas: Run['deltas'], kind: DeltaKind = 'text') =>
  deltas
    .filter((d) => d.kind === kind)
    .map((d) => d.text)
    .join('');

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

describe('streaming in each wire format', () => {
  it('openai-compatible: SSE chunks to text and reasoning deltas, usage, [DONE]', async () => {
    fake.on(
      'POST /v1/chat/completions',
      stream('sse', [
        { choices: [{ delta: { role: 'assistant' } }] },
        { choices: [{ delta: { reasoning_content: 'Think' } }] },
        { choices: [{ delta: { reasoning: 'ing.' } }] },
        { choices: [{ delta: { content: 'Hel' } }] },
        ': keep-alive comment\n\n',
        { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        'data: [DONE]\n\n',
      ]),
    );
    const r = relay();
    const chat = run(r, r.resolve({ providerId: 'keyed' }), { thinking: true, temperature: 0.2, maxTokens: 64 });
    expect(await chat.outcome).toEqual({ status: 'completed' });
    expect(textOf(chat.deltas)).toBe('Hello');
    expect(textOf(chat.deltas, 'reasoning')).toBe('Thinking.');
    expect(chat.usage).toEqual([{ inputTokens: 12, outputTokens: 3 }]);
    const [request] = fake.to('/v1/chat/completions');
    expect(request!.headers.authorization).toBe('Bearer sk-secret');
    expect(JSON.parse(request!.body)).toEqual({
      model: 'm1',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 64,
      // An unknown openai-compatible server gets no thinking field (quirks.ts); it might reject one.
    });
  });

  it('ollama: NDJSON lines to deltas and usage, done: true ends it', async () => {
    fake.on(
      'POST /api/chat',
      stream(
        'ndjson',
        [
          { message: { role: 'assistant', content: '', thinking: 'Hmm' } },
          { message: { role: 'assistant', content: 'Blue ' } },
          // One line split across two writes, and a blank line.
          '{"message":{"role":"assistant","con',
          'tent":"sky"}}\n\n',
          { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 20, eval_count: 7 },
          { message: { content: 'after done is ignored' } },
        ],
        { delayMs: 2 },
      ),
    );
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: `${fake.url}/`, kind: 'ollama' }), { thinking: false, temperature: 0.5, maxTokens: 10 });
    expect(await chat.outcome).toEqual({ status: 'completed' });
    expect(textOf(chat.deltas)).toBe('Blue sky');
    expect(textOf(chat.deltas, 'reasoning')).toBe('Hmm');
    expect(chat.usage).toEqual([{ inputTokens: 20, outputTokens: 7 }]);
    expect(JSON.parse(fake.to('/api/chat')[0]!.body)).toEqual({
      model: 'm1',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: true,
      options: { temperature: 0.5, num_predict: 10 },
      think: false,
    });
    expect(fake.to('/api/chat')[0]!.headers.authorization).toBeUndefined();
  });

  it('anthropic: SSE events to deltas, usage from message_start and message_delta, message_stop ends it', async () => {
    fake.on(
      'POST /v1/messages',
      stream('sse', [
        'event: message_start\n',
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 1 } } })}\n\n`,
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Consider.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } },
        { type: 'ping' },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ]),
    );
    const r = new ProviderRelay({ providers: [{ id: 'claude', name: 'Claude', baseURL: fake.url, apiKey: 'sk-ant-x' }] });
    const chat = run(r, { ...r.resolve({ providerId: 'claude' }), kind: 'anthropic' }, { thinking: true, temperature: 1 });
    expect(await chat.outcome).toEqual({ status: 'completed' });
    expect(textOf(chat.deltas)).toBe('Hi there');
    expect(textOf(chat.deltas, 'reasoning')).toBe('Consider.');
    expect(chat.usage).toEqual([{ inputTokens: 9, outputTokens: 15 }]);
    const [request] = fake.to('/v1/messages');
    expect(request!.headers['x-api-key']).toBe('sk-ant-x');
    expect(request!.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(request!.body)).toEqual({
      model: 'm1',
      max_tokens: 4096,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
  });

  it('sends no usage when the provider reports none', async () => {
    fake.on('POST /api/chat', stream('ndjson', [{ message: { content: 'x' } }, { done: true }]));
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    expect(await chat.outcome).toEqual({ status: 'completed' });
    expect(chat.usage).toEqual([]);
  });
});

describe('failures', () => {
  const failed = async (chat: Run) => {
    const outcome = await chat.outcome;
    if (outcome.status !== 'failed') throw new Error(`expected failed, got ${outcome.status}`);
    return outcome.error;
  };

  it('401 is unauthorized and is not retried', async () => {
    fake.on('POST /v1/chat/completions', text(401, 'bad key'));
    const r = relay();
    const error = await failed(run(r, r.resolve({ providerId: 'keyed' })));
    expect(error).toMatchObject({ reason: 'unauthorized', status: 401 });
    expect(error.message).toContain('bad key');
    expect(fake.to('/v1/chat/completions')).toHaveLength(1);
  });

  it('404 is not_found, 500 is upstream', async () => {
    fake.on('POST /api/chat', json(404, { error: 'model "m1" not found' }), json(500, { error: 'boom' }));
    const r = relay();
    expect(await failed(run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })))).toMatchObject({ reason: 'not_found', status: 404 });
    expect(await failed(run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })))).toMatchObject({ reason: 'upstream', status: 500 });
  });

  it('an error object in the stream fails the chat after the text so far', async () => {
    fake.on('POST /api/chat', stream('ndjson', [{ message: { content: 'par' } }, { error: 'model crashed' }]));
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    expect(await failed(chat)).toEqual({ reason: 'upstream', message: 'the provider reported an error: model crashed' });
    expect(textOf(chat.deltas)).toBe('par');
  });

  it('an anthropic error event and an openai error chunk fail the chat', async () => {
    fake.on('POST /v1/messages', stream('sse', [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
    fake.on('POST /v1/chat/completions', stream('sse', [{ error: { message: 'context too long' } }]));
    const r = relay();
    expect(await failed(run(r, { baseURL: fake.url, kind: 'anthropic' }))).toMatchObject({ reason: 'upstream', message: expect.stringContaining('Overloaded') });
    expect(await failed(run(r, r.resolve({ providerId: 'keyed' })))).toMatchObject({ message: expect.stringContaining('context too long') });
  });

  it('a frame that is not JSON is bad_response', async () => {
    fake.on('POST /api/chat', stream('ndjson', ['<html>oops</html>\n']));
    const r = relay();
    expect(await failed(run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })))).toMatchObject({ reason: 'bad_response' });
  });

  it('a stream that ends without its end marker is unreachable', async () => {
    fake.on('POST /v1/chat/completions', stream('sse', [{ choices: [{ delta: { content: 'cut' } }] }, 'data: {"choices":[]}']));
    const r = relay();
    const chat = run(r, r.resolve({ providerId: 'keyed' }));
    expect(await failed(chat)).toMatchObject({ reason: 'unreachable', message: 'the stream ended before the provider finished' });
    expect(textOf(chat.deltas)).toBe('cut');
  });

  it('a connection cut mid-stream is unreachable', async () => {
    fake.on('POST /api/chat', async (_req, res) => {
      res.writeHead(200);
      res.write(`${JSON.stringify({ message: { content: 'a' } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.socket?.destroy();
    });
    const r = relay();
    expect(await failed(run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })))).toMatchObject({ reason: 'unreachable' });
  });
});

describe('abort', () => {
  it('cancels the upstream request mid-stream and ends aborted', async () => {
    fake.on('POST /api/chat', stream('ndjson', Array.from({ length: 200 }, (_, i) => ({ message: { content: `${i} ` } })), { delayMs: 10 }));
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    await until(() => chat.deltas.length >= 2, 'two deltas');
    chat.controller.abort();
    expect(await chat.outcome).toEqual({ status: 'aborted' });
    await until(() => fake.aborted === 1, 'the fake to see the hang-up');
    expect(chat.deltas.length).toBeLessThan(200);
  });

  it('cancels a request that has no answer yet', async () => {
    fake.on('POST /api/chat', silent());
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    await until(() => fake.to('/api/chat').length === 1, 'the request');
    chat.controller.abort();
    expect(await chat.outcome).toEqual({ status: 'aborted' });
    await until(() => fake.aborted === 1, 'the fake to see the hang-up');
  });

  it('a chat aborted before it started never reaches the provider', async () => {
    const r = relay();
    const controller = new AbortController();
    controller.abort();
    const outcome = await r.chat(r.resolve({ baseURL: fake.url, kind: 'ollama' }), { model: 'm', messages: [] }, { delta: () => {}, usage: () => {} }, controller.signal);
    expect(outcome).toEqual({ status: 'aborted' });
    expect(fake.requests).toHaveLength(0);
  });

  it('cancels a backoff wait', async () => {
    fake.on('POST /api/chat', json(503, {}, { 'Retry-After': '10' }));
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    await until(() => fake.to('/api/chat').length === 1, 'the first attempt');
    chat.controller.abort();
    expect(await chat.outcome).toEqual({ status: 'aborted' });
    expect(fake.to('/api/chat')).toHaveLength(1);
  });
});

describe('retries', () => {
  it('retries 429, 502, 503 and 504 and then streams', async () => {
    fake.on(
      'POST /api/chat',
      json(429, {}),
      json(502, {}),
      json(503, {}),
      stream('ndjson', [{ message: { content: 'ok' } }, { done: true }]),
    );
    const r = relay();
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    expect(await chat.outcome).toEqual({ status: 'completed' });
    expect(textOf(chat.deltas)).toBe('ok');
    expect(fake.to('/api/chat')).toHaveLength(4);
  });

  it('gives up after three retries with the last status', async () => {
    fake.on('POST /api/chat', json(504, {}));
    const r = relay();
    const outcome = await run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })).outcome;
    expect(outcome).toMatchObject({ status: 'failed', error: { reason: 'upstream', status: 504 } });
    expect(fake.to('/api/chat')).toHaveLength(4);
  });

  it('honors Retry-After in seconds', async () => {
    fake.on('POST /api/chat', json(429, {}, { 'Retry-After': '0.3' }), stream('ndjson', [{ done: true }]));
    const r = relay();
    const started = Date.now();
    expect(await run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })).outcome).toEqual({ status: 'completed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it('fails at once with retryAfterMs when Retry-After is longer than it waits', async () => {
    fake.on('POST /api/chat', json(429, { error: 'slow down' }, { 'Retry-After': '120' }));
    const r = relay({ maxRetryAfterMs: 1_000 });
    const outcome = await run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })).outcome;
    expect(outcome).toMatchObject({ status: 'failed', error: { reason: 'rate_limited', status: 429, retryAfterMs: 120_000 } });
    expect(fake.to('/api/chat')).toHaveLength(1);
  });
});

describe('dead-host cooldown', () => {
  it('two connect failures put the server in cooldown; later requests fail without connecting', async () => {
    const port = await closedPort();
    const r = relay();
    const provider = r.resolve({ baseURL: `http://127.0.0.1:${port}` });
    const first = await run(r, provider).outcome;
    expect(first).toMatchObject({ status: 'failed', error: { reason: 'unreachable' } });
    expect((first as { error: { message: string } }).error.message).toMatch(/cannot connect to http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
    expect(r.http.cooldownLeft(provider.baseURL)).toBeGreaterThan(19_000);
    const second = await run(r, provider).outcome;
    expect(second).toMatchObject({ status: 'failed', error: { reason: 'unreachable', retryAfterMs: expect.any(Number) } });
    expect((second as { error: { message: string } }).error.message).toMatch(/skipped for 20 s/);
  });
});

describe('first-token watchdog', () => {
  it('a server that accepts and never streams fails with timeout and is cancelled upstream', async () => {
    fake.on('POST /api/chat', hang());
    const r = relay({ firstTokenTimeoutMs: 150 });
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    expect(await chat.outcome).toEqual({ status: 'failed', error: { reason: 'timeout', message: 'no first token within 150 ms' } });
    await until(() => fake.aborted === 1, 'the fake to see the hang-up');
  });

  it('a server that never sends headers fails with timeout too', async () => {
    fake.on('POST /api/chat', silent());
    const r = relay({ firstTokenTimeoutMs: 100 });
    expect(await run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' })).outcome).toMatchObject({ status: 'failed', error: { reason: 'timeout' } });
  });

  it('stops watching after the first delta, however slow the rest', async () => {
    // The first chunk is written at once; the deadline only has to cover a busy machine delivering it.
    // Each later gap (1.2 s) is longer than the deadline (1 s), so a watchdog still armed would fire.
    fake.on('POST /api/chat', stream('ndjson', [{ message: { content: 'a' } }, { message: { content: 'b' } }, { done: true }], { delayMs: 1_200 }));
    const r = relay({ firstTokenTimeoutMs: 1_000 });
    const chat = run(r, r.resolve({ baseURL: fake.url, kind: 'ollama' }));
    expect(await chat.outcome).toEqual({ status: 'completed' });
    expect(textOf(chat.deltas)).toBe('ab');
  });
});

describe('models', () => {
  it('lists models in each format, with the key of a provider kept on the host', async () => {
    fake.on('GET /v1/models', json(200, { data: [{ id: 'gpt-x' }, { object: 'no id' }, 'junk'] }));
    fake.on('GET /api/tags', json(200, { models: [{ name: 'qwen3:4b' }, { model: 'llama3.2:3b' }] }));
    const r = relay();
    expect(await r.models(r.resolve({ providerId: 'keyed' }))).toEqual([{ id: 'gpt-x' }]);
    expect(fake.to('/v1/models')[0]!.headers.authorization).toBe('Bearer sk-secret');
    expect(await r.models(r.resolve({ baseURL: fake.url, kind: 'ollama' }))).toEqual([{ id: 'qwen3:4b' }, { id: 'llama3.2:3b' }]);

    fake.on('GET /v1/models', json(200, { data: [{ id: 'claude-x', display_name: 'Claude X' }, { id: 'claude-y' }] }));
    expect(await r.models({ baseURL: fake.url, kind: 'anthropic' })).toEqual([{ id: 'claude-x', displayName: 'Claude X' }, { id: 'claude-y' }]);
    expect(fake.requests.at(-1)!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('accepts a bare list from an openai-compatible server', async () => {
    fake.on('GET /models', json(200, [{ id: 'a' }]));
    const r = relay();
    expect(await r.models({ baseURL: fake.url, kind: 'openai-compatible' })).toEqual([{ id: 'a' }]);
  });

  it('a body that is not a model list or not JSON is bad_response', async () => {
    fake.on('GET /api/tags', json(200, { hello: 'world' }));
    fake.on('GET /models', text(200, 'not json'));
    const r = relay();
    await expect(r.models({ baseURL: fake.url, kind: 'ollama' })).rejects.toMatchObject({ reason: 'bad_response' });
    await expect(r.models({ baseURL: fake.url, kind: 'openai-compatible' })).rejects.toMatchObject({ reason: 'bad_response' });
  });

  it('a server that does not answer in time is unreachable', async () => {
    fake.on('GET /api/tags', silent());
    const r = relay({ modelsTimeoutMs: 100 });
    const error = await r.models({ baseURL: fake.url, kind: 'ollama' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderFailure);
    expect(error).toMatchObject({ reason: 'unreachable', message: expect.stringContaining('did not answer within 100 ms') });
  });
});

describe('resolve and list', () => {
  const r = new ProviderRelay({
    providers: [
      { id: 'mac', name: 'Ollama on this Mac', baseURL: 'http://127.0.0.1:11434' },
      { id: 'cloud', name: 'Claude', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant' },
    ],
  });

  it('lists providers with their derived kind and never the key', () => {
    expect(r.list()).toEqual([
      { id: 'mac', name: 'Ollama on this Mac', baseURL: 'http://127.0.0.1:11434', kind: 'ollama', hasKey: false },
      { id: 'cloud', name: 'Claude', baseURL: 'https://api.anthropic.com', kind: 'anthropic', hasKey: true },
    ]);
    expect(JSON.stringify(r.list())).not.toContain('sk-ant');
    expect(r.names()).toEqual(['Ollama on this Mac', 'Claude']);
  });

  it('resolves ids, kept base URLs (with their key) and host-routed base URLs', () => {
    expect(r.resolve({ providerId: 'cloud' })).toEqual({ baseURL: 'https://api.anthropic.com', kind: 'anthropic', apiKey: 'sk-ant' });
    expect(r.resolve({ baseURL: 'https://API.anthropic.com/' })).toEqual({ baseURL: 'https://api.anthropic.com', kind: 'anthropic', apiKey: 'sk-ant' });
    expect(r.resolve({ baseURL: 'http://192.168.1.5:1234/v1' })).toEqual({ baseURL: 'http://192.168.1.5:1234/v1', kind: 'openai-compatible' });
    expect(r.resolve({ baseURL: 'https://box.tail1234.ts.net:11434', kind: 'openai-compatible' })).toEqual({
      baseURL: 'https://box.tail1234.ts.net:11434',
      kind: 'openai-compatible',
    });
    expect(r.resolve({ providerId: 'mac', kind: 'openai-compatible' }).kind).toBe('openai-compatible');
  });

  it('refuses unknown ids, public https base URLs, junk and unknown kinds', () => {
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error as RpcError;
      }
      throw new Error('did not throw');
    };
    expect(err(() => r.resolve({ providerId: 'nope' }))).toMatchObject({ code: 'not_found', data: { providerId: 'nope' } });
    expect(err(() => r.resolve({ baseURL: 'https://api.openai.com/v1' }))).toMatchObject({ code: 'invalid_params', data: { path: 'params.baseURL' } });
    expect(err(() => r.resolve({ baseURL: 'ftp://x' }))).toMatchObject({ code: 'invalid_params', data: { path: 'params.baseURL' } });
    expect(err(() => r.resolve({}))).toMatchObject({ code: 'invalid_params', data: { path: 'params.providerId' } });
    expect(err(() => r.resolve({ providerId: 'mac', kind: 'gemini' as never }))).toMatchObject({ code: 'invalid_params', data: { path: 'params.kind' } });
  });
});
