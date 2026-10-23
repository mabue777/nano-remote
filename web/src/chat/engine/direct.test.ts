import { describe, expect, it } from 'vitest';

import { collect, cut, fakeFetch, fixture, joined, type Reply } from '../../../test/chat-doubles';
import { createChatEngine, type ChatEngineDeps } from './chat';
import { DeadHosts, directChat, retryAfter, type DirectTiming } from './direct';
import { HOST_UNAVAILABLE_MESSAGE } from './errors';
import type { ChatEvent, ChatProvider, ChatTurn } from './types';

const OPENAI: ChatProvider = { id: 'p-openai', name: 'Acme AI', baseURL: 'https://api.acme.example/v1', kind: 'openai-compatible' };
const OLLAMA: ChatProvider = { id: 'p-ollama', name: 'Ollama Cloud', baseURL: 'https://ollama.com', kind: 'ollama' };
const ANTHROPIC: ChatProvider = { id: 'p-anthropic', name: 'Anthropic', baseURL: 'https://api.anthropic.com', kind: 'anthropic' };

const TURNS: ChatTurn[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Say hi in three words.' },
];

/** Fast timings so retries and the watchdog run in milliseconds. */
// firstTokenMs only guards a busy machine here; tests that assert the watchdog fires set their own.
const FAST: Partial<DirectTiming> = { retryBaseMs: 1, retryMaxMs: 4, firstTokenMs: 10_000 };

function engine(fetch: ChatEngineDeps['fetch'], extra: Partial<ChatEngineDeps> = {}) {
  return createChatEngine({ fetch, keyFor: () => 'sk-test', host: () => null, timing: FAST, random: () => 0, ...extra });
}

const last = (events: ChatEvent[]): ChatEvent | undefined => events.at(-1);

interface Format {
  label: string;
  provider: ChatProvider;
  file: string;
  framing: 'sse' | 'ndjson';
  url: string;
  reasoning: string;
  text: string;
  usage: { inputTokens?: number; outputTokens?: number }[];
  /** Frames to keep before the mid-stream error / abort; enough to include a reasoning delta. */
  keep: number;
  errorFrame: string;
  errorDetail: string;
}

const FORMATS: Format[] = [
  {
    label: 'OpenAI-compatible SSE',
    provider: OPENAI,
    file: 'openai-reasoning.sse',
    framing: 'sse',
    url: 'https://api.acme.example/v1/chat/completions',
    reasoning: 'We need to respond with three-word greeting.',
    text: 'Hey there, friend!',
    usage: [{ inputTokens: 73, outputTokens: 24 }],
    keep: 3,
    errorFrame: 'data: {"error":{"message":"model overloaded","type":"server_error"}}\n\n',
    errorDetail: 'model overloaded',
  },
  {
    label: 'Ollama NDJSON',
    provider: OLLAMA,
    file: 'ollama-thinking.ndjson',
    framing: 'ndjson',
    url: 'https://ollama.com/api/chat',
    reasoning: '',
    text: '',
    usage: [{ inputTokens: 73, outputTokens: 88 }],
    keep: 3,
    errorFrame: '{"error":"an error was encountered while running the model"}\n',
    errorDetail: 'an error was encountered while running the model',
  },
  {
    label: 'Anthropic SSE',
    provider: ANTHROPIC,
    file: 'anthropic-thinking.sse',
    framing: 'sse',
    url: 'https://api.anthropic.com/v1/messages',
    reasoning: 'Let me solve this step by step:\n\n1. First break down 27 * 453\n2. 453 = 400 + 50 + 3',
    text: '27 * 453 = 12,231',
    usage: [{ inputTokens: 25 }, { outputTokens: 15 }],
    keep: 4,
    errorFrame: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    errorDetail: 'Overloaded',
  },
];

/** What the recorded Ollama stream says, computed from the file itself (it is long). */
function ollamaExpected(): { reasoning: string; text: string } {
  let reasoning = '';
  let text = '';
  for (const line of fixture('ollama-thinking.ndjson').split('\n')) {
    if (line.trim() === '') continue;
    const frame = JSON.parse(line) as { message?: { thinking?: string; content?: string } };
    reasoning += frame.message?.thinking ?? '';
    text += frame.message?.content ?? '';
  }
  return { reasoning, text };
}

