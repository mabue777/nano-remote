// A fake model provider for the Playwright smoke of local chat: one https server that answers as an
// OpenAI-compatible cloud API (SSE) and as Ollama (NDJSON), replaying the chat engine's recorded fixtures
// (src/chat/engine/fixtures) frame by frame, paced so the browser sees the reply stream in.
//
// The app calls a provider directly only for https on a public host (ADR 0006), so the smoke's browser maps
// two public names to this server (playwright.config.ts: --host-resolver-rules, and ignoreHTTPSErrors for
// the throwaway self-signed certificate made here with openssl):
//   https://api.fake-provider.test:<port>/v1   openai-compatible: GET /v1/models, POST /v1/chat/completions
//   https://ollama.com:<port>                  ollama (the preset's host): GET /api/tags, POST /api/chat
// A last user message containing "slowly" streams the reasoning and the first frame of answer text, then
// holds the stream open until the client aborts (the Stop test). Every answer carries CORS headers for the app's origin.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../src/chat/engine/fixtures/', import.meta.url));
export const FAKE_PROVIDER_HOSTS = ['api.fake-provider.test', 'ollama.com'];

/** Per frame. */
const PACE_MS = 60;
/** A frame that carries answer text (SSE `delta.content`, NDJSON `message.content`). */
const ANSWER = /"content":"[^"]/;

export const FAKE_MODELS = {
  openai: { data: [{ id: 'fake-reasoner', name: 'Fake Reasoner', supported_parameters: ['reasoning', 'tools'] }, { id: 'fake-mini', supported_parameters: [] }] },
  ollama: { models: [{ name: 'llama-fake:1b' }] },
};

function selfSignedCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-provider-'));
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=api.fake-provider.test'], { stdio: 'ignore' });
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function frames(file: string, separator: string): string[] {
  return readFileSync(path.join(FIXTURES, file), 'utf8')
    .split(separator)
    .filter((frame) => frame.trim() !== '')
    .map((frame) => frame + separator);
}

export interface FakeProvider {
  port: number;
  /** The bodies of chat requests, newest last. */
  chats: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startFakeProvider(port: number): Promise<FakeProvider> {
  const sse = frames('openai-reasoning.sse', '\n\n');
  const ndjson = frames('ollama-thinking.ndjson', '\n');
  const chats: Record<string, unknown>[] = [];

  const cors = (request: http.IncomingMessage): Record<string, string> => ({
    'access-control-allow-origin': request.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': request.headers['access-control-request-headers'] ?? 'authorization, content-type',
    'access-control-max-age': '600',
  });

  const stream = (request: http.IncomingMessage, response: http.ServerResponse, type: string, parts: string[], hold: boolean) => {
    response.writeHead(200, { ...cors(request), 'content-type': type, 'cache-control': 'no-cache' });
    const firstAnswer = parts.findIndex((part) => ANSWER.test(part));
    const limit = hold ? firstAnswer + 1 : parts.length;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (i < limit) {
        response.write(parts[i++]);
        timer = setTimeout(next, PACE_MS);
      } else if (!hold) response.end();
      // held: stays open until the client goes away
    };
    response.on('close', () => clearTimeout(timer));
    next();
  };

  const server = https.createServer(selfSignedCertificate(), (request, response) => {
    const url = new URL(request.url ?? '/', 'https://fake');
    if (request.method === 'OPTIONS') return void response.writeHead(204, cors(request)).end();
    const json = (status: number, body: unknown) =>
      void response.writeHead(status, { ...cors(request), 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && url.pathname === '/v1/models') return json(200, FAKE_MODELS.openai);
    if (request.method === 'GET' && url.pathname === '/api/tags') return json(200, FAKE_MODELS.ollama);
    if (request.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/api/chat')) {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        const body = JSON.parse(text) as { messages?: { role: string; content: string }[] };
        chats.push(body as Record<string, unknown>);
        const last = body.messages?.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        const hold = /slowly/i.test(last);
        if (url.pathname === '/api/chat') stream(request, response, 'application/x-ndjson', ndjson, hold);
        else stream(request, response, 'text/event-stream', sse, hold);
      });
      return;
    }
    json(404, { error: { message: `no route ${request.method} ${url.pathname}` } });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    chats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
