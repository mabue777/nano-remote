import { afterEach, describe, expect, it } from 'vitest';

import { collect, joined } from '../../../test/chat-doubles';
import { FakeSocket, HostScript, INIT_RESULT, ManualLifecycle } from '../../../test/doubles';
import { exampleMessage } from '../../../test/fixtures';
import { StreamClient } from '../../stream/client';
import { createChatEngine } from './chat';
import { HOST_UNAVAILABLE_MESSAGE } from './errors';
import { hostChat, type HostLink } from './host';
import type { ChatEvent, ChatProvider, ChatTurn } from './types';

const MAC_OLLAMA: ChatProvider = { id: 'p-mac', name: 'Mac Ollama', baseURL: 'http://192.168.1.20:11434', kind: 'ollama' };
const TURNS: ChatTurn[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Why is the sky blue?' },
];

const clients: StreamClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
});

/** A StreamClient on a FakeSocket, handshaken unless told otherwise. */
function connect(ready = true) {
  let socket: FakeSocket | undefined;
  let host: HostScript | undefined;
  const client = new StreamClient({
    clientId: 'dev_test',
    url: 'ws://fake/v1/stream',
    lifecycle: new ManualLifecycle(),
    newStreamId: () => 'stream-1',
    createSocket: (url) => {
      socket = new FakeSocket(url);
      host = new HostScript(socket, 'stream-1');
      return socket;
    },
  });
  clients.push(client);
  client.start();
  if (ready) {
    socket!.open();
    host!.answer('initialize', INIT_RESULT);
  }
  let n = 0;
  const engine = createChatEngine({ keyFor: () => null, host: () => client, requestId: () => `chat-${++n}` });
  return { client, socket: socket!, host: host!, engine };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The protocol example notification (49 to 51) re-addressed to a request id. */
function example(prefix: string, requestId: string) {
  const message = exampleMessage(prefix);
  message.params.requestId = requestId;
  return message;
}

function chatRequests(socket: FakeSocket) {
  return socket.messages.filter((m) => m.method === 'provider/chat');
}

describe('host route (ADR 0006, protocol section 15)', () => {
  it('sends provider/chat with the base URL and options, and maps delta, usage and done to the same events', async () => {
    const { socket, host, engine } = connect();
    const run = collect(engine.chat(MAC_OLLAMA, 'qwen3:4b', TURNS, { thinking: true, temperature: 0.7 }));
    await tick();
    expect(chatRequests(socket)).toHaveLength(1);
    expect(chatRequests(socket)[0].params).toEqual({
      requestId: 'chat-1',
      baseURL: 'http://192.168.1.20:11434',
      kind: 'ollama',
      model: 'qwen3:4b',
      messages: TURNS,
      options: { thinking: true, temperature: 0.7 },
    });
    host.answer('provider/chat', { ok: true });
    host.message(example('49', 'chat-1')); // reasoning "Rayleigh scattering"
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'text', text: 'Short blue light ' } });
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'text', text: 'scatters most.' } });
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'text', text: '' } });
    host.message(example('50', 'chat-1')); // usage 21 / 143
    host.message({ method: 'provider/done', params: { requestId: 'chat-1', status: 'completed' } });
    const events = await run;
    expect(events).toEqual([
      { type: 'reasoning', text: 'Rayleigh scattering' },
      { type: 'text', text: 'Short blue light ' },
      { type: 'text', text: 'scatters most.' },
      { type: 'usage', inputTokens: 21, outputTokens: 143 },
      { type: 'done', status: 'completed' },
    ]);
  });

  it('ignores notifications for other chats on the same stream', async () => {
    const { host, engine } = connect();
    const run = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.message({ method: 'provider/delta', params: { requestId: 'other', kind: 'text', text: 'not mine' } });
    host.message({ method: 'provider/usage', params: { requestId: 'other', inputTokens: 1 } });
    host.message({ method: 'provider/done', params: { requestId: 'other', status: 'completed' } });
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'text', text: 'mine' } });
    host.message({ method: 'provider/usage', params: { requestId: 'chat-1' } });
    host.message({ method: 'provider/done', params: { requestId: 'chat-1', status: 'completed' } });
    expect(await run).toEqual([{ type: 'text', text: 'mine' }, { type: 'usage' }, { type: 'done', status: 'completed' }]);
  });

  it('maps a failed done to one sentence, keeping the host error as detail and retryAfterMs', async () => {
    const { host, engine } = connect();
    const run = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.message(example('51', 'chat-1')); // failed, rate_limited, 429, retryAfterMs 60000
    expect(await run).toEqual([
      {
        type: 'error',
        reason: 'rate_limited',
        message: 'Mac Ollama is rate limiting requests. Try again in 60 s.',
        detail: 'upstream answered 429',
        status: 429,
        retryAfterMs: 60_000,
      },
    ]);
  });

  it('maps an unknown or missing failure reason to upstream, and a done(aborted) from the host to aborted', async () => {
    const { host, engine } = connect();
    const first = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.message({ method: 'provider/done', params: { requestId: 'chat-1', status: 'failed', error: { reason: 'weird', message: 'x' } } });
    expect(await first).toMatchObject([{ type: 'error', reason: 'upstream', detail: 'x' }]);
    const second = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.message({ method: 'provider/done', params: { requestId: 'chat-2', status: 'failed' } });
    expect(await second).toMatchObject([{ type: 'error', reason: 'upstream' }]);
    const third = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.message({ method: 'provider/done', params: { requestId: 'chat-3', status: 'aborted' } });
    expect(await third).toEqual([{ type: 'done', status: 'aborted' }]);
  });

  it('sends provider/abort when the signal aborts, keeps what streamed, and ends with done(aborted) at once', async () => {
    const { socket, host, engine } = connect();
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    const run = (async () => {
      for await (const event of engine.chat(MAC_OLLAMA, 'm', TURNS, {}, controller.signal)) events.push(event);
    })();
    await tick();
    host.answer('provider/chat', { ok: true });
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'text', text: 'partial' } });
    await tick();
    controller.abort();
    await run;
    expect(events).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'done', status: 'aborted' },
    ]);
    expect(socket.messages.filter((m) => m.method === 'provider/abort').map((m) => m.params)).toEqual([{ requestId: 'chat-1' }]);
    // The host's own done(aborted) arrives later and changes nothing.
    host.message({ method: 'provider/done', params: { requestId: 'chat-1', status: 'aborted' } });
    expect(events).toHaveLength(2);
  });

  it('sends provider/abort when the consumer stops reading early', async () => {
    const { socket, host, engine } = connect();
    const run = (async () => {
      for await (const event of engine.chat(MAC_OLLAMA, 'm', TURNS)) if (event.type === 'text') break;
    })();
    await tick();
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'text', text: 'enough' } });
    await run;
    expect(socket.messages.filter((m) => m.method === 'provider/abort')).toHaveLength(1);
  });

  it('answers done(aborted) without a request when the signal is already aborted', async () => {
    const { socket, engine } = connect();
    expect(await collect(engine.chat(MAC_OLLAMA, 'm', TURNS, {}, AbortSignal.abort()))).toEqual([{ type: 'done', status: 'aborted' }]);
    expect(chatRequests(socket)).toHaveLength(0);
  });

  it('fails fast with the one sentence when no stream to the Mac is open', async () => {
    const { socket, engine } = connect(false);
    const events = await collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    expect(events).toEqual([{ type: 'error', reason: 'host_unavailable', message: 'Your Mac is not reachable; this provider runs through it.' }]);
    expect(chatRequests(socket)).toHaveLength(0);
  });

  it('fails fast the same way when the phone is not paired', async () => {
    const engine = createChatEngine({ keyFor: () => null, host: () => null });
    expect(await collect(engine.chat(MAC_OLLAMA, 'm', TURNS))).toEqual([
      { type: 'error', reason: 'host_unavailable', message: HOST_UNAVAILABLE_MESSAGE },
    ]);
  });

  it('ends with host_unavailable when the stream closes mid-chat (the host sends no done then)', async () => {
    const { socket, host, engine } = connect();
    const run = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.message({ method: 'provider/delta', params: { requestId: 'chat-1', kind: 'reasoning', text: 'hmm' } });
    socket.serverClose(1006);
    const events = await run;
    expect(joined(events, 'reasoning')).toBe('hmm');
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'host_unavailable', message: HOST_UNAVAILABLE_MESSAGE });
  });

  it('maps a rejected provider/chat request: host errors to sentences, a lost connection to host_unavailable', async () => {
    const { host, engine } = connect();
    const invalid = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.fail('provider/chat', { code: 'invalid_params', message: 'duplicate requestId' });
    expect(await invalid).toMatchObject([{ type: 'error', reason: 'upstream', detail: 'duplicate requestId' }]);

    const unknown = collect(engine.chat({ ...MAC_OLLAMA, baseURL: 'http://mac.local:1234/v1', kind: 'openai-compatible' }, 'm', TURNS));
    await tick();
    host.fail('provider/chat', { code: 'not_found', message: 'no provider' });
    expect(await unknown).toMatchObject([{ type: 'error', reason: 'not_found' }]);

    const unavailable = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.fail('provider/chat', {
      code: 'provider_unavailable',
      message: 'cooling down',
      data: { reason: 'unreachable', message: 'cooling down', retryAfterMs: 12_000 },
    });
    expect(await unavailable).toMatchObject([{ type: 'error', reason: 'unreachable', retryAfterMs: 12_000 }]);

    const plain = collect(engine.chat(MAC_OLLAMA, 'm', TURNS));
    await tick();
    host.fail('provider/chat', { code: 'provider_unavailable', message: 'down', data: { reason: 'unauthorized', message: 'down' } });
    expect(await plain).toMatchObject([{ type: 'error', reason: 'unauthorized' }]);
  });

  it('maps a request the stream client gives up on to host_unavailable', async () => {
    const link: HostLink = {
      state: 'ready',
      request: () => Promise.reject(Object.assign(new Error('provider/chat got no response'), { code: 'timeout' })),
      onNotification: () => () => undefined,
      on: () => () => undefined,
    };
    const events = await collect(hostChat(MAC_OLLAMA, 'm', TURNS, {}, undefined, { host: link }));
    expect(events).toMatchObject([{ type: 'error', reason: 'host_unavailable', detail: 'provider/chat got no response' }]);
    const odd: HostLink = { ...link, request: () => Promise.reject('boom') };
    expect(await collect(hostChat(MAC_OLLAMA, 'm', TURNS, {}, undefined, { host: odd }))).toMatchObject([{ reason: 'upstream', detail: 'boom' }]);
  });

  it('omits kind for a kind the host does not speak, omits empty options, and passes maxTokens', async () => {
    const { socket, host, engine } = connect();
    const gemini: ChatProvider = { id: 'g', name: 'G', baseURL: 'http://10.0.0.5:8080/v1beta', kind: 'gemini' };
    const a = collect(engine.chat(gemini, 'm', TURNS));
    await tick();
    host.message({ method: 'provider/done', params: { requestId: 'chat-1', status: 'completed' } });
    await a;
    const b = collect(engine.chat(MAC_OLLAMA, 'm', TURNS, { maxTokens: 64, thinking: false }));
    await tick();
    host.message({ method: 'provider/done', params: { requestId: 'chat-2', status: 'completed' } });
    await b;
    const [first, second] = chatRequests(socket).map((m) => m.params);
    expect(first.kind).toBeUndefined();
    expect(first.options).toBeUndefined();
    expect(second.options).toEqual({ maxTokens: 64, thinking: false });
  });

  it('uses a random request id by default', async () => {
    const { client, socket, host } = connect();
    const run = collect(hostChat(MAC_OLLAMA, 'm', TURNS, {}, undefined, { host: client }));
    await tick();
    const requestId = chatRequests(socket)[0].params.requestId as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    host.message({ method: 'provider/done', params: { requestId, status: 'completed' } });
    expect(await run).toEqual([{ type: 'done', status: 'completed' }]);
  });
});
