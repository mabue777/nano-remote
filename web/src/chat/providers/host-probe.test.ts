import { describe, expect, it, vi } from 'vitest';

import type { ClientState } from '../../stream/client';
import { createHostProbe, hostAvailable, replyForError, type HostRequester } from './host-probe';
import { HOST_UNAVAILABLE_MESSAGE, probeModels } from './probe';

function fakeHost(state: ClientState, answer: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const request = vi.fn(answer);
  const host = { state, request } as unknown as HostRequester & { state: ClientState };
  return { host, request };
}

const signal = () => new AbortController().signal;

describe('createHostProbe', () => {
  it('asks provider/models with the base URL and the kind, and passes the list through', async () => {
    const { host, request } = fakeHost('ready', async () => ({ models: [{ id: 'llama3.2:1b' }] }));
    const probe = createHostProbe(() => host);
    expect(await probe({ baseURL: 'http://127.0.0.1:11434', kind: 'ollama', signal: signal() })).toEqual({ models: [{ id: 'llama3.2:1b' }] });
    expect(request).toHaveBeenCalledWith('provider/models', { baseURL: 'http://127.0.0.1:11434', kind: 'ollama' });
  });

  it('leaves the kind to the host for gemini, and reads a result without models as empty', async () => {
    const { host, request } = fakeHost('connecting', async () => ({}));
    expect(await createHostProbe(() => host)({ baseURL: 'http://10.0.0.2:8080', kind: 'gemini', signal: signal() })).toEqual({ models: [] });
    expect(request).toHaveBeenCalledWith('provider/models', { baseURL: 'http://10.0.0.2:8080' });
  });

  it('answers host-unreachable without a host, or with a stopped client', async () => {
    expect(await createHostProbe(() => null)({ baseURL: 'http://a:1', kind: 'ollama', signal: signal() })).toEqual({ error: 'host-unreachable' });
    const { host, request } = fakeHost('unpaired', async () => ({}));
    expect(await createHostProbe(() => host)({ baseURL: 'http://a:1', kind: 'ollama', signal: signal() })).toEqual({ error: 'host-unreachable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('maps a rejected request through replyForError', async () => {
    const { host } = fakeHost('ready', async () => {
      throw { code: 'provider_unavailable', message: 'nope', data: { reason: 'unauthorized', status: 401 } };
    });
    expect(await createHostProbe(() => host)({ baseURL: 'http://a:1', kind: 'ollama', signal: signal() })).toEqual({
      error: 'provider',
      reason: 'unauthorized',
      status: 401,
    });
  });

  it('on abort: the Mac is away while the stream is down, else the probe decides', async () => {
    const down = fakeHost('waiting', () => new Promise(() => undefined));
    const c1 = new AbortController();
    const pending = createHostProbe(() => down.host)({ baseURL: 'http://a:1', kind: 'ollama', signal: c1.signal });
    c1.abort();
    expect(await pending).toEqual({ error: 'host-unreachable' });

    const up = fakeHost('ready', () => new Promise(() => undefined));
    const c2 = new AbortController();
    c2.abort();
    await expect(createHostProbe(() => up.host)({ baseURL: 'http://a:1', kind: 'ollama', signal: c2.signal })).rejects.toThrow('aborted');
  });

  it('gives the probe its sentences end to end, timing out into the Mac-away sentence while reconnecting', async () => {
    const { host } = fakeHost('waiting', () => new Promise(() => undefined));
    const result = await probeModels({ name: 'Mac Ollama', baseURL: 'http://192.168.1.5:11434', kind: 'ollama' }, { hostProbe: createHostProbe(() => host), timeoutMs: 5 });
    expect(result).toEqual({ ok: false, code: 'host-unavailable', message: HOST_UNAVAILABLE_MESSAGE });
    const ready = fakeHost('ready', () => new Promise(() => undefined));
    const slow = await probeModels({ name: 'Mac Ollama', baseURL: 'http://192.168.1.5:11434', kind: 'ollama' }, { hostProbe: createHostProbe(() => ready.host), timeoutMs: 5 });
    expect(slow).toMatchObject({ ok: false, code: 'unreachable' });
  });
});

describe('replyForError', () => {
  it('maps stream failures, provider failures and anything else', () => {
    expect(replyForError({ code: 'connection_lost' })).toEqual({ error: 'host-unreachable' });
    expect(replyForError({ code: 'timeout' })).toEqual({ error: 'host-unreachable' });
    expect(replyForError({ code: 'provider_unavailable', data: { reason: 'rate_limited', retryAfterMs: 3000 } })).toEqual({
      error: 'provider',
      reason: 'rate_limited',
      retryAfterMs: 3000,
    });
    expect(replyForError({ code: 'provider_unavailable', data: {} })).toEqual({ error: 'refused' });
    expect(replyForError({ code: 'invalid_params' })).toEqual({ error: 'refused' });
    expect(replyForError(null)).toEqual({ error: 'refused' });
  });

  it('hostAvailable is true only for a client that can still reach the host', () => {
    expect(hostAvailable(null)).toBe(false);
    expect(hostAvailable(fakeHost('ready', async () => ({})).host)).toBe(true);
    expect(hostAvailable(fakeHost('suspended', async () => ({})).host)).toBe(true);
    expect(hostAvailable(fakeHost('idle', async () => ({})).host)).toBe(false);
    expect(hostAvailable(fakeHost('stopped', async () => ({})).host)).toBe(false);
  });
});
