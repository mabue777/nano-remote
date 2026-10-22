import net, { type AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_PAYLOAD_BYTES, MAX_REASON_CHARS, PushSender, refusalReason, topicHeader, type SendLogFields } from './sender.js';
import { decrypt, FakePushService, newReceiver, type Receiver } from './testing/web-push.js';
import { generateVapidKeys } from './vapid.js';
import { VapidSigner } from './vapid-jwt.js';

let service: FakePushService;
let receiver: Receiver;
let logs: SendLogFields[];

beforeEach(async () => {
  service = await FakePushService.start();
  receiver = newReceiver();
  logs = [];
});

afterEach(async () => {
  await service.close();
});

const keys = generateVapidKeys();
const sender = (timeoutMs?: number) =>
  new PushSender({ signer: new VapidSigner({ keys }), log: (fields) => logs.push(fields), ...(timeoutMs ? { timeoutMs } : {}) });
const payload = { title: 'mabue-mbp', body: 'Codex wants to run a command', url: '/session/s1' };

describe('push sender', () => {
  it('201: POSTs the encrypted payload with the Web Push headers and reports delivered', async () => {
    const subscription = { endpoint: service.endpoint('SECRET-ENDPOINT'), keys: receiver.keys };
    const result = await sender().send('dev_phone', subscription, { ...payload, extra: 'dropped' } as typeof payload, {
      ttl: 60,
      topic: 'req_123',
    });
    expect(result).toEqual({ outcome: 'delivered', status: 201 });
    const [push] = service.received;
    expect(push!.path).toBe('/push/SECRET-ENDPOINT');
    expect(push!.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '60',
      urgency: 'high',
      topic: topicHeader('req_123'),
    });
    expect(push!.headers.authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${keys.publicKey}$`));
    const jwtClaims = JSON.parse(Buffer.from(push!.headers.authorization!.split('.')[1]!, 'base64url').toString());
    expect(jwtClaims.aud).toBe(service.origin);
    expect(JSON.parse(decrypt(push!.body, receiver.privateKey, receiver.keys.auth).plaintext.toString())).toEqual(payload);

    expect(logs).toEqual([{ clientId: 'dev_phone', outcome: 'delivered', statusCode: 201, durationMs: expect.any(Number) }]);
    const line = JSON.stringify(logs);
    for (const secret of ['SECRET-ENDPOINT', receiver.keys.auth, receiver.keys.p256dh, 'Codex wants']) expect(line).not.toContain(secret);
  });

  it('defaults to TTL 3600 and urgency high without a topic, honours other urgencies', async () => {
    const subscription = { endpoint: service.endpoint(), keys: receiver.keys };
    await sender().send('c', subscription, payload);
    await sender().send('c', subscription, payload, { urgency: 'normal', ttl: 12.7 });
    expect(service.received[0]!.headers).toMatchObject({ ttl: '3600', urgency: 'high' });
    expect(service.received[0]!.headers.topic).toBeUndefined();
    expect(service.received[1]!.headers).toMatchObject({ ttl: '12', urgency: 'normal' });
  });

  it('410 and 404 are gone, 500 is failed', async () => {
    const subscription = { endpoint: service.endpoint(), keys: receiver.keys };
    service.status = 410;
    expect(await sender().send('c', subscription, payload)).toEqual({ outcome: 'gone', status: 410 });
    service.status = 404;
    expect(await sender().send('c', subscription, payload)).toEqual({ outcome: 'gone', status: 404 });
    service.status = 500;
    expect(await sender().send('c', subscription, payload)).toEqual({ outcome: 'failed', status: 500 });
    expect(logs.map((l) => [l.outcome, l.statusCode])).toEqual([
      ['gone', 410],
      ['gone', 404],
      ['failed', 500],
    ]);
  });

  it("logs the push service's refusal reason: the JSON reason field, else the text, at most 200 chars", async () => {
    const subscription = { endpoint: service.endpoint('SECRET-ENDPOINT'), keys: receiver.keys };
    service.status = 403;
    service.body = '{"reason":"BadJwtToken"}';
    expect(await sender().send('dev_phone', subscription, payload)).toEqual({ outcome: 'failed', status: 403, detail: 'BadJwtToken' });
    service.status = 410;
    service.body = 'subscription expired\n';
    expect(await sender().send('dev_phone', subscription, payload)).toEqual({ outcome: 'gone', status: 410, detail: 'subscription expired' });
    service.status = 400;
    service.body = 'x'.repeat(1000);
    await sender().send('dev_phone', subscription, payload);
    expect(logs.map((l) => [l.outcome, l.statusCode, l.reason])).toEqual([
      ['failed', 403, 'BadJwtToken'],
      ['gone', 410, 'subscription expired'],
      ['failed', 400, 'x'.repeat(MAX_REASON_CHARS)],
    ]);
    expect(JSON.stringify(logs)).not.toContain('SECRET-ENDPOINT');
  });

  it('refusalReason takes only the reason field of a JSON body and ignores empty bodies', () => {
    expect(refusalReason('{"reason":"BadJwtToken","other":"secret"}')).toBe('BadJwtToken');
    expect(refusalReason('')).toBeUndefined();
    expect(refusalReason(' \n ')).toBeUndefined();
    expect(refusalReason('bad\r\nthing')).toBe('bad thing');
  });

  it('a push service that never answers is a timeout error, not a throw', async () => {
    service.hang = true;
    const started = Date.now();
    const result = await sender(150).send('c', { endpoint: service.endpoint(), keys: receiver.keys }, payload);
    expect(result).toEqual({ outcome: 'error', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logs[0]).toMatchObject({ outcome: 'error', reason: 'timeout' });
  });

  it('a refused connection is a network error', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await sender().send('c', { endpoint: `http://127.0.0.1:${port}/x`, keys: receiver.keys }, payload);
    expect(result).toEqual({ outcome: 'error', reason: 'network' });
  });

  it('rejects an oversized payload and unusable subscriptions without sending', async () => {
    const endpoint = service.endpoint();
    const big = { ...payload, body: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    expect(await sender().send('c', { endpoint, keys: receiver.keys }, big)).toEqual({ outcome: 'error', reason: 'payload_too_large' });
    const bad: [string, { p256dh: string; auth: string }][] = [
      ['not a url', receiver.keys],
      ['http://push.example.com/x', receiver.keys], // plain HTTP off loopback
      ['ftp://127.0.0.1/x', receiver.keys],
      [endpoint, { ...receiver.keys, auth: 'short' }],
    ];
    for (const [url, k] of bad) {
      expect(await sender().send('c', { endpoint: url, keys: k }, payload)).toEqual({ outcome: 'error', reason: 'invalid_subscription' });
    }
    expect(service.received).toEqual([]);
    expect(logs.every((l) => l.outcome === 'error' && l.statusCode === undefined)).toBe(true);
  });

  it('works with the default log and fetch options', async () => {
    const plain = new PushSender({ signer: new VapidSigner({ keys }) });
    expect(await plain.send('c', { endpoint: service.endpoint(), keys: receiver.keys }, payload)).toMatchObject({ outcome: 'delivered' });
  });

  it('hashes every topic into 32 base64url characters, a length Apple accepts (not 1 mod 4)', () => {
    const requestId = 'req_0mvj3howlad4286488f8469bf';
    expect(requestId).toHaveLength(29);
    for (const topic of ['push-test', requestId, 'req_1-A', 'approval:req/1', 'x'.repeat(33), '']) {
      expect(topicHeader(topic)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
    expect(topicHeader('push-test')).not.toBe('push-test');
    expect(topicHeader(requestId)).toBe(topicHeader(requestId));
    expect(topicHeader('push-test')).toBe(topicHeader('push-test'));
    expect(topicHeader(requestId)).not.toBe(topicHeader('req_0mvj3howlad4286488f8469bg'));
    expect(topicHeader('push-test')).not.toBe(topicHeader(requestId));
  });
});
