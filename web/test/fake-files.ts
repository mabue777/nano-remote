// Session folders for the fake host (protocol-v1.md section 4.1), in memory: `fs/readFile` with the binary
// sniff, media types and line-aligned ranges, and `GET /v1/file` with ETag, 304 and single byte ranges. Written
// from the spec, independently of host/src/files, with the same rules the viewer depends on:
// - Scope: a path is relative to the session folder (or absolute inside it); `..` that leaves the folder, an
//   absolute path elsewhere and a missing file all answer `not_found` with `data.path` as sent. A folder (any
//   stored path below it) is `invalid_params`. Symlinks are not modelled.
// - Binary: a NUL or invalid UTF-8 in the first 8 KiB (a character cut by the 8 KiB mark does not count).
// - Ranges: `maxBytes` defaults to 256 KiB, at least 4096 and at most 1 MiB; `offset` moves back to its line
//   start when that is at most 1024 bytes earlier, else to its character start; an answer that stops early ends
//   after its last newline, else at a character boundary; an offset past the end is `invalid_params`.
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const DEFAULT_READ = 256 * 1024;
const MIN_READ = 4096;
const MAX_READ = 1024 * 1024;
const LINE_SEEK = 1024;
const SNIFF = 8192;

interface StoredFile {
  bytes: Buffer;
  mtimeMs: number;
}

/** An error the stream answers with (fake-host.ts turns it into a JSON-RPC error). */
export class FileError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_params',
    message: string,
    readonly data: Json,
  ) {
    super(message);
  }
}

const TYPES: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
};

function magic(head: Buffer): string | undefined {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return undefined;
}

function isBinary(head: Buffer, complete: boolean): boolean {
  if (head.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: !complete });
    return false;
  } catch {
    return true;
  }
}

const continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

export class FakeFiles {
  /** sessionId -> relative path -> file. */
  private readonly folders = new Map<string, Map<string, StoredFile>>();

  clear(): void {
    this.folders.clear();
  }

  /** Puts a file in a session folder (text or bytes); the modification time is now unless given. */
  put(sessionId: string, relative: string, content: string | Buffer, mtimeMs = Date.now()): void {
    let folder = this.folders.get(sessionId);
    if (folder === undefined) this.folders.set(sessionId, (folder = new Map()));
    folder.set(relative, { bytes: typeof content === 'string' ? Buffer.from(content, 'utf8') : content, mtimeMs });
  }

  /** The stored file for a requested path under the scope rule, with its path inside the folder. */
  resolve(sessionId: string, cwd: string, requested: string, paramPath = 'params.path'): { relative: string; file: StoredFile } {
    const outside = () => new FileError('not_found', 'no such file or folder in the session folder', { path: requested });
    if (requested.includes('\0')) throw new FileError('invalid_params', 'path must not contain NUL', { path: paramPath });
    const absolute = path.posix.isAbsolute(requested) ? path.posix.normalize(requested) : path.posix.join(cwd, requested === '' ? '.' : requested);
    if (absolute !== cwd && !absolute.startsWith(`${cwd}/`)) throw outside();
    const relative = path.posix.relative(cwd, absolute);
    const folder = this.folders.get(sessionId) ?? new Map<string, StoredFile>();
    const file = folder.get(relative);
    if (file !== undefined) return { relative, file };
    if (relative === '' || [...folder.keys()].some((key) => key.startsWith(`${relative}/`))) {
      throw new FileError('invalid_params', 'path names a folder, not a file', { path: paramPath });
    }
    throw outside();
  }

