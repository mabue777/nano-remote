// The host's VAPID key pair (protocol-v1.md section 9, ADR 0005): the identity Nano Host signs Web Push
// messages with. Generated on first start, kept in `vapid.json` (0600) in the NanoHost folder (0700), and
// never rotated by the host: a new key would orphan every browser's push subscription. `initialize`
// advertises the public key as `push.vapidPublicKey` so the web app can call `pushManager.subscribe`.
//
//   { "publicKey": "<base64url, 65-byte uncompressed P-256 point>",
//     "privateKey": "<base64url, 32-byte P-256 scalar>",
//     "createdAt": 1792000000 }
//
// Sending (Phase 3) needs nothing else: the JWT is ES256 over this key, and the push subscription table
// is designed in docs/security/host-v0-pass.md item 6.
import { createECDH, generateKeyPairSync } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

import { PRIVATE_FILE_MODE } from '../config/private-files.js';

export const VAPID_KEYS_FILE = 'vapid.json';

export interface VapidKeys {
  /** base64url of the uncompressed P-256 public point (65 bytes, starts with 0x04): `applicationServerKey`. */
  publicKey: string;
  /** base64url of the 32-byte private scalar. Never leaves this file and the signer. */
  privateKey: string;
  /** Unix seconds. */
  createdAt: number;
}

export class VapidKeyError extends Error {
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}; move the file away to generate a new key (every push subscription then has to be renewed)`);
    this.name = 'VapidKeyError';
  }
}

/** A fresh P-256 key pair in the stored format. */
export function generateVapidKeys(now = () => Math.floor(Date.now() / 1000)): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d!, createdAt: now() };
}

/** Throws unless the private scalar is a P-256 key whose public point is `publicKey`. */
function checkPair(keys: VapidKeys, file: string): void {
  const point = Buffer.from(keys.publicKey, 'base64url');
  const scalar = Buffer.from(keys.privateKey, 'base64url');
  if (point.length !== 65 || point[0] !== 4) throw new VapidKeyError(file, 'publicKey is not an uncompressed P-256 point');
  if (scalar.length !== 32) throw new VapidKeyError(file, 'privateKey is not a 32-byte P-256 scalar');
  let derived: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    derived = ecdh.getPublicKey();
  } catch {
    throw new VapidKeyError(file, 'privateKey is not a valid P-256 key');
  }
  if (!derived.equals(point)) throw new VapidKeyError(file, 'publicKey does not belong to privateKey');
}

/**
 * Reads the key pair, creating it (0600) when the file is missing. An existing file is tightened to
 * 0600. A damaged file is an error, not a reason to start over silently.
 */
export function ensureVapidKeys(file: string, now?: () => number): VapidKeys {
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text === undefined) {
    const keys = generateVapidKeys(now);
    writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    chmodSync(file, PRIVATE_FILE_MODE);
    return keys;
  }
  chmodSync(file, PRIVATE_FILE_MODE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VapidKeyError(file, 'not valid JSON');
  }
  const raw = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof raw.publicKey !== 'string' || typeof raw.privateKey !== 'string' || typeof raw.createdAt !== 'number') {
    throw new VapidKeyError(file, 'expected {publicKey, privateKey, createdAt}');
  }
  const keys: VapidKeys = { publicKey: raw.publicKey, privateKey: raw.privateKey, createdAt: raw.createdAt };
  checkPair(keys, file);
  return keys;
}
