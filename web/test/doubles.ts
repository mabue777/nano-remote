// Test doubles for the stream layer: a scriptable socket and a lifecycle you can drive by hand.
import type { Presence, SocketLike } from '../src/stream/envelope-stream';
import type { Lifecycle, LifecycleHandlers } from '../src/stream/lifecycle';

/* eslint-disable @typescript-eslint/no-explicit-any */
export class FakeSocket implements SocketLike {
  readonly sent: any[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, ((event: any) => void)[]>();
  sendThrows = false;
  closeThrows = false;

  constructor(readonly url = 'ws://fake/v1/stream') {}

  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    if (this.closeThrows) throw new Error('cannot close');
  }

  /** Envelopes of one type, in order. */
  ofType(type: string): any[] {
    return this.sent.filter((e) => e.type === type);
  }

  /** The JSON-RPC messages sent in client_message envelopes. */
  get messages(): any[] {
    return this.ofType('client_message').map((e) => e.message);
  }

  fire(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.fire('open');
  }

  /** Delivers a text frame. Objects are serialized. */
  deliver(frame: unknown): void {
    this.fire('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverClose(code: number, reason = ''): void {
    this.fire('close', { code, reason });
  }
}

/** Builds host envelopes for one stream, numbering server seq_ids itself. */
export class HostScript {
  private seq = 0;
  constructor(
    private readonly socket: FakeSocket,
    readonly streamId: string,
    readonly clientId = 'dev_test',
  ) {}

  header(seq: number) {
    return { client_id: this.clientId, stream_id: this.streamId, seq_id: seq };
  }

  message(message: unknown): number {
    const seq = ++this.seq;
    this.socket.deliver({ type: 'server_message', ...this.header(seq), message });
    return seq;
  }

  /** Answers the latest request with this method. */
  answer(method: string, result: unknown): void {
    const request = [...this.socket.messages].reverse().find((m) => m.method === method);
    if (request === undefined) throw new Error(`no ${method} request sent`);
    this.message({ id: request.id, result });
  }

  fail(method: string, error: { code: string; message: string; data?: unknown }): void {
    const request = [...this.socket.messages].reverse().find((m) => m.method === method);
    if (request === undefined) throw new Error(`no ${method} request sent`);
    this.message({ id: request.id, error });
  }

  ack(seq: number): void {
    this.socket.deliver({ type: 'ack', ...this.header(seq) });
  }

  pong(seq: number, status = 'active'): void {
    this.socket.deliver({ type: 'pong', ...this.header(seq), status });
  }

  /** Delivers an envelope with an explicit seq_id (for gap tests); does not move the counter. */
  raw(fields: Record<string, unknown>): void {
    this.socket.deliver({ client_id: this.clientId, stream_id: this.streamId, ...fields });
  }

  get lastSeq(): number {
    return this.seq;
  }

  set nextSeq(value: number) {
    this.seq = value - 1;
  }
}

export class ManualLifecycle implements Lifecycle {
  state: Presence = 'foreground';
  private handlers: LifecycleHandlers | undefined;
  unsubscribed = false;

  presence(): Presence {
    return this.state;
  }

  subscribe(handlers: LifecycleHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.unsubscribed = true;
      this.handlers = undefined;
    };
  }

  setVisibility(state: Presence): void {
    this.state = state;
    this.handlers?.visibility(state);
  }

  pagehide(): void {
    this.handlers?.pagehide();
  }

  pageshow(): void {
    this.handlers?.pageshow();
  }
}

export const INIT_RESULT = {
  protocolVersion: 1,
  host: { hostId: 'host_t', name: 'test-mac', version: '0.1.0', os: 'darwin', arch: 'arm64' },
  device: { clientId: 'dev_test', displayName: 'Test phone' },
  agents: [{ id: 'codex', name: 'Codex', status: 'ready' }],
  push: { vapidPublicKey: 'B', subscribed: false },
  limits: { maxMessageBytes: 16777216, snapshotTurns: 5 },
};