describe.each(FORMATS)('direct route, $label (recorded fixture)', (format) => {
  const expected = format.provider.kind === 'ollama' ? ollamaExpected() : { reasoning: format.reasoning, text: format.text };

  it('streams reasoning and text deltas, usage, then done; reasoning is never mixed into the text', async () => {
    const { fetch, calls } = fakeFetch({ body: fixture(format.file) });
    const events = await collect(engine(fetch).chat(format.provider, 'm-1', TURNS));
    expect(joined(events, 'reasoning')).toBe(expected.reasoning);
    expect(joined(events, 'text')).toBe(expected.text);
    expect(expected.reasoning).not.toBe('');
    expect(expected.text).not.toBe('');
    expect(events.filter((e) => e.type === 'usage').map(({ type: _t, ...u }) => u)).toEqual(format.usage);
    expect(last(events)).toEqual({ type: 'done', status: 'completed' });
    expect(events.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(format.url);
    expect(calls[0]?.body).toMatchObject({ model: 'm-1', stream: true });
  });

  it('reads the same events when the bytes arrive in 5-byte chunks', async () => {
    const whole = await collect(engine(fakeFetch({ body: fixture(format.file) }).fetch).chat(format.provider, 'm-1', TURNS));
    const chunked = await collect(engine(fakeFetch({ body: fixture(format.file), chunkBytes: 5 }).fetch).chat(format.provider, 'm-1', TURNS));
    expect(chunked).toEqual(whole);
  });

  it('ends with an upstream error on a mid-stream error frame and keeps what came before', async () => {
    const body = cut(fixture(format.file), format.keep, format.framing) + format.errorFrame + fixture(format.file);
    const events = await collect(engine(fakeFetch({ body }).fetch).chat(format.provider, 'm-1', TURNS));
    expect(events.some((e) => e.type === 'reasoning')).toBe(true);
    expect(last(events)).toMatchObject({ type: 'error', reason: 'upstream', detail: format.errorDetail });
    expect((last(events) as { message: string }).message).toContain(format.provider.name);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
  });

  it('stops on abort mid-stream: done(aborted), nothing after it, the request is cancelled', async () => {
    const replay = fakeFetch({ body: cut(fixture(format.file), format.keep, format.framing), stall: true });
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const event of engine(replay.fetch).chat(format.provider, 'm-1', TURNS, {}, controller.signal)) {
      events.push(event);
      if (event.type === 'reasoning') controller.abort();
    }
    expect(events.filter((e) => e.type === 'reasoning')).toHaveLength(1);
    expect(last(events)).toEqual({ type: 'done', status: 'aborted' });
    expect(replay.calls[0]?.signal.aborted).toBe(true);
    expect(replay.cancelled()).toBe(1);
  });
});

