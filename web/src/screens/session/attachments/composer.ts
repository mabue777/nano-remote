// The composer's attachments (spec 8.1): what the user picked for the next message, each uploaded to the
// host right away so that sending is instant. An entry is `preparing` (a photo being downscaled),
// `uploading` (with progress), `ready` (the host answered its URL) or `failed` (with one sentence and a
// retry). Removing an entry aborts its upload. The message can go once every entry is ready; its input
// parts are then `{type:"image", url}` for photos and `{type:"file", url, name, mediaType}` for the rest.
import type { InputPart } from '../../../replica/types';
import { errorText } from '../../model';
import { prepareImage, type ResizeDeps } from './resize';
import { megabytes, UploadAborted, type UploadHandle, type UploadResult, type Uploader } from './upload';

/** At most this many attachments go with one message. */
export const MAX_ATTACHMENTS = 10;

export type AttachmentState = 'preparing' | 'uploading' | 'ready' | 'failed';

export interface AttachmentEntry {
  readonly id: string;
  /** The name as picked, then as the host stored it. */
  name: string;
  kind: 'image' | 'file';
  mediaType: string;
  size: number;
  state: AttachmentState;
  /** Upload progress, 0 to 1. */
  progress: number;
  error?: string;
  /** A local object URL for the thumbnail of an image. */
  previewUrl?: string;
  uploaded?: UploadResult;
}

/** What the agent takes (capabilities.attachments) and how large a file the host accepts. */
export interface AttachmentRules {
  images: boolean;
  files: boolean;
  maxBytes: number;
}

/** A picked file: the browser's File fits. */
export interface PickedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface ComposerAttachmentsOptions {
  sessionId: string;
  uploader: Uploader;
  resize: ResizeDeps;
  /** URL.createObjectURL / revokeObjectURL; tests pass fakes. */
  objectUrls?: { create: (blob: Blob) => string; revoke: (url: string) => void };
  onChange: () => void;
}

const browserObjectUrls = {
  create: (blob: Blob) => URL.createObjectURL(blob),
  revoke: (url: string) => URL.revokeObjectURL(url),
};

export class ComposerAttachments {
  entries: AttachmentEntry[] = [];
  /** Why a pick was refused (too many, too large, a type the agent does not take); cleared by the next pick. */
  notice: string | undefined;
  private readonly uploads = new Map<string, UploadHandle>();
  private readonly sources = new Map<string, Blob & PickedFile>();
  private readonly objectUrls: { create: (blob: Blob) => string; revoke: (url: string) => void };
  private nextId = 0;

  constructor(private readonly options: ComposerAttachmentsOptions) {
    this.objectUrls = options.objectUrls ?? browserObjectUrls;
  }

  get busy(): boolean {
    return this.entries.some((e) => e.state === 'preparing' || e.state === 'uploading');
  }

  get failed(): boolean {
    return this.entries.some((e) => e.state === 'failed');
  }

  /** Every entry is uploaded (true when there are none). */
  get ready(): boolean {
    return this.entries.every((e) => e.state === 'ready');
  }

  /** Adds picked files under the rules, and starts preparing and uploading each one. */
  add(files: readonly (Blob & PickedFile)[], rules: AttachmentRules): void {
    this.notice = undefined;
    const room = MAX_ATTACHMENTS - this.entries.length;
    if (files.length > room) this.notice = `At most ${MAX_ATTACHMENTS} attachments go with one message.`;
    for (const file of files.slice(0, Math.max(0, room))) {
      const isImage = file.type.toLowerCase().startsWith('image/');
      if (!isImage && !rules.files) {
        this.notice = `This agent takes images only; ${file.name} was not added.`;
        continue;
      }
      // Photos shrink before upload; any other file must fit as it is.
      if (!isImage && file.size > rules.maxBytes) {
        this.notice = `${file.name} is larger than ${megabytes(rules.maxBytes)}.`;
        continue;
      }
      const entry: AttachmentEntry = {
        id: `att-${++this.nextId}`,
        name: file.name,
        kind: isImage ? 'image' : 'file',
        mediaType: file.type === '' ? 'application/octet-stream' : file.type,
        size: file.size,
        state: isImage ? 'preparing' : 'uploading',
        progress: 0,
      };
      this.entries.push(entry);
      this.sources.set(entry.id, file);
      void this.start(entry, file, rules);
    }
    this.options.onChange();
  }

