// Nano Host entry point (scaffold). Phase 1 adds the Journal, adapters, envelope server and pairing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type * as protocol from './generated/index.js';

/** Protocol major version this host speaks (protocol/protocol-v1.md). */
export const PROTOCOL_VERSION = 1;

/** Directory the host serves the web client from. `pnpm -C web build` writes here. */
export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Content type for a static file served from PUBLIC_DIR; unknown extensions are octet-stream. */
export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export * as core from './core/index.js';
export { FakeAdapter, FakeAgent, echoScript, scripted } from './core/testing/fake-adapter.js';
