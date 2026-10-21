// Sends one Web Push message (RFC 8030) to one subscription: the payload is encrypted (RFC 8291) and
// signed for (RFC 8292), then POSTed to the push service with the built-in fetch.
//
//   const result = await sender.send(clientId, subscription, { title, body, url }, { ttl: PUSH_TTL.approval, topic });
//   if (result.outcome === 'gone') subscriptions.deleteByEndpoint(subscription.endpoint);
//
// send never throws: every failure is a result. One structured log line per send carries the clientId,
// outcome, status code and duration, never the endpoint, the keys or the payload text (they are
// capabilities or session content).
import { createHash } from 'node:crypto';

import type { PushSubscription } from '../generated/common.js';
import { encrypt } from './encrypt.js';
import type { VapidSigner } from './vapid-jwt.js';

/** Push payload (protocol-v1.md section 9): nothing else is sent. */
export interface PushPayload {
  title: string;
  body: string;
  /** Path in the web app, such as `/session/<id>`. */
  url: string;
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface SendOptions {
  /** Seconds the push service keeps an undelivered message; default PUSH_TTL.completion. */
  ttl?: number;
  /** Default 'high'. */
  urgency?: PushUrgency;
  /** Collapses pushes for the same thing (a request id): a newer message replaces an undelivered older one. */
  topic?: string;
}

export type SendResult =
  | { outcome: 'delivered'; status: number }
  /** 404 or 410: the subscription is dead and the caller deletes it. */
  | { outcome: 'gone'; status: number }
  | { outcome: 'failed'; status: number }
  | { outcome: 'error'; reason: 'network' | 'timeout' | 'payload_too_large' | 'invalid_subscription' };

/** TTLs by what the push announces: an approval is useless after a minute, a finished turn is not. */
export const PUSH_TTL = { approval: 60, completion: 3600 } as const;
/** The JSON payload cap. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;
export const SEND_TIMEOUT_MS = 10_000;

export interface SendLogFields {
  clientId: string;
  outcome: SendResult['outcome'];
  statusCode?: number;
  reason?: string;
  durationMs: number;
}

export interface PushSenderOptions {
  signer: VapidSigner;
  /** Default SEND_TIMEOUT_MS. */
  timeoutMs?: number;
  /** One call per send. */
  log?: (fields: SendLogFields) => void;
  /** Default the global fetch (tests may swap it). */
  fetch?: typeof fetch;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Push services are HTTPS; plain HTTP is accepted on loopback only (a local test service). */
function endpointUrl(endpoint: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  return undefined;
}

/** RFC 8030 section 5.4: a Topic is at most 32 base64url characters; anything else is hashed into one. */
export function topicHeader(topic: string): string {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(topic)) return topic;
  return createHash('sha256').update(topic).digest('base64url').slice(0, 32);
}

export class PushSender {
  private readonly timeoutMs: number;
  private readonly log: (fields: SendLogFields) => void;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: PushSenderOptions) {
    this.timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async send(clientId: string, subscription: PushSubscription, payload: PushPayload, options: SendOptions = {}): Promise<SendResult> {
    const started = Date.now();
    const result = await this.attempt(subscription, payload, options);
    const fields: SendLogFields = { clientId, outcome: result.outcome, durationMs: Date.now() - started };
    if ('status' in result) fields.statusCode = result.status;
    else fields.reason = result.reason;
    this.log(fields);
    return result;
  }

  private async attempt(subscription: PushSubscription, payload: PushPayload, options: SendOptions): Promise<SendResult> {
    // Exactly the three fields, whatever the caller's object carries.
    const json = Buffer.from(JSON.stringify({ title: payload.title, body: payload.body, url: payload.url }));
    if (json.length > MAX_PAYLOAD_BYTES) return { outcome: 'error', reason: 'payload_too_large' };
    const url = endpointUrl(subscription.endpoint);
    if (!url) return { outcome: 'error', reason: 'invalid_subscription' };
    let body: Buffer;
    let authorization: string;
    try {
      body = encrypt(subscription.keys, json);
      authorization = this.options.signer.authorization(url.href);
    } catch {
      return { outcome: 'error', reason: 'invalid_subscription' };
    }
    const headers: Record<string, string> = {
      authorization,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(Math.max(0, Math.floor(options.ttl ?? PUSH_TTL.completion))),
      urgency: options.urgency ?? 'high',
    };
    if (options.topic !== undefined) headers.topic = topicHeader(options.topic);
    let response: Response;
    try {
      response = await this.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      // The body is not needed; drain it so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      return { outcome: 'error', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
    const status = response.status;
    if (status >= 200 && status < 300) return { outcome: 'delivered', status };
    if (status === 404 || status === 410) return { outcome: 'gone', status };
    return { outcome: 'failed', status };
  }
}
