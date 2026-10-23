// The attachment store on disk (spec 8.1): owner-only folders per session, safe names, the size limit,
// reload after a restart, and deletion with the session.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AttachmentStore,
  AttachmentTooLarge,
  BLOB_ID,
  MAX_ATTACHMENT_BYTES,
  blobIdOf,
  blobUrl,
  cleanMediaType,
  cleanName,
  deletedSessionDirs,
} from './store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nano-attachments-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SES = 'ses_0abc123';
const mode = (file: string) => statSync(file).mode & 0o777;
const body = (...chunks: (string | Buffer)[]) => Readable.from(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));

describe('names, media types and URLs', () => {
  it('cleanName keeps the last segment, drops control characters and leading dots, and caps the length', () => {
    expect(cleanName('photo.jpg')).toBe('photo.jpg');
    expect(cleanName('../../etc/passwd')).toBe('passwd');
    expect(cleanName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(cleanName('..')).toBe('attachment');
    expect(cleanName('.env')).toBe('env');
    expect(cleanName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(cleanName('')).toBe('attachment');
    expect(cleanName(undefined)).toBe('attachment');
    expect(cleanName('meta.json')).toBe('attachment');
    const long = cleanName(`${'x'.repeat(300)}.png`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.png')).toBe(true);
  });

  it('cleanMediaType drops parameters and lower-cases; anything odd is octet-stream', () => {
    expect(cleanMediaType('Image/JPEG; q=1')).toBe('image/jpeg');
    expect(cleanMediaType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(cleanMediaType('')).toBe('application/octet-stream');
    expect(cleanMediaType(undefined)).toBe('application/octet-stream');
    expect(cleanMediaType('text/html\r\nx: y')).toBe('application/octet-stream');
    expect(cleanMediaType('nonsense')).toBe('application/octet-stream');
  });

  it('blob URLs round-trip; anything else is no blob', () => {
    expect(blobUrl('blb_AAAAAAAAAAAAAAAAAAAAAA')).toBe('/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA');
    expect(blobIdOf('/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA')).toBe('blb_AAAAAAAAAAAAAAAAAAAAAA');
    expect(blobIdOf('/v1/blob/blb_short')).toBeUndefined();
    expect(blobIdOf('/v1/blob/../x')).toBeUndefined();
    expect(blobIdOf('data:image/png;base64,AA')).toBeUndefined();
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('AttachmentStore', () => {
  it('stores bytes 0600 under their name in 0700 session and blob folders, with meta.json', async () => {
    const store = new AttachmentStore({ dir: path.join(root, 'attachments'), now: () => 1700 });
    const a = await store.save(SES, { name: 'shot.png', mediaType: 'image/png' }, body('ab', 'cd'));
    expect(a).toMatchObject({ sessionId: SES, name: 'shot.png', mediaType: 'image/png', size: 4, createdAt: 1700 });
    expect(a.blobId).toMatch(BLOB_ID);
    expect(a.path).toBe(path.join(root, 'attachments', SES, a.blobId, 'shot.png'));
    expect(readFileSync(a.path, 'utf8')).toBe('abcd');
    expect(mode(a.path)).toBe(0o600);
    expect(mode(path.join(root, 'attachments'))).toBe(0o700);
    expect(mode(path.join(root, 'attachments', SES))).toBe(0o700);
    expect(mode(path.dirname(a.path))).toBe(0o700);
    expect(mode(path.join(path.dirname(a.path), 'meta.json'))).toBe(0o600);
    expect(store.get(a.blobId)).toEqual(a);
    expect(store.list(SES)).toEqual([a]);
  });

  it('every upload gets its own id, also with the same name', async () => {
    const store = new AttachmentStore({ dir: root });
    const a = await store.save(SES, { name: 'x.txt' }, body('1'));
    const b = await store.save(SES, { name: 'x.txt' }, body('2'));
    expect(a.blobId).not.toBe(b.blobId);
    expect(readFileSync(a.path, 'utf8')).toBe('1');
    expect(readFileSync(b.path, 'utf8')).toBe('2');
    expect(a.mediaType).toBe('application/octet-stream');
  });

  it('resolve answers only for a blob URL of the same session', async () => {
    const store = new AttachmentStore({ dir: root });
    const a = await store.save(SES, { name: 'x.txt' }, body('1'));
    expect(store.resolve(SES, blobUrl(a.blobId))).toEqual(a);
    expect(store.resolve('ses_other', blobUrl(a.blobId))).toBeUndefined();
    expect(store.resolve(SES, '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
    expect(store.resolve(SES, 'data:image/png;base64,AA')).toBeUndefined();
  });

  it('refuses a body past the limit, keeps nothing, and keeps draining it', async () => {
    const store = new AttachmentStore({ dir: root, maxBytes: 5 });
    const stream = new PassThrough();
    const saving = store.save(SES, { name: 'big.bin' }, stream);
    stream.write(Buffer.alloc(4));
    stream.write(Buffer.alloc(4));
    await expect(saving).rejects.toBeInstanceOf(AttachmentTooLarge);
    await expect(saving).rejects.toMatchObject({ maxBytes: 5 });
    stream.end(Buffer.alloc(100));
    expect(store.list(SES)).toEqual([]);
    expect(existsSync(path.join(root, SES)) ? readdirSync(path.join(root, SES)) : []).toEqual([]);
    // Exactly at the limit is fine.
    expect((await store.save(SES, {}, body(Buffer.alloc(5)))).size).toBe(5);
  });

  it('an upload that breaks off keeps nothing', async () => {
    const store = new AttachmentStore({ dir: root });
    const stream = new PassThrough();
    const saving = store.save(SES, { name: 'cut.bin' }, stream);
    stream.write('abc');
    stream.destroy();
    await expect(saving).rejects.toThrow(/ended early/);
    const errored = new PassThrough();
    const failing = store.save(SES, { name: 'err.bin' }, errored);
    errored.destroy(new Error('socket reset'));
    await expect(failing).rejects.toThrow(/socket reset/);
    expect(store.list(SES)).toEqual([]);
  });

  it('a slow disk pauses the body until the file drains', async () => {
    const store = new AttachmentStore({ dir: root });
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const a = await store.save(SES, { name: 'big.bin' }, body(big, big, big));
    expect(a.size).toBe(9 * 1024 * 1024);
    expect(statSync(a.path).size).toBe(9 * 1024 * 1024);
  });

  it('refuses a session id that is not one', async () => {
    const store = new AttachmentStore({ dir: root });
    await expect(store.save('../etc', {}, body('x'))).rejects.toThrow(/not a session id/);
    expect(() => store.sessionDir('ses_ok/..')).toThrow();
  });

  it('reloads what an earlier run stored and skips folders it cannot read', async () => {
    const dir = path.join(root, 'attachments');
    const first = new AttachmentStore({ dir });
    const a = await first.save(SES, { name: 'a.txt', mediaType: 'text/plain' }, body('hello'));
    // Noise the loader must skip: a non-session folder, a non-blob folder, broken and lying meta.json.
    mkdirSync(path.join(dir, 'tmp'));
    mkdirSync(path.join(dir, SES, 'notablob'));
    const broken = path.join(dir, SES, 'blb_BBBBBBBBBBBBBBBBBBBBBB');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'meta.json'), '{');
    const lying = path.join(dir, SES, 'blb_CCCCCCCCCCCCCCCCCCCCCC');
    mkdirSync(lying);
    writeFileSync(path.join(lying, 'meta.json'), JSON.stringify({ blobId: 'blb_DDDDDDDDDDDDDDDDDDDDDD', sessionId: SES, name: 'x' }));
    const logs: string[] = [];
    const second = new AttachmentStore({ dir, log: (m) => logs.push(m) });
    expect(second.get(a.blobId)).toEqual(a);
    expect(second.list(SES)).toHaveLength(1);
    expect(logs).toHaveLength(2);
    expect(new AttachmentStore({ dir: path.join(root, 'missing') }).list(SES)).toEqual([]);
  });

  it('deleteSession removes the folder and forgets its attachments; others stay', async () => {
    const store = new AttachmentStore({ dir: root });
    const a = await store.save(SES, { name: 'a' }, body('1'));
    const b = await store.save('ses_0keep', { name: 'b' }, body('2'));
    await store.deleteSession(SES);
    expect(existsSync(path.join(root, SES))).toBe(false);
    expect(store.get(a.blobId)).toBeUndefined();
    expect(store.get(b.blobId)).toEqual(b);
    await store.deleteSession('ses_0never'); // nothing there: fine
  });

  it('deletedSessionDirs removes the folders of sessions that no longer exist', async () => {
    const store = new AttachmentStore({ dir: root });
    await store.save(SES, {}, body('1'));
    await store.save('ses_0keep', {}, body('2'));
    mkdirSync(path.join(root, 'not-a-session'));
    expect(deletedSessionDirs(store, (id) => id === 'ses_0keep')).toEqual([SES]);
    expect(existsSync(path.join(root, SES))).toBe(false);
    expect(existsSync(path.join(root, 'ses_0keep'))).toBe(true);
    expect(existsSync(path.join(root, 'not-a-session'))).toBe(true);
    expect(deletedSessionDirs(new AttachmentStore({ dir: path.join(root, 'none') }), () => false)).toEqual([]);
  });
});
