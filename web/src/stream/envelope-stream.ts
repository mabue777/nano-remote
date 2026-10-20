// One stream = one WebSocket (spec 0). This class is the client's per-socket envelope state machine
// (spec 2): its own stream_id, seq_id per direction, batched acks for what the host sends, the unacked
// window for what we send, pings on a timer, chunking both ways. It knows nothing about JSON-RPC; the
// StreamClient on top of it does requests, reconnects and close-code policy.
import { ChunkError, Reassembler, splitMessage, utf8, type Segment } from './chunking';
import { CloseCode, MAX_MESSAGE_BYTES, MAX_UNACKED_BYTES, MAX_UNACKED_ENVELOPES, type Timing } from './constants';

/** The part of the WebSocket API we use. The browser WebSocket and Node's global WebSocket both fit. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type Presence = 'foreground' | 'background';
export type PongStatus = 'active' | 'degraded' | 'draining';

export interface StreamClose {
  code: number;
  reason: string;
  /** True when this client closed the socket (a protocol error it detected, pagehide, stop). */
  byClient: boolean;
}

export interface EnvelopeStreamOptions {
  socket: SocketLike;
  clientId: string;
  streamId: string;
  timing: Pick<Timing, 'ackDelayMs' | 'ackBatch' | 'pingIntervalMs'>;
  /** Read at every ping, so a ping always carries the current presence. */
  presence: () => Presence;
  onOpen: () => void;
  onMessage: (message: unknown) => void;
  onPong: (status: PongStatus) => void;
  onClose: (close: StreamClose) => void;
}

interface Envelope {
  type: string;
  stream_id?: unknown;
  seq_id?: unknown;
  message?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

/** Thrown by `send` for a message above the 16 MiB cap; the stream stays open. */
export class MessageTooLarge extends Error {
  constructor(readonly size: number) {
    super(`message of ${size} bytes exceeds the ${MAX_MESSAGE_BYTES} byte cap`);
    this.name = 'MessageTooLarge';
  }
}

export class EnvelopeStream {
  readonly streamId: string;
  private readonly socket: SocketLike;
  private readonly clientId: string;
  private readonly options: EnvelopeStreamOptions;
  private phase: 'connecting' | 'open' | 'closed' = 'connecting';
  private lastOut = 0;
  private lastIn = 0;
  private readonly unacked: { seq: number; bytes: number }[] = [];
  private unackedBytes = 0;
  private readonly outbox: string[] = [];
  private ackSeq = 0;
  private ackCount = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly reassembler = new Reassembler();

  constructor(options: EnvelopeStreamOptions) {
    this.options = options;
    this.socket = options.socket;
    this.clientId = options.clientId;
    this.streamId = options.streamId;
    this.socket.addEventListener('open', () => this.opened());
    this.socket.addEventListener('message', (event: { data: unknown }) => {
      // Spec 1: text frames only; binary frames are dropped.
      if (typeof event.data === 'string') this.receive(event.data);
    });
    this.socket.addEventListener('close', (event: { code?: number; reason?: string }) =>
      this.finish({ code: event.code ?? 1006, reason: event.reason ?? '', byClient: false }),
    );
  }

  get open(): boolean {
    return this.phase === 'open';
  }

  /** Our sent and unacked envelopes, and messages held back by the window. For diagnostics and tests. */
  get backlog(): { unackedEnvelopes: number; unackedBytes: number; waiting: number } {
    return { unackedEnvelopes: this.unacked.length, unackedBytes: this.unackedBytes, waiting: this.outbox.length };
  }

  /**
   * Sends one JSON-RPC message, chunked above 100 KiB. Held back (in order) while the unacked window is
   * full. Returns false when the stream is not open; throws MessageTooLarge above 16 MiB.
   */
  send(message: unknown): boolean {
    if (this.phase !== 'open') return false;
    const json = JSON.stringify(message);
    const size = utf8(json).length;
    if (size > MAX_MESSAGE_BYTES) throw new MessageTooLarge(size);
    if (this.outbox.length > 0 || this.windowFull()) this.outbox.push(json);
    else this.transmit(json);
    return true;
  }

  /** Sends a ping now with the given presence (spec 2.2). */
  ping(state: Presence = this.options.presence()): void {
    if (this.phase !== 'open') return;
    this.socket.send(JSON.stringify({ type: 'ping', ...this.header(++this.lastOut), state }));
  }

  /** Says goodbye with `client_closed` (spec 2) and closes the socket normally. */
  clientClosed(reason: 'background' | 'user' | 'error'): void {
    if (this.phase === 'open') {
      this.flushAck();
      this.socket.send(JSON.stringify({ type: 'client_closed', ...this.header(++this.lastOut), reason }));
    }
    this.close(CloseCode.normal, `client closed: ${reason}`);
  }

