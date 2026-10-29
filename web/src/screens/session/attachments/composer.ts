// The composer's attachments (spec 8.1): what the user picked for the next message, each uploaded to the
// host right away so that sending is instant. An entry is `preparing` (a photo being downscaled),
// `uploading` (with progress), `ready` (the host answered its URL) or `failed` (with one sentence and a
// retry). Removing an entry aborts its upload. The message can go once every entry is ready; its input
// parts are then `{type:"image", url}` for photos and `{type:"file", url, name, mediaType}` for the rest.
//
// Markup (docs/plan/image-markup.md, ticket 4): a photo the browser could decode keeps its prepared original
// and, once marked, the marks. `markup` replaces the entry's upload with the marked picture (the running upload
// is aborted, the finished one dropped; the host keeps a stored blob until the session goes, R-28); marking it
// again starts from the original with the marks still editable, and Done without marks puts the original back.
// A failed upload of a marked picture retries the marked picture. `notes()` is the comment lines the message
// text gets, counting images in the order they are sent.
import type { InputPart } from '../../../replica/types';
import type { Mark } from '../markup/marks';
import { errorText } from '../../model';
import { prepareImage, type PreparedImage, type ResizeDeps } from './resize';
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
  /** The marks on a photo (the tray badge; the cover re-opens with them); absent while unmarked. */
  markup?: Markup;
}

/** A marked photo's marks and what they add to the message. */
export interface Markup {
  /** In the prepared original's pixels. */
  readonly marks: readonly Mark[];
  /** Pins with a comment: the badge's count. */
  readonly comments: number;
  /** The comment lines for this picture sent as image `index` of `count` (marks.ts composeCommentLines). */
  readonly lines: (index: number, count: number) => string[];
}

