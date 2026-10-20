// `POST /v1/pair` (protocol-v1.md section 8): redeems a pairing code for a device token, answers
// `{clientId, deviceToken, host:{hostId, name}}` and sets the `nano_device` cookie for browsers.
//
// Errors use the stream's error body shape, `{error:{code, message, data?}}` (spec 10), with an HTTP
// status: 400 invalid_params, 403 unauthorized (wrong, expired or used code; one message for all, so a
// prober learns nothing), 413 body too large, 415 not JSON, 429 rate_limited with `data.retryAfterMs`.
import type http from 'node:http';

import { clip, MAX_DISPLAY_NAME_LENGTH, type DeviceStore } from '../devices/store.js';
import type { ErrorBody } from '../stream/router.js';
import { DEVICE_COOKIE } from '../stream/constants.js';
import type { PairingCodes } from './codes.js';

export const PAIR_ENDPOINT = '/v1/pair';

/** Largest request body accepted by the pairing endpoint. */
export const MAX_PAIR_BODY_BYTES = 16 * 1024;

/**
 * Cookie attributes of `nano_device` (spec 1, 8). Security-pass seam. Max-Age keeps the device paired
 * across browser restarts; 400 days is the longest browsers honor.
 */
export const DEVICE_COOKIE_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${400 * 24 * 3600}`];

export interface PairRequest {
  code: unknown;
  client: { name: string; platform: string; userAgent?: string };
}

export interface PairResponse {
  clientId: string;
  deviceToken: string;
  host: { hostId: string; name: string };
}

export interface PairEndpointOptions {
  codes: PairingCodes;
  devices: DeviceStore;
  host: () => { hostId: string; name: string };
  log?: (message: string, error?: unknown) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
    readonly headers: Record<string, string> = {},
  ) {
    super(body.message);
  }
}

function invalid(path: string, message: string): HttpError {
  return new HttpError(400, { code: 'invalid_params', message, data: { path } });
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(path, `${path} must be a non-empty string`);
  return value;
}

/** Validates a parsed body. The code itself is checked by PairingCodes so that a bad code counts as a failure. */
export function parsePairRequest(body: unknown): PairRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('', 'body must be a JSON object');
  const { code, client } = body as Record<string, unknown>;
  if (!('code' in body)) throw invalid('code', 'code is required');
  if (typeof client !== 'object' || client === null || Array.isArray(client)) {
    throw invalid('client', 'client must be an object');
  }
  const c = client as Record<string, unknown>;
  const name = requiredString(c.name, 'client.name');
  const platform = requiredString(c.platform, 'client.platform');
  if (c.userAgent !== undefined && typeof c.userAgent !== 'string') {
    throw invalid('client.userAgent', 'client.userAgent must be a string');
  }
  return { code, client: { name, platform, ...(c.userAgent !== undefined ? { userAgent: c.userAgent } : {}) } };
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PAIR_BODY_BYTES) {
        reject(new HttpError(413, { code: 'invalid_params', message: 'body too large', data: { path: '' } }));
        request.removeAllListeners('data');
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(text);
}

async function pair(request: http.IncomingMessage, options: PairEndpointOptions): Promise<PairResponse> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  // A JSON content type cannot come from a plain cross-site form, so this also stops form-based CSRF.
  if (type !== 'application/json') {
    throw new HttpError(415, { code: 'invalid_params', message: 'content-type must be application/json', data: { path: '' } });
  }
  const text = await readBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('', 'body is not valid JSON');
  }
  const body = parsePairRequest(parsed);
  const source = request.socket.remoteAddress ?? 'unknown';
  const redeemed = options.codes.redeem(body.code, source);
  if (!redeemed.ok) {
    if (redeemed.reason === 'rate_limited') {
      throw new HttpError(
        429,
        { code: 'rate_limited', message: 'too many failed pairing attempts', data: { retryAfterMs: redeemed.retryAfterMs } },
        { 'retry-after': String(Math.ceil(redeemed.retryAfterMs / 1000)) },
      );
    }
    throw new HttpError(403, { code: 'unauthorized', message: 'pairing code is wrong, expired or already used' });
  }
  const { device, token } = options.devices.create({
    displayName: clip(body.client.name, MAX_DISPLAY_NAME_LENGTH),
    platform: body.client.platform,
    userAgent: body.client.userAgent ?? request.headers['user-agent'] ?? '',
  });
  return { clientId: device.clientId, deviceToken: token, host: options.host() };
}

/** The `Set-Cookie` value carrying a device token. */
export function deviceCookie(token: string): string {
  return [`${DEVICE_COOKIE}=${token}`, ...DEVICE_COOKIE_ATTRIBUTES].join('; ');
}

/** Handles `POST /v1/pair`. The caller routes only that path here; other methods answer 405. */
export async function handlePair(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: PairEndpointOptions,
): Promise<void> {
  if (request.method !== 'POST') {
    send(response, 405, { error: { code: 'invalid_params', message: 'use POST', data: { path: '' } } }, { allow: 'POST' });
    return;
  }
  try {
    const result = await pair(request, options);
    send(response, 200, result, { 'set-cookie': deviceCookie(result.deviceToken) });
    options.log?.(`paired device ${result.clientId}`);
  } catch (error) {
    if (error instanceof HttpError) {
      send(response, error.status, { error: error.body }, error.headers);
      return;
    }
    options.log?.('pairing failed', error);
    send(response, 500, { error: { code: 'internal', message: 'internal error' } });
  }
}
