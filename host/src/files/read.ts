// Reading files of a session folder (protocol-v1.md section 4.1): `fs/readFile` text ranges, the binary
// sniff, media types, and `fs/readDirectory` with a `sessionId`. Every path goes through scope.ts first.
//
// Ranges. A text answer covers bytes [offset, offset + length) of the file. The requested offset moves back
// to the start of its line when that start is at most LINE_SEEK bytes earlier, otherwise only back to the
// start of a UTF-8 character. An answer that stops before the end of the file ends right after its last
// newline when it holds one, otherwise at a character boundary. So "show more" is offset = previous
// offset + length: that is a line start (no move), or the middle of a line longer than the window, where
// the line start is further back than LINE_SEEK and the offset stays put. Every answer makes progress
// because a window is never smaller than MIN_READ_BYTES, which is larger than LINE_SEEK plus three.
import { constants } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { DirEntry } from '../generated/common.js';
import type { FsReadFileResult } from '../generated/methods.js';
import { RpcError } from '../errors.js';
import { outOfScope, resolveInSession } from './scope.js';

/** `limits.maxFileReadBytes`: the most one `fs/readFile` answer carries (1 MiB). */
export const MAX_FILE_READ_BYTES = 1024 * 1024;
/** `maxBytes` when the request names none (256 KiB). */
export const DEFAULT_FILE_READ_BYTES = 256 * 1024;
/** The smallest window the host reads, whatever `maxBytes` says. */
export const MIN_READ_BYTES = 4096;
/** How far back an offset may move to reach its line start. */
export const LINE_SEEK = 1024;
/** Bytes at the start of a file that decide whether it is text. */
export const SNIFF_BYTES = 8192;

const NEWLINE = 0x0a;

/** Media types by extension; the first bytes win for the formats `sniffMagic` knows. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
};

/** The media type the first bytes prove (PNG, JPEG, GIF, WebP, PDF), or undefined. */
export function sniffMagic(head: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => Buffer.from(head.subarray(from, to)).toString('latin1');
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === 'PNG' && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  return undefined;
}

/**
 * Binary when the first bytes hold a NUL or are not valid UTF-8. A sequence cut by the end of the sniffed
 * bytes counts as valid when the file goes on (`complete` false).
 */
export function looksBinary(head: Uint8Array, complete: boolean): boolean {
  if (head.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: !complete });
    return false;
  } catch {
    return true;
  }
}

/** The media type of a file from its name and first bytes. */
export function mediaTypeOf(name: string, head: Uint8Array, binary: boolean): string {
  const magic = sniffMagic(head);
  if (magic !== undefined) return magic;
  const extension = path.extname(name).slice(1).toLowerCase();
  return BY_EXTENSION[extension] ?? (binary ? 'application/octet-stream' : 'text/plain');
}

const isContinuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

/** An open regular file of a session folder with its stat; the caller closes it. */
export interface OpenedFile {
  handle: FileHandle;
  size: number;
  mtimeMs: number;
  /** '/'-separated, relative to the session folder. */
  relative: string;
  /** `realpath` of the file. */
  real: string;
}

/**
 * Opens a regular file inside the session folder for reading. The last component is opened with
 * O_NOFOLLOW (it is a `realpath`, so a link there now was swapped in after the check) and O_NONBLOCK (a
 * FIFO must not hang the host). A folder or anything but a regular file is `invalid_params`.
 */
