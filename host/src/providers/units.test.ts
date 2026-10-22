// Unit checks of the relay's pieces: base URL rules, framing, the HTTP helpers, the adapter table's edge
// cases and discovery.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discover, DISCOVERY_PORTS, ownAddresses, probe } from './discover.js';
import { ndjsonFramer, sseFramer } from './frames.js';
import { Cancelled, ProviderFailure, ProviderHttp, retryAfterMs, sleep } from './http.js';
import { FakeProvider, json, silent } from './testing/fake-provider.js';
import { isHostRouted, isPrivateHost, kindForURL, normalizeBaseURL, originOf } from './url.js';
import { WIRE } from './wire.js';

describe('base URLs', () => {
  it('normalizes to scheme, host, port and path', () => {
    expect(normalizeBaseURL(' HTTP://LocalHost:11434/ ')).toBe('http://localhost:11434');
    expect(normalizeBaseURL('https://api.example.com:443/v1//?x=1#y')).toBe('https://api.example.com/v1');
    for (const bad of ['', 'not a url', 'ftp://x', 'http://user:pw@host', 'localhost:1234', 'http://a b']) {
      expect(normalizeBaseURL(bad), bad).toBeNull();
    }
  });

  it('routes http and private hosts through the host, public https directly (ADR 0006)', () => {
    for (const url of [
      'http://example.com',
      'https://127.0.0.1:8080',
      'https://localhost',
      'https://10.1.2.3',
      'https://172.16.0.1',
      'https://192.168.1.2',
      'https://169.254.1.1',
      'https://100.64.0.1',
      'https://100.127.255.255',
      'https://mac.local',
      'https://box.tail123.ts.net',
      'https://gpu',
      'https://[::1]:11434',
      'https://[fd7a:115c:a1e0::1]',
      'https://[fe80::1]',
      'https://[::ffff:c0a8:0101]',
      'https://dev.localhost',
    ]) {
      expect(isHostRouted(url), url).toBe(true);
    }
    for (const url of ['https://api.openai.com/v1', 'https://100.128.0.1', 'https://172.32.0.1', 'https://[2001:db8::1]', 'https://[::ffff:0808:0808]']) {
      expect(isHostRouted(url), url).toBe(false);
    }
    expect(isPrivateHost('999.1.1.1')).toBe(false);
  });

  it('derives the kind from the host only', () => {
    expect(kindForURL('https://api.anthropic.com')).toBe('anthropic');
    expect(kindForURL('https://anthropic.com/v1')).toBe('anthropic');
    expect(kindForURL('https://api.anthropic.com.evil.example')).toBe('openai-compatible');
    expect(kindForURL('https://ollama.com')).toBe('ollama');
    expect(kindForURL('http://192.168.1.9:11434')).toBe('ollama');
    expect(kindForURL('http://localhost:1234/v1')).toBe('openai-compatible');
    expect(originOf('http://127.0.0.1:11434/api/chat')).toBe('http://127.0.0.1:11434');
  });
});

describe('framing', () => {
  it('SSE joins multi-line data, ignores other fields, handles CRLF split across chunks and [DONE]', () => {
    const framer = sseFramer();
    expect(framer.push('event: x\r\ndata: {"a":\r')).toEqual([]);
    expect(framer.push('\ndata: 1}\r\n\r\n: comment\nid: 4\ndata:{"b":2}\n')).toEqual([{ data: '{"a":\n1}' }]);
    expect(framer.push('\ndata: [DONE]\n\n')).toEqual([{ data: '{"b":2}' }, { done: true }]);
    expect(framer.push('\n\n')).toEqual([]);
  });

  it('SSE flushes an event without a trailing blank line at the end', () => {
    const framer = sseFramer();
    expect(framer.push('data: {"c":3}')).toEqual([]);
    expect(framer.end()).toEqual([{ data: '{"c":3}' }]);
    expect(sseFramer().end()).toEqual([]);
  });

  it('NDJSON yields every non-blank line, and the last line without a newline at the end', () => {
    const framer = ndjsonFramer();
    expect(framer.push('{"a":1}\n\n{"b"')).toEqual([{ data: '{"a":1}' }]);
    expect(framer.push(':2}\r\n{"c":3}')).toEqual([{ data: '{"b":2}' }]);
    expect(framer.end()).toEqual([{ data: '{"c":3}' }]);
  });
});

