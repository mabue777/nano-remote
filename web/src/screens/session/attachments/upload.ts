// Uploads one attachment to the host (spec 8.1): `POST /v1/blob?sessionId=&name=` with the bytes as the
// body, authenticated by the device cookie (same origin). XMLHttpRequest rather than fetch, because only
// it reports upload progress. The answer is `{blobId, url, name, mediaType, size}`; failures become one
// sentence for the composer.

/** What `POST /v1/blob` answers. */
export interface UploadResult {
  blobId: string;
  url: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface UploadHandle {
  readonly done: Promise<UploadResult>;
  abort(): void;
}

/** Uploads one attachment of a session; `onProgress` gets the sent share, 0 to 1. */
export type Uploader = (sessionId: string, file: { blob: Blob; name: string; type: string }, onProgress: (share: number) => void) => UploadHandle;

/** An upload the user removed before it finished. */
export class UploadAborted extends Error {
  constructor() {
    super('upload aborted');
  }
}

/** The sentence the composer shows for a failed upload, from the HTTP status (0: no answer). */
export function uploadErrorText(status: number, maxBytes?: number): string {
  switch (status) {
    case 0:
      return 'Upload failed: the host did not answer.';
    case 401:
    case 403:
      return 'Upload failed: this device is no longer paired.';
    case 404:
      return 'Upload failed: the host does not know this session any more.';
    case 413:
      return `Upload failed: the file is larger than ${megabytes(maxBytes ?? 20 * 1024 * 1024)}.`;
    default:
      return `Upload failed: the host answered ${status}.`;
  }
}

/** 20971520 -> "20 MB". */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The subset of XMLHttpRequest the uploader uses (tests pass a fake). */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  readonly upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

export function xhrUploader(create: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike): Uploader {
  return (sessionId, file, onProgress) => {
    const xhr = create();
    const done = new Promise<UploadResult>((resolve, reject) => {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
      };
      xhr.onload = () => {
        if (xhr.status === 201 || xhr.status === 200) {
          try {
            resolve(JSON.parse(xhr.responseText) as UploadResult);
          } catch {
            reject(new Error('Upload failed: the host answered something unreadable.'));
          }
          return;
        }
        let maxBytes: number | undefined;
        try {
          const data = (JSON.parse(xhr.responseText) as { error?: { data?: { maxBytes?: unknown } } }).error?.data?.maxBytes;
          if (typeof data === 'number') maxBytes = data;
        } catch {
          // a body that is not JSON: the status says enough
        }
        reject(new Error(uploadErrorText(xhr.status, maxBytes)));
      };
      xhr.onerror = () => reject(new Error(uploadErrorText(0)));
      xhr.onabort = () => reject(new UploadAborted());
    });
    const query = new URLSearchParams({ sessionId, name: file.name });
    xhr.open('POST', `/v1/blob?${query}`);
    xhr.setRequestHeader('content-type', file.type === '' ? 'application/octet-stream' : file.type);
    xhr.send(file.blob);
    return { done, abort: () => xhr.abort() };
  };
}
