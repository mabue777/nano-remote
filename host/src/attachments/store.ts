// Attachments (protocol-v1.md section 8.1): files a paired device uploads to the host before it sends the
// message that refers to them. One folder per session in the host's app folder, owner-only:
//
//   <app folder>/attachments/<sessionId>/            0700
//   <app folder>/attachments/<sessionId>/<blobId>/   0700
//       meta.json                                    0600  {blobId, sessionId, name, mediaType, size, createdAt}
//       <name>                                       0600  the bytes, under the uploaded file's name
//
// The file keeps its own name so an agent that gets it as a path ("Attached file: <path>") sees a
// meaningful name and extension. Blob ids are 128 random bits: knowing one is not enough to read it (the
// endpoint also wants a paired device), but ids never leak anything either. Deleting a session deletes
// its folder.
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, ensurePrivateDir } from '../config/private-files.js';

/** Largest attachment the host accepts (spec 8.1): 20 MiB per file. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Path prefix of the attachment endpoint; a blob's URL is this plus its id. */
export const BLOB_PATH = '/v1/blob';

/** `blb_` and 22 base64url characters (128 random bits). */
export const BLOB_ID = /^blb_[A-Za-z0-9_-]{22}$/;

/** Session ids as the host mints them (core/ids.ts); anything else never names a folder. */
const SESSION_ID = /^ses_[0-9a-z]+$/;

/** A media type as `type/subtype`, parameters dropped; anything else is stored as octet-stream. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const DEFAULT_NAME = 'attachment';
const MAX_NAME_LENGTH = 120;

export interface Attachment {
  blobId: string;
  sessionId: string;
  /** The file name as stored (made safe for a file system). */
  name: string;
  mediaType: string;
  size: number;
  /** Unix seconds. */
  createdAt: number;
  /** Absolute path of the bytes. */
  path: string;
}

/** The upload was larger than the limit; nothing was kept. */
export class AttachmentTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`attachment larger than ${maxBytes} bytes`);
  }
}

/** `/v1/blob/<blobId>` */
export function blobUrl(blobId: string): string {
  return `${BLOB_PATH}/${blobId}`;
}

/** The blob id of a `/v1/blob/<id>` URL, else undefined. */
export function blobIdOf(url: string): string | undefined {
  const prefix = `${BLOB_PATH}/`;
  if (!url.startsWith(prefix)) return undefined;
  const id = url.slice(prefix.length);
  return BLOB_ID.test(id) ? id : undefined;
}

/** `image/jpeg; charset=x` -> `image/jpeg`; unusable values -> application/octet-stream. */
export function cleanMediaType(value: string | undefined): string {
  const type = (value ?? '').split(';')[0]!.trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : DEFAULT_MEDIA_TYPE;
}

/**
 * A file name safe to store and to show an agent: the last path segment, no control characters, no
 * leading dots (no hidden files, never `..`), at most 120 characters with the extension kept.
 */
export function cleanName(value: string | undefined): string {
  const base = (value ?? '').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '');
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name === '' || name === 'meta.json' ? DEFAULT_NAME : name;
}

export interface AttachmentStoreOptions {
  /** The attachments folder, `<app folder>/attachments`. Created 0700 on first use. */
  dir: string;
  /** Default MAX_ATTACHMENT_BYTES. */
  maxBytes?: number;
  /** Unix seconds. */
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class AttachmentStore {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly byId = new Map<string, Attachment>();

  constructor(options: AttachmentStoreOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? (() => {});
    this.load();
  }

  /** The folder of one session's attachments (it may not exist yet). */
  sessionDir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
    return path.join(this.dir, sessionId);
  }

