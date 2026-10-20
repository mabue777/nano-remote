import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage } from '../../test/replica-doubles';
import { DEVICE_STORAGE_KEY, forgetDevice, loadDevice, saveDevice } from './device';
import {
  codeFromHash,
  defaultDeviceName,
  failureText,
  normalizeCode,
  PairModel,
  platformOf,
  redeemCode,
  type FetchLike,
} from './pair-model';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => (body === undefined ? Promise.reject(new SyntaxError('no json')) : Promise.resolve(body)),
  };
}

const PAIRED = { clientId: 'dev_8f3a9c21', deviceToken: 'never-kept', host: { hostId: 'host_1', name: 'mabue-mbp' } };

describe('pairing helpers', () => {
  it.each([
    ['#code=12345678', '12345678'],
    ['code=12345678', '12345678'],
    ['#code=1234%205678', '12345678'],
    ['#other=1&code=87654321', '87654321'],
    ['', ''],
    ['#code=', ''],
  ])('codeFromHash(%j)', (hash, code) => {
    expect(codeFromHash(hash)).toBe(code);
  });

  it('normalizeCode keeps at most eight digits', () => {
    expect(normalizeCode('12-34 56 78 9')).toBe('12345678');
  });

  it.each([
    [IPHONE_SAFARI, 'iPhone (Safari)', 'ios-web'],
    [IPHONE_CHROME, 'iPhone (Chrome)', 'ios-web'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1', 'iPad (Safari)', 'ios-web'],
    [ANDROID_CHROME, 'Android (Chrome)', 'android-web'],
    [MAC_FIREFOX, 'Mac (Firefox)', 'web'],
    [WINDOWS_EDGE, 'Windows (Edge)', 'web'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux', 'web'],
    ['SomeBot Chrome/1', 'Chrome', 'web'],
    ['', 'Web browser', 'web'],
  ])('%s → %s', (ua, name, platform) => {
    expect(defaultDeviceName(ua)).toBe(name);
    expect(platformOf(ua)).toBe(platform);
  });
});

describe('redeemCode (POST /v1/pair)', () => {
  it('posts JSON with the code and client, same-origin credentials, and keeps only the clientId', async () => {
    const fetcher = vi.fn<FetchLike>(async () => response(200, PAIRED));
    const outcome = await redeemCode(fetcher, { code: '12345678', name: 'My phone', userAgent: IPHONE_SAFARI });
    expect(outcome).toEqual({ ok: true, device: { clientId: 'dev_8f3a9c21', hostName: 'mabue-mbp' } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/v1/pair');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ code: '12345678', client: { name: 'My phone', platform: 'ios-web', userAgent: IPHONE_SAFARI } });
    expect(JSON.stringify(outcome)).not.toContain('never-kept');
  });

  it('maps failures: 403 bad code, 429 with body or header wait, 400/415 invalid, 5xx, network, bad bodies', async () => {
    const run = (r: ReturnType<typeof response> | Error) =>
      redeemCode(async () => {
        if (r instanceof Error) throw r;
        return r;
      }, { code: '1', name: 'n', userAgent: '' });
    expect(await run(response(403, { error: { code: 'unauthorized', message: 'pairing code is wrong, expired or used' } }))).toEqual({
      ok: false,
      failure: { kind: 'bad_code' },
    });
    expect(await run(response(429, { error: { code: 'rate_limited', message: '', data: { retryAfterMs: 42_000 } } }))).toEqual({
      ok: false,
      failure: { kind: 'rate_limited', retryAfterMs: 42_000 },
    });
    expect(await run(response(429, {}, { 'retry-after': '30' }))).toMatchObject({ failure: { retryAfterMs: 30_000 } });
    expect(await run(response(429, undefined))).toMatchObject({ failure: { retryAfterMs: 60_000 } });
    expect(await run(response(400, { error: { code: 'invalid_params', message: 'client.name must be a non-empty string' } }))).toEqual({
      ok: false,
      failure: { kind: 'invalid', message: 'client.name must be a non-empty string' },
    });
    expect(await run(response(415, {}))).toEqual({ ok: false, failure: { kind: 'invalid', message: '' } });
    expect(await run(response(500, { error: { message: 'boom' } }))).toEqual({ ok: false, failure: { kind: 'server', status: 500, message: 'boom' } });
    expect(await run(new TypeError('Failed to fetch'))).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(await run(response(200, { host: {} }))).toMatchObject({ ok: false, failure: { kind: 'server' } });
    expect(await run(response(200, { clientId: 'dev_x' }))).toEqual({ ok: true, device: { clientId: 'dev_x', hostName: '' } });
  });

  it('failureText names every cause, including all three for a bad code', () => {
    const bad = failureText({ kind: 'bad_code' });
    expect(bad).toMatch(/wrong/);
    expect(bad).toMatch(/expired/);
    expect(bad).toMatch(/already used/);
    expect(failureText({ kind: 'rate_limited', retryAfterMs: 1500 })).toContain('2 s');
    expect(failureText({ kind: 'invalid', message: 'x' })).toContain(': x');
    expect(failureText({ kind: 'invalid', message: '' })).toMatch(/refused the request\.$/);
    expect(failureText({ kind: 'network' })).toMatch(/Cannot reach/);
    expect(failureText({ kind: 'server', status: 502, message: '' })).toContain('(502).');
    expect(failureText({ kind: 'server', status: 500, message: 'm' })).toContain('(500): m');
  });
});

describe('device storage (nothing secret)', () => {
  it('saves, loads and forgets the clientId and host name; tolerates junk and missing storage', () => {
    const storage = new MemoryStorage();
    expect(loadDevice(storage)).toBeNull();
    saveDevice(storage, { clientId: 'dev_1', hostName: 'mbp' });
    expect(loadDevice(storage)).toEqual({ clientId: 'dev_1', hostName: 'mbp' });
    forgetDevice(storage);
    expect(loadDevice(storage)).toBeNull();
    storage.setItem(DEVICE_STORAGE_KEY, '{nope');
    expect(loadDevice(storage)).toBeNull();
    storage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ clientId: '' }));
    expect(loadDevice(storage)).toBeNull();
    storage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ clientId: 'dev_2', hostName: 7 }));
    expect(loadDevice(storage)).toEqual({ clientId: 'dev_2', hostName: '' });
    expect(loadDevice(null)).toBeNull();
    saveDevice(null, { clientId: 'x', hostName: '' });
    forgetDevice(null);
    const full = new MemoryStorage();
    full.failWhenLongerThan = 0;
    expect(() => saveDevice(full, { clientId: 'x', hostName: '' })).not.toThrow();
    const broken = { getItem: () => null, setItem: () => undefined, removeItem: () => { throw new Error('blocked'); } };
    expect(() => forgetDevice(broken)).not.toThrow();
  });
});

