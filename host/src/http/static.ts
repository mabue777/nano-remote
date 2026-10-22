// Static files of the web client (ADR 0004): `pnpm -C web build` writes host/public; the host serves it
// on the same origin as the stream. Client-side routes (pairing, chats, session and chat pages) get index.html.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory the host serves the web client from. `pnpm -C web build` writes here. */
export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

/** Paths the web app routes itself; each answers with index.html. */
export const CLIENT_ROUTES: readonly string[] = ['/', '/pair', '/chats'];

/**
 * Session pages, `/s/<sessionId>`, and local chat pages, `/c/<chatId>` (web/src/routes): also index.html,
 * so a reload or a push link works.
 */
const PAGE_ROUTE = /^\/[sc]\/[A-Za-z0-9_-]{1,128}$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Content type for a static file served from PUBLIC_DIR; unknown extensions are octet-stream. */
export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Headers every response from the host carries. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/**
 * The file under `root` a URL path names, or null when the path escapes `root` or is malformed.
 * Client routes map to index.html.
 */
export function resolveStatic(root: string, urlPath: string): string | null {
  if (CLIENT_ROUTES.includes(urlPath) || PAGE_ROUTE.test(urlPath)) return path.join(root, 'index.html');
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const file = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  return file.startsWith(root + path.sep) ? file : null;
}

function notFound(response: http.ServerResponse): void {
  response.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
}

/** Serves GET and HEAD for files under `root`. Directories, dotfiles and missing files answer 404. */
export async function serveStatic(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  root: string,
  urlPath: string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    response.end('method not allowed\n');
    return;
  }
  const base = path.resolve(root);
  const file = resolveStatic(base, urlPath);
  if (file === null || path.relative(base, file).split(path.sep).some((part) => part.startsWith('.'))) {
    return notFound(response);
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return notFound(response);
  // Built assets carry a content hash in their name; everything else (index.html) must revalidate.
  const immutable = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2)$/.test(file) && file.includes(`${path.sep}assets${path.sep}`);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': contentTypeFor(file),
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file)
    .on('error', () => response.destroy())
    .pipe(response);
}
