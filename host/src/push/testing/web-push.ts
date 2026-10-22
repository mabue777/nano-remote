// Test helpers for Web Push: the browser's side of RFC 8291 (a receiver key pair and decrypt) and a fake
// push service on 127.0.0.1 that records what the host POSTs and answers with a chosen status.
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) =>
  hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

/** A browser's subscription keys: the private scalar stays with the test to decrypt. */
export interface Receiver {
  privateKey: Buffer;
  keys: { p256dh: string; auth: string };
}

export function newReceiver(): Receiver {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

/** What a browser does with an aes128gcm push body (RFC 8188 header parse, RFC 8291 key derivation). */
export function decrypt(body: Buffer, receiverPrivateKey: Buffer, authSecret: string): { plaintext: Buffer; recordSize: number } {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(receiverPrivateKey);
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = hkdf(Buffer.from(authSecret, 'base64url'), ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // RFC 8188: strip trailing zero padding, then the delimiter; 0x02 marks the last record.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error(`expected the last-record delimiter 0x02, found ${padded[end]}`);
  return { plaintext: padded.subarray(0, end), recordSize };
}

export interface ReceivedPush {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A local push service: `status` and `body` are what it answers next; `hang` never answers (a timeout). */
export class FakePushService {
  status = 201;
  body = '';
  hang = false;
  readonly received: ReceivedPush[] = [];
  private readonly server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      this.received.push({ path: request.url ?? '/', headers: request.headers, body: Buffer.concat(chunks) });
      if (this.hang) return;
      response.writeHead(this.status, { location: '/message/1' });
      response.end(this.body);
    });
  });

  static async start(): Promise<FakePushService> {
    const service = new FakePushService();
    await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
    return service;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  endpoint(name = 'sub-1'): string {
    return `${this.origin}/push/${name}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
