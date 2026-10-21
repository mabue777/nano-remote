import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generateVapidKeys } from './vapid.js';
import { DEFAULT_VAPID_CONTACT, VAPID_JWT_RENEW_SECONDS, VAPID_JWT_TTL_SECONDS, VapidSigner } from './vapid-jwt.js';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

/** Verifies an ES256 JWT with node:crypto against the uncompressed public point, as a push service does. */
function verifyJwt(jwt: string, publicKey: string): boolean {
  const point = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const [header, claims, signature] = jwt.split('.');
  const raw = Buffer.from(signature!, 'base64url');
  expect(raw).toHaveLength(64); // r||s, not DER
  return verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, raw);
}

describe('VAPID JWT (RFC 8292)', () => {
  it('signs ES256 over the stored key with the right header and claims, and verifies with node:crypto', () => {
    const keys = generateVapidKeys();
    const signer = new VapidSigner({ keys, now: () => 1_800_000_000 });
    const header = signer.authorization('https://web.push.apple.com/QABC/def?x=1');
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match?.[2]).toBe(keys.publicKey);
    const jwt = match![1]!;
    const [h, c] = jwt.split('.');
    expect(decode(h!)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decode(c!)).toEqual({ aud: 'https://web.push.apple.com', exp: 1_800_000_000 + VAPID_JWT_TTL_SECONDS, sub: DEFAULT_VAPID_CONTACT });
    expect(verifyJwt(jwt, keys.publicKey)).toBe(true);
    // Another key does not verify it.
    expect(verifyJwt(jwt, generateVapidKeys().publicKey)).toBe(false);
  });

  it('uses a configured contact', () => {
    const keys = generateVapidKeys();
    const jwt = new VapidSigner({ keys, contact: 'mailto:me@example.org' }).jwt('https://fcm.googleapis.com');
    expect(decode(jwt.split('.')[1]!).sub).toBe('mailto:me@example.org');
    expect(verifyJwt(jwt, keys.publicKey)).toBe(true);
  });

  it('caches one JWT per audience until an hour before it expires', () => {
    let now = 1_800_000_000;
    const signer = new VapidSigner({ keys: generateVapidKeys(), now: () => now });
    const apple = signer.jwt('https://web.push.apple.com');
    const google = signer.jwt('https://fcm.googleapis.com');
    expect(google).not.toBe(apple);
    now += VAPID_JWT_TTL_SECONDS - VAPID_JWT_RENEW_SECONDS - 1;
    expect(signer.jwt('https://web.push.apple.com')).toBe(apple);
    expect(signer.authorization('https://web.push.apple.com/other')).toContain(apple);
    now += 1;
    const renewed = signer.jwt('https://web.push.apple.com');
    expect(renewed).not.toBe(apple);
    expect(decode(renewed.split('.')[1]!).exp).toBe(now + VAPID_JWT_TTL_SECONDS);
  });
});
