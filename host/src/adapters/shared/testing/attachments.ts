// Attachment fixtures for adapter tests (spec 8.1): files on disk and the resolved input parts the core
// hands an adapter for them, so each adapter test can assert the exact payload its engine receives.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AdapterInputPart } from '../../../core/adapter.js';

/** A 1x1 transparent PNG. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export interface AttachmentFixture {
  dir: string;
  pngPath: string;
  logPath: string;
  heicPath: string;
  /** Text, a stored PNG, a stored HEIC (no engine takes it natively) and a stored text file. */
  input: AdapterInputPart[];
}

export function attachmentFixture(): AttachmentFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'nano-attach-'));
  const pngPath = path.join(dir, 'screen.png');
  const logPath = path.join(dir, 'login error.log');
  const heicPath = path.join(dir, 'photo.heic');
  writeFileSync(pngPath, PNG_BYTES);
  writeFileSync(logPath, 'E: denied\n');
  writeFileSync(heicPath, 'not really heic');
  return {
    dir,
    pngPath,
    logPath,
    heicPath,
    input: [
      { type: 'text', text: 'What is wrong here?' },
      { type: 'image', url: '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA', path: pngPath, mediaType: 'image/png' },
      { type: 'image', url: '/v1/blob/blb_CCCCCCCCCCCCCCCCCCCCCC', path: heicPath, mediaType: 'image/heic' },
      { type: 'file', url: '/v1/blob/blb_BBBBBBBBBBBBBBBBBBBBBB', name: 'login error.log', mediaType: 'text/plain', path: logPath },
    ],
  };
}
