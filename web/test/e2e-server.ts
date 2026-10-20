// The host the Playwright smoke runs against: one origin that serves the built app (host/public) with
// the client routes, `POST /v1/pair` (spec 8) with single-use codes that set an HttpOnly cookie, and
// the fake host's stream on /v1/stream, which closes 4003 for a socket without a paired cookie. Three
// scripted sessions are seeded: finished, waiting for an approval, and new. session/list pages by two,
// so the third row only appears through cursor paging.
//
// Scripted turns are paced (PACE_MS per step) so the browser sees deltas arrive.
//
// Test hooks: `POST /test/code` issues a fresh code; `POST /test/expire` issues one that is already
// expired; `POST /test/reset` puts the three seeded sessions back (every spec starts from them);
// `POST /test/run {sessionId, text}` starts a scripted turn the way the desktop would;
// `POST /test/resolve {sessionId, decision}` answers its approval from another device;
// `POST /test/delay {method, ms}` holds back the answer to the next request of that method;
// `POST /test/request {sessionId, request}` puts any approval or question up (answers {requestId});
// `POST /test/resolve-request {sessionId, requestId, by?, decision?, answers?}` answers it from another
// device; `POST /test/last {method}` returns the params of the last request of that method;
// `POST /test/review {sessionId, chunks}` starts a turn whose command streams `chunks` (answers {itemId}),
// `POST /test/review-finish {sessionId, changes}` completes it with those file changes, and
// `POST /test/no-diffs {sessionId}` makes turn/diff answer not_supported for the session.
// Started by playwright.config.ts through e2e-host.mjs (which loads this file with Vite).
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeHost } from './fake-host';

const PUBLIC = fileURLToPath(new URL('../../host/public/', import.meta.url));
const CLIENT_ROUTE = /^\/(pair\/?)?$|^\/s\/[^/]+$/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export const SEEDED_TITLES = ['Create hello.txt and list files', 'Run the test suite', 'Sketch the README'];
const PACE_MS = 80;

/** Three sessions: finished (ses_fake_1), waiting for an approval (ses_fake_2), and new (ses_fake_3). */
function seed(host: FakeHost): void {
  host.reset();
  host.paceMs = 0;
  const finished = host.createSession({ title: SEEDED_TITLES[0] });
  host.runScriptedTurn(finished, 'Create a file named hello.txt in the current directory.');
  host.resolveElsewhere(finished, 'accept');
  const waiting = host.createSession({ title: SEEDED_TITLES[1], agentId: 'claude' });
  host.runScriptedTurn(waiting, 'Run the tests.');
  const fresh = host.createSession({ title: SEEDED_TITLES[2] });
  // Recent, fixed times: waiting (newest), finished, then the new one, which lands on page two.
  const now = Math.floor(Date.now() / 1000);
  host.session(waiting).summary.updatedAt = now - 60;
  host.session(finished).summary.updatedAt = now - 600;
  host.session(fresh).summary.updatedAt = now - 86_400;
  host.paceMs = PACE_MS;
}

interface Code {
  expiresAt: number;
  used: boolean;
}

export async function startE2eHost(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const codes = new Map<string, Code>();
  const tokens = new Map<string, string>(); // token -> clientId
  let devices = 0;
  const issue = (lifetimeMs: number) => {
    let code: string;
    do code = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
    while (codes.has(code));
    codes.set(code, { expiresAt: Date.now() + lifetimeMs, used: false });
    return code;
  };

  const host = new FakeHost({ pageSize: 2 });
  seed(host);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
    };
    if (request.method === 'POST' && url.pathname === '/test/code') return json(200, { code: issue(5 * 60_000) });
    if (request.method === 'POST' && url.pathname === '/test/expire') return json(200, { code: issue(-1) });
    if (request.method === 'POST' && url.pathname.startsWith('/test/')) {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        try {
          const body = text === '' ? {} : JSON.parse(text);
          switch (url.pathname) {
            case '/test/reset':
              seed(host);
              return json(200, { ok: true });
            case '/test/run':
              host.runScriptedTurn(body.sessionId, body.text ?? 'Go on.');
              return json(200, { ok: true });
            case '/test/resolve':
              host.resolveElsewhere(body.sessionId, body.decision ?? 'accept');
              return json(200, { ok: true });
            case '/test/request':
              return json(200, { requestId: host.addRequest(body.sessionId, body.request) });
            case '/test/resolve-request':
              host.resolveRequest(body.sessionId, body.requestId, body.by ?? 'dev_desktop', { decision: body.decision, answers: body.answers });
              return json(200, { ok: true });
            case '/test/last':
              return json(200, { params: host.requestLog.filter((r) => r.method === body.method).at(-1)?.params ?? null });
            case '/test/review':
              return json(200, { itemId: host.runReviewTurn(body.sessionId, body.chunks ?? []) });
            case '/test/review-finish':
              host.finishReviewTurn(body.sessionId, body.changes ?? []);
              return json(200, { ok: true });
            case '/test/no-diffs':
              host.noDiffs.add(body.sessionId);
              return json(200, { ok: true });
            case '/test/delay':
              host.delay(body.method, body.ms);
              return json(200, { ok: true });
            default:
              return json(404, { error: { code: 'not_found', message: url.pathname } });
          }
        } catch (error) {
          return json(400, { error: { code: 'invalid_params', message: String(error) } });
        }
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/pair') {
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
        return json(415, { error: { code: 'invalid_params', message: 'content-type must be application/json', data: { path: '' } } });
      }
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        let body: { code?: unknown; client?: { name?: unknown } };
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: { code: 'invalid_params', message: 'body is not valid JSON', data: { path: '' } } });
        }
        if (typeof body.client?.name !== 'string' || body.client.name.trim() === '') {
          return json(400, { error: { code: 'invalid_params', message: 'client.name must be a non-empty string', data: { path: 'client.name' } } });
        }
        const code = typeof body.code === 'string' ? codes.get(body.code) : undefined;
        if (code === undefined || code.used || code.expiresAt < Date.now()) {
          return json(403, { error: { code: 'unauthorized', message: 'pairing code is wrong, expired or already used' } });
        }
        code.used = true;
        const clientId = `dev_e2e_${++devices}`;
        const token = randomBytes(32).toString('base64url');
        tokens.set(token, clientId);
        return json(
          200,
          { clientId, deviceToken: token, host: { hostId: 'host_2b7d4e90', name: 'mabue-mbp' } },
          { 'set-cookie': `nano_device=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` },
        );
      });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: { code: 'method_not_found', message: 'GET only' } });
    const file = CLIENT_ROUTE.test(url.pathname) ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, path.posix.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(response);
  });

  await host.start({
    server,
    authorize: (request) => {
      for (const part of (request.headers.cookie ?? '').split(';')) {
        const [name, value] = part.trim().split('=');
        if (name === 'nano_device' && value !== undefined && tokens.has(value)) return true;
      }
      return false;
    },
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await host.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
