// A fake model provider on loopback for the relay tests: scripted replies per path that stream
// OpenAI-style SSE, Anthropic-style SSE or Ollama NDJSON, answer with chosen statuses, or stall. It records
// every request and notices when the client hangs up before a reply finished (an upstream abort).
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Reply = (request: RecordedRequest, response: http.ServerResponse) => void | Promise<void>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A JSON answer. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
}

/** A plain-text answer (an error page). */
export function text(status: number, body: string, headers: Record<string, string> = {}): Reply {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
    res.end(body);
  };
}

/**
 * Streams chunks with a pause between them. Objects become `data: <json>\n\n` (SSE) or `<json>\n`
 * (NDJSON); strings are written as they are.
 */
export function stream(framing: 'sse' | 'ndjson', chunks: readonly unknown[], options: { delayMs?: number; end?: boolean } = {}): Reply {
  return async (_req, res) => {
    res.writeHead(200, { 'Content-Type': framing === 'sse' ? 'text/event-stream' : 'application/x-ndjson' });
    for (const chunk of chunks) {
      if (res.destroyed) return;
      const out = typeof chunk === 'string' ? chunk : framing === 'sse' ? `data: ${JSON.stringify(chunk)}\n\n` : `${JSON.stringify(chunk)}\n`;
      res.write(out);
      if (options.delayMs) await wait(options.delayMs);
    }
    if (options.end ?? true) res.end();
  };
}

/** Sends 200 and its headers, then nothing: a server that accepts and never streams. */
export function hang(): Reply {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
  };
}

/** Never answers at all, not even headers. */
export function silent(): Reply {
  return () => {};
}

export class FakeProvider {
  readonly requests: RecordedRequest[] = [];
  /** Requests whose client hung up before the reply ended. */
  aborted = 0;
  private readonly routes = new Map<string, Reply[]>();
  private readonly sockets = new Set<Socket>();

  private constructor(private readonly server: http.Server) {}

  static async start(): Promise<FakeProvider> {
    let fake: FakeProvider | undefined;
    const server = http.createServer((req, res) => void fake!.handle(req, res));
    fake = new FakeProvider(server);
    server.on('connection', (socket) => {
      fake!.sockets.add(socket);
      socket.on('close', () => fake!.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Replies for `METHOD /path` (path without query), used in order; the last one repeats. */
  on(route: string, ...replies: Reply[]): this {
    this.routes.set(route, replies);
    return this;
  }

  /** Requests to one path. */
  to(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '/').split('?')[0]!;
    const recorded: RecordedRequest = { method: req.method ?? 'GET', path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    this.requests.push(recorded);
    res.on('close', () => {
      if (!res.writableFinished) this.aborted += 1;
    });
    const replies = this.routes.get(`${recorded.method} ${path}`);
    if (!replies || replies.length === 0) {
      json(404, { error: 'not found' })(recorded, res);
      return;
    }
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    await reply(recorded, res);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A loopback port nobody listens on (bound, then released). */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
