import { describe, expect, it } from 'vitest';

import { UploadAborted, megabytes, uploadErrorText, xhrUploader, type XhrLike } from './upload';

class FakeXhr implements XhrLike {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: Blob | undefined;
  status = 0;
  responseText = '';
  aborted = false;
  readonly upload: XhrLike['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: Blob): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const upload = xhrUploader(() => new FakeXhr());
const file = { blob: new Blob(['abc'], { type: 'image/png' }), name: 'IMG 1.png', type: 'image/png' };

describe('xhrUploader (spec 8.1)', () => {
  it('POSTs the bytes to /v1/blob with the session and name, reports progress, and answers the host result', async () => {
    const shares: number[] = [];
    const handle = upload('ses_1', file, (share) => shares.push(share));
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/v1/blob?sessionId=ses_1&name=IMG+1.png');
    expect(xhr.headers).toEqual({ 'content-type': 'image/png' });
    expect(xhr.body).toBe(file.blob);
    xhr.upload.onprogress!({ loaded: 1, total: 4, lengthComputable: true });
    xhr.upload.onprogress!({ loaded: 9, total: 4, lengthComputable: true });
    xhr.upload.onprogress!({ loaded: 1, total: 0, lengthComputable: false });
    const result = { blobId: 'blb_x', url: '/v1/blob/blb_x', name: 'IMG 1.png', mediaType: 'image/png', size: 3 };
    xhr.answer(201, result);
    expect(await handle.done).toEqual(result);
    expect(shares).toEqual([0.25, 1]);
  });

  it('an empty type goes as application/octet-stream', () => {
    void upload('ses_1', { ...file, type: '' }, () => {}).done.catch(() => {});
    expect(FakeXhr.last.headers['content-type']).toBe('application/octet-stream');
  });

  it('failures become one sentence: size with the host limit, auth, session gone, no answer, other status, garbage', async () => {
    const cases: [number, unknown, string][] = [
      [413, { error: { code: 'invalid_params', data: { maxBytes: 10 * 1024 * 1024 } } }, 'Upload failed: the file is larger than 10 MB.'],
      [413, 'not json', 'Upload failed: the file is larger than 20 MB.'],
      [401, { error: { code: 'unauthorized' } }, 'Upload failed: this device is no longer paired.'],
      [403, {}, 'Upload failed: this device is no longer paired.'],
      [404, {}, 'Upload failed: the host does not know this session any more.'],
      [500, '', 'Upload failed: the host answered 500.'],
      [201, '{', 'Upload failed: the host answered something unreadable.'],
    ];
    for (const [status, body, message] of cases) {
      const handle = upload('ses_1', file, () => {});
      FakeXhr.last.answer(status, body);
      await expect(handle.done).rejects.toThrow(message);
    }
    const offline = upload('ses_1', file, () => {});
    FakeXhr.last.onerror!();
    await expect(offline.done).rejects.toThrow('Upload failed: the host did not answer.');
  });

  it('abort cancels the request and rejects with UploadAborted', async () => {
    const handle = upload('ses_1', file, () => {});
    handle.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    await expect(handle.done).rejects.toBeInstanceOf(UploadAborted);
  });

  it('copy helpers', () => {
    expect(megabytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(uploadErrorText(0)).toBe('Upload failed: the host did not answer.');
    expect(uploadErrorText(413)).toBe('Upload failed: the file is larger than 20 MB.');
  });
});