describe('direct route requests', () => {
  it('sends the key as a bearer token with stream_options.include_usage for OpenAI-compatible servers', async () => {
    const { fetch, calls } = fakeFetch({ body: fixture('openai-reasoning.sse') });
    await collect(engine(fetch).chat(OPENAI, 'gpt-x', TURNS, { temperature: 0.2, maxTokens: 100 }));
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer sk-test', 'Content-Type': 'application/json', Accept: 'text/event-stream' });
    expect(calls[0]?.body).toEqual({
      model: 'gpt-x',
      messages: TURNS,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 100,
    });
  });

  it('sends x-api-key, anthropic-version and the direct-browser-access header to Anthropic, system turns joined', async () => {
    const { fetch, calls } = fakeFetch({ body: fixture('anthropic-thinking.sse') });
    const turns: ChatTurn[] = [{ role: 'system', content: 'A.' }, { role: 'system', content: 'B.' }, { role: 'user', content: 'Hi' }];
    await collect(engine(fetch, { keyFor: () => 'sk-ant-xyz' }).chat(ANTHROPIC, 'claude-sonnet-4-5', turns));
    expect(calls[0]?.headers).toMatchObject({
      'x-api-key': 'sk-ant-xyz',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.body).toEqual({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
      system: 'A.\n\nB.',
      stream: true,
      max_tokens: 4096,
    });
  });

  it('does not double /v1 for an Anthropic base URL that already ends in it, and sends no key header without a key', async () => {
    const { fetch, calls } = fakeFetch({ body: fixture('anthropic-thinking.sse') });
    const provider = { ...ANTHROPIC, baseURL: 'https://gateway.example/anthropic/v1' };
    await collect(engine(fetch, { keyFor: () => null }).chat(provider, 'claude-x', TURNS));
    expect(calls[0]?.url).toBe('https://gateway.example/anthropic/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('sends Ollama Cloud its key as a bearer token, and no Authorization header without a key', async () => {
    const withKey = fakeFetch({ body: fixture('ollama-thinking.ndjson') });
    await collect(engine(withKey.fetch).chat(OLLAMA, 'gpt-oss:120b', TURNS));
    expect(withKey.calls[0]?.headers).toMatchObject({ Authorization: 'Bearer sk-test', Accept: 'application/x-ndjson' });
    const without = fakeFetch({ body: fixture('ollama-thinking.ndjson') });
    await collect(engine(without.fetch, { keyFor: () => null }).chat(OLLAMA, 'gpt-oss:120b', TURNS));
    expect(without.calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('uses the browser fetch when none is injected', async () => {
    const original = globalThis.fetch;
    const replay = fakeFetch({ body: fixture('openai-reasoning.sse') });
    globalThis.fetch = replay.fetch as unknown as typeof fetch;
    try {
      const events = await collect(createChatEngine({ keyFor: () => null, host: () => null }).chat(OPENAI, 'm', TURNS));
      expect(last(events)).toEqual({ type: 'done', status: 'completed' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('direct route failures', () => {
  it('maps 401 to one sentence naming the provider, with the server words only in detail', async () => {
    const { fetch } = fakeFetch({ status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' });
    const events = await collect(engine(fetch).chat(OPENAI, 'm', TURNS));
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'unauthorized',
        message: 'Acme AI rejected the key. Check the key in Settings.',
        detail: 'Incorrect API key provided',
        status: 401,
      },
    ]);
  });

  it('maps 410 for a retired model (as Ollama Cloud answers it) to not_found', async () => {
    const body = '{"error":"qwen3.5:397b was retired on September 25, 2026. Try glm-5.3-flash:cloud."}';
    const events = await collect(engine(fakeFetch({ status: 410, body }).fetch).chat(OLLAMA, 'qwen3.5:cloud', TURNS));
    expect(last(events)).toMatchObject({ reason: 'not_found', status: 410, message: 'Ollama Cloud does not know this model. Pick another model.' });
    expect((last(events) as { detail: string }).detail).toContain('retired');
  });

  it('does not retry other errors and keeps a non-JSON body as detail', async () => {
    const { fetch, calls } = fakeFetch({ status: 500, body: 'Internal Server Error' });
    const events = await collect(engine(fetch).chat(OPENAI, 'm', TURNS));
    expect(last(events)).toMatchObject({ reason: 'upstream', status: 500, detail: 'Internal Server Error' });
    expect(calls).toHaveLength(1);
  });

  it('fails with bad_response for a reply without a body, a frame that is not JSON, or a stream without its end marker', async () => {
    const noBody = await collect(engine(fakeFetch({ body: null }).fetch).chat(OPENAI, 'm', TURNS));
    expect(last(noBody)).toMatchObject({ reason: 'bad_response', message: 'Acme AI sent a reply this app could not read.' });
    const garbage = await collect(engine(fakeFetch({ body: 'data: {oops\n\n' }).fetch).chat(OPENAI, 'm', TURNS));
    expect(last(garbage)).toMatchObject({ reason: 'bad_response', detail: 'a stream frame is not JSON' });
    const notObject = await collect(engine(fakeFetch({ body: '[1,2]\n' }).fetch).chat(OLLAMA, 'm', TURNS));
    expect(last(notObject)).toMatchObject({ reason: 'bad_response', detail: 'a stream frame is not a JSON object' });
    const truncated = cut(fixture('anthropic-thinking.sse'), 5, 'sse');
    const cutOff = await collect(engine(fakeFetch({ body: truncated }).fetch).chat(ANTHROPIC, 'm', TURNS));
    expect(joined(cutOff, 'reasoning')).not.toBe('');
    expect(last(cutOff)).toMatchObject({ reason: 'bad_response', detail: 'the stream ended without its end marker' });
  });

  it('counts an OpenAI stream that finished (finish_reason) but sent no [DONE] as completed', async () => {
    const body = fixture('openai-reasoning.sse').replace('data: [DONE]\n\n', '');
    const events = await collect(engine(fakeFetch({ body }).fetch).chat(OPENAI, 'm', TURNS));
    expect(last(events)).toEqual({ type: 'done', status: 'completed' });
  });

  it('ends with unreachable when the connection breaks mid-stream', async () => {
    const body = cut(fixture('openai-reasoning.sse'), 7, 'sse');
    const events = await collect(engine(fakeFetch({ body, breakWith: new TypeError('network connection was lost') }).fetch).chat(OPENAI, 'm', TURNS));
    expect(joined(events, 'text')).toBe('Hey there');
    expect(last(events)).toMatchObject({ reason: 'unreachable' });
    expect((last(events) as { detail: string }).detail).toContain('network connection was lost');
  });
});

describe('direct route retries (provider-connection.md section 4)', () => {
  it('retries 429, 502, 503 and 504 with backoff, then streams', async () => {
    const replies: Reply[] = [{ status: 429 }, { status: 502 }, { status: 503 }, { body: fixture('openai-reasoning.sse') }];
    const { fetch, calls } = fakeFetch(...replies);
    const events = await collect(engine(fetch).chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(4);
    expect(last(events)).toEqual({ type: 'done', status: 'completed' });
  });

  it('gives up after 3 retries with the last status', async () => {
    const { fetch, calls } = fakeFetch({ status: 504, body: 'gateway timeout' });
    const events = await collect(engine(fetch).chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(4);
    expect(last(events)).toMatchObject({ reason: 'upstream', status: 504 });
  });

  it('honors Retry-After in seconds and as an HTTP date', async () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    const replies: Reply[] = [
      { status: 429, headers: { 'Retry-After': '0' } },
      { status: 503, headers: { 'Retry-After': new Date(now - 1000).toUTCString() } },
      { body: fixture('openai-reasoning.sse') },
    ];
    const { fetch, calls } = fakeFetch(...replies);
    const events = await collect(engine(fetch, { now: () => now }).chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(3);
    expect(last(events)).toEqual({ type: 'done', status: 'completed' });
  });

  it('fails at once with rate_limited and retryAfterMs when Retry-After is above 30 s', async () => {
    const { fetch, calls } = fakeFetch({ status: 429, headers: { 'Retry-After': '120' }, body: '{"error":{"message":"slow down"}}' });
    const events = await collect(engine(fetch).chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(1);
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'rate_limited',
        message: 'Acme AI is rate limiting requests. Try again in 120 s.',
        detail: 'slow down',
        status: 429,
        retryAfterMs: 120_000,
      },
    ]);
  });

  it('says "wait a minute" for a 429 without Retry-After once retries run out', async () => {
    const events = await collect(engine(fakeFetch({ status: 429 }).fetch).chat(OPENAI, 'm', TURNS));
    expect(last(events)).toMatchObject({ message: 'Acme AI is rate limiting requests. Wait a minute and try again.' });
  });

  it('retries a connect failure once, then starts the dead-host cooldown after the second failure', async () => {
    let clock = 1_000;
    const deps = { now: () => clock };
    const { fetch, calls } = fakeFetch({ reject: new TypeError('Load failed') });
    const e = engine(fetch, deps);
    const first = await collect(e.chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(2);
    expect(first).toEqual([
      {
        type: 'error',
        reason: 'unreachable',
        message: 'Acme AI is not reachable. Check the address and that the server is running.',
        detail: 'TypeError: Load failed',
      },
    ]);
    clock += 5_000;
    const second = await collect(e.chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(2); // not even tried
    expect(second).toMatchObject([{ reason: 'unreachable', retryAfterMs: 15_000 }]);
    clock += 15_000;
    await collect(e.chat(OPENAI, 'm', TURNS));
    expect(calls).toHaveLength(4); // the cooldown is over: tried again, and retried once
  });

  it('recovers after one connect failure, and a success resets the failure count', async () => {
    const hosts = new DeadHosts();
    const replies: Reply[] = [{ reject: new TypeError('x') }, { body: fixture('openai-reasoning.sse') }];
    const { fetch } = fakeFetch(...replies);
    const events = await collect(directChat(OPENAI, 'm', TURNS, {}, undefined, { fetch, apiKey: null, timing: FAST, deadHosts: hosts }));
    expect(last(events)).toEqual({ type: 'done', status: 'completed' });
    expect(hosts.remaining('https://api.acme.example', Date.now())).toBe(0);
  });

  it('stops during the backoff wait when aborted', async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({ status: 503, headers: { 'Retry-After': '20' } });
    const pending = collect(engine(fetch).chat(OPENAI, 'm', TURNS, {}, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await pending).toEqual([{ type: 'done', status: 'aborted' }]);
    expect(calls).toHaveLength(1);
  });
});

describe('direct route watchdog and abort', () => {
  it('fails with timeout when the server accepts the request but sends no delta in time', async () => {
    const body = cut(fixture('anthropic-thinking.sse'), 3, 'sse'); // message_start, block start, ping: no delta
    const replay = fakeFetch({ body, stall: true });
    const events = await collect(engine(replay.fetch, { timing: { ...FAST, firstTokenMs: 30 } }).chat(ANTHROPIC, 'm', TURNS));
    expect(events).toEqual([
      { type: 'usage', inputTokens: 25 },
      {
        type: 'error',
        reason: 'timeout',
        message: 'Anthropic accepted the request but sent nothing back. Try again, or pick a smaller model.',
      },
    ]);
    expect(replay.calls[0]?.signal.aborted).toBe(true);
  });

  it('fails with timeout when the server never answers the request', async () => {
    const replay = fakeFetch({ hang: true });
    const events = await collect(engine(replay.fetch, { timing: { ...FAST, firstTokenMs: 30 } }).chat(OPENAI, 'm', TURNS));
    expect(events).toMatchObject([{ type: 'error', reason: 'timeout' }]);
    expect(replay.calls).toHaveLength(1);
  });

  it('keeps streaming past the watchdog once the first delta arrived', async () => {
    const body = cut(fixture('openai-reasoning.sse'), 2, 'sse');
    const replay = fakeFetch({ body, stall: true });
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    const run = (async () => {
      // The deadline covers a busy machine delivering the first delta; the wait outlasts it, so a watchdog
      // still armed would have fired before the abort.
      for await (const event of engine(replay.fetch, { timing: { ...FAST, firstTokenMs: 1_000 } }).chat(OPENAI, 'm', TURNS, {}, controller.signal)) {
        events.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(events.map((e) => e.type)).toEqual(['reasoning', 'reasoning']);
    controller.abort();
    await run;
    expect(last(events)).toEqual({ type: 'done', status: 'aborted' });
  });

  it('answers done(aborted) without a request when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch({ body: fixture('openai-reasoning.sse') });
    const events = await collect(engine(fetch).chat(OPENAI, 'm', TURNS, {}, AbortSignal.abort()));
    expect(events).toEqual([{ type: 'done', status: 'aborted' }]);
    expect(calls).toHaveLength(0);
  });

  it('answers done(aborted) when aborted while waiting for the response headers', async () => {
    const controller = new AbortController();
    const replay = fakeFetch({ hang: true });
    const pending = collect(engine(replay.fetch).chat(OPENAI, 'm', TURNS, {}, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await pending).toEqual([{ type: 'done', status: 'aborted' }]);
  });

  it('cancels the request when the consumer stops reading early', async () => {
    const replay = fakeFetch({ body: fixture('openai-reasoning.sse'), stall: true });
    for await (const event of engine(replay.fetch).chat(OPENAI, 'm', TURNS)) {
      if (event.type === 'reasoning') break;
    }
    expect(replay.calls[0]?.signal.aborted).toBe(true);
    expect(replay.cancelled()).toBe(1);
  });
});

describe('routing', () => {
  it('sends a provider on a private address through the host and fails fast without one', async () => {
    const { fetch, calls } = fakeFetch({ body: fixture('ollama-thinking.ndjson') });
    const local: ChatProvider = { id: 'p-local', name: 'Mac Ollama', baseURL: 'http://192.168.1.20:11434', kind: 'ollama' };
    const events = await collect(engine(fetch).chat(local, 'qwen3:4b', TURNS));
    expect(events).toEqual([{ type: 'error', reason: 'host_unavailable', message: HOST_UNAVAILABLE_MESSAGE }]);
    expect(HOST_UNAVAILABLE_MESSAGE).toBe('Your Mac is not reachable; this provider runs through it.');
    expect(calls).toHaveLength(0);
  });
});

describe('retryAfter', () => {
  it('reads seconds, fractions and HTTP dates, and ignores junk', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(retryAfter(null, now)).toBeUndefined();
    expect(retryAfter(' ', now)).toBeUndefined();
    expect(retryAfter('7', now)).toBe(7000);
    expect(retryAfter('1.5', now)).toBe(1500);
    expect(retryAfter('Thu, 22 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
    expect(retryAfter('Thu, 22 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfter('soon', now)).toBeUndefined();
  });
});
