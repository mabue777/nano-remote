// Sends one Web Push message (RFC 8030) to one subscription: the payload is encrypted (RFC 8291) and
// signed for (RFC 8292), then POSTed to the push service with the built-in fetch.
//
//   const result = await sender.send(clientId, subscription, { title, body, url }, { ttl: PUSH_TTL.approval, topic });
//   if (result.outcome === 'gone') subscriptions.deleteByEndpoint(subscription.endpoint);
//
// send never throws: every failure is a result. One structured log line per send carries the clientId,
// outcome, status code, the push service's reason on a refusal (such as Apple's "BadJwtToken", at most
// 200 characters) and duration, never the endpoint, the keys or the payload text (they are
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
  /** 404 or 410: the subscription is dead and the caller deletes it. `detail`: the push service's reason, if it gave one. */
  | { outcome: 'gone'; status: number; detail?: string }
  | { outcome: 'failed'; status: number; detail?: string }
  | { outcome: 'error'; reason: 'network' | 'timeout' | 'payload_too_large' | 'invalid_subscription' };

/** TTLs by what the push announces: an approval is useless after a minute, a finished turn is not. */
export const PUSH_TTL = { approval: 60, completion: 3600 } as const;
/** The JSON payload cap. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;
export const SEND_TIMEOUT_MS = 10_000;
/** The most of a push service's refusal reason that is logged. */
export const MAX_REASON_CHARS = 200;

/**
 * The reason in a refusal body: the `reason` field of a JSON body (Apple: {"reason":"BadJwtToken"}),
 * else the plain text body. Control characters are dropped and it is cut to MAX_REASON_CHARS.
 */
export function refusalReason(text: string): string | undefined {
  let reason = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { reason?: unknown }).reason === 'string') {
      reason = (parsed as { reason: string }).reason;
    }
  } catch {
    // Not JSON: the text itself.
  }
  // eslint-disable-next-line no-control-regex
  const clean = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
  return clean === '' ? undefined : clean;
}

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

/**
 * Every topic is hashed into exactly 32 base64url characters (RFC 8030 section 5.4 allows at most 32).
 * Apple decodes the Topic header as base64url and refuses a value whose length is 1 mod 4 with
 * 400 BadWebPushTopic (probed against a live iPhone subscription on 2026-10-22: lengths 5, 9 and 29
 * refused, 6, 7, 8, 30 and 32 accepted). Host ids are 29 characters, so nothing passes through unchanged.
 * The hash is deterministic: equal topics still replace each other.
 */
export function topicHeader(topic: string): string {
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
    if ('status' in result) {
      fields.statusCode = result.status;
      if ('detail' in result && result.detail !== undefined) fields.reason = result.detail;
    } else fields.reason = result.reason;
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
    let text = '';
    try {
      response = await this.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      // Read the body even on success so the connection can be reused; a refusal's body says why.
      text = await response.text().catch(() => '');
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      return { outcome: 'error', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
    const status = response.status;
    if (status >= 200 && status < 300) return { outcome: 'delivered', status };
    const detail = refusalReason(text);
    const outcome = status === 404 || status === 410 ? 'gone' : 'failed';
    return detail === undefined ? { outcome, status } : { outcome, status, detail };
  }
}
