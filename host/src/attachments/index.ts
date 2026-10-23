// Attachments (protocol-v1.md section 8.1): the per-session store on disk and the `/v1/blob` endpoint.
export { handleBlob, isBlobPath } from './endpoint.js';
export type { BlobEndpointOptions, BlobUploadResult } from './endpoint.js';
export {
  AttachmentStore,
  AttachmentTooLarge,
  BLOB_ID,
  BLOB_PATH,
  DEFAULT_MEDIA_TYPE,
  MAX_ATTACHMENT_BYTES,
  blobIdOf,
  blobUrl,
  cleanMediaType,
  cleanName,
  deletedSessionDirs,
} from './store.js';
export type { Attachment, AttachmentStoreOptions } from './store.js';
