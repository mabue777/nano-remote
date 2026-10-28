// The scope rule and the reads of a session folder (spec 4.1): every way out of the folder is refused with
// the same `not_found`, the binary sniff, media types, and text ranges that never split a line or a UTF-8
// character and always make progress.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '../errors.js';
import {
  DEFAULT_FILE_READ_BYTES,
  LINE_SEEK,
  MAX_FILE_READ_BYTES,
  MIN_READ_BYTES,
  SNIFF_BYTES,
  looksBinary,
  mediaTypeOf,
  readSessionDirectory,
  readSessionFile,
  sniffMagic,
} from './read.js';
import { resolveInSession } from './scope.js';

let base: string;
/** The session folder. */
let cwd: string;
/** A sibling of the session folder holding a secret. */
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'nano-files-')));
  cwd = path.join(base, 'repo');
  outside = path.join(base, 'secret');
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'key.txt'), 'TOP SECRET\n');
  writeFileSync(path.join(cwd, 'README.md'), '# Hello\n');
  writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The error a read throws, for matching. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string; data: unknown }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    const e = error as RpcError;
    return { code: e.code, message: e.message, data: e.data };
  }
  throw new Error('expected a failure');
}

const NOT_FOUND = { code: 'not_found', message: 'no such file or folder in the session folder' };

describe('scope', () => {
  it('a relative path, ./ and an absolute path inside the folder resolve', async () => {
    expect(await resolveInSession(cwd, 'src/a.ts')).toEqual({ root: cwd, real: path.join(cwd, 'src', 'a.ts'), relative: 'src/a.ts' });
    expect((await resolveInSession(cwd, './src/../src/a.ts')).relative).toBe('src/a.ts');
    expect((await resolveInSession(cwd, path.join(cwd, 'README.md'))).relative).toBe('README.md');
    expect((await resolveInSession(cwd, '')).relative).toBe('');
    expect((await resolveInSession(cwd, '.')).relative).toBe('');
  });

  it('.. out of the folder is not_found, with nothing about what is outside', async () => {
    for (const requested of ['../secret/key.txt', 'src/../../secret/key.txt', '..', '../secret/missing.txt']) {
      expect(await failure(resolveInSession(cwd, requested))).toEqual({ ...NOT_FOUND, data: { path: requested } });
    }
  });

  it('an absolute path outside the folder is not_found, the same as a missing file', async () => {
    const secret = path.join(outside, 'key.txt');
    expect(await failure(readSessionFile(cwd, secret))).toEqual({ ...NOT_FOUND, data: { path: secret } });
    expect(await failure(readSessionFile(cwd, '/etc/hosts'))).toEqual({ ...NOT_FOUND, data: { path: '/etc/hosts' } });
    expect(await failure(readSessionFile(cwd, 'nope.txt'))).toEqual({ ...NOT_FOUND, data: { path: 'nope.txt' } });
  });

  it('a sibling folder whose name starts with the session folder name is outside', async () => {
    mkdirSync(`${cwd}-evil`);
    writeFileSync(path.join(`${cwd}-evil`, 'x.txt'), 'x');
    expect((await failure(readSessionFile(cwd, '../repo-evil/x.txt'))).code).toBe('not_found');
    expect((await failure(readSessionFile(cwd, path.join(`${cwd}-evil`, 'x.txt')))).code).toBe('not_found');
  });

  it('symlinks pointing out of the folder (file, folder, chained) are not_found', async () => {
    symlinkSync(path.join(outside, 'key.txt'), path.join(cwd, 'link-file'));
    symlinkSync(outside, path.join(cwd, 'link-dir'));
    symlinkSync(path.join(cwd, 'link-dir'), path.join(cwd, 'src', 'chained'));
    symlinkSync('../../secret/key.txt', path.join(cwd, 'src', 'relative-link'));
    for (const requested of ['link-file', 'link-dir/key.txt', 'src/chained/key.txt', 'src/relative-link']) {
      expect(await failure(readSessionFile(cwd, requested))).toEqual({ ...NOT_FOUND, data: { path: requested } });
    }
    expect((await failure(readSessionDirectory(cwd, 'link-dir'))).code).toBe('not_found');
  });

  it('a symlink that stays inside the folder is followed and reported by its real path', async () => {
    symlinkSync(path.join(cwd, 'src', 'a.ts'), path.join(cwd, 'alias.ts'));
    const result = await readSessionFile(cwd, 'alias.ts');
    expect(result).toMatchObject({ path: 'src/a.ts', content: 'export const a = 1;\n' });
  });

  it('a session folder reached through a symlink (like /tmp on macOS) still scopes correctly', async () => {
    const linked = path.join(base, 'linked-repo');
    symlinkSync(cwd, linked);
    expect(await readSessionFile(linked, 'src/a.ts')).toMatchObject({ path: 'src/a.ts' });
    expect((await failure(readSessionFile(linked, '../secret/key.txt'))).code).toBe('not_found');
  });

  it('a symlink loop, a deleted session folder and a NUL byte are refused', async () => {
    symlinkSync(path.join(cwd, 'loop-b'), path.join(cwd, 'loop-a'));
    symlinkSync(path.join(cwd, 'loop-a'), path.join(cwd, 'loop-b'));
    expect((await failure(readSessionFile(cwd, 'loop-a'))).code).toBe('not_found');
    expect(await failure(readSessionFile(cwd, 'a\0b'))).toEqual({ code: 'invalid_params', message: 'path must not contain NUL', data: { path: 'params.path' } });
    rmSync(cwd, { recursive: true });
    expect((await failure(readSessionFile(cwd, 'README.md'))).code).toBe('not_found');
    expect((await failure(readSessionFile('', 'README.md'))).code).toBe('not_found');
    expect((await failure(readSessionFile('relative/cwd', 'README.md'))).code).toBe('not_found');
  });

  it('a folder or a FIFO is invalid_params, and a FIFO does not hang the host', async () => {
    expect(await failure(readSessionFile(cwd, 'src'))).toEqual({ code: 'invalid_params', message: 'path names a folder, not a file', data: { path: 'params.path' } });
    execFileSync('mkfifo', [path.join(cwd, 'pipe')]);
    expect(await failure(readSessionFile(cwd, 'pipe'))).toEqual({ code: 'invalid_params', message: 'path is not a regular file', data: { path: 'params.path' } });
  });
});

