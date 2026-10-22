// The provider methods end to end: a real StreamServer and TestClients on loopback, the relay against a
// fake provider. Checks the response-then-notifications order, that notifications reach only the asking
// stream, params errors, provider_unavailable, abort, and that closing a stream cancels its chats.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_MESSAGE_BYTES } from '../stream/constants.js';
import { MethodRegistry } from '../stream/router.js';
import { StreamServer } from '../stream/server.js';
import { TestClient } from '../stream/testing/client.js';
import { registerProviderMethods } from './methods.js';
import { ProviderRelay } from './relay.js';
import { FakeProvider, json, silent, stream } from './testing/fake-provider.js';

const DEVICES: Record<string, string> = { 'good-token': 'dev_test', 'other-token': 'dev_other' };

let fake: FakeProvider;
let server: StreamServer;
let logged: Record<string, unknown>[];
const clients: TestClient[] = [];

beforeEach(async () => {
  fake = await FakeProvider.start();
  logged = [];
  const relay = new ProviderRelay({
    providers: [
      { id: 'mac', name: 'Ollama on this Mac', baseURL: fake.url },
      { id: 'lab', name: 'Lab', baseURL: `${fake.url}/v1`, apiKey: 'sk-lab-secret' },
    ],
    http: { backoffBaseMs: 1, backoffMaxMs: 2 },
    firstTokenTimeoutMs: 2_000,
  });
  const registry = registerProviderMethods(
    new MethodRegistry().register('initialize', (_params, context) => ({
      protocolVersion: 1,
      host: { hostId: 'host_test', name: 'test', version: '0', os: 'darwin', arch: 'arm64' },
      device: { clientId: context.clientId, displayName: 'Test' },
      agents: [],
      push: { vapidPublicKey: 'k', subscribed: false },
      limits: { maxMessageBytes: MAX_MESSAGE_BYTES, snapshotTurns: 5 },
    })),
    {
      relay,
      notify: (streamId, method, params) => server.notifyStream(streamId, method, params),
      discover: async () => [{ baseURL: 'http://127.0.0.1:11434', kind: 'ollama' }],
      log: (event, fields) => logged.push({ event, ...fields }),
    },
  );
  server = new StreamServer({ authenticate: (token) => DEVICES[token] ?? null, registry });
  await server.listen();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server.close();
  await fake.close();
});

async function connect(token = 'good-token'): Promise<TestClient> {
  const client = await TestClient.connect(server.url, { token, clientId: DEVICES[token] });
  clients.push(client);
  await client.handshake();
  await client.call('provider/list'); // `initialized` has been processed: notifications flow
  return client;
}

const notes = (client: TestClient, requestId: string, method?: string) =>
  client.messages.filter((m) => (method === undefined ? String(m.method).startsWith('provider/') : m.method === method) && (m.params as { requestId?: string })?.requestId === requestId);

const done = (client: TestClient, requestId: string) =>
  client.until(() => notes(client, requestId, 'provider/done')[0]?.params as Record<string, unknown> | undefined, `provider/done ${requestId}`);

const chatParams = (requestId: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  providerId: 'mac',
  kind: 'ollama',
  model: 'qwen3:4b',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
  ...extra,
});

