// A FileReader that reads a user-attached text file from `/v1/blob` so it can open in the same file viewer
// as a session-folder file (docs/plan/file-viewer.md item P4). It fetches the blob once, returns the host's
// stored name from Content-Disposition, and answers `fs/readFile` ranges from the cached text.
import { RequestError } from '../../../stream/client';
import type { FileReader } from './file-model';

/** Text-ish media types we are willing to preview; everything else is shown as a binary card. */
function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/javascript';
}

function nameFromDisposition(disposition: string | null): string | undefined {
  if (disposition === null) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8 !== null) return decodeURIComponent(utf8[1]!);
  const quoted = /filename="([^"]+)"/i.exec(disposition);
  if (quoted !== null) return quoted[1];
  return undefined;
}

/**
 * Wraps `/v1/blob/<id>` for `FileViewerModel`. The first `fs/readFile` fetch caches the blob; later calls
 * return slices of the cached text. Binary blobs answer `binary: true` so the viewer shows its card.
 */
export class BlobFileReader implements FileReader {
  private readonly url: string;
  private fetched = false;
  private info: { path: string; size: number; mediaType: string } | undefined;
  private text: string | undefined;

  constructor(url: string) {
    this.url = url;
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method !== 'fs/readFile') {
      throw new Error(`BlobFileReader does not support ${method}`);
    }
    const offset = Math.max(0, Number(params?.offset ?? 0));
    if (!this.fetched) {
      const response = await fetch(this.url, { credentials: 'same-origin' });
      if (response.status === 404) throw new RequestError('not_found', 'no such attachment');
      if (!response.ok) throw new RequestError('internal', `fetch failed: ${response.status}`);
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'text/plain';
      const name = nameFromDisposition(response.headers.get('content-disposition')) ?? this.url.split('/').pop() ?? 'attachment';
      const blob = await response.blob();
      this.info = { path: name, size: blob.size, mediaType };
      this.fetched = true;
      if (!isTextMediaType(mediaType)) {
        return {
          path: name,
          size: blob.size,
          mtimeMs: 0,
          mediaType,
          binary: true,
          encoding: 'none',
          offset: 0,
          length: 0,
          truncated: false,
        } as T;
      }
      this.text = await blob.text();
    }

    if (this.info === undefined) {
      throw new RequestError('internal', 'blob fetch did not initialize');
    }

    if (!isTextMediaType(this.info.mediaType)) {
      return {
        path: this.info.path,
        size: this.info.size,
        mtimeMs: 0,
        mediaType: this.info.mediaType,
        binary: true,
        encoding: 'none',
        offset: 0,
        length: 0,
        truncated: false,
      } as T;
    }

    const full = this.text ?? '';
    const slice = full.slice(offset);
    const content = slice;
    const length = new TextEncoder().encode(content).length;
    return {
      path: this.info.path,
      size: this.info.size,
      mtimeMs: 0,
      mediaType: this.info.mediaType,
      binary: false,
      encoding: 'utf8',
      content,
      offset,
      length,
      truncated: false,
    } as T;
  }
}
