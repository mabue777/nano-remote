// Test doubles for attachments (spec 8.1): an uploader the test drives call by call, a resize that
// "decodes" files by a size written into their name, and object URLs that are counted.
import type { Decoded, ResizeDeps } from '../src/screens/session/attachments/resize';
import { UploadAborted, type UploadResult, type Uploader } from '../src/screens/session/attachments/upload';

export interface FakeUpload {
  sessionId: string;
  name: string;
  type: string;
  size: number;
  progress(share: number): void;
  resolve(result?: Partial<UploadResult>): void;
  reject(message: string): void;
  aborted: boolean;
}

/** Records every upload; the test resolves, rejects or reports progress on each. */
export class FakeUploader {
  readonly uploads: FakeUpload[] = [];
  private id = 0;

  readonly upload: Uploader = (sessionId, file, onProgress) => {
    let settle!: { resolve: (value: UploadResult) => void; reject: (error: Error) => void };
    const done = new Promise<UploadResult>((resolve, reject) => (settle = { resolve, reject }));
    const blobId = `blb_${String(++this.id).padStart(22, '0')}`;
    const entry: FakeUpload = {
      sessionId,
      name: file.name,
      type: file.type,
      size: file.blob.size,
      aborted: false,
      progress: (share) => onProgress(share),
      resolve: (result = {}) => settle.resolve({ blobId, url: `/v1/blob/${blobId}`, name: file.name, mediaType: file.type, size: file.blob.size, ...result }),
      reject: (message) => settle.reject(new Error(message)),
    };
    this.uploads.push(entry);
    return {
      done,
      abort: () => {
        entry.aborted = true;
        settle.reject(new UploadAborted());
      },
    };
  };

  get last(): FakeUpload {
    const last = this.uploads.at(-1);
    if (last === undefined) throw new Error('no upload yet');
    return last;
  }
}

/**
 * Decodes a file named `<anything>@<width>x<height>.<ext>` to that size; any other name fails to decode.
 * Encoding returns a blob of `encodedBytes` bytes (default 1000) and records the call.
 */
export function fakeResize(options: { encodedBytes?: number; failEncode?: boolean } = {}) {
  const calls: { width: number; height: number; type: string; quality: number }[] = [];
  const closed: Decoded[] = [];
  const deps: ResizeDeps = {
    decode: async (blob) => {
      const match = /@(\d+)x(\d+)\./.exec((blob as Blob & { name?: string }).name ?? '');
      if (match === null) throw new Error('cannot decode');
      const image: Decoded = { width: Number(match[1]), height: Number(match[2]), close: () => closed.push(image) };
      return image;
    },
    encode: async (_image, width, height, type, quality) => {
      if (options.failEncode) throw new Error('no 2d canvas');
      calls.push({ width, height, type, quality });
      return new Blob([new Uint8Array(options.encodedBytes ?? 1000)], { type });
    },
  };
  return { deps, calls, closed };
}

export function fakeObjectUrls() {
  const created: string[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    urls: {
      create: () => {
        const url = `blob:preview-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revoke: (url: string) => revoked.push(url),
    },
  };
}

/** A picked file of `size` bytes. */
export function picked(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}