describe('http helpers', () => {
  it('reads Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-22T10:00:00Z');
    expect(retryAfterMs('3', now)).toBe(3000);
    expect(retryAfterMs('0.5', now)).toBe(500);
    expect(retryAfterMs('Thu, 22 Oct 2026 10:00:07 GMT', now)).toBe(7000);
    expect(retryAfterMs('Thu, 22 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs(' ', now)).toBeUndefined();
    expect(retryAfterMs('soon', now)).toBeUndefined();
  });

  it('backs off exponentially with jitter and a cap', () => {
    const http = new ProviderHttp({ random: () => 0.5 });
    expect([0, 1, 2, 3, 4, 5].map((n) => http.backoff(n))).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(new ProviderHttp({ random: () => 0 }).backoff(0)).toBe(400);
    expect(new ProviderHttp({ random: () => 1 }).backoff(0)).toBe(600);
  });

  it('sleep resolves, and rejects with Cancelled on abort before or during the wait', async () => {
    await sleep(1);
    const before = new AbortController();
    before.abort();
    await expect(sleep(1000, before.signal)).rejects.toBeInstanceOf(Cancelled);
    const during = new AbortController();
    const waiting = sleep(1000, during.signal);
    during.abort();
    await expect(waiting).rejects.toBeInstanceOf(Cancelled);
  });

  it('send with an aborted signal is Cancelled without a request', async () => {
    let calls = 0;
    const http = new ProviderHttp({ fetch: (async () => (calls++, new Response('{}'))) as typeof fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(http.send({ url: 'http://127.0.0.1:1/x', method: 'GET', headers: {} }, { signal: controller.signal })).rejects.toBeInstanceOf(Cancelled);
    expect(calls).toBe(0);
  });

  it('a 503 with a long Retry-After fails as upstream with retryAfterMs; an error body that cannot be read is left out', async () => {
    const http = new ProviderHttp({
      fetch: (async () => new Response('down for maintenance', { status: 503, headers: { 'Retry-After': '3600' } })) as typeof fetch,
    });
    await expect(http.send({ url: 'http://127.0.0.1:1/x', method: 'GET', headers: {} })).rejects.toMatchObject({
      reason: 'upstream',
      status: 503,
      retryAfterMs: 3_600_000,
      message: 'the provider answered HTTP 503: down for maintenance',
    });
    const broken = new ProviderHttp({
      fetch: (async () => {
        const response = new Response('x', { status: 500 });
        Object.defineProperty(response, 'text', { value: () => Promise.reject(new Error('gone')) });
        return response;
      }) as typeof fetch,
    });
    await expect(broken.send({ url: 'http://127.0.0.1:1/x', method: 'GET', headers: {} })).rejects.toMatchObject({ message: 'the provider answered HTTP 500' });
  });

  it('names the cause of a network error, whatever its shape', async () => {
    const failing = (error: unknown) =>
      new ProviderHttp({
        maxConnectRetries: 0,
        fetch: (async () => {
          throw error;
        }) as typeof fetch,
      }).send({ url: 'http://127.0.0.1:1/x', method: 'GET', headers: {} });
    await expect(failing(Object.assign(new TypeError('fetch failed'), { cause: { message: 'socket hang up' } }))).rejects.toMatchObject({
      message: 'cannot connect to http://127.0.0.1:1 (socket hang up)',
    });
    await expect(failing(new Error('plain'))).rejects.toMatchObject({ message: 'cannot connect to http://127.0.0.1:1 (plain)' });
    await expect(failing('text')).rejects.toMatchObject({ message: 'cannot connect to http://127.0.0.1:1 (text)' });
  });

  it('the cooldown ends after its time and a success clears the failure count', async () => {
    let now = 1_000;
    let up = false;
    const http = new ProviderHttp({
      now: () => now,
      maxConnectRetries: 0,
      fetch: (async () => {
        if (!up) throw new TypeError('fetch failed');
        return new Response('{}');
      }) as typeof fetch,
    });
    const request = { url: 'http://10.0.0.9:8000/v1/models', method: 'GET' as const, headers: {} };
    await expect(http.send(request)).rejects.toBeInstanceOf(ProviderFailure);
    expect(http.cooldownLeft(request.url)).toBe(0); // one failure is not yet dead
    await expect(http.send(request)).rejects.toBeInstanceOf(ProviderFailure);
    expect(http.cooldownLeft(request.url)).toBe(20_000);
    now += 20_001;
    up = true;
    expect((await http.send(request)).status).toBe(200);
    up = false;
    await expect(http.send(request)).rejects.toBeInstanceOf(ProviderFailure);
    expect(http.cooldownLeft(request.url)).toBe(0);
    expect(new ProviderFailure('timeout', 'x').toError()).toEqual({ reason: 'timeout', message: 'x' });
  });
});

describe('adapter table edge cases', () => {
  it('frames that are not objects are errors; empty deltas and unknown events are dropped', () => {
    for (const kind of ['openai-compatible', 'ollama', 'anthropic'] as const) {
      expect(WIRE[kind].parse('str')).toEqual([{ type: 'error', message: 'frame is not an object' }]);
    }
    expect(WIRE['openai-compatible'].parse({ choices: [{ delta: { content: '' } }] })).toEqual([]);
    expect(WIRE['openai-compatible'].parse({ choices: 'x', usage: { prompt_tokens: -1 } })).toEqual([]);
    expect(WIRE.ollama.parse({ error: { message: 'oom' } })).toEqual([{ type: 'error', message: 'oom' }]);
    expect(WIRE.ollama.parse({ error: 42 })).toEqual([{ type: 'error', message: '42' }]);
    expect(WIRE.anthropic.parse({ type: 'message_start' })).toEqual([]);
    expect(WIRE.anthropic.parse({ type: 'message_delta' })).toEqual([]);
    expect(WIRE.anthropic.parse({ type: 'content_block_delta' })).toEqual([]);
    expect(WIRE.anthropic.parse({ type: 'content_block_stop' })).toEqual([]);
    expect(WIRE['openai-compatible'].parseModels({})).toBeNull();
    expect(WIRE.anthropic.parseModels({ data: [{ display_name: 'no id' }] })).toEqual([]);
    expect(WIRE.ollama.parseModels({ models: [{}] })).toEqual([]);
  });

  it('anthropic: no extra /v1 when the base ends in it, no thinking below the minimum budget, temperature without thinking', () => {
    const request = WIRE.anthropic.chatRequest('https://proxy.example/v1', undefined, {
      model: 'c',
      messages: [{ role: 'user', content: 'x' }],
      options: { thinking: true, maxTokens: 1000, temperature: 0.3 },
    });
    expect(request.url).toBe('https://proxy.example/v1/messages');
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({ model: 'c', max_tokens: 1000, messages: [{ role: 'user', content: 'x' }], stream: true, temperature: 0.3 });
    expect(WIRE.anthropic.modelsRequest('https://api.anthropic.com', 'k').url).toBe('https://api.anthropic.com/v1/models?limit=1000');
  });

  it('openai and ollama send no optional fields when no options are given', () => {
    const input = { model: 'm', messages: [{ role: 'user' as const, content: 'x' }] };
    expect(JSON.parse(WIRE['openai-compatible'].chatRequest('http://h/v1', undefined, input).body!)).toEqual({
      ...input,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(JSON.parse(WIRE.ollama.chatRequest('http://h', 'k', input).body!)).toEqual({ ...input, stream: true });
    expect(WIRE.ollama.chatRequest('http://h', 'k', input).headers.Authorization).toBe('Bearer k');
  });
});

describe('discovery', () => {
  let ollama: FakeProvider;
  let lmstudio: FakeProvider;
  let llama: FakeProvider;

  beforeEach(async () => {
    [ollama, lmstudio, llama] = await Promise.all([FakeProvider.start(), FakeProvider.start(), FakeProvider.start()]);
    ollama.on('GET /api/tags', json(200, { models: [] }));
    lmstudio.on('GET /v1/models', json(200, { data: [{ id: 'qwen' }] }));
    llama.on('GET /models', json(200, [{ id: 'gguf' }]));
  });

  afterEach(async () => {
    await Promise.all([ollama.close(), lmstudio.close(), llama.close()]);
  });

  it('finds Ollama, a /v1 server and a bare /models server; a server on several addresses is reported once, loopback first', async () => {
    const candidates = await discover({
      // 127.0.0.2 is loopback too on macOS only after an alias; use 127.0.0.1 under two scopes instead.
      addresses: () => [
        { address: '127.0.0.1', scope: 'tailnet' },
        { address: '127.0.0.1', scope: 'loopback' },
      ],
      ports: [ollama.port, lmstudio.port, llama.port],
      timeoutMs: 500,
    });
    expect(candidates).toEqual([
      { baseURL: `http://127.0.0.1:${ollama.port}`, kind: 'ollama' },
      { baseURL: `http://127.0.0.1:${lmstudio.port}/v1`, kind: 'openai-compatible' },
      { baseURL: `http://127.0.0.1:${llama.port}`, kind: 'openai-compatible' },
    ]);
  });

  it('a port that answers with something else, an error or nothing is not a candidate', async () => {
    const odd = await FakeProvider.start();
    odd.on('GET /api/tags', json(200, { hello: 1 })).on('GET /v1/models', json(500, {})).on('GET /models', silent());
    try {
      const started = Date.now();
      expect(await probe(globalThis.fetch, odd.url, 100)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await odd.close();
    }
  });

  it('probes the documented ports on this Mac’s own IPv4 addresses', () => {
    expect(DISCOVERY_PORTS.slice(0, 4)).toEqual([11434, 1234, 9931, 8080]);
    expect(DISCOVERY_PORTS).toContain(8000);
    expect(DISCOVERY_PORTS).toContain(8020);
    expect(DISCOVERY_PORTS).toHaveLength(25);
    const ipv4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
    expect(
      ownAddresses({
        lo0: [ipv4('127.0.0.1', true)],
        en0: [ipv4('192.168.1.20'), { ...ipv4('fe80::1'), family: 'IPv6' as const, scopeid: 0 }],
        utun4: [ipv4('100.101.102.103')],
        en1: [ipv4('192.168.1.20')],
        bad: undefined,
      }),
    ).toEqual([
      { address: '127.0.0.1', scope: 'loopback' },
      { address: '192.168.1.20', scope: 'lan' },
      { address: '100.101.102.103', scope: 'tailnet' },
    ]);
    expect(ownAddresses()[0]).toEqual({ address: '127.0.0.1', scope: 'loopback' });
  });

  it('an empty scan returns no candidates', async () => {
    expect(await discover({ addresses: () => [], ports: [] })).toEqual([]);
  });
});