  /** `fs/readFile` (spec 4.1). */
  read(sessionId: string, cwd: string, params: Json): Json {
    const { relative, file } = this.resolve(sessionId, cwd, String(params.path ?? ''));
    const bytes = file.bytes;
    const size = bytes.length;
    const offset = Number(params.offset ?? 0);
    const maxBytes = Math.min(MAX_READ, Math.max(MIN_READ, Number(params.maxBytes ?? DEFAULT_READ)));
    if (offset > size) throw new FileError('invalid_params', 'offset is past the end of the file', { path: 'params.offset' });
    const head = bytes.subarray(0, SNIFF);
    const binary = isBinary(head, size <= SNIFF);
    const ext = path.posix.extname(relative).slice(1).toLowerCase();
    const mediaType = magic(head) ?? TYPES[ext] ?? (binary ? 'application/octet-stream' : 'text/plain');
    const common = { path: relative, size, mtimeMs: file.mtimeMs, mediaType };
    if (binary) return { ...common, binary: true, encoding: 'none', offset: 0, length: 0, truncated: false };
    let start = offset;
    if (start > 0 && start < size && bytes[start - 1] !== 0x0a) {
      const newline = bytes.lastIndexOf(0x0a, start - 1);
      if (newline >= 0 && start - (newline + 1) <= LINE_SEEK) start = newline + 1;
      else if (newline < 0 && start <= LINE_SEEK) start = 0;
      else while (start > 0 && continuation(bytes[start])) start -= 1;
    }
    let end = Math.min(size, start + maxBytes);
    if (end < size) {
      const newline = bytes.subarray(start, end).lastIndexOf(0x0a);
      if (newline >= 0) end = start + newline + 1;
      else while (end > start + 1 && continuation(bytes[end])) end -= 1;
    }
    const content = new TextDecoder('utf-8').decode(bytes.subarray(start, end));
    return { ...common, binary: false, encoding: 'utf8', content, offset: start, length: end - start, truncated: end < size };
  }

  /** `GET /v1/file?sessionId&path` (and HEAD), for a paired request; `cwd` undefined for an unknown session. */
  serve(request: IncomingMessage, response: ServerResponse, url: URL, cwd: string | undefined): void {
    const fail = (status: number, code: string, message: string, data?: Json, headers: Record<string, string> = {}) =>
      void response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify({ error: { code, message, ...(data ? { data } : {}) } }));
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const requested = url.searchParams.get('path') ?? '';
    if (sessionId === '') return fail(400, 'invalid_params', 'sessionId is required', { path: 'sessionId' });
    if (requested === '') return fail(400, 'invalid_params', 'path is required', { path: 'path' });
    if (cwd === undefined) return fail(404, 'not_found', `no session ${sessionId}`, { sessionId });
    let found;
    try {
      found = this.resolve(sessionId, cwd, requested, 'path');
    } catch (error) {
      if (!(error instanceof FileError)) throw error;
      return fail(error.code === 'not_found' ? 404 : 400, error.code, error.message, error.data);
    }
    const { relative, file } = found;
    const size = file.bytes.length;
    const binary = isBinary(file.bytes.subarray(0, SNIFF), size <= SNIFF);
    const mediaType = magic(file.bytes) ?? TYPES[path.posix.extname(relative).slice(1).toLowerCase()] ?? (binary ? 'application/octet-stream' : 'text/plain');
    const etag = `"${size.toString(16)}-${Math.trunc(file.mtimeMs * 1000).toString(16)}"`;
    const base = {
      etag,
      'last-modified': new Date(file.mtimeMs).toUTCString(),
      'cache-control': 'private, no-cache',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
    };
    if ((request.headers['if-none-match'] ?? '').split(',').some((tag) => tag.trim() === etag)) {
      return void response.writeHead(304, base).end();
    }
    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (range !== null && (range[1] !== '' || range[2] !== '') && (request.headers['if-range'] === undefined || request.headers['if-range'] === etag)) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (start >= size) return fail(416, 'invalid_params', 'range not satisfiable', { path: 'range' }, { ...base, 'content-range': `bytes */${size}` });
        if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
      }
      partial = end >= start;
      if (!partial) [start, end] = [0, size - 1];
    }
    const textual = !binary && (mediaType.startsWith('text/') || mediaType === 'application/json');
    const name = relative.split('/').pop() ?? relative;
    const inline = mediaType.startsWith('image/') && mediaType !== 'image/svg+xml';
    response.writeHead(partial ? 206 : 200, {
      ...base,
      'content-type': textual ? `${mediaType}; charset=utf-8` : mediaType,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-length': String(size === 0 ? 0 : end - start + 1),
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    response.end(request.method === 'HEAD' || size === 0 ? undefined : file.bytes.subarray(start, end + 1));
  }
}