describe('binary sniff and media type', () => {
  it('a NUL byte or invalid UTF-8 in the first 8 KiB is binary; a sequence cut by the sniff window is not', () => {
    expect(looksBinary(Buffer.from('plain text\n'), true)).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]), true)).toBe(true);
    expect(looksBinary(Buffer.from([0x61, 0xff, 0x62]), true)).toBe(true);
    const cut = Buffer.from('é', 'utf8').subarray(0, 1);
    expect(looksBinary(Buffer.concat([Buffer.from('ab'), cut]), false)).toBe(false);
    expect(looksBinary(Buffer.concat([Buffer.from('ab'), cut]), true)).toBe(true);
  });

  it('the first bytes win over the extension for PNG, JPEG, GIF, WebP and PDF', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(sniffMagic(png)).toBe('image/png');
    expect(mediaTypeOf('photo.jpg', png, true)).toBe('image/png');
    expect(sniffMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMagic(Buffer.from('GIF89a..'))).toBe('image/gif');
    expect(sniffMagic(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMagic(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(mediaTypeOf('notes.MD', Buffer.from('# x'), false)).toBe('text/markdown');
    expect(mediaTypeOf('Makefile', Buffer.from('all:'), false)).toBe('text/plain');
    expect(mediaTypeOf('blob.bin', Buffer.from([0]), true)).toBe('application/octet-stream');
  });

  it('fs/readFile on a binary file answers its kind and size, no content', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    writeFileSync(path.join(cwd, 'shot.png'), png);
    const result = await readSessionFile(cwd, 'shot.png');
    expect(result).toEqual({
      path: 'shot.png',
      size: png.length,
      mtimeMs: expect.any(Number),
      mediaType: 'image/png',
      binary: true,
      encoding: 'none',
      offset: 0,
      length: 0,
      truncated: false,
    });
    writeFileSync(path.join(cwd, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(await readSessionFile(cwd, 'latin1.txt')).toMatchObject({ binary: true, encoding: 'none', mediaType: 'text/plain' });
  });
});

describe('text ranges', () => {
  it('a small file comes whole, with size, mtime and media type', async () => {
    expect(await readSessionFile(cwd, 'README.md')).toEqual({
      path: 'README.md',
      size: 8,
      mtimeMs: expect.any(Number),
      mediaType: 'text/markdown',
      binary: false,
      encoding: 'utf8',
      content: '# Hello\n',
      offset: 0,
      length: 8,
      truncated: false,
    });
    writeFileSync(path.join(cwd, 'empty.txt'), '');
    expect(await readSessionFile(cwd, 'empty.txt')).toMatchObject({ content: '', length: 0, truncated: false, binary: false });
  });

  it('a long file stops after its last whole line, and offset + length continues exactly', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(i % 37)}`);
    const text = `${lines.join('\n')}\n`;
    writeFileSync(path.join(cwd, 'long.txt'), text);
    let offset = 0;
    let joined = '';
    let calls = 0;
    for (;;) {
      const page = await readSessionFile(cwd, 'long.txt', { offset, maxBytes: 10_000 });
      expect(page.offset).toBe(offset);
      expect(page.length).toBeLessThanOrEqual(10_000);
      if (page.truncated) expect(page.content!.endsWith('\n')).toBe(true);
      joined += page.content!;
      offset = page.offset + page.length;
      calls += 1;
      if (!page.truncated) break;
    }
    expect(joined).toBe(text);
    expect(offset).toBe(Buffer.byteLength(text));
    expect(calls).toBeGreaterThan(5);
  });

  it('an offset inside a line moves back to the line start', async () => {
    writeFileSync(path.join(cwd, 'f.txt'), 'first line\nsecond line\nthird\n');
    expect(await readSessionFile(cwd, 'f.txt', { offset: 15 })).toMatchObject({ offset: 11, content: 'second line\nthird\n' });
    expect(await readSessionFile(cwd, 'f.txt', { offset: 11 })).toMatchObject({ offset: 11 });
    expect(await readSessionFile(cwd, 'f.txt', { offset: 29 })).toMatchObject({ offset: 29, content: '', truncated: false });
    expect(await failure(readSessionFile(cwd, 'f.txt', { offset: 30 }))).toMatchObject({ code: 'invalid_params', data: { path: 'params.offset' } });
  });

  it('never splits a UTF-8 character, at either end, even in a line longer than the window', async () => {
    // One line of 3-byte characters and emoji, far longer than one window: the window cannot end at a newline.
    const line = '€😀'.repeat(20_000);
    writeFileSync(path.join(cwd, 'wide.txt'), line);
    const size = Buffer.byteLength(line);
    let offset = 0;
    let joined = '';
    for (let calls = 0; ; calls += 1) {
      expect(calls).toBeLessThan(100);
      const page = await readSessionFile(cwd, 'wide.txt', { offset, maxBytes: MIN_READ_BYTES });
      expect(page.content).not.toContain('�');
      joined += page.content!;
      offset = page.offset + page.length;
      if (!page.truncated) break;
    }
    expect(joined).toBe(line);
    expect(offset).toBe(size);
    // An offset that lands inside a character (byte 1 of '€') moves back to its first byte.
    // 7 * 300 is the first byte of a '€', past LINE_SEEK, so no line start is in reach.
    expect(7 * 300).toBeGreaterThan(LINE_SEEK);
    expect(await readSessionFile(cwd, 'wide.txt', { offset: 7 * 300 + 1, maxBytes: MIN_READ_BYTES })).toMatchObject({ offset: 7 * 300 });
    expect(await readSessionFile(cwd, 'wide.txt', { offset: 7 * 300 + 2, maxBytes: MIN_READ_BYTES })).toMatchObject({ offset: 7 * 300 });
  });

  it('maxBytes defaults to 256 KiB, is raised to 4 KiB and capped at 1 MiB', async () => {
    const big = `${'y'.repeat(99)}\n`.repeat(20_000); // 2 000 000 bytes
    writeFileSync(path.join(cwd, 'big.txt'), big);
    expect((await readSessionFile(cwd, 'big.txt')).length).toBe(DEFAULT_FILE_READ_BYTES - (DEFAULT_FILE_READ_BYTES % 100));
    expect((await readSessionFile(cwd, 'big.txt', { maxBytes: 1 })).length).toBe(MIN_READ_BYTES - (MIN_READ_BYTES % 100));
    const capped = await readSessionFile(cwd, 'big.txt', { maxBytes: 50 * 1024 * 1024 });
    expect(capped.length).toBe(MAX_FILE_READ_BYTES - (MAX_FILE_READ_BYTES % 100));
    expect(capped.truncated).toBe(true);
  });

  it('bad UTF-8 after the sniffed head shows as U+FFFD instead of failing', async () => {
    const head = 'a'.repeat(SNIFF_BYTES + 10);
    writeFileSync(path.join(cwd, 'late.txt'), Buffer.concat([Buffer.from(head), Buffer.from([0xff, 0x0a])]));
    const result = await readSessionFile(cwd, 'late.txt');
    expect(result.binary).toBe(false);
    expect(result.content!.endsWith('�\n')).toBe(true);
  });
});

describe('fs/readDirectory with a session', () => {
  it('lists relative paths with size, mtime and hidden; links out of the folder are left out', async () => {
    writeFileSync(path.join(cwd, '.env'), 'X=1\n');
    symlinkSync(outside, path.join(cwd, 'z-out'));
    symlinkSync(path.join(outside, 'key.txt'), path.join(cwd, 'z-out-file'));
    symlinkSync(path.join(cwd, 'src'), path.join(cwd, 'z-in'));
    symlinkSync(path.join(cwd, 'missing'), path.join(cwd, 'z-broken'));
    const entries = await readSessionDirectory(cwd, '.');
    expect(entries.map((e) => [e.name, e.kind, e.path, e.size, e.hidden])).toEqual([
      ['src', 'dir', 'src', undefined, false],
      ['z-in', 'dir', 'z-in', undefined, false],
      ['.env', 'file', '.env', 4, true],
      ['README.md', 'file', 'README.md', 8, false],
    ]);
    expect(entries.every((e) => typeof e.mtimeMs === 'number')).toBe(true);
    expect(await readSessionDirectory(cwd, 'src')).toEqual([
      { name: 'a.ts', kind: 'file', path: 'src/a.ts', size: 20, mtimeMs: expect.any(Number), hidden: false },
    ]);
    expect(await readSessionDirectory(cwd, '')).toHaveLength(4);
  });

  it('outside the folder, a file, or a missing folder is not_found', async () => {
    for (const requested of ['..', '../secret', outside, 'README.md', 'nope', '/']) {
      expect((await failure(readSessionDirectory(cwd, requested))).code).toBe('not_found');
    }
  });
});
