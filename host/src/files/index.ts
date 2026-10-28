// Reading files of a session folder (protocol-v1.md section 4.1): the scope rule, `fs/readFile`,
// `fs/readDirectory` with a `sessionId`, and the `/v1/file` endpoint.
export { FILE_PATH, MAX_SERVED_FILE_BYTES, fileEtag, handleFile, parseRange } from './endpoint.js';
export type { FileEndpointOptions } from './endpoint.js';
export {
  DEFAULT_FILE_READ_BYTES,
  LINE_SEEK,
  MAX_FILE_READ_BYTES,
  MIN_READ_BYTES,
  SNIFF_BYTES,
  looksBinary,
  mediaTypeOf,
  openInSession,
  readSessionDirectory,
  readSessionFile,
  sniffMagic,
  textWindow,
} from './read.js';
export type { OpenedFile } from './read.js';
export { isInside, outOfScope, resolveInSession } from './scope.js';
export type { ScopedPath } from './scope.js';