describe('PairModel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(hash: string, answers: ReturnType<typeof response>[]) {
    const storage = new MemoryStorage();
    const onPaired = vi.fn();
    const fetcher = vi.fn<FetchLike>(async () => {
      const next = answers.shift();
      if (next === undefined) throw new TypeError('Failed to fetch'); // the host is unreachable
      return next;
    });
    const model = new PairModel({ hash, userAgent: IPHONE_SAFARI, fetch: fetcher, storage, onPaired });
    const changes = vi.fn();
    model.subscribe(changes);
    return { model, storage, onPaired, fetcher, changes };
  }

  it('takes the code from the link and a default name, pairs, stores only the clientId and goes on', async () => {
    const { model, storage, onPaired, changes } = setup('#code=12345678', [response(200, PAIRED)]);
    expect(model.code).toBe('12345678');
    expect(model.codeFromLink).toBe(true);
    expect(model.name).toBe('iPhone (Safari)');
    expect(model.canSubmit).toBe(true);
    const done = model.submit();
    expect(model.phase).toBe('pairing');
    expect(model.canSubmit).toBe(false);
    expect(await done).toBe(true);
    expect(model.phase).toBe('paired');
    expect(onPaired).toHaveBeenCalledWith({ clientId: 'dev_8f3a9c21', hostName: 'mabue-mbp' });
    expect(loadDevice(storage)).toEqual({ clientId: 'dev_8f3a9c21', hostName: 'mabue-mbp' });
    expect([...storage.data.values()].join()).not.toContain('never-kept');
    expect(changes).toHaveBeenCalled();
  });

  it('a bad code shows the combined message, clears the code, and a retry with a new code works', async () => {
    const { model, onPaired, fetcher } = setup('#code=11111111', [response(403, { error: { code: 'unauthorized' } }), response(200, PAIRED)]);
    expect(await model.submit()).toBe(false);
    expect(model.phase).toBe('editing');
    expect(model.errorText).toMatch(/wrong, expired .* or already used/);
    expect(model.code).toBe('');
    expect(model.canSubmit).toBe(false);
    model.setCode('2222 3333');
    expect(model.code).toBe('22223333');
    expect(await model.submit()).toBe(true);
    expect(model.errorText).toBeUndefined();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).code).toBe('22223333');
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('a network failure keeps the code for a retry', async () => {
    const { model } = setup('#code=12345678', []);
    model.setName('  Work phone ');
    // no answer queued: the fetch fails the way it does offline
    expect(await model.submit()).toBe(false);
    expect(model.code).toBe('12345678');
    expect(model.canSubmit).toBe(true);
  });

  it('rate limited: the button stays off until the wait is over', async () => {
    const { model, changes } = setup('#code=12345678', [response(429, { error: { data: { retryAfterMs: 5000 } } })]);
    expect(await model.submit()).toBe(false);
    expect(model.failure).toEqual({ kind: 'rate_limited', retryAfterMs: 5000 });
    expect(model.canSubmit).toBe(false);
    const before = changes.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(changes.mock.calls.length).toBe(before + 1);
    expect(model.canSubmit).toBe(true);
  });

  it('needs a complete code and a name; no link code means typing it', async () => {
    const { model, fetcher } = setup('', []);
    expect(model.codeFromLink).toBe(false);
    expect(await model.submit()).toBe(false);
    model.setCode('1234567');
    expect(model.canSubmit).toBe(false);
    model.setCode('12345678');
    model.setName('   ');
    expect(model.canSubmit).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
