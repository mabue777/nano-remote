import { describe, expect, it, vi } from 'vitest';

import type { FetchLike, HostProbe, HostProbeReply } from './probe';
import { HOST_UNAVAILABLE_MESSAGE, modelsRequest, parseModels, probeModels } from './probe';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake fetch answering one status and body; records what it was asked. */
function fakeFetch(status: number, body?: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return {
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected token < in JSON');
        return body;
      },
    };
  };
  return { fetch, calls };
}

/** A fetch that never answers until aborted. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

const openai = { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', kind: 'openai-compatible' as const };

describe('modelsRequest', () => {
  it('builds the path and headers per kind', () => {
    expect(modelsRequest('https://api.openai.com/v1', 'openai-compatible', 'sk-1')).toEqual({
      path: '/models',
      headers: { Accept: 'application/json', Authorization: 'Bearer sk-1' },
    });
    expect(modelsRequest('https://api.anthropic.com', 'anthropic', 'sk-ant-1')).toEqual({
      path: '/v1/models?limit=1000',
      headers: {
        Accept: 'application/json',
        'x-api-key': 'sk-ant-1',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    expect(modelsRequest('https://api.anthropic.com/v1', 'anthropic').path).toBe('/models?limit=1000');
    expect(modelsRequest('https://generativelanguage.googleapis.com/v1beta', 'gemini', 'AIza1')).toEqual({
      path: '/models?pageSize=1000',
      headers: { Accept: 'application/json', 'x-goog-api-key': 'AIza1' },
    });
    expect(modelsRequest('https://generativelanguage.googleapis.com', 'gemini').path).toBe('/v1beta/models?pageSize=1000');
    expect(modelsRequest('http://localhost:11434', 'ollama')).toEqual({
      path: '/api/tags',
      headers: { Accept: 'application/json' },
    });
    expect(modelsRequest('https://ollama.com', 'ollama', 'k').headers.Authorization).toBe('Bearer k');
    expect(modelsRequest('https://x.example', 'openai-compatible', null).headers).toEqual({ Accept: 'application/json' });
  });
});

describe('parseModels', () => {
  it('accepts {data: [...]} and bare lists for OpenAI-compatible servers', () => {
    expect(parseModels('openai-compatible', { data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }] })).toEqual([
      { id: 'gpt-5', displayName: 'gpt-5', capabilities: {}, source: 'unknown' },
      { id: 'gpt-5-mini', displayName: 'GPT-5 mini', capabilities: {}, source: 'unknown' },
    ]);
    expect(parseModels('openai-compatible', [{ id: 'a' }, 'b', '', 7, null, { id: 'a' }, { name: 'no id' }])).toEqual([
      { id: 'a', displayName: 'a', capabilities: {}, source: 'unknown' },
      { id: 'b', displayName: 'b', capabilities: {}, source: 'unknown' },
    ]);
  });

  it('records vendor capabilities from OpenRouter supported_parameters', () => {
    expect(
      parseModels('openai-compatible', {
        data: [
          { id: 'x/a', supported_parameters: ['tools', 'reasoning'] },
          { id: 'x/b', supported_parameters: ['include_reasoning'] },
          { id: 'x/c', supported_parameters: [] },
        ],
      }),
    ).toEqual([
      { id: 'x/a', displayName: 'x/a', capabilities: { tools: true, reasoning: true }, source: 'vendor' },
      { id: 'x/b', displayName: 'x/b', capabilities: { tools: false, reasoning: true }, source: 'vendor' },
      { id: 'x/c', displayName: 'x/c', capabilities: { tools: false, reasoning: false }, source: 'vendor' },
    ]);
  });

  it('reads Ollama models[].name (falling back to model)', () => {
    expect(parseModels('ollama', { models: [{ name: 'glm-5.3-flash:cloud' }, { model: 'llama3:8b' }, {}] })?.map((m) => m.id)).toEqual([
      'glm-5.3-flash:cloud',
      'llama3:8b',
    ]);
  });

  it('reads Anthropic data[] with display_name', () => {
    expect(parseModels('anthropic', { data: [{ id: 'claude-x', display_name: 'Claude X' }, { type: 'model' }] })).toEqual([
      { id: 'claude-x', displayName: 'Claude X', capabilities: {}, source: 'unknown' },
    ]);
  });

  it('reads Gemini models[], keeping those that generate content', () => {
    expect(
      parseModels('gemini', {
        models: [
          { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-plain' },
          { displayName: 'nameless' },
        ],
      }),
    ).toEqual([
      { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', capabilities: {}, source: 'unknown' },
      { id: 'gemini-plain', displayName: 'gemini-plain', capabilities: {}, source: 'unknown' },
    ]);
  });

  it('returns null when the body is not a model list', () => {
    expect(parseModels('openai-compatible', { error: 'x' })).toBeNull();
    expect(parseModels('ollama', 'text')).toBeNull();
    expect(parseModels('anthropic', null)).toBeNull();
    expect(parseModels('gemini', [{ name: 'models/a' }])).toBeNull();
  });
});

describe('probeModels, direct route', () => {
  it('fetches /models with the key and returns the list', async () => {
    const { fetch, calls } = fakeFetch(200, { data: [{ id: 'gpt-5' }] });
    const result = await probeModels({ ...openai, apiKey: 'sk-proj-1' }, { fetch });
    expect(result).toEqual({ ok: true, models: [{ id: 'gpt-5', displayName: 'gpt-5', capabilities: {}, source: 'unknown' }] });
    expect(calls).toEqual([
      { url: 'https://api.openai.com/v1/models', headers: { Accept: 'application/json', Authorization: 'Bearer sk-proj-1' } },
    ]);
  });

  it('calls Anthropic at /v1/models and Ollama Cloud at /api/tags', async () => {
    const a = fakeFetch(200, { data: [{ id: 'claude-x' }] });
    await probeModels({ baseURL: 'https://api.anthropic.com', kind: 'anthropic', apiKey: 'sk-ant-1' }, { fetch: a.fetch });
    expect(a.calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const o = fakeFetch(200, { models: [{ name: 'gpt-oss:120b' }] });
    const result = await probeModels({ baseURL: 'https://ollama.com', kind: 'ollama', apiKey: 'k' }, { fetch: o.fetch });
    expect(o.calls[0]?.url).toBe('https://ollama.com/api/tags');
    expect(result.ok).toBe(true);
  });

  it.each([
    [401, 'wrong-key', 'OpenAI rejected the key. Check that you pasted the whole key.'],
    [403, 'wrong-key', 'OpenAI rejected the key. Check that you pasted the whole key.'],
    [429, 'rate-limited', 'OpenAI is rate limiting requests. Wait a minute and try again.'],
    [404, 'not-found', 'OpenAI has no model list at this address. Check the base URL.'],
    [503, 'server-error', 'OpenAI answered with an error (HTTP 503). Try again later.'],
    [302, 'server-error', 'OpenAI answered with an error (HTTP 302). Try again later.'],
  ])('maps HTTP %i to %s in one plain sentence', async (status, code, message) => {
    const { fetch } = fakeFetch(status, { error: { message: 'raw vendor json {"x":1}' } });
    expect(await probeModels(openai, { fetch })).toEqual({ ok: false, code, message });
  });

  it('maps Gemini 400 (invalid key) to wrong key', async () => {
    const { fetch } = fakeFetch(400);
    const result = await probeModels(
      { baseURL: 'https://generativelanguage.googleapis.com/v1beta', kind: 'gemini', apiKey: 'AIza' },
      { fetch },
    );
    expect(result).toMatchObject({ ok: false, code: 'wrong-key', message: expect.stringContaining('generativelanguage.googleapis.com') });
  });

  it('reports reachable but no models, with the hint', async () => {
    const { fetch } = fakeFetch(200, { data: [] });
    expect(await probeModels(openai, { fetch })).toEqual({
      ok: false,
      code: 'no-models',
      message: 'OpenAI answered but lists no models. Check the key or the service status.',
    });
  });

  it('reports a body that is not a model list without showing it', async () => {
    const html = fakeFetch(200);
    const r1 = await probeModels(openai, { fetch: html.fetch });
    expect(r1).toEqual({ ok: false, code: 'bad-response', message: 'OpenAI answered, but not with a model list. Check the base URL.' });
    const json = fakeFetch(200, { unexpected: { nested: true } });
    const r2 = await probeModels(openai, { fetch: json.fetch });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).not.toMatch(/[{}]/);
  });

  it('names the provider by its host when it has no name', async () => {
    const { fetch } = fakeFetch(401);
    const result = await probeModels({ baseURL: 'https://llm.example.com:8443/v1', kind: 'openai-compatible', name: ' ' }, { fetch });
    expect(result).toMatchObject({ message: 'llm.example.com:8443 rejected the key. Check that you pasted the whole key.' });
  });

  it('gives the unreachable message when the connection fails', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('Load failed');
    };
    expect(await probeModels(openai, { fetch })).toEqual({
      ok: false,
      code: 'unreachable',
      message: 'OpenAI did not answer within 10 seconds. Check the address and that the server is running.',
    });
  });

  it('gives up after the connect timeout (10 s by default)', async () => {
    vi.useFakeTimers();
    try {
      const pending = probeModels(openai, { fetch: hangingFetch });
      await vi.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: false, code: 'unreachable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a shorter injected timeout', async () => {
    expect(await probeModels(openai, { fetch: hangingFetch, timeoutMs: 5 })).toMatchObject({
      code: 'unreachable',
      message: 'OpenAI did not answer within 1 second. Check the address and that the server is running.',
    });
  });

  it('reports a cancelled test, also when cancelled before it starts', async () => {
    const controller = new AbortController();
    const pending = probeModels(openai, { fetch: hangingFetch, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: 'aborted', message: 'The test was cancelled.' });
    expect(await probeModels(openai, { fetch: hangingFetch, signal: controller.signal })).toMatchObject({ code: 'aborted' });
  });

  it('rejects an invalid base URL without fetching', async () => {
    const { fetch, calls } = fakeFetch(200, []);
    expect(await probeModels({ baseURL: 'ftp://x', kind: 'openai-compatible' }, { fetch })).toMatchObject({ code: 'invalid-url' });
    expect(calls).toEqual([]);
  });

  it('turns a missing fetch for a direct provider into unreachable rather than a crash', async () => {
    expect(await probeModels(openai, {})).toMatchObject({ code: 'unreachable' });
  });
});

describe('probeModels, host route', () => {
  const ollama = { name: 'Ollama', baseURL: 'http://LOCALHOST:11434/', kind: 'ollama' as const, apiKey: 'never-sent' };
  const reply = (r: HostProbeReply): HostProbe => async () => r;

  it('asks the host by base URL and kind, never sends a key and never calls fetch', async () => {
    const { fetch, calls } = fakeFetch(200, []);
    const requests: Parameters<HostProbe>[0][] = [];
    const hostProbe: HostProbe = async (request) => {
      requests.push(request);
      return { models: [{ id: 'llama3.2:3b' }, { id: 'qwen3:4b', displayName: 'Qwen 3' }, { id: 'llama3.2:3b' }, { id: '' }] };
    };
    const result = await probeModels(ollama, { fetch, hostProbe });
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'llama3.2:3b', displayName: 'llama3.2:3b', capabilities: {}, source: 'unknown' },
        { id: 'qwen3:4b', displayName: 'Qwen 3', capabilities: {}, source: 'unknown' },
      ],
    });
    expect(calls).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ baseURL: 'http://localhost:11434', kind: 'ollama' });
    expect(JSON.stringify(requests[0])).not.toContain('never-sent');
  });

  it('maps provider_unavailable reasons to one sentence each', async () => {
    const cases: [HostProbeReply, string, string][] = [
      [{ error: 'provider', reason: 'unauthorized', status: 401 }, 'wrong-key', "Ollama rejected the request. Add its key to your Mac's config.json."],
      [{ error: 'provider', reason: 'rate_limited' }, 'rate-limited', 'Ollama is rate limiting requests. Wait a minute and try again.'],
      [{ error: 'provider', reason: 'rate_limited', retryAfterMs: 41_200 }, 'rate-limited', 'Ollama is rate limiting requests. Try again in 42 s.'],
      [{ error: 'provider', reason: 'unreachable', retryAfterMs: 12_000 }, 'unreachable', 'Ollama did not answer within 10 seconds. Check the address and that the server is running.'],
      [{ error: 'provider', reason: 'timeout' }, 'unreachable', 'Ollama did not answer within 10 seconds. Check the address and that the server is running.'],
      [{ error: 'provider', reason: 'not_found', status: 404 }, 'not-found', 'Ollama has no model list at this address. Check the base URL.'],
      [{ error: 'provider', reason: 'bad_response' }, 'bad-response', 'Ollama answered, but not with a model list. Check the base URL.'],
      [{ error: 'provider', reason: 'upstream', status: 502 }, 'server-error', 'Ollama answered with an error (HTTP 502). Try again later.'],
      [{ error: 'provider', reason: 'something-new' }, 'server-error', 'Ollama answered with an error. Try again later.'],
      [{ error: 'refused' }, 'server-error', 'Your Mac could not ask Ollama for its models. Check the base URL.'],
      [{ error: 'host-unreachable' }, 'host-unavailable', HOST_UNAVAILABLE_MESSAGE],
      [{ models: [] }, 'no-models', 'Ollama answered but lists no models. Check the key or the service status.'],
      [{ models: 'nope' as unknown as [] }, 'no-models', 'Ollama answered but lists no models. Check the key or the service status.'],
    ];
    for (const [r, code, message] of cases) {
      expect(await probeModels(ollama, { hostProbe: reply(r) })).toEqual({ ok: false, code, message });
    }
  });

  it('says the Mac is not reachable when no host is paired', async () => {
    expect(await probeModels(ollama, {})).toEqual({ ok: false, code: 'host-unavailable', message: HOST_UNAVAILABLE_MESSAGE });
  });

  it('treats a host probe that throws as unreachable', async () => {
    const hostProbe: HostProbe = async () => {
      throw new Error('socket closed');
    };
    expect(await probeModels(ollama, { hostProbe })).toMatchObject({ code: 'unreachable' });
  });

  it('reports a cancelled host probe as cancelled', async () => {
    const controller = new AbortController();
    const hostProbe: HostProbe = async ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ error: 'host-unreachable' })));
    const pending = probeModels(ollama, { hostProbe, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ code: 'aborted' });
  });
});
