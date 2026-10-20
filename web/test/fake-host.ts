// A fake Nano Host for the web tests: an in-process ws server that speaks the envelope (spec 2: seq_id
// checks, acks, pongs, chunking both ways), the message layer (initialize first, JSON-RPC errors), a
// per-session Journal with session/open in events and snapshot mode, events/since and cursor_expired,
// and a scripted agent that plays the walkthrough of spec 13: a turn with streamed text, a command that
// needs approval, and the rest of the turn after the decision (or an interrupt).
//
// It is written independently of web/src so a bug in the client cannot hide behind the same bug here.
// Shapes come from protocol/examples via fixtures.ts. Test knobs: kill() drops every socket the way iOS
// does on lock, closeAll(code) closes with a spec 10 code, compact() makes old cursors expire,
// dropLive() loses one live event, onRequest intercepts requests, refuse() closes new sockets.
import { WebSocketServer, type WebSocket } from 'ws';

import { exampleMessage } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const SEGMENT_BYTES = 100 * 1024;
const SEND_SEGMENT_BYTES = SEGMENT_BYTES - (SEGMENT_BYTES % 3);

export interface JournalEntry {
  method: string;
  params: Json;
}

interface FakeSession {
  summary: Json;
  settings: Json;
  journal: JournalEntry[];
  /** Events with seq at or below this are compacted away: old cursors expire. */
  compactedThrough: number;
  turns: Json[];
  items: Map<string, Json>;
  approvals: Map<string, Json>;
  inputs: Map<string, Json>;
  byClientMessageId: Map<string, string>;
  /** The scripted turn in progress, if any. */
  running?: { turnId: string; commandItemId: string; requestId?: string };
}

export type RequestHook = (
  method: string,
  params: Json,
  stream: FakeStream,
) => undefined | 'drop' | { result: Json } | { error: { code: string; message: string; data?: Json } };

export interface FakeHostOptions {
  /** How many item/delta events the scripted agent message streams (the capture had 752). */
  deltas?: number;
}

export class FakeStream {
  clientId = '';
  streamId = '';
  initialized = false;
  ready = false;
  readonly subscriptions = new Set<string>();
  /** Every envelope the client sent, parsed, in order. */
  readonly received: Json[] = [];
  /** Every request message the client sent (chunked ones reassembled). */
  readonly requests: Json[] = [];
  /** Highest seq_id the client acked. */
  lastAck = 0;
  /** Number of ack envelopes the client sent. */
  ackCount = 0;
  lastIn = 0;
  lastOut = 0;
  closed = false;
  private chunks: Buffer[] = [];
  private chunkCount = 0;