  /** Closes the socket from our side. Idempotent; reports onClose with byClient true. */
  close(code: number, reason: string): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'open' && code === CloseCode.normal) this.flushAck();
    try {
      this.socket.close(code, reason);
    } catch {
      // A socket that is still connecting may refuse; it is abandoned either way.
    }
    this.finish({ code, reason, byClient: true });
  }

  // ---- inbound ----------------------------------------------------------------------------------

  private opened(): void {
    if (this.phase !== 'connecting') return;
    this.phase = 'open';
    // Walkthrough 13: the first envelope on a new socket is a ping with the current presence.
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), this.options.timing.pingIntervalMs);
    this.options.onOpen();
  }

  private receive(text: string): void {
    if (this.phase !== 'open') return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      this.close(CloseCode.sequence, 'envelope is not JSON');
      return;
    }
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      this.close(CloseCode.sequence, 'envelope has no type');
      return;
    }
    if (envelope.stream_id !== this.streamId) {
      this.close(CloseCode.sequence, 'envelope names another stream');
      return;
    }
    const seq = envelope.seq_id;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
      this.close(CloseCode.sequence, 'envelope has no seq_id');
      return;
    }
    switch (envelope.type) {
      case 'ack':
        this.receiveAck(seq);
        return;
      case 'pong':
        this.options.onPong(envelope.status as PongStatus);
        return;
      case 'server_message':
      case 'server_message_chunk':
        break;
      default:
        return; // unknown envelope types are ignored (spec 12)
    }
    // Sequence-consuming envelopes: seq_id must be last + 1, else the stream is broken (2.1).
    if (seq !== this.lastIn + 1) {
      this.close(CloseCode.sequence, `seq_id ${seq} after ${this.lastIn}`);
      return;
    }
    this.lastIn = seq;
    if (this.reassembler.inProgress && envelope.type !== 'server_message_chunk') {
      this.close(CloseCode.sequence, `${envelope.type} inside a chunked message`);
      return;
    }
    this.scheduleAck(seq);
    if (envelope.type === 'server_message') {
      this.options.onMessage(envelope.message);
      return;
    }
    let joined: string | undefined;
    try {
      joined = this.reassembler.push(envelope as unknown as Segment);
    } catch (error) {
      const chunkError = error as ChunkError;
      this.close(chunkError.code, chunkError.message);
      return;
    }
    if (joined === undefined) return;
    let message: unknown;
    try {
      message = JSON.parse(joined);
    } catch {
      this.close(CloseCode.sequence, 'reassembled message is not JSON');
      return;
    }
    this.options.onMessage(message);
  }

  private receiveAck(seq: number): void {
    if (seq > this.lastOut) {
      this.close(CloseCode.sequence, `ack ${seq} for an envelope not sent (last ${this.lastOut})`);
      return;
    }
    // Batched acks: N acknowledges everything up to N.
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= seq) {
      this.unackedBytes -= this.unacked.shift()!.bytes;
    }
    while (this.phase === 'open' && this.outbox.length > 0 && !this.windowFull()) {
      this.transmit(this.outbox.shift()!);
    }
  }

  private scheduleAck(seq: number): void {
    this.ackSeq = seq;
    this.ackCount += 1;
    if (this.ackCount >= this.options.timing.ackBatch) {
      this.flushAck();
    } else if (this.ackTimer === undefined) {
      this.ackTimer = setTimeout(() => this.flushAck(), this.options.timing.ackDelayMs);
    }
  }

  private flushAck(): void {
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.ackCount === 0 || this.phase !== 'open') return;
    this.ackCount = 0;
    // ack consumes no seq_id: it carries the seq_id of the envelope it answers (spec 2).
    this.socket.send(JSON.stringify({ type: 'ack', ...this.header(this.ackSeq) }));
  }

  // ---- outbound ---------------------------------------------------------------------------------

  private windowFull(): boolean {
    return this.unacked.length >= MAX_UNACKED_ENVELOPES || this.unackedBytes >= MAX_UNACKED_BYTES;
  }

  /** One message as one client_message, or as consecutive chunks with nothing in between (2.3). */
  private transmit(json: string): void {
    const segments = splitMessage(utf8(json));
    if (segments === null) {
      const seq = ++this.lastOut;
      this.sendCounted(
        seq,
        `{"type":"client_message","client_id":${JSON.stringify(this.clientId)},` +
          `"stream_id":${JSON.stringify(this.streamId)},"seq_id":${seq},"message":${json}}`,
      );
      return;
    }
    for (const segment of segments) {
      const seq = ++this.lastOut;
      this.sendCounted(seq, JSON.stringify({ type: 'client_message_chunk', ...this.header(seq), ...segment }));
    }
  }

  private sendCounted(seq: number, frame: string): void {
    const bytes = utf8(frame).length;
    this.unacked.push({ seq, bytes });
    this.unackedBytes += bytes;
    this.socket.send(frame);
  }

  private header(seq: number): { client_id: string; stream_id: string; seq_id: number } {
    return { client_id: this.clientId, stream_id: this.streamId, seq_id: seq };
  }

  private finish(close: StreamClose): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.ackTimer = undefined;
    this.pingTimer = undefined;
    this.options.onClose(close);
  }
}