  /**
   * Streams an upload into the session's folder. Rejects with AttachmentTooLarge (and keeps nothing) as
   * soon as more than `maxBytes` arrived.
   */
  async save(sessionId: string, meta: { name?: string; mediaType?: string }, body: Readable): Promise<Attachment> {
    const sessionDir = this.sessionDir(sessionId);
    ensurePrivateDir(this.dir);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { mode: PRIVATE_DIR_MODE });
    const blobId = `blb_${randomBytes(16).toString('base64url')}`;
    const blobDir = path.join(sessionDir, blobId);
    mkdirSync(blobDir, { mode: PRIVATE_DIR_MODE });
    const name = cleanName(meta.name);
    const file = path.join(blobDir, name);
    let size = 0;
    try {
      size = await this.write(body, file);
    } catch (error) {
      await rm(blobDir, { recursive: true, force: true });
      throw error;
    }
    const attachment: Attachment = { blobId, sessionId, name, mediaType: cleanMediaType(meta.mediaType), size, createdAt: this.now(), path: file };
    const { path: _path, ...record } = attachment;
    writeFileSync(path.join(blobDir, 'meta.json'), JSON.stringify(record), { mode: PRIVATE_FILE_MODE });
    chmodSync(file, PRIVATE_FILE_MODE);
    this.byId.set(blobId, attachment);
    return attachment;
  }

  /**
   * Copies `body` into `file`, counting bytes. Past the limit it stops writing and rejects, but keeps
   * reading (and dropping) the body instead of destroying it, so the caller can still answer 413 on the
   * same connection.
   */
  private write(body: Readable, file: string): Promise<number> {
    const max = this.maxBytes;
    return new Promise((resolve, reject) => {
      const out = createWriteStream(file, { mode: PRIVATE_FILE_MODE, flags: 'wx' });
      let size = 0;
      let done = false;
      let ended = false;
      const stop = (error: Error): void => {
        if (done) return;
        done = true;
        out.destroy();
        body.resume();
        reject(error);
      };
      body.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > max) return stop(new AttachmentTooLarge(max));
        if (!out.write(chunk)) {
          body.pause();
          out.once('drain', () => body.resume());
        }
      });
      body.once('end', () => {
        ended = true;
        if (!done) out.end();
      });
      body.once('error', stop);
      body.once('close', () => {
        if (!ended) stop(new Error('the upload ended early'));
      });
      out.once('error', stop);
      out.once('finish', () => {
        if (done) return;
        done = true;
        resolve(size);
      });
    });
  }

  get(blobId: string): Attachment | undefined {
    return this.byId.get(blobId);
  }

  /** The attachment a `/v1/blob/<id>` URL names when it belongs to `sessionId`, else undefined. */
  resolve(sessionId: string, url: string): Attachment | undefined {
    const blobId = blobIdOf(url);
    const attachment = blobId === undefined ? undefined : this.byId.get(blobId);
    return attachment?.sessionId === sessionId ? attachment : undefined;
  }

  /** Every attachment of a session, oldest first. */
  list(sessionId: string): Attachment[] {
    return [...this.byId.values()].filter((a) => a.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Deletes a session's folder and forgets its attachments (session/delete). */
  async deleteSession(sessionId: string): Promise<void> {
    for (const [blobId, attachment] of this.byId) if (attachment.sessionId === sessionId) this.byId.delete(blobId);
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /** Reads what earlier runs stored; a folder without a readable meta.json is skipped (and logged). */
  private load(): void {
    if (!existsSync(this.dir)) return;
    for (const sessionId of readdirSync(this.dir)) {
      if (!SESSION_ID.test(sessionId)) continue;
      for (const blobId of readdirSync(path.join(this.dir, sessionId))) {
        if (!BLOB_ID.test(blobId)) continue;
        const blobDir = path.join(this.dir, sessionId, blobId);
        try {
          const meta = JSON.parse(readFileSync(path.join(blobDir, 'meta.json'), 'utf8')) as Omit<Attachment, 'path'>;
          const file = path.join(blobDir, cleanName(meta.name));
          if (meta.blobId !== blobId || meta.sessionId !== sessionId || !existsSync(file)) throw new Error('meta.json does not match its folder');
          this.byId.set(blobId, { ...meta, path: file });
        } catch (error) {
          this.log(`attachment ${sessionId}/${blobId} skipped`, error);
        }
      }
    }
  }
}

/** Removes the attachment folders of sessions that no longer exist (deleted while the host was down). */
export function deletedSessionDirs(store: AttachmentStore, exists: (sessionId: string) => boolean): string[] {
  if (!existsSync(store.dir)) return [];
  const removed: string[] = [];
  for (const sessionId of readdirSync(store.dir)) {
    if (!SESSION_ID.test(sessionId) || exists(sessionId)) continue;
    rmSync(path.join(store.dir, sessionId), { recursive: true, force: true });
    removed.push(sessionId);
  }
  return removed;
}