describe('provider methods over a stream', () => {
  it('provider/list never carries a key', async () => {
    const phone = await connect();
    const response = await phone.call('provider/list');
    expect(response.result).toEqual({
      providers: [
        { id: 'mac', name: 'Ollama on this Mac', baseURL: fake.url, kind: 'openai-compatible', hasKey: false },
        { id: 'lab', name: 'Lab', baseURL: `${fake.url}/v1`, kind: 'openai-compatible', hasKey: true },
      ],
    });
    expect(JSON.stringify(phone.frames)).not.toContain('sk-lab-secret');
  });

  it('provider/chat answers ok, then deltas, usage and done to the asking stream only', async () => {
    fake.on(
      'POST /api/chat',
      stream('ndjson', [
        { message: { content: '', thinking: 'Scattering.' } },
        { message: { content: 'Rayleigh ' } },
        { message: { content: 'scattering.' } },
        { done: true, prompt_eval_count: 11, eval_count: 4 },
      ]),
    );
    const phone = await connect();
    const other = await connect('other-token');
    const id = phone.request('provider/chat', chatParams('r1', { options: { thinking: true, temperature: 0.4, maxTokens: 50 } }));
    const final = await done(phone, 'r1');
    expect(final).toEqual({ requestId: 'r1', status: 'completed' });

    const sequence = phone.messages.filter((m) => m.id === id || String(m.method).startsWith('provider/'));
    expect(sequence.map((m) => m.method ?? 'response')).toEqual([
      'response',
      'provider/delta',
      'provider/delta',
      'provider/delta',
      'provider/usage',
      'provider/done',
    ]);
    expect(sequence[0]).toMatchObject({ result: { ok: true } });
    expect(notes(phone, 'r1', 'provider/delta').map((m) => m.params)).toEqual([
      { requestId: 'r1', kind: 'reasoning', text: 'Scattering.' },
      { requestId: 'r1', kind: 'text', text: 'Rayleigh ' },
      { requestId: 'r1', kind: 'text', text: 'scattering.' },
    ]);
    expect(notes(phone, 'r1', 'provider/usage')[0]!.params).toEqual({ requestId: 'r1', inputTokens: 11, outputTokens: 4 });
    expect(notes(other, 'r1')).toEqual([]);
    expect(JSON.parse(fake.to('/api/chat')[0]!.body)).toMatchObject({ think: true, options: { temperature: 0.4, num_predict: 50 } });
    expect(logged).toEqual([
      { event: 'provider.chat', origin: fake.url, kind: 'ollama', model: 'qwen3:4b', status: 'completed', ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(logged)).not.toContain('sky');
  });

  it('a failed chat ends with done failed and the reason', async () => {
    fake.on('POST /v1/chat/completions', json(401, { error: 'invalid key' }));
    const phone = await connect();
    await phone.call('provider/chat', chatParams('r2', { providerId: 'lab', kind: undefined }));
    expect(await done(phone, 'r2')).toMatchObject({ requestId: 'r2', status: 'failed', error: { reason: 'unauthorized', status: 401 } });
    expect(fake.to('/v1/chat/completions')[0]!.headers.authorization).toBe('Bearer sk-lab-secret');
    expect(logged[0]).toMatchObject({ status: 'failed', reason: 'unauthorized' });
  });

  it('provider/abort cancels a running chat; aborting again or an unknown id is ok', async () => {
    fake.on('POST /api/chat', stream('ndjson', Array.from({ length: 500 }, () => ({ message: { content: 'x' } })), { delayMs: 10 }));
    const phone = await connect();
    await phone.call('provider/chat', chatParams('r3'));
    await phone.until(() => notes(phone, 'r3', 'provider/delta').length >= 2, 'deltas');
    expect(await phone.call('provider/abort', { requestId: 'r3' })).toMatchObject({ result: { ok: true } });
    expect(await done(phone, 'r3')).toEqual({ requestId: 'r3', status: 'aborted' });
    expect(await phone.call('provider/abort', { requestId: 'r3' })).toMatchObject({ result: { ok: true } });
    expect(await phone.call('provider/abort', { requestId: 'never' })).toMatchObject({ result: { ok: true } });
    await phone.until(() => fake.aborted === 1, 'the upstream hang-up');
  });

  it('another stream cannot abort my chat', async () => {
    fake.on('POST /api/chat', stream('ndjson', [{ message: { content: 'a' } }, { done: true }], { delayMs: 100 }));
    const phone = await connect();
    const other = await connect('other-token');
    await phone.call('provider/chat', chatParams('r4'));
    await other.call('provider/abort', { requestId: 'r4' });
    expect(await done(phone, 'r4')).toEqual({ requestId: 'r4', status: 'completed' });
  });

  it('closing the stream cancels its chats upstream', async () => {
    fake.on('POST /api/chat', silent());
    const phone = await connect();
    await phone.call('provider/chat', chatParams('r5'));
    await phone.until(() => fake.to('/api/chat').length === 1, 'the upstream request');
    phone.close();
    await phone.until(() => fake.aborted === 1, 'the upstream hang-up').catch(async () => {
      // until() rejects on a closed socket; poll the fake directly.
      for (let i = 0; i < 200 && fake.aborted === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fake.aborted).toBe(1);
  });

  it('a requestId already running on this stream is invalid_params; the same id on another stream is fine', async () => {
    fake.on('POST /api/chat', stream('ndjson', [{ message: { content: 'a' } }, { done: true }], { delayMs: 150 }));
    const phone = await connect();
    const other = await connect('other-token');
    await phone.call('provider/chat', chatParams('dup'));
    expect(await phone.call('provider/chat', chatParams('dup'))).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'params.requestId' } },
    });
    expect(await other.call('provider/chat', chatParams('dup'))).toMatchObject({ result: { ok: true } });
    await done(phone, 'dup');
    await done(other, 'dup');
    // Finished: the id may be used again.
    expect(await phone.call('provider/chat', chatParams('dup'))).toMatchObject({ result: { ok: true } });
    await phone.until(() => notes(phone, 'dup', 'provider/done').length === 2, 'the second done');
  });

  it('checks params and names the field', async () => {
    const phone = await connect();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...chatParams('p'), requestId: '' }, 'params.requestId'],
      [{ ...chatParams('p'), model: 7 }, 'params.model'],
      [{ ...chatParams('p'), messages: [] }, 'params.messages'],
      [{ ...chatParams('p'), messages: [{ role: 'tool', content: 'x' }] }, 'params.messages.0'],
      [{ ...chatParams('p'), messages: ['hi'] }, 'params.messages.0'],
      [{ ...chatParams('p'), kind: 'gemini' }, 'params.kind'],
      [{ ...chatParams('p'), providerId: undefined }, 'params.providerId'],
      [{ ...chatParams('p'), options: 'fast' }, 'params.options'],
      [{ ...chatParams('p'), options: { temperature: -1 } }, 'params.options.temperature'],
      [{ ...chatParams('p'), options: { maxTokens: 1.5 } }, 'params.options.maxTokens'],
      [{ ...chatParams('p'), options: { thinking: 'yes' } }, 'params.options.thinking'],
      [{ ...chatParams('p'), providerId: undefined, baseURL: 'https://api.openai.com/v1' }, 'params.baseURL'],
    ];
    for (const [params, path] of cases) {
      expect(await phone.call('provider/chat', params), path).toMatchObject({ error: { code: 'invalid_params', data: { path } } });
    }
    expect(await phone.call('provider/chat', { ...chatParams('p'), providerId: 'ghost' })).toMatchObject({ error: { code: 'not_found' } });
    expect(await phone.call('provider/abort', {})).toMatchObject({ error: { code: 'invalid_params', data: { path: 'params.requestId' } } });
    expect(fake.requests).toHaveLength(0);
  });

  it('provider/models returns the list, or provider_unavailable with the reason', async () => {
    fake.on('GET /api/tags', json(200, { models: [{ name: 'qwen3:4b' }] }), json(403, {}));
    const phone = await connect();
    expect(await phone.call('provider/models', { baseURL: fake.url, kind: 'ollama' })).toMatchObject({ result: { models: [{ id: 'qwen3:4b' }] } });
    expect(await phone.call('provider/models', { providerId: 'mac', kind: 'ollama' })).toMatchObject({
      error: { code: 'provider_unavailable', data: { reason: 'unauthorized', status: 403 } },
    });
    expect(await phone.call('provider/models', { providerId: 'nope' })).toMatchObject({ error: { code: 'not_found' } });
  });

  it('provider/discover returns the candidates', async () => {
    const phone = await connect();
    expect(await phone.call('provider/discover')).toMatchObject({ result: { candidates: [{ baseURL: 'http://127.0.0.1:11434', kind: 'ollama' }] } });
  });
});
