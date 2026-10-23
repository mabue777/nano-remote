// The attachment endpoint (protocol-v1.md section 8.1), plain HTTPS beside the stream:
//
//   POST /v1/blob?sessionId=<id>&name=<file name>   body: the bytes, Content-Type: the media type
//     -> 201 {blobId, url, name, mediaType, size}
//   GET  /v1/blob/<blobId>
//     -> 200 the bytes with their media type
//
// Both authenticate exactly like the stream upgrade (spec 1): the `nano_device` cookie, or for a client
// without an `Origin` a bearer token; a request from a page of another origin is refused. Errors use the
// stream's error body, `{error:{code, message, data?}}`: 401 unauthorized (no token, unknown or revoked),
// 403 unauthorized (foreign origin), 400 invalid_params, 404 not_found, 405, 413 invalid_params with
// `data.maxBytes`.
//
// Downloads are served so that a stored file can never act as a page of the host's origin: nosniff, a
// sandboxing Content-Security-Policy, and `attachment` disposition for anything but raster images.
import { createReadStream } from 'node:fs';
import type http from 'node:http';

import { tokenFrom } from '../stream/server.js';
import { AttachmentTooLarge, BLOB_ID, BLOB_PATH, blobUrl, type AttachmentStore } from './store.js';

/** Media types a browser may show inline from `/v1/blob` (raster images only, never SVG or HTML). */
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);

/** Headers of every blob response: never sniffed, never scripted, never framed. */
const BLOB_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

export interface BlobEndpointOptions {
  store: AttachmentStore;
  /** Device token to clientId, or null when unknown or revoked (the device store). */
  authenticate: (token: string) => string | null;
  /** The host's own origin; requests carrying another `Origin` are refused. */
  origin: () => string;
  /** True when the session exists and is not deleted. */
  sessionExists: (sessionId: string) => boolean;
  log?: (message: string, error?: unknown) => void;
}

/** What `POST /v1/blob` answers. */
export interface BlobUploadResult {
  blobId: string;
  url: string;
  name: string;
  mediaType: string;
  size: number;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...BLOB_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(text);
}

function fail(
  response: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  data?: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  sendJson(response, status, { error: { code, message, ...(data !== undefined ? { data } : {}) } }, headers);
}

/** True when the request is for the attachment endpoint (`/v1/blob` or below). */
export function isBlobPath(urlPath: string): boolean {
  return urlPath === BLOB_PATH || urlPath.startsWith(`${BLOB_PATH}/`);
}

/** The authenticated clientId, or null after answering 401 or 403. */
function authenticate(request: http.IncomingMessage, response: http.ServerResponse, options: BlobEndpointOptions): string | null {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== new URL(options.origin()).origin) {
    fail(response, 403, 'unauthorized', 'origin not allowed');
    return null;
  }
  const token = tokenFrom(request);
  let clientId: string | null = null;
  if (token !== null) {
    try {
      clientId = options.authenticate(token);
    } catch (error) {
      options.log?.('blob authentication failed', error);
    }
  }
  if (clientId === null) {
    fail(response, 401, 'unauthorized', 'device token missing, unknown or revoked');
    return null;
  }
  return clientId;
}

/** Handles every request under `/v1/blob`. Drains an unread upload body so the socket stays usable. */
export async function handleBlob(request: http.IncomingMessage, response: http.ServerResponse, options: BlobEndpointOptions): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const isUpload = url.pathname === BLOB_PATH;
  const allow = isUpload ? 'POST' : 'GET, HEAD';
  if (isUpload ? request.method !== 'POST' : request.method !== 'GET' && request.method !== 'HEAD') {
    request.resume();
    fail(response, 405, 'invalid_params', `use ${allow}`, { path: '' }, { allow });
    return;
  }
  const clientId = authenticate(request, response, options);
  if (clientId === null) {
    request.resume();
    return;
  }
  if (isUpload) await upload(request, response, url, clientId, options);
  else download(request, response, url.pathname.slice(BLOB_PATH.length + 1), options);
}

async function upload(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  clientId: string,
  options: BlobEndpointOptions,
): Promise<void> {
  const { store } = options;
  const sessionId = url.searchParams.get('sessionId') ?? '';
  if (sessionId === '') {
    request.resume();
    return fail(response, 400, 'invalid_params', 'sessionId is required', { path: 'sessionId' });
  }
  if (!/^ses_[0-9a-z]+$/.test(sessionId) || !options.sessionExists(sessionId)) {
    request.resume();
    return fail(response, 404, 'not_found', `no session ${sessionId}`, { sessionId });
  }
  const declared = Number(request.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > store.maxBytes) {
    // Refuse before reading: the client learns at once instead of after sending 20 MB. The connection
    // closes because the rest of the body is never read.
    fail(response, 413, 'invalid_params', `an attachment may have at most ${store.maxBytes} bytes`, { path: '', maxBytes: store.maxBytes }, { connection: 'close' });
    request.resume();
    return;
  }
  try {
    const attachment = await store.save(
      sessionId,
      { name: url.searchParams.get('name') ?? '', mediaType: request.headers['content-type'] ?? '' },
      request,
    );
    const result: BlobUploadResult = {
      blobId: attachment.blobId,
      url: blobUrl(attachment.blobId),
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
    };
    options.log?.(`attachment stored blobId=${attachment.blobId} sessionId=${sessionId} clientId=${clientId} size=${attachment.size}`);
    sendJson(response, 201, result);
  } catch (error) {
    if (error instanceof AttachmentTooLarge) {
      fail(response, 413, 'invalid_params', `an attachment may have at most ${error.maxBytes} bytes`, { path: '', maxBytes: error.maxBytes }, {
        connection: 'close',
      });
      return;
    }
    throw error;
  }
}

function download(request: http.IncomingMessage, response: http.ServerResponse, blobId: string, options: BlobEndpointOptions): void {
  const attachment = BLOB_ID.test(blobId) ? options.store.get(blobId) : undefined;
  if (attachment === undefined || !options.sessionExists(attachment.sessionId)) {
    return fail(response, 404, 'not_found', 'no such attachment');
  }
  const inline = INLINE_TYPES.has(attachment.mediaType);
  response.writeHead(200, {
    ...BLOB_HEADERS,
    'content-type': attachment.mediaType,
    'content-length': String(attachment.size),
    // Blobs never change; only paired devices may keep a copy.
    'cache-control': 'private, max-age=86400',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(attachment.path);
  stream.on('error', (error) => {
    options.log?.(`attachment ${blobId} unreadable`, error);
    response.destroy();
  });
  stream.pipe(response);
}
