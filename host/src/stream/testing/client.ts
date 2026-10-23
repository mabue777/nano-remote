// In-process test client for the stream server: a real ws socket that numbers its envelopes, records
// every frame the host sends, reassembles chunks, and acks automatically unless told not to.
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

export interface Frame {
  type: string;
  client_id: string;
  stream_id: string;
  seq_id: number;
  [key: string]: unknown;
}

export interface Closed {
  code: number;
  reason: string;
}

export interface ConnectOptions {
  token?: string | null;
  cookie?: string;
  headers?: Record<string, string>;
  clientId?: string;
  streamId?: string;
  autoAck?: boolean;
  /** Extra options for the ws client (TLS settings). */
  ws?: WebSocket.ClientOptions;
}

export class TestClient {
  readonly frames: Frame[] = [];
  /** Messages the host sent, chunks reassembled, in arrival order. */
  readonly messages: Record<string, unknown>[] = [];
  readonly closed: Promise<Closed>;
  clientId: string;
  streamId: string;
  autoAck: boolean;
  seq = 0;
  private nextId = 1;
  private chunks: string[] = [];
  private waiters: (() => void)[] = [];
  private closedValue: Closed | undefined;

  private constructor(
    readonly socket: WebSocket,
    options: ConnectOptions,
  ) {
    this.clientId = options.clientId ?? 'dev_test';
    this.streamId = options.streamId ?? randomUUID();
    this.autoAck = options.autoAck ?? true;
    socket.on('message', (data) => this.onFrame(JSON.parse(data.toString()) as Frame));
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        this.closedValue = { code, reason: reason.toString() };
        resolve(this.closedValue);
        this.wake();
      });
    });
  }

  static async connect(url: string, options: ConnectOptions = {}): Promise<TestClient> {
    const headers: Record<string, string> = { ...options.headers };
    const token = options.token === undefined ? 'good-token' : options.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (options.cookie) headers.cookie = options.cookie;
    const socket = new WebSocket(url, { headers, ...options.ws });
    const client = new TestClient(socket, options);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  get isClosed(): Closed | undefined {
    return this.closedValue;
  }

  private onFrame(frame: Frame): void {
    this.frames.push(frame);
    if (frame.type === 'server_message') {
      this.messages.push(frame.message as Record<string, unknown>);
      if (this.autoAck) this.ack(frame.seq_id);
    } else if (frame.type === 'server_message_chunk') {
      this.chunks.push(frame.message_chunk_base64 as string);
      if (this.chunks.length === frame.segment_count) {
        this.messages.push(JSON.parse(Buffer.from(this.chunks.join(''), 'base64').toString('utf8')));
        this.chunks = [];
      }
      if (this.autoAck) this.ack(frame.seq_id);
    }
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /**
   * Resolves when `check` returns a value; rejects on close (unless waiting for it) or after 20 s. The
   * deadline is generous because a busy machine can take seconds to spawn an engine behind the host.
   */
  async until<T>(check: () => T | undefined | false, label = 'condition'): Promise<T> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const value = check();
      if (value !== undefined && value !== false) return value;
      if (this.closedValue) throw new Error(`socket closed ${JSON.stringify(this.closedValue)} while waiting for ${label}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The response to request `id`. */
  response(id: string | number): Promise<Record<string, unknown>> {
    return this.until(() => this.messages.find((m) => m.id === id && !('method' in m)), `response ${id}`);
  }

  /** Sends an envelope; header fields default to this client's ids and the next seq_id. */
  send(fields: Record<string, unknown>, consume = true): void {
    const seq = consume ? ++this.seq : undefined;
    this.raw(JSON.stringify({ client_id: this.clientId, stream_id: this.streamId, seq_id: seq, ...fields }));
  }

  raw(text: string | Buffer): void {
    this.socket.send(text, { binary: Buffer.isBuffer(text) });
  }

  ack(seq: number): void {
    this.send({ type: 'ack', seq_id: seq }, false);
  }

  ping(state: 'foreground' | 'background' = 'foreground'): number {
    this.send({ type: 'ping', state });
    return this.seq;
  }

  message(message: Record<string, unknown>): void {
    this.send({ type: 'client_message', message });
  }

  /** Sends a request and returns its id. */
  request(method: string, params?: Record<string, unknown>, id: string | number = `c-${this.nextId++}`): string | number {
    this.message(params === undefined ? { id, method } : { id, method, params });
    return id;
  }

  async call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.response(this.request(method, params));
  }

  /** initialize + initialized; returns the initialize response. */
  async handshake(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.call('initialize', { protocolVersion: 1, client: CLIENT, ...params });
    this.message({ method: 'initialized' });
    return response;
  }

  /** Sends one message as chunks of `segmentBytes` raw bytes. */
  sendChunked(message: unknown, segmentBytes = 100 * 1024): void {
    const bytes = Buffer.from(JSON.stringify(message), 'utf8');
    const count = Math.ceil(bytes.length / segmentBytes);
    for (let i = 0; i < count; i += 1) {
      this.send({
        type: 'client_message_chunk',
        segment_id: i,
        segment_count: count,
        message_size_bytes: bytes.length,
        message_chunk_base64: bytes.subarray(i * segmentBytes, (i + 1) * segmentBytes).toString('base64'),
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

export const CLIENT = { name: 'Test', version: '0.0.0', platform: 'test' };