  /** Removes an entry; its upload, if still running, is aborted. */
  remove(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined) return;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.uploads.get(id)?.abort();
    this.uploads.delete(id);
    this.sources.delete(id);
    if (entry.previewUrl !== undefined) this.objectUrls.revoke(entry.previewUrl);
    this.options.onChange();
  }

  /** Uploads a failed entry again. */
  retry(id: string, rules: AttachmentRules): void {
    const entry = this.entries.find((e) => e.id === id);
    const file = this.sources.get(id);
    if (entry === undefined || file === undefined || entry.state !== 'failed') return;
    delete entry.error;
    entry.progress = 0;
    entry.state = entry.kind === 'image' && entry.previewUrl === undefined ? 'preparing' : 'uploading';
    this.options.onChange();
    void this.start(entry, file, rules);
  }

  /** The input parts of the ready entries, in pick order. */
  parts(): InputPart[] {
    return this.entries.flatMap((entry): InputPart[] => {
      const uploaded = entry.uploaded;
      if (entry.state !== 'ready' || uploaded === undefined) return [];
      return entry.kind === 'image'
        ? [{ type: 'image', url: uploaded.url }]
        : [{ type: 'file', url: uploaded.url, name: uploaded.name, mediaType: uploaded.mediaType }];
    });
  }

  /** Empties the tray after a send (or when the screen goes): aborts uploads and frees the thumbnails. */
  clear(): void {
    for (const handle of this.uploads.values()) handle.abort();
    for (const entry of this.entries) if (entry.previewUrl !== undefined) this.objectUrls.revoke(entry.previewUrl);
    this.uploads.clear();
    this.sources.clear();
    this.entries = [];
    this.notice = undefined;
    this.options.onChange();
  }

  private alive(entry: AttachmentEntry): boolean {
    return this.entries.includes(entry);
  }

  private async start(entry: AttachmentEntry, file: Blob & PickedFile, rules: AttachmentRules): Promise<void> {
    let upload = { blob: file as Blob, name: file.name, type: entry.mediaType };
    if (entry.kind === 'image') {
      try {
        const prepared = await prepareImage(file, this.options.resize);
        if (!this.alive(entry)) return;
        if (prepared === undefined) {
          // The browser cannot decode it (HEIC outside Safari, say): it goes as a file, if the agent takes files.
          if (!rules.files) return this.fail(entry, 'This image cannot be read on this phone.');
          entry.kind = 'file';
        } else {
          upload = { blob: prepared.blob, name: prepared.name, type: prepared.type };
          entry.name = prepared.name;
          entry.mediaType = prepared.type;
          entry.size = prepared.blob.size;
          if (entry.previewUrl === undefined) entry.previewUrl = this.objectUrls.create(prepared.blob);
        }
      } catch (error) {
        return this.fail(entry, `The image could not be prepared: ${errorText(error)}`);
      }
      if (upload.blob.size > rules.maxBytes) return this.fail(entry, `${entry.name} is larger than ${megabytes(rules.maxBytes)}.`);
      entry.state = 'uploading';
      this.options.onChange();
    }
    const handle = this.options.uploader(this.options.sessionId, upload, (share) => {
      if (!this.alive(entry)) return;
      entry.progress = share;
      this.options.onChange();
    });
    this.uploads.set(entry.id, handle);
    try {
      const result = await handle.done;
      if (!this.alive(entry)) return;
      entry.uploaded = result;
      entry.name = result.name;
      entry.mediaType = result.mediaType;
      entry.progress = 1;
      entry.state = 'ready';
      this.options.onChange();
    } catch (error) {
      if (error instanceof UploadAborted || !this.alive(entry)) return;
      this.fail(entry, errorText(error));
    } finally {
      if (this.uploads.get(entry.id) === handle) this.uploads.delete(entry.id);
    }
  }

  private fail(entry: AttachmentEntry, message: string): void {
    entry.state = 'failed';
    entry.error = message;
    this.options.onChange();
  }
}