/** A tray photo with marks burned in, and the marks (markup/burn.ts markedPhoto). */
export interface MarkedPhoto {
  image: PreparedImage;
  markup: Markup;
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
  /** A photo's prepared original, with its own object URL (the cover draws on it). */
  private readonly originals = new Map<string, { image: PreparedImage; url: string }>();
  /** A Done whose marked picture is still being drawn (a newer Done or a remove makes it stale). */
  private readonly marking = new Map<string, object>();
  /** What a retry uploads once the entry was prepared: the original, or the marked picture. */
  private readonly prepared = new Map<string, { blob: Blob; name: string; type: string }>();
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
    this.forget(entry);
    this.options.onChange();
  }

  /** The prepared original of a photo that can be marked up (one the browser decoded), with its object URL. */
  original(id: string): { image: PreparedImage; url: string } | undefined {
    return this.originals.get(id);
  }

  /**
   * Done in the markup cover: `marked` resolves to the marks burned into the original (markup/burn.ts
   * markedPhoto); undefined means no marks, and the original goes up again. The running upload is aborted at
   * once and the entry is `preparing` until the picture is ready, so Send cannot take the unmarked upload; then
   * the thumbnail shows the marked picture and it uploads. Nothing happens when an unmarked photo stays unmarked.
   * If the marks cannot be drawn the entry fails, and Retry uploads what the thumbnail still shows.
   */
  replace(id: string, marked: Promise<MarkedPhoto> | undefined, rules: AttachmentRules): void {
    const entry = this.entries.find((e) => e.id === id);
    const original = this.originals.get(id);
    if (entry === undefined || original === undefined || (marked === undefined && entry.markup === undefined)) return;
    this.uploads.get(id)?.abort();
    this.uploads.delete(id);
    delete entry.uploaded;
    delete entry.error;
    entry.progress = 0;
    entry.state = 'preparing';
    const token = {};
    this.marking.set(id, token);
    this.options.onChange();
    void this.applyMarks(entry, original, marked, token, rules);
  }

  private async applyMarks(entry: AttachmentEntry, original: { image: PreparedImage; url: string }, marked: Promise<MarkedPhoto> | undefined, token: object, rules: AttachmentRules): Promise<void> {
    const current = () => this.alive(entry) && this.marking.get(entry.id) === token;
    let result: MarkedPhoto | undefined;
    try {
      result = await marked;
    } catch (error) {
      if (!current()) return;
      this.marking.delete(entry.id);
      return this.fail(entry, `The marks could not be added: ${errorText(error)}`);
    }
    if (!current()) return;
    this.marking.delete(entry.id);
    const unmark = result === undefined || result.markup.marks.length === 0;
    const image = unmark ? original.image : result!.image;
    if (entry.previewUrl !== undefined && entry.previewUrl !== original.url) this.objectUrls.revoke(entry.previewUrl);
    entry.previewUrl = unmark ? original.url : this.objectUrls.create(image.blob);
    if (unmark) delete entry.markup;
    else entry.markup = result!.markup;
    entry.name = image.name;
    entry.mediaType = image.type;
    entry.size = image.blob.size;
    const upload = { blob: image.blob, name: image.name, type: image.type };
    this.prepared.set(entry.id, upload);
    if (upload.blob.size > rules.maxBytes) return this.fail(entry, `${entry.name} is larger than ${megabytes(rules.maxBytes)}.`);
    entry.state = 'uploading';
    this.options.onChange();
    void this.send(entry, upload);
  }

  /** Uploads a failed entry again. */
  retry(id: string, rules: AttachmentRules): void {
    const entry = this.entries.find((e) => e.id === id);
    const file = this.sources.get(id);
    if (entry === undefined || file === undefined || entry.state !== 'failed') return;
    const upload = this.prepared.get(id);
    if (upload !== undefined && upload.blob.size > rules.maxBytes) return this.fail(entry, `${entry.name} is larger than ${megabytes(rules.maxBytes)}.`);
    delete entry.error;
    entry.progress = 0;
    entry.state = entry.kind === 'image' && upload === undefined ? 'preparing' : 'uploading';
    this.options.onChange();
    void (upload === undefined ? this.start(entry, file, rules) : this.send(entry, upload));
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

  /**
   * The comment lines of the marked photos among the ready entries, one block per picture, separated by an empty
   * line; images are counted in the order they are sent ("Marks on image 2 of 3"). Empty without comments.
   */
  notes(): string {
    const images = this.entries.filter((e) => e.state === 'ready' && e.uploaded !== undefined && e.kind === 'image');
    return images
      .map((entry, index) => entry.markup?.lines(index + 1, images.length) ?? [])
      .filter((lines) => lines.length > 0)
      .map((lines) => lines.join('\n'))
      .join('\n\n');
  }

  /** Empties the tray after a send (or when the screen goes): aborts uploads and frees the thumbnails. */
  clear(): void {
    for (const handle of this.uploads.values()) handle.abort();
    for (const entry of this.entries) this.forget(entry);
    this.uploads.clear();
    this.entries = [];
    this.notice = undefined;
    this.options.onChange();
  }

  private alive(entry: AttachmentEntry): boolean {
    return this.entries.includes(entry);
  }

  /** Drops what the tray held for an entry and frees its object URLs. */
  private forget(entry: AttachmentEntry): void {
    const original = this.originals.get(entry.id);
    if (entry.previewUrl !== undefined && entry.previewUrl !== original?.url) this.objectUrls.revoke(entry.previewUrl);
    if (original !== undefined) this.objectUrls.revoke(original.url);
    this.sources.delete(entry.id);
    this.originals.delete(entry.id);
    this.prepared.delete(entry.id);
    this.marking.delete(entry.id);
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
          entry.previewUrl = this.objectUrls.create(prepared.blob);
          this.originals.set(entry.id, { image: prepared, url: entry.previewUrl });
        }
        this.prepared.set(entry.id, upload);
      } catch (error) {
        return this.fail(entry, `The image could not be prepared: ${errorText(error)}`);
      }
      if (upload.blob.size > rules.maxBytes) return this.fail(entry, `${entry.name} is larger than ${megabytes(rules.maxBytes)}.`);
      entry.state = 'uploading';
      this.options.onChange();
    }
    return this.send(entry, upload);
  }

  /** Uploads `upload` for the entry; an answer for an upload that was replaced or removed changes nothing. */
  private async send(entry: AttachmentEntry, upload: { blob: Blob; name: string; type: string }): Promise<void> {
    let handle: UploadHandle | undefined;
    const current = () => this.alive(entry) && handle !== undefined && this.uploads.get(entry.id) === handle;
    handle = this.options.uploader(this.options.sessionId, upload, (share) => {
      if (!current()) return;
      entry.progress = share;
      this.options.onChange();
    });
    this.uploads.set(entry.id, handle);
    try {
      const result = await handle.done;
      if (!current()) return;
      entry.uploaded = result;
      entry.name = result.name;
      entry.mediaType = result.mediaType;
      entry.progress = 1;
      entry.state = 'ready';
      this.options.onChange();
    } catch (error) {
      if (error instanceof UploadAborted || !current()) return;
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
