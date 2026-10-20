// One stream = one WebSocket (spec 0). This class is the per-socket state machine for spec 2 to 4:
// per-direction seq_id, acks and the unacked window with backpressure, ping/pong and the 90 s timeout,
// chunking both ways, and the initialize-first rule in front of the method registry.
import type { WebSocket } from 'ws';

import { ChunkError, MessageTooLarge, Reassembler, splitMessage } from './chunking.js';
import {
  ACCEPTED_PROTOCOL_VERSIONS,
  CloseCode,
  MAX_MESSAGE_BYTES,
  MAX_UNACKED_BYTES,
  MAX_UNACKED_ENVELOPES,
} from './constants.js';
import {
  checkInitializeParams,
  checkMessage,
  isNotification,
  isRequest,
  parseClientEnvelope,
  requestIdOf,
  type Message,
  type Request,
} from './guard.js';
import type { PresenceRegistry } from './presence.js';
import { RpcError, toErrorBody, type ErrorBody, type MethodRegistry, type RequestContext } from './router.js';

export type HostStatus = 'active' | 'degraded' | 'draining';

export interface SendOptions {
  /**
   * True for Journal events (spec 5.2). Only these wait while the unacked window is full (spec 2.1);
   * other messages still go out but never overtake anything already waiting.
   */
  journal?: boolean;
}

export interface ConnectionDeps {
  socket: WebSocket;
  clientId: string;
  registry: MethodRegistry;
  presence: PresenceRegistry;
  status: () => HostStatus;
  pingTimeoutMs: number;
  /** Claims a stream id for this connection; false when another open socket already uses it. */
  claimStreamId: (connection: Connection, streamId: string) => boolean;
  onClosed: (connection: Connection) => void;
  log: (message: string, error?: unknown) => void;
}

interface Pending {
  bytes: Buffer;
  journal: boolean;
}

/** WebSocket close reasons are limited to 123 UTF-8 bytes. */
function closeReason(reason: string): string {
  const bytes = Buffer.from(reason, 'utf8');
  return bytes.length <= 123 ? reason : bytes.subarray(0, 120).toString('utf8').replace(/�$/, '') + '...';
}

export class Connection {
  readonly clientId: string;
  private streamIdValue = '';
  private lastInSeq = 0;
  private lastOutSeq = 0;
  private readonly unacked: { seq: number; bytes: number }[] = [];
  private unackedBytes = 0;
  private readonly outbox: Pending[] = [];
  private readonly reassembler = new Reassembler();
  private readonly closeHandlers: (() => void)[] = [];
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private initState: 'none' | 'pending' | 'done' = 'none';
  private readyValue = false;
  private optOut: ReadonlySet<string> = new Set();
  private closing = false;
  private finished = false;

  constructor(private readonly deps: ConnectionDeps) {
    this.clientId = deps.clientId;
    deps.presence.open(this.clientId, this);
    deps.socket.on('message', (data, isBinary) => {
      // Spec 1: text frames only; binary frames are dropped.
      if (!isBinary) this.receive(data.toString());
    });
    deps.socket.on('close', () => this.finish());
    this.armPingTimer();
  }

  /** The client's stream_id; empty until the first envelope names it. */
  get streamId(): string {
    return this.streamIdValue;
  }

  /** `initialize` succeeded on this stream. */
  get initialized(): boolean {
    return this.initState === 'done';
  }

  /** The client also sent the `initialized` notification: unsolicited notifications may flow (spec 4). */
  get ready(): boolean {
    return this.readyValue;
  }

  get open(): boolean {
    return !this.closing;
  }

  /** Envelopes sent and not yet acked, and messages held back by backpressure. For diagnostics and tests. */
  get backlog(): { unackedEnvelopes: number; unackedBytes: number; waiting: number } {
    return { unackedEnvelopes: this.unacked.length, unackedBytes: this.unackedBytes, waiting: this.outbox.length };
  }

  /**
   * Sends a notification (spec 3). Returns false when it was not accepted: stream closed, not
   * initialized, or the method is in the client's `optOutNotifications`. Throws MessageTooLarge above
   * 16 MiB serialized.
   */
  notify(method: string, params: Record<string, unknown> | undefined, options: SendOptions = {}): boolean {
    if (!this.initialized || this.closing || this.optOut.has(method)) return false;
    this.send(params === undefined ? { method } : { method, params }, options.journal ?? false);
    return true;
  }

  /** Closes the stream with a spec 10 code. Idempotent. */
  close(code: number, reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.clearPingTimer();
    this.deps.socket.close(code, closeReason(reason));
  }

  // ---- inbound ----------------------------------------------------------------------------------