  constructor(
    readonly socket: WebSocket,
    private readonly host: FakeHost,
  ) {
    socket.on('message', (data, isBinary) => {
      if (!isBinary) this.receive(data.toString());
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  close(code: number, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(code, reason);
  }

  /** Sends text as is, for protocol-error tests. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** server_message, or server_message_chunk envelopes above 100 KiB (spec 2.3). */
  send(message: Json): void {
    if (this.closed) return;
    const bytes = Buffer.from(JSON.stringify(message), 'utf8');
    const header = () => ({ client_id: this.clientId, stream_id: this.streamId, seq_id: ++this.lastOut });
    if (bytes.length <= SEGMENT_BYTES) {
      this.socket.send(JSON.stringify({ type: 'server_message', ...header(), message }));
      return;
    }
    const count = Math.ceil(bytes.length / SEND_SEGMENT_BYTES);
    for (let i = 0; i < count; i += 1) {
      this.socket.send(
        JSON.stringify({
          type: 'server_message_chunk',
          ...header(),
          segment_id: i,
          segment_count: count,
          message_size_bytes: bytes.length,
          message_chunk_base64: bytes.subarray(i * SEND_SEGMENT_BYTES, (i + 1) * SEND_SEGMENT_BYTES).toString('base64'),
        }),
      );
    }
  }

  notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  private control(type: 'ack' | 'pong', seq: number, extra: Json = {}): void {
    this.socket.send(JSON.stringify({ type, client_id: this.clientId, stream_id: this.streamId, seq_id: seq, ...extra }));
  }

  private receive(text: string): void {
    if (this.closed) return;
    const envelope = JSON.parse(text);
    this.received.push(envelope);
    if (this.streamId === '') {
      this.streamId = envelope.stream_id;
      this.clientId = envelope.client_id;
    } else if (envelope.stream_id !== this.streamId) {
      this.close(4002, 'stream_id changed');
      return;
    }
    if (envelope.type === 'ack') {
      this.lastAck = Math.max(this.lastAck, envelope.seq_id);
      this.ackCount += 1;
      return;
    }
    if (envelope.seq_id !== this.lastIn + 1) {
      this.close(4002, `seq_id ${envelope.seq_id} after ${this.lastIn}`);
      return;
    }
    this.lastIn = envelope.seq_id;
    switch (envelope.type) {
      case 'ping':
        this.host.pings.push({ streamId: this.streamId, state: envelope.state });
        this.control('pong', envelope.seq_id, { status: this.host.pongStatus });
        return;
      case 'client_closed':
        this.host.goodbyes.push({ streamId: this.streamId, reason: envelope.reason });
        this.close(1000, 'client closed');
        return;
      case 'client_message':
        this.control('ack', envelope.seq_id);
        this.message(envelope.message);
        return;
      case 'client_message_chunk': {
        this.control('ack', envelope.seq_id);
        this.chunks.push(Buffer.from(envelope.message_chunk_base64, 'base64'));
        this.chunkCount = envelope.segment_count;
        if (this.chunks.length < this.chunkCount) return;
        const joined = Buffer.concat(this.chunks);
        this.chunks = [];
        if (joined.length !== envelope.message_size_bytes) {
          this.close(4002, 'chunk size mismatch');
          return;
        }
        this.message(JSON.parse(joined.toString('utf8')));
        return;
      }
      default:
        this.close(4002, `unknown envelope ${envelope.type}`);
    }
  }

  private message(message: Json): void {
    if (typeof message.method !== 'string') return;
    if (message.id === undefined) {
      if (message.method === 'initialized' && this.initialized) this.ready = true;
      return;
    }
    this.requests.push(message);
    this.host.requestLog.push({ streamId: this.streamId, method: message.method, params: message.params });
    const hooked = this.host.onRequest?.(message.method, message.params ?? {}, this);
    if (hooked === 'drop') return;
    if (hooked !== undefined) {
      this.send({ id: message.id, ...hooked });
      return;
    }
    if (message.method !== 'initialize' && !this.initialized) {
      this.send({ id: message.id, error: { code: 'not_initialized', message: 'send initialize first' } });
      return;
    }
    let after: (() => void) | undefined;
    try {
      const outcome = this.host.handle(this, message.method, message.params ?? {});
      after = outcome.after;
      this.send({ id: message.id, result: outcome.result });
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      this.send({ id: message.id, error: error.body });
      after = (error as HostError & { after?: () => void }).after;
    }
    after?.();
  }
}

export class HostError extends Error {
  constructor(readonly body: { code: string; message: string; data?: Json }) {
    super(body.message);
  }
}

export class FakeHost {
  url = '';
  readonly streams: FakeStream[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly requestLog: { streamId: string; method: string; params: Json }[] = [];
  readonly pings: { streamId: string; state: string }[] = [];
  readonly goodbyes: { streamId: string; reason: string | undefined }[] = [];
  pongStatus: 'active' | 'degraded' | 'draining' = 'active';
  onRequest: RequestHook | undefined;
  private server: WebSocketServer | undefined;
  private refusal: { code: number; reason: string } | undefined;
  private readonly dropped = new Set<string>();
  private nextSession = 0;
  private nextId = 0;
  private readonly deltas: number;

  constructor(options: FakeHostOptions = {}) {
    this.deltas = options.deltas ?? 12;
  }

  async start(): Promise<string> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/v1/stream' });
    this.server = server;
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    server.on('connection', (socket) => {
      if (this.refusal !== undefined) {
        socket.close(this.refusal.code, this.refusal.reason);
        return;
      }
      this.streams.push(new FakeStream(socket, this));
    });
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    this.url = `ws://127.0.0.1:${address.port}/v1/stream`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const stream of this.streams) stream.socket.terminate();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Open streams, oldest first. */
  get openStreams(): FakeStream[] {
    return this.streams.filter((s) => !s.closed);
  }

  /** The newest open stream. */
  get stream(): FakeStream | undefined {
    return this.openStreams.at(-1);
  }

  /** Drops every socket without a close frame, the way iOS does about 30 s after lock. */
  kill(): void {
    for (const stream of this.openStreams) {
      stream.closed = true;
      stream.socket.terminate();
    }
  }

  closeAll(code: number, reason = ''): void {
    for (const stream of this.openStreams) stream.close(code, reason);
  }

  /** New sockets are closed at once with this code until refuse(undefined). */
  refuse(close: { code: number; reason: string } | undefined): void {
    this.refusal = close;
  }

  /** Forgets every event up to `throughSeq`: cursors before it expire (spec 6). */
  compact(sessionId: string, throughSeq: number): void {
    this.session(sessionId).compactedThrough = throughSeq;
  }

  /** The live delivery of this event is lost (it stays in the Journal). */
  dropLive(sessionId: string, seq: number): void {
    this.dropped.add(`${sessionId}#${seq}`);
  }

  session(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new HostError({ code: 'not_found', message: `no session ${sessionId}` });
    return session;
  }

  head(sessionId: string): number {
    return this.session(sessionId).journal.length;
  }

  /** Creates a session without any client, the way the desktop would. */
  createSession(fields: Json = {}): string {
    const template = exampleMessage('13').result.session;
    const { settings, ...summary } = template;
    const sessionId = `ses_fake_${++this.nextSession}`;
    const now = 1760930000 + this.nextSession;
    this.sessions.set(sessionId, {
      summary: { ...summary, ...fields, sessionId, status: 'idle', createdAt: now, updatedAt: now, lastSeq: 0, pending: { approvals: 0, inputs: 0 } },
      settings,
      journal: [],
      compactedThrough: 0,
      turns: [],
      items: new Map(),
      approvals: new Map(),
      inputs: new Map(),
      byClientMessageId: new Map(),
    });
    return sessionId;
  }

  /**
   * Appends a Journal event (seq assigned here), folds it into the session state, and sends it to every
   * ready stream subscribed to the session.
   */
  emit(sessionId: string, method: string, params: Json): JournalEntry {
    const session = this.session(sessionId);
    const seq = session.journal.length + 1;
    const entry = { method, params: { sessionId, seq, ...params } };
    session.journal.push(entry);
    this.fold(session, entry);
    if (this.dropped.delete(`${sessionId}#${seq}`)) return entry;
    for (const stream of this.openStreams) {
      if (stream.ready && stream.subscriptions.has(sessionId)) stream.notify(method, entry.params);
    }
    return entry;
  }

  /** Sends an unsequenced notification to every ready stream. */
  broadcast(method: string, params: Json): void {
    for (const stream of this.openStreams) if (stream.ready) stream.notify(method, params);
  }

  /** Answers the pending approval as another device would (the phone sees only events). */
  resolveElsewhere(sessionId: string, decision: 'accept' | 'decline' | 'cancel', by = 'dev_desktop'): void {
    const running = this.session(sessionId).running;
    if (running?.requestId === undefined) throw new Error('no approval pending');
    this.decide(sessionId, running.requestId, decision, by);
  }

  // ---- methods ----------------------------------------------------------------------------------

  handle(stream: FakeStream, method: string, params: Json): { result: Json; after?: () => void } {
    switch (method) {
      case 'initialize': {
        if (stream.initialized) throw new HostError({ code: 'invalid_params', message: 'initialize was already sent' });
        if (params.protocolVersion !== 1) {
          const after = () => stream.close(4001, 'unsupported protocol version; accepted: 1');
          throw Object.assign(new HostError({ code: 'unsupported_protocol', message: 'v1 only', data: { accepted: [1] } }), { after });
        }
        stream.initialized = true;
        const result = exampleMessage('08').result;
        result.device.clientId = stream.clientId;
        return { result };
      }
      case 'session/list': {
        const sessions = [...this.sessions.values()].map((s) => ({ ...s.summary })).sort((a, b) => b.updatedAt - a.updatedAt);
        return { result: { sessions } };
      }
      case 'session/start': {
        const sessionId = this.createSession({ agentId: params.agentId, cwd: params.cwd, title: params.title ?? 'New session' });
        const session = this.session(sessionId);
        if (!Array.isArray(params.input)) return { result: { session: this.full(session) } };
        const turn = this.newTurn(session, undefined);
        return {
          result: { session: this.full(session), turn: { ...turn, items: [] } },
          after: () => this.playTurn(sessionId, turn.turnId, params.input, undefined),
        };
      }
      case 'session/open':
        return this.open(stream, params);
      case 'session/close':
        stream.subscriptions.delete(params.sessionId);
        return { result: { ok: true } };
      case 'events/since': {
        const session = this.session(params.sessionId);
        if (params.cursor < session.compactedThrough) {
          throw new HostError({ code: 'cursor_expired', message: 'cursor is older than the Journal keeps' });
        }
        const limit = params.limit ?? 100;
        const events = session.journal.slice(params.cursor, params.cursor + limit);
        const cursor = params.cursor + events.length;
        return { result: { events, cursor, complete: cursor >= session.journal.length } };
      }
      case 'turn/start': {
        const session = this.session(params.sessionId);
        const known = session.byClientMessageId.get(params.clientMessageId);
        if (known !== undefined) {
          // Same clientMessageId twice: the existing turn, not a new one (spec 7).
          const turn = session.turns.find((t) => t.turnId === known);
          return { result: { turn: { ...turn, items: [...turn.items] } } };
        }
        if (session.running !== undefined) {
          throw new HostError({ code: 'session_busy', message: 'A turn is already running in this session.', data: { turnId: session.running.turnId } });
        }
        const turn = this.newTurn(session, params.clientMessageId);
        return {
          result: { turn: { ...turn, items: [] } },
          after: () => this.playTurn(params.sessionId, turn.turnId, params.input, params.clientMessageId),
        };
      }
      case 'turn/interrupt': {
        const session = this.session(params.sessionId);
        if (session.running?.turnId !== params.turnId) return { result: { ok: true } };
        return { result: { ok: true }, after: () => this.interruptTurn(params.sessionId) };
      }
      case 'approval/resolve': {
        const session = this.session(params.sessionId);
        if (!session.approvals.has(params.requestId)) {
          const answered = session.journal.find((e) => e.method === 'request/resolved' && e.params.requestId === params.requestId);
          if (answered) throw new HostError({ code: 'already_resolved', message: 'answered', data: { resolvedBy: answered.params.resolvedBy } });
          throw new HostError({ code: 'not_found', message: 'no such request' });
        }
        return { result: { ok: true }, after: () => this.decide(params.sessionId, params.requestId, params.decision, stream.clientId) };
      }
      case 'host/status':
        return { result: exampleMessage('44').params };
      default:
        throw new HostError({ code: 'method_not_found', message: `unknown method ${method}` });
    }
  }

  private open(stream: FakeStream, params: Json): { result: Json; after: () => void } {
    const session = this.session(params.sessionId);
    // Subscribing after the response is sent means live events start right after the response's cursor.
    const after = () => stream.subscriptions.add(params.sessionId);
    const cursor = session.journal.length;
    const pending = { approvals: [...session.approvals.values()], inputs: [...session.inputs.values()] };
    if (typeof params.cursor === 'number' && params.cursor >= session.compactedThrough) {
      return {
        result: { mode: 'events', session: this.full(session), events: session.journal.slice(params.cursor), cursor, pending },
        after,
      };
    }
    const turns = session.turns.slice(-(params.turns ?? 5)).map((turn) => ({
      ...turn,
      items: turn.items.map((id: string) => session.items.get(id)).filter(Boolean),
    }));
    return { result: { mode: 'snapshot', session: this.full(session), turns, cursor, pending }, after };
  }

  // ---- the scripted agent (walkthrough, spec 13) ------------------------------------------------

  private newTurn(session: FakeSession, clientMessageId: string | undefined): Json {
    const turnId = `trn_fake_${++this.nextId}`;
    const turn = { turnId, status: 'inProgress', startedAt: 1760930100 + this.nextId, completedAt: null, error: null, items: [] };
    if (clientMessageId !== undefined) session.byClientMessageId.set(clientMessageId, turnId);
    session.running = { turnId, commandItemId: `itm_fake_${++this.nextId}` };
    return turn;
  }

  /** P6: turn/started, the user's message, streamed agent text, a command, and its approval request. */
  private playTurn(sessionId: string, turnId: string, input: Json, clientMessageId: string | undefined): void {
    const session = this.session(sessionId);
    const running = session.running!;
    this.emit(sessionId, 'turn/started', { turn: { turnId, status: 'inProgress', startedAt: 1760930100, completedAt: null, error: null, items: [] } });
    const user = {
      itemId: `itm_fake_${++this.nextId}`,
      type: 'userMessage',
      turnId,
      status: 'completed',
      content: input,
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
    };
    this.emit(sessionId, 'item/started', { turnId, item: user });
    this.emit(sessionId, 'status/changed', { status: 'running' });
    const agent = exampleMessage('28').params.item;
    const text: string = agent.text;
    const agentId = `itm_fake_${++this.nextId}`;
    this.emit(sessionId, 'item/started', { turnId, item: { ...agent, itemId: agentId, turnId, status: 'inProgress', text: '' } });
    const size = Math.ceil(text.length / this.deltas);
    for (let i = 0; i < text.length; i += size) {
      this.emit(sessionId, 'item/delta', { itemId: agentId, turnId, field: 'text', delta: text.slice(i, i + size) });
    }
    this.emit(sessionId, 'item/completed', { turnId, item: { ...agent, itemId: agentId, turnId, text } });
    const command = exampleMessage('29').params.item;
    this.emit(sessionId, 'item/started', { turnId, item: { ...command, itemId: running.commandItemId, turnId } });
    const request = exampleMessage('32').params.request;
    running.requestId = `req_fake_${++this.nextId}`;
    this.emit(sessionId, 'approval/request', {
      request: { ...request, requestId: running.requestId, sessionId, turnId, itemId: running.commandItemId },
    });
    this.emit(sessionId, 'status/changed', { status: 'waiting_approval' });
  }

  /** P7 and P8: the decision, then the rest of the turn. */
  private decide(sessionId: string, requestId: string, decision: string, resolvedBy: string): void {
    const session = this.session(sessionId);
    const running = session.running!;
    this.emit(sessionId, 'request/resolved', { requestId, kind: 'command', resolvedBy, decision });
    running.requestId = undefined;
    if (decision === 'cancel') {
      this.finishTurn(sessionId, 'interrupted');
      return;
    }
    const command = exampleMessage('31').params.item;
    const item = { ...command, itemId: running.commandItemId, turnId: running.turnId };
    if (decision === 'decline') {
      this.emit(sessionId, 'item/completed', { turnId: running.turnId, item: { ...item, status: 'declined', output: '' } });
    } else {
      this.emit(sessionId, 'status/changed', { status: 'running' });
      this.emit(sessionId, 'item/delta', { itemId: item.itemId, turnId: running.turnId, field: 'output', delta: command.output });
      this.emit(sessionId, 'item/completed', { turnId: running.turnId, item });
    }
    this.emit(sessionId, 'usage/updated', { usage: { inputTokens: 1200, outputTokens: 340, contextPercent: 4 } });
    this.finishTurn(sessionId, 'completed');
  }

  /** P9: the turn ends interrupted; a pending approval is withdrawn by the agent (spec 5.3). */
  private interruptTurn(sessionId: string): void {
    const running = this.session(sessionId).running!;
    if (running.requestId !== undefined) {
      this.emit(sessionId, 'request/resolved', { requestId: running.requestId, kind: 'command', resolvedBy: 'agent', decision: 'cancel' });
    }
    this.finishTurn(sessionId, 'interrupted');
  }

  private finishTurn(sessionId: string, status: 'completed' | 'interrupted'): void {
    const session = this.session(sessionId);
    const turn = session.turns.find((t) => t.turnId === session.running!.turnId);
    session.running = undefined;
    this.emit(sessionId, 'turn/completed', { turn: { ...turn, items: [...turn.items], status, completedAt: 1760930700 } });
    this.emit(sessionId, 'status/changed', { status: 'idle' });
  }

  // ---- host-side state --------------------------------------------------------------------------

  private full(session: FakeSession): Json {
    return { ...session.summary, settings: session.settings };
  }

  private fold(session: FakeSession, { method, params }: JournalEntry): void {
    const turnOf = (turnId: string) => session.turns.find((t) => t.turnId === turnId);
    switch (method) {
      case 'turn/started':
        session.turns.push({ ...params.turn, items: [...params.turn.items] });
        break;
      case 'turn/completed':
        Object.assign(turnOf(params.turn.turnId), params.turn);
        session.summary.lastTurnStatus = params.turn.status;
        break;
      case 'item/started':
      case 'item/completed': {
        session.items.set(params.item.itemId, { ...params.item });
        const turn = turnOf(params.turnId);
        if (turn && !turn.items.includes(params.item.itemId)) turn.items.push(params.item.itemId);
        break;
      }
      case 'item/delta': {
        const item = session.items.get(params.itemId);
        if (item) item[params.field] = (item[params.field] ?? '') + params.delta;
        break;
      }
      case 'approval/request':
        session.approvals.set(params.request.requestId, params.request);
        break;
      case 'input/request':
        session.inputs.set(params.request.requestId, params.request);
        break;
      case 'request/resolved':
        session.approvals.delete(params.requestId);
        session.inputs.delete(params.requestId);
        break;
      case 'status/changed':
        session.summary.status = params.status;
        break;
      case 'session/closed':
        session.summary.status = 'closed';
        break;
    }
    session.summary.lastSeq = params.seq;
    session.summary.updatedAt += 1;
    session.summary.pending = { approvals: session.approvals.size, inputs: session.inputs.size };
  }
}