export async function openInSession(cwd: string, requested: string, paramPath = 'params.path'): Promise<OpenedFile> {
  const scoped = await resolveInSession(cwd, requested, paramPath);
  let handle: FileHandle;
  try {
    handle = await open(scoped.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') throw outOfScope(requested);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw RpcError.invalidParams(paramPath, info.isDirectory() ? 'path names a folder, not a file' : 'path is not a regular file');
    }
    return { handle, size: info.size, mtimeMs: info.mtimeMs, relative: scoped.relative, real: scoped.real };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Reads up to `length` bytes at `position` (fewer at the end of the file). */
export async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

/** The window of a text file: where it starts and ends, after the line and UTF-8 rules above. */
export function textWindow(bytes: Buffer, base: number, offset: number, maxBytes: number, size: number): { start: number; end: number } {
  const at = (position: number) => bytes[position - base];
  let start = offset;
  if (start > 0 && start < size && at(start - 1) !== NEWLINE) {
    let lineStart: number | undefined;
    for (let i = start - 1; i >= Math.max(base, start - LINE_SEEK); i -= 1) {
      if (at(i - 1) === NEWLINE || i === 0) {
        lineStart = i;
        break;
      }
    }
    if (lineStart !== undefined) start = lineStart;
    else for (let moved = 0; moved < 3 && start > 0 && isContinuation(at(start)); moved += 1) start -= 1;
  }
  let end = Math.min(size, start + maxBytes);
  if (end < size) {
    let lastNewline = -1;
    for (let i = end - 1; i >= start; i -= 1) {
      if (at(i) === NEWLINE) {
        lastNewline = i;
        break;
      }
    }
    if (lastNewline >= 0) end = lastNewline + 1;
    else for (let moved = 0; moved < 3 && end > start + 1 && isContinuation(at(end)); moved += 1) end -= 1;
  }
  return { start, end };
}

/** `fs/readFile` (spec 4.1) on the session folder `cwd`. */
export async function readSessionFile(
  cwd: string,
  requested: string,
  options: { offset?: number | undefined; maxBytes?: number | undefined } = {},
): Promise<FsReadFileResult> {
  const offset = options.offset ?? 0;
  const maxBytes = Math.min(MAX_FILE_READ_BYTES, Math.max(MIN_READ_BYTES, options.maxBytes ?? DEFAULT_FILE_READ_BYTES));
  const file = await openInSession(cwd, requested);
  try {
    const { handle, size, mtimeMs, relative } = file;
    if (offset > size) throw RpcError.invalidParams('params.offset', `offset is past the end of the file (${size} bytes)`);
    const head = await readAt(handle, 0, Math.min(size, SNIFF_BYTES));
    const binary = looksBinary(head, size <= SNIFF_BYTES);
    const mediaType = mediaTypeOf(relative, head, binary);
    const common = { path: relative, size, mtimeMs, mediaType };
    if (binary) return { ...common, binary: true, encoding: 'none', offset: 0, length: 0, truncated: false };
    const base = Math.max(0, offset - LINE_SEEK - 1);
    // One byte past the window, to see whether the window's end splits a character.
    const bytes = await readAt(handle, base, Math.min(size, offset + maxBytes + 1) - base);
    const { start, end } = textWindow(bytes, base, offset, maxBytes, size);
    // Past the sniffed head the file may still hold bad UTF-8: it shows as U+FFFD, never as an error.
    const content = new TextDecoder('utf-8').decode(bytes.subarray(start - base, end - base));
    return { ...common, binary: false, encoding: 'utf8', content, offset: start, length: end - start, truncated: end < size };
  } finally {
    await file.handle.close();
  }
}

/**
 * `fs/readDirectory {path, sessionId}` (spec 4.1): `path` relative to the session folder, entries with
 * `size` (files), `mtimeMs` and `hidden`, paths relative to the folder. Folders first, then by name. A link
 * is listed as what it points to, and only when that is inside the folder; others are skipped.
 */
export async function readSessionDirectory(cwd: string, requested: string): Promise<DirEntry[]> {
  const scoped = await resolveInSession(cwd, requested);
  let dirents;
  try {
    dirents = await readdir(scoped.real, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') throw outOfScope(requested);
    throw error;
  }
  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    const full = path.join(scoped.real, dirent.name);
    if (dirent.isSymbolicLink()) {
      const inside = await resolveInSession(scoped.root, full).then(
        () => true,
        () => false,
      );
      if (!inside) continue;
    } else if (!dirent.isDirectory() && !dirent.isFile()) continue;
    const info = await stat(full).catch(() => undefined);
    const kind: DirEntry['kind'] | undefined = info?.isDirectory() ? 'dir' : info?.isFile() ? 'file' : undefined;
    if (info === undefined || kind === undefined) continue;
    entries.push({
      name: dirent.name,
      kind,
      path: scoped.relative === '' ? dirent.name : `${scoped.relative}/${dirent.name}`,
      ...(kind === 'file' ? { size: info.size } : {}),
      mtimeMs: info.mtimeMs,
      hidden: dirent.name.startsWith('.'),
    });
  }
  return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}
