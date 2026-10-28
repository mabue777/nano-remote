// `GET /v1/file?sessionId=<id>&path=<relative path>` (and HEAD), protocol-v1.md section 4.1: the bytes of a
// file in a session folder, for images, PDFs and other files that should not travel over the stream as
// base64. Authenticated exactly like `/v1/blob` (the same function), served with the same headers so a file
// never acts as a page of the host's origin, plus what a file that changes needs: `ETag` (size and
// modification time), `Last-Modified`, `Cache-Control: private, no-cache` (revalidate every time; an
// unchanged file answers 304) and single byte ranges (`Accept-Ranges: bytes`, 206, 416).
//
// Errors use the stream's error body: 401/403 unauthorized, 400 invalid_params (`data.path` `sessionId`,
// `path` or `range`), 404 not_found (unknown or deleted session, a path outside the folder or missing, with
// no hint of which), 405, 413 invalid_params (`data.maxBytes`), 416 invalid_params.
import type http from 'node:http';

import { authenticate, BLOB_HEADERS, fail, INLINE_TYPES } from '../attachments/endpoint.js';
import { MAX_ATTACHMENT_BYTES } from '../attachments/store.js';
import { RpcError } from '../errors.js';
import { looksBinary, mediaTypeOf, openInSession, readAt, SNIFF_BYTES, type OpenedFile } from './read.js';

/** The endpoint's path. */
export const FILE_PATH = '/v1/file';

/** The largest file `/v1/file` serves: the attachment limit (20 MiB). */
export const MAX_SERVED_FILE_BYTES = MAX_ATTACHMENT_BYTES;

export interface FileEndpointOptions {
  /** Device token to clientId, or null when unknown or revoked (the device store). */
  authenticate: (token: string) => string | null;
  /** The host's own origin; requests carrying another `Origin` are refused. */
  origin: () => string;
  /** The session's folder, or undefined when the session is unknown or deleted. */
  sessionFolder: (sessionId: string) => string | undefined;
  /** Default MAX_SERVED_FILE_BYTES. */
  maxBytes?: number;
  log?: (message: string, error?: unknown) => void;
}

/** A strong validator from size and modification time (microseconds): it changes whenever the file does. */
export function fileEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs * 1000).toString(16)}"`;
}

/**
 * One `bytes=` range of a `size`-byte file: the inclusive [start, end], `unsatisfiable` (416), or undefined
 * when the header is absent, malformed or asks for several ranges (then the whole file is served, as RFC
 * 9110 allows).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return undefined;
  return { start, end };
}

/** True when an `If-None-Match` header names this ETag (or `*`). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((tag) => {
    const value = tag.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}

/** Handles every request to `/v1/file`. */
export async function handleFile(request: http.IncomingMessage, response: http.ServerResponse, options: FileEndpointOptions): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    request.resume();
    fail(response, 405, 'invalid_params', 'use GET, HEAD', { path: '' }, { allow: 'GET, HEAD' });
    return;
  }
  if (authenticate(request, response, options) === null) {
    request.resume();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId') ?? '';
  const requested = url.searchParams.get('path') ?? '';
  if (sessionId === '') return fail(response, 400, 'invalid_params', 'sessionId is required', { path: 'sessionId' });
  if (requested === '') return fail(response, 400, 'invalid_params', 'path is required', { path: 'path' });
  const folder = /^ses_[0-9a-z]+$/.test(sessionId) ? options.sessionFolder(sessionId) : undefined;
  if (folder === undefined) return fail(response, 404, 'not_found', `no session ${sessionId}`, { sessionId });

  let file: OpenedFile;
  try {
    file = await openInSession(folder, requested, 'path');
  } catch (error) {
    if (error instanceof RpcError && (error.code === 'not_found' || error.code === 'invalid_params')) {
      return fail(response, error.code === 'not_found' ? 404 : 400, error.code, error.message, error.data);
    }
    throw error;
  }
  let streaming = false;
  try {
    streaming = await serve(request, response, file, options.maxBytes ?? MAX_SERVED_FILE_BYTES);
  } finally {
    if (!streaming) await file.handle.close();
  }
}

/** Answers for an opened file. True when a body stream now owns (and will close) the file handle. */
async function serve(request: http.IncomingMessage, response: http.ServerResponse, file: OpenedFile, maxBytes: number): Promise<boolean> {
  const { handle, size, mtimeMs, relative } = file;
  if (size > maxBytes) {
    fail(response, 413, 'invalid_params', `a file may have at most ${maxBytes} bytes to be served`, { path: 'path', maxBytes });
    return false;
  }
  const head = await readAt(handle, 0, Math.min(size, SNIFF_BYTES));
  const binary = looksBinary(head, size <= SNIFF_BYTES);
  const mediaType = mediaTypeOf(relative, head, binary);
  const name = relative.split('/').pop() ?? relative;
  const etag = fileEtag(size, mtimeMs);
  const validators = {
    etag,
    'last-modified': new Date(mtimeMs).toUTCString(),
    // Session files change: keep a copy, but ask every time (an unchanged file answers 304).
    'cache-control': 'private, no-cache',
    'accept-ranges': 'bytes',
  };
  if (matchesEtag(request.headers['if-none-match'], etag)) {
    response.writeHead(304, { ...BLOB_HEADERS, ...validators });
    response.end();
    return false;
  }
  const ifRange = request.headers['if-range'];
  const range = ifRange === undefined || ifRange === etag ? parseRange(request.headers.range, size) : undefined;
  if (range === 'unsatisfiable') {
    fail(response, 416, 'invalid_params', 'range not satisfiable', { path: 'range' }, { ...validators, 'content-range': `bytes */${size}` });
    return false;
  }
  const textual = !binary && (mediaType.startsWith('text/') || mediaType === 'application/json');
  const headers: Record<string, string> = {
    ...BLOB_HEADERS,
    ...validators,
    'content-type': textual ? `${mediaType}; charset=utf-8` : mediaType,
    'content-disposition': `${INLINE_TYPES.has(mediaType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  if (range !== undefined) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  headers['content-length'] = String(size === 0 ? 0 : end - start + 1);
  response.writeHead(range !== undefined ? 206 : 200, headers);
  if (request.method === 'HEAD' || size === 0) {
    response.end();
    return false;
  }
  const stream = handle.createReadStream({ start, end, autoClose: true });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  return true;
}
