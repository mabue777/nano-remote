// Web Push message encryption (RFC 8291) in the aes128gcm content coding (RFC 8188), node:crypto only.
//
//   body = salt(16) || rs(4, big endian) || idlen(1) = 65 || as_public(65) || AES-128-GCM(CEK, NONCE, plaintext || 0x02)
//
// One record, no padding beyond the 0x02 delimiter, record size 4096. The salt and the ephemeral
// application-server key are random per message; tests pass both to replay RFC 8291 Appendix A exactly.
import { createCipheriv, createECDH, createHmac, randomBytes, type ECDH } from 'node:crypto';

/** RFC 8188 record size the host writes. A single record carries the whole message. */
export const RECORD_SIZE = 4096;
/** AES-GCM tag length (RFC 8188 section 2). */
const TAG_LENGTH = 16;
/** The largest plaintext one record holds: the record minus the tag and the 0x02 delimiter. */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - TAG_LENGTH - 1;

/** The receiver's keys from the browser's `PushSubscription.toJSON().keys` (base64url). */
export interface ReceiverKeys {
  /** Uncompressed P-256 point, 65 bytes. */
  p256dh: string;
  /** 16-byte authentication secret. */
  auth: string;
}

export interface EncryptInputs {
  /** 16 bytes; default random. */
  salt?: Buffer;
  /** The ephemeral application-server private scalar (32 bytes); default a fresh key. */
  ephemeralPrivateKey?: Buffer;
}

export class PushEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushEncryptionError';
  }
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF with a single output block (every length here is at most 32 bytes). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

function ephemeralKey(privateKey: Buffer | undefined): ECDH {
  const ecdh = createECDH('prime256v1');
  if (privateKey) ecdh.setPrivateKey(privateKey);
  else ecdh.generateKeys();
  return ecdh;
}

/**
 * Encrypts `plaintext` for one subscription. Throws PushEncryptionError when the receiver keys are not
 * a P-256 point and a 16-byte secret, or the plaintext does not fit one record.
 */
export function encrypt(keys: ReceiverKeys, plaintext: Uint8Array, inputs: EncryptInputs = {}): Buffer {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new PushEncryptionError('keys.p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new PushEncryptionError('keys.auth is not 16 bytes');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new PushEncryptionError(`plaintext is over ${MAX_PLAINTEXT_BYTES} bytes`);
  const salt = inputs.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new PushEncryptionError('salt must be 16 bytes');

  const as = ephemeralKey(inputs.ephemeralPrivateKey);
  const asPublic = as.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = as.computeSecret(uaPublic);
  } catch {
    throw new PushEncryptionError('keys.p256dh is not a point on P-256');
  }

  // RFC 8291 section 3.4: combine the ECDH secret with the auth secret, then derive CEK and nonce.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}