  private receive(text: string): void {
    if (this.closing) return;
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      this.close(CloseCode.tooLarge, 'frame exceeds 16 MiB');
      return;
    }
    const parsed = parseClientEnvelope(text);
    if (!parsed.ok) {
      this.close(CloseCode.sequence, `invalid envelope at ${parsed.path || '(root)'}: ${parsed.message}`);
      return;
    }
    const envelope = parsed.value;
    if (envelope.client_id !== this.clientId) {
      this.close(CloseCode.unauthorized, 'client_id does not match the authenticated device');
      return;
    }
    if (this.streamIdValue === '') {
      if (!this.deps.claimStreamId(this, envelope.stream_id)) {
        this.close(CloseCode.sequence, 'stream_id is already in use by another socket');
        return;
      }
      this.streamIdValue = envelope.stream_id;
      this.deps.presence.identify(this.clientId, this, envelope.stream_id);
    } else if (envelope.stream_id !== this.streamIdValue) {
      this.close(CloseCode.sequence, 'stream_id changed on an open stream');
      return;
    }
    if (envelope.type === 'ack') {
      this.receiveAck(envelope.seq_id);
      return;
    }
    if (envelope.seq_id !== this.lastInSeq + 1) {
      this.close(CloseCode.sequence, `seq_id ${envelope.seq_id} after ${this.lastInSeq}`);
      return;
    }
    this.lastInSeq = envelope.seq_id;
    if (this.reassembler.inProgress && envelope.type !== 'client_message_chunk') {
      this.close(CloseCode.sequence, `${envelope.type} inside a chunked message`);
      return;
    }
    switch (envelope.type) {
      case 'ping':
        this.armPingTimer();
        this.deps.presence.ping(this.clientId, this, envelope.state);
        this.sendControl({ type: 'pong', seq_id: envelope.seq_id, status: this.deps.status() });
        return;
      case 'client_closed':
        this.close(CloseCode.normal, `client closed${envelope.reason ? `: ${envelope.reason}` : ''}`);
        return;
      case 'client_message':
        this.sendControl({ type: 'ack', seq_id: envelope.seq_id });
        this.receiveMessage(envelope.message);
        return;
      case 'client_message_chunk': {
        this.sendControl({ type: 'ack', seq_id: envelope.seq_id });
        let text: string | undefined;
        try {
          text = this.reassembler.push(envelope);
        } catch (error) {
          const chunkError = error as ChunkError;
          this.close(chunkError.code, chunkError.message);
          return;
        }
        if (text === undefined) return;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          this.close(CloseCode.sequence, 'reassembled message is not JSON');
          return;
        }
        this.receiveMessage(value);
        return;
      }
    }
  }

  private receiveAck(seq: number): void {
    if (seq > this.lastOutSeq) {
      this.close(CloseCode.sequence, `ack ${seq} for an envelope not sent (last ${this.lastOutSeq})`);
      return;
    }
    // Batched acks: N acknowledges everything up to N. Stale or repeated acks change nothing.
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= seq) {
      this.unackedBytes -= this.unacked.shift()!.bytes;
    }
    this.drain();
  }

  private receiveMessage(value: unknown): void {
    const checked = checkMessage(value);
    if (!checked.ok) {
      const id = requestIdOf(value);
      if (id === undefined) {
        this.deps.log(`stream ${this.streamIdValue}: dropped malformed message at ${checked.path}: ${checked.message}`);
        return;
      }
      this.respondError(id, RpcError.invalidParams(checked.path, checked.message).toBody());
      return;
    }
    const message = checked.value;
    if (isRequest(message)) {
      void this.receiveRequest(message);
    } else if (isNotification(message)) {
      if (message.method === 'initialized' && this.initialized) this.readyValue = true;
    }
    // Responses from the client answer nothing: the host sends no requests in v1 (spec 3.1).
  }

  private async receiveRequest(request: Request): Promise<void> {
    const { id, method } = request;
    if (method === 'initialize') {
      await this.initialize(request);
      return;
    }
    if (!this.initialized) {
      this.respondError(id, { code: 'not_initialized', message: 'send initialize first' });
      return;
    }
    try {
      const result = await this.deps.registry.dispatch(method, request.params, this.context());
      this.respond(id, result);
    } catch (error) {
      this.respondFailure(id, method, error);
    }
  }

  private async initialize(request: Request): Promise<void> {
    const { id } = request;
    if (this.initState !== 'none') {
      this.respondError(id, RpcError.invalidParams('method', 'initialize was already sent on this stream').toBody());
      return;
    }
    const checked = checkInitializeParams(request.params);
    if (!checked.ok) {
      this.respondError(id, RpcError.invalidParams(checked.path, checked.message).toBody());
      return;
    }
    const params = checked.value;
    if (!ACCEPTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)) {
      const accepted = [...ACCEPTED_PROTOCOL_VERSIONS];
      this.respondError(id, {
        code: 'unsupported_protocol',
        message: `protocolVersion ${params.protocolVersion} is not supported`,
        data: { accepted },
      });
      this.close(CloseCode.unsupportedProtocol, `unsupported protocol version; accepted: ${accepted.join(',')}`);
      return;
    }
    this.initState = 'pending';
    try {
      const result = await this.deps.registry.dispatch('initialize', params, this.context());
      if (this.closing) return;
      this.initState = 'done';
      this.optOut = new Set(params.optOutNotifications ?? []);
      this.respond(id, result);
    } catch (error) {
      this.initState = 'none';
      this.respondFailure(id, 'initialize', error);
    }
  }

  private context(): RequestContext {
    return {
      clientId: this.clientId,
      streamId: this.streamIdValue,
      onClose: (fn) => {
        if (this.finished) fn();
        else this.closeHandlers.push(fn);
      },
    };
  }

  private respondFailure(id: string | number, method: string, error: unknown): void {
    const body = toErrorBody(error);
    if (body.code === 'internal') this.deps.log(`stream ${this.streamIdValue}: ${method} failed`, error);
    this.respondError(id, body);
  }

  private respond(id: string | number, result: Record<string, unknown>): void {
    if (this.closing) return;
    try {
      this.send({ id, result }, false);
    } catch (error) {
      // Only MessageTooLarge can get here: tell the client instead of leaving the request hanging.
      this.respondFailure(id, 'response', error);
    }
  }

  private respondError(id: string | number, error: ErrorBody): void {
    if (this.closing) return;
    this.send({ id, error }, false);
  }

  // ---- outbound ---------------------------------------------------------------------------------

  private windowFull(): boolean {
    return this.unacked.length >= MAX_UNACKED_ENVELOPES || this.unackedBytes >= MAX_UNACKED_BYTES;
  }

  private send(message: Message, journal: boolean): void {
    const bytes = Buffer.from(JSON.stringify(message), 'utf8');
    if (bytes.length > MAX_MESSAGE_BYTES) throw new MessageTooLarge(bytes.length);
    if (this.outbox.length > 0 || (journal && this.windowFull())) {
      this.outbox.push({ bytes, journal });
      return;
    }
    this.transmit(bytes);
  }

  /** Sends what backpressure held back, in order, until a Journal event meets a full window again. */
  private drain(): void {
    while (!this.closing && this.outbox.length > 0) {
      const head = this.outbox[0]!;
      if (head.journal && this.windowFull()) return;
      this.outbox.shift();
      this.transmit(head.bytes);
    }
  }

  /** One message as one server_message, or as consecutive chunks with nothing in between (2.3). */
  private transmit(bytes: Buffer): void {
    const segments = splitMessage(bytes);
    if (segments === null) {
      const seq = ++this.lastOutSeq;
      this.sendFrame(
        seq,
        `{"type":"server_message","client_id":${JSON.stringify(this.clientId)},` +
          `"stream_id":${JSON.stringify(this.streamIdValue)},"seq_id":${seq},"message":${bytes.toString('utf8')}}`,
      );
      return;
    }
    for (const segment of segments) {
      const seq = ++this.lastOutSeq;
      this.sendFrame(seq, JSON.stringify({ type: 'server_message_chunk', ...this.header(seq), ...segment }));
    }
  }

  private sendFrame(seq: number, frame: string): void {
    const size = Buffer.byteLength(frame, 'utf8');
    this.unacked.push({ seq, bytes: size });
    this.unackedBytes += size;
    this.deps.socket.send(frame);
  }

  /** ack and pong: they answer a client envelope and consume no seq_id (spec 2). */
  private sendControl(fields: { type: 'ack'; seq_id: number } | { type: 'pong'; seq_id: number; status: HostStatus }): void {
    this.deps.socket.send(JSON.stringify({ ...fields, ...this.header(fields.seq_id) }));
  }

  private header(seq: number): { client_id: string; stream_id: string; seq_id: number } {
    return { client_id: this.clientId, stream_id: this.streamIdValue, seq_id: seq };
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  private armPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => this.close(CloseCode.pingTimeout, 'no ping for 90 s'), this.deps.pingTimeoutMs);
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== undefined) clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
  }

  /** Runs once, on the socket's close event, whoever closed it. */
  private finish(): void {
    this.finished = true;
    this.closing = true;
    this.clearPingTimer();
    this.outbox.length = 0;
    this.deps.presence.close(this.clientId, this);
    for (const fn of this.closeHandlers.splice(0)) {
      try {
        fn();
      } catch (error) {
        this.deps.log(`stream ${this.streamIdValue}: close handler failed`, error);
      }
    }
    this.deps.onClosed(this);
  }
}
