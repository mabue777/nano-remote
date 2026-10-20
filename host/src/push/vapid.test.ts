import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VAPID_KEYS_FILE, VapidKeyError, ensureVapidKeys, generateVapidKeys } from './vapid.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nano-vapid-'));
  file = path.join(dir, VAPID_KEYS_FILE);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The stored key pair as node:crypto keys, the way a Phase 3 ES256 signer would load them. */
function keyObjects(keys: { publicKey: string; privateKey: string }) {
  const point = Buffer.from(keys.publicKey, 'base64url');
  const jwk = { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') };
  return {
    privateKey: createPrivateKey({ key: { ...jwk, d: keys.privateKey }, format: 'jwk' }),
    publicKey: createPublicKey({ key: jwk, format: 'jwk' }),
  };
}

describe('VAPID key pair', () => {
  it('security: is generated on first start as a P-256 pair in a 0600 file, and reused afterwards', () => {
    const keys = ensureVapidKeys(file, () => 1_792_000_000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.publicKey, 'base64url')[0]).toBe(4);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...keys, createdAt: 1_792_000_000 });

    // ES256 with the stored private key verifies with the advertised public key.
    const { privateKey, publicKey } = keyObjects(keys);
    const signature = sign('sha256', Buffer.from('jwt'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(verify('sha256', Buffer.from('jwt'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);

    expect(ensureVapidKeys(file)).toEqual(keys);
  });

  it('security: tightens a file that is too open', () => {
    const keys = ensureVapidKeys(file);
    chmodSync(file, 0o644);
    expect(ensureVapidKeys(file)).toEqual(keys);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a damaged file instead of replacing the key silently', () => {
    writeFileSync(file, 'not json');
    expect(() => ensureVapidKeys(file)).toThrow(VapidKeyError);
    writeFileSync(file, JSON.stringify({ publicKey: 'x' }));
    expect(() => ensureVapidKeys(file)).toThrow(/expected/);
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    writeFileSync(file, JSON.stringify({ ...a, publicKey: b.publicKey }));
    expect(() => ensureVapidKeys(file)).toThrow(/does not belong/);
    writeFileSync(file, JSON.stringify({ ...a, privateKey: Buffer.alloc(32).toString('base64url') }));
    expect(() => ensureVapidKeys(file)).toThrow(/not a valid P-256 key/);
    writeFileSync(file, JSON.stringify({ ...a, privateKey: 'AAAA' }));
    expect(() => ensureVapidKeys(file)).toThrow(/32-byte/);
    writeFileSync(file, JSON.stringify({ ...a, publicKey: 'AAAA' }));
    expect(() => ensureVapidKeys(file)).toThrow(/uncompressed/);
  });

  it('generates a different pair each time', () => {
    expect(generateVapidKeys().privateKey).not.toBe(generateVapidKeys().privateKey);
  });
});
