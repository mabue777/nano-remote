// A fake Nano Host for the web tests: an in-process ws server that speaks the envelope (spec 2: seq_id
// checks, acks, pongs, chunking both ways), the message layer (initialize first, JSON-RPC errors), a
// per-session Journal with session/open in events and snapshot mode, events/since and cursor_expired,
// and a scripted agent that plays the walkthrough of spec 13: a turn with streamed text, a command that
// needs approval, and the rest of the turn after the decision (or an interrupt).
//
// It is written independently of web/src so a bug in the client cannot hide behind the same bug here.
// Shapes come from protocol/examples via fixtures.ts. Test knobs: kill() drops every socket the way iOS
// does on lock, closeAll(code) closes with a spec 10 code, compact() makes old cursors expire,
// dropLive() loses one live event, onRequest intercepts requests, refuse() closes new sockets,
// paceMs plays scripted turns step by step on a timer (so a browser sees deltas arrive), delay() holds
// back the answer to the next request of a method, and reset() forgets every session and the request log. addRequest() puts
// any approval or question in front of the user and resolveRequest() answers it from another device;
// approval/resolve, input/answer and device/list (this stream's device plus a desktop) are answered.
// For the browser smoke (e2e-server.ts) it can also share an http server and authorize sockets by cookie,
// and it answers the discovery calls of spec 4 (agent/list, model/list, fs/readDirectory, project/list)
// and pages session/list by cursor (the archived ones with `archived: true`). session/archive,
// session/unarchive and session/delete work as in spec 6: archive and delete stop a running turn and its
// background tasks first; delete forgets the session. turn/diff is computed from the turn's fileChange items (the last
// change per path), answered from `turnDiffs` when a test set one, or refused `not_supported` for sessions
// in `noDiffs`. runReviewTurn() plays a turn
// whose command streams colored output until finishReviewTurn() ends it with file edits.
import type { IncomingMessage, Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { exampleMessage } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const SEGMENT_BYTES = 100 * 1024;
const SEND_SEGMENT_BYTES = SEGMENT_BYTES - (SEGMENT_BYTES % 3);

/**
 * Pi as initialize and agent/list list it after example 08's agents. Its capabilities honour no
 * approvalMode (spec 4), so the new-session sheet offers no "Bypass approvals" for it.
 */
export const PI_AGENT = {
  id: 'pi',
  name: 'Pi',
  status: 'ready',
  capabilities: { steer: true, diff: true, approvalModes: [] as string[], attachments: { images: true, files: true } },
};

/**
 * The agents of initialize and agent/list: example 08's (Kimi there carries no capabilities, like an agent
 * from an older host) and pi. Like the real host (spec 7), every agent declares `diff: true`.
 */
function fakeAgents(locked: ReadonlySet<string> = new Set()): Json[] {
  return [...exampleMessage('08').result.agents, PI_AGENT].map((agent: Json) =>
    // Codex, Claude Code and pi change model and effort in an open session (spec 4 settingsUpdate), unless
    // a test locks an agent; Kimi (example 08) carries no capabilities, like an agent from an older host.
    agent.capabilities === undefined || locked.has(agent.id)
      ? agent
      : { ...agent, capabilities: { ...agent.capabilities, settingsUpdate: ['model', 'effort'] } },
  );
}

/** pi's model/list: provider/model ids from two providers, each with `provider` (spec 4, example 54). */
export const PI_MODELS = [
  { id: 'llamacpp/bonsai-27b', displayName: 'bonsai-27b', default: true, provider: 'llamacpp' },
  { id: 'llamacpp/qwen3.5-9b', displayName: 'qwen3.5-9b', default: false, provider: 'llamacpp' },
  { id: 'openrouter/deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', default: false, provider: 'openrouter' },
  { id: 'openrouter/qwen/qwen3.5-coder', displayName: 'Qwen 3.5 Coder', default: false, provider: 'openrouter' },
];

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
  /** The scripted turn in progress, if any; `timer` is its next paced step. */
  running?: { turnId: string; commandItemId: string; requestId?: string; timer?: ReturnType<typeof setTimeout>; queued?: Json };
  /** Set by session/delete before the turn and helpers stop: the list hears no more of it (as the host). */
  deleted?: true;
}

export type RequestHook = (
  method: string,
  params: Json,
  stream: FakeStream,
) => undefined | 'drop' | { result: Json } | { error: { code: string; message: string; data?: Json } };

export interface FakeHostOptions {
  /** How many item/delta events the scripted agent message streams (the capture had 752). */
  deltas?: number;
  /** session/list page size when the request names no limit (the spec default is 50). */
  pageSize?: number;
  /** A directory tree for fs/readDirectory: path to its entries. */
  tree?: Record<string, { name: string; kind: 'dir' | 'file' }[]>;
}

export interface StartOptions {
  /** Share this http server (same origin as the page) instead of listening on a port of its own. */
  server?: Server;
  /** Decides whether an upgrade belongs to a paired device; false closes the socket with 4003 (spec 8). */
  authorize?: (request: IncomingMessage) => boolean;
}

const DEFAULT_TREE: Record<string, { name: string; kind: 'dir' | 'file' }[]> = {
  '/Users/me': [
    { name: 'Desktop', kind: 'dir' },
    { name: 'notes.txt', kind: 'file' },
  ],
  '/Users/me/Desktop': [{ name: 'phone-test', kind: 'dir' }],
  '/Users/me/Desktop/phone-test': [{ name: 'hello.txt', kind: 'file' }],
};

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
    const delay = this.host.takeDelay(message.method);
    if (delay !== undefined) {
      setTimeout(() => this.answer(message), delay);
      return;
    }
    this.answer(message);
  }

  private answer(message: Json): void {
    if (this.closed) return;
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

/** The VAPID public key the fake host advertises in initialize (an uncompressed P-256 point). */
export const FAKE_VAPID_PUBLIC_KEY = 'BLqV9YHYYANsdXdPRsHojo-QK0K6dl2lGcRree27K9no9AcPff1jvU8tGx_aQzuS6fueSsuSEJ3HyKFOXfaGoPw';

export class FakeHost {
  url = '';
  readonly streams: FakeStream[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly requestLog: { streamId: string; method: string; params: Json }[] = [];
  readonly pings: { streamId: string; state: string }[] = [];
  readonly goodbyes: { streamId: string; reason: string | undefined }[] = [];
  /** Web Push (spec 9): the subscription each clientId sent with push/subscribe. */
  readonly pushSubscriptions = new Map<string, Json>();
  /** push/test calls, in order, by clientId. */
  readonly pushTests: string[] = [];
  /** When set, push/test answers this error instead of {ok: true}. */
  pushTestError: { code: string; message: string; data?: Json } | undefined;
  pongStatus: 'active' | 'degraded' | 'draining' = 'active';
  /**
   * Keep this Mac awake (spec 4): the setting and the power source behind `host/status.keepAwake`;
   * `host/settings/update` changes the setting, setPower() the source. Null: an older host without it.
   */
  keepAwake: { setting: 'pluggedIn' | 'off'; onBattery: boolean } | null = { setting: 'pluggedIn', onBattery: false };
  /** Local chat's relay (protocol section 15): the providers kept on the host, for `provider/list`. */
  hostProviders: Json[] = [];
  /** What `provider/discover` finds. */
  discoverCandidates: Json[] = [];
  /**
   * `provider/models` by providerId or baseURL: a model list, or the `provider_unavailable` reason it fails
   * with. Anything not here fails `unreachable`.
   */
  readonly providerModels = new Map<string, Json[] | { reason: string; status?: number }>();
  onRequest: RequestHook | undefined;
  /** When above 0, scripted turns emit one step per this many ms instead of all at once. */
  paceMs = 0;
  /** Sessions whose agent "does not provide diffs": turn/diff answers not_supported. */
  readonly noDiffs = new Set<string>();
  /** Agents that declare no settingsUpdate: session/settings/update answers not_supported. */
  readonly settingsLocked = new Set<string>();
  /**
   * turn/diff answers for a session, as the real host computes them from git (spec 7): a result (files,
   * note, truncated, omittedFiles) or an error such as not_a_repository. Without one, the fake lists the
   * turn's fileChange items.
   */
  readonly turnDiffs = new Map<string, { result?: Json; error?: { code: string; message: string; data?: Json } }>();
  private readonly delays = new Map<string, number>();
  private server: WebSocketServer | undefined;
  private refusal: { code: number; reason: string } | undefined;
  private readonly dropped = new Set<string>();
  private nextSession = 0;
  private nextId = 0;
  private readonly deltas: number;
  private readonly pageSize: number;
  private readonly tree: Record<string, { name: string; kind: 'dir' | 'file' }[]>;

  constructor(options: FakeHostOptions = {}) {
    this.deltas = options.deltas ?? 12;
    this.pageSize = options.pageSize ?? 50;
    this.tree = options.tree ?? DEFAULT_TREE;
  }

  async start(options: StartOptions = {}): Promise<string> {
    const server =
      options.server !== undefined
        ? new WebSocketServer({ server: options.server, path: '/v1/stream' })
        : new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/v1/stream' });
    this.server = server;
    server.on('connection', (socket, request) => {
      if (this.refusal !== undefined) {
        socket.close(this.refusal.code, this.refusal.reason);
        return;
      }
      if (options.authorize !== undefined && !options.authorize(request)) {
        socket.close(4003, 'device token missing, unknown or revoked');
        return;
      }
      this.streams.push(new FakeStream(socket, this));
    });
    if (options.server !== undefined) return '';
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
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

  /** The answer to the next request of `method` is sent `ms` later. */
  delay(method: string, ms: number): void {
    this.delays.set(method, ms);
  }

  takeDelay(method: string): number | undefined {
    const ms = this.delays.get(method);
    this.delays.delete(method);
    return ms;
  }

  /**
   * Forgets every session (stopping paced turns) and numbers new ones from 1 again. Also empties the
   * request log, so a test that asks for the last request of a method never sees one an earlier test sent.
   */
  reset(): void {
    this.requestLog.length = 0;
    for (const session of this.sessions.values()) clearTimeout(session.running?.timer);
    this.sessions.clear();
    this.delays.clear();
    this.noDiffs.clear();
    this.settingsLocked.clear();
    this.turnDiffs.clear();
    this.nextSession = 0;
    this.pushSubscriptions.clear();
    this.pushTests.length = 0;
    this.pushTestError = undefined;
    this.hostProviders = [];
    this.discoverCandidates = [];
    this.providerModels.clear();
    this.keepAwake = { setting: 'pluggedIn', onBattery: false };
  }

  /** The `keepAwake` status object, as the real host reports it. */
  keepAwakeStatus(): Json {
    if (this.keepAwake === null) return undefined;
    const { setting, onBattery } = this.keepAwake;
    return { setting, active: setting === 'pluggedIn' && !onBattery, onBattery };
  }

  hostStatus(): Json {
    const { keepAwake: _example, ...status } = exampleMessage('44').params;
    const keepAwake = this.keepAwakeStatus();
    return keepAwake === undefined ? status : { ...status, keepAwake };
  }

  /** The Mac is unplugged (or plugged back in): host/status/changed to every stream, as the poll would. */
  setPower(onBattery: boolean): void {
    if (this.keepAwake === null) return;
    this.keepAwake.onBattery = onBattery;
    this.broadcast('host/status/changed', this.hostStatus());
  }

  /** True for a session the host knows (the attachment endpoint, spec 8.1). */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
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

  /** session/updated with the row, unless the session is being deleted (host-core sends none then). */
  private rowChanged(session: FakeSession): void {
    if (session.deleted !== true) this.broadcast('session/updated', { summary: { ...session.summary } });
  }

  /** Sends an unsequenced notification to every ready stream. */
  broadcast(method: string, params: Json): void {
    for (const stream of this.openStreams) if (stream.ready) stream.notify(method, params);
  }

  /** Starts the scripted turn without any client, as the desktop would; it stops at the approval request. */
  runScriptedTurn(sessionId: string, text: string): void {
    const turn = this.newTurn(this.session(sessionId), undefined);
    this.playTurn(sessionId, turn.turnId, [{ type: 'text', text }], undefined);
  }

  /**
   * Emits a pending request as an agent would: an approval (`kind` command, fileChange, permission) or a
   * question (`kind: "input"`). Missing ids are filled in. Returns the requestId.
   */
  addRequest(sessionId: string, request: Json): string {
    const session = this.session(sessionId);
    const requestId = request.requestId ?? `req_fake_${++this.nextId}`;
    const body = {
      sessionId,
      turnId: session.running?.turnId ?? session.turns.at(-1)?.turnId ?? `trn_fake_${++this.nextId}`,
      itemId: `itm_fake_${++this.nextId}`,
      ...(request.kind === 'input' ? {} : { createdAt: 1760930150 + this.nextId, expiresAt: null }),
      ...request,
      requestId,
    };
    this.emit(sessionId, request.kind === 'input' ? 'input/request' : 'approval/request', { request: body });
    return requestId;
  }

  /** Answers any pending request as another device would. */
  resolveRequest(sessionId: string, requestId: string, by = 'dev_desktop', answer: { decision?: string; answers?: Json } = {}): void {
    const session = this.session(sessionId);
    if (session.running?.requestId === requestId) {
      this.decide(sessionId, requestId, answer.decision ?? 'accept', by);
      return;
    }
    const request = session.approvals.get(requestId) ?? session.inputs.get(requestId);
    if (request === undefined) throw new Error(`no pending request ${requestId}`);
    const result = request.kind === 'input' ? { answers: answer.answers ?? {} } : { decision: answer.decision ?? 'accept' };
    this.emit(sessionId, 'request/resolved', { requestId, kind: request.kind, resolvedBy: by, ...result });
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
        result.agents = fakeAgents(this.settingsLocked);
        result.device.clientId = stream.clientId;
        result.push = { vapidPublicKey: FAKE_VAPID_PUBLIC_KEY, subscribed: this.pushSubscriptions.has(stream.clientId) };
        return { result };
      }
      case 'session/list': {
        const all = [...this.sessions.values()]
          .map((s) => ({ ...s.summary }))
          .filter((s) => params.agentId === undefined || s.agentId === params.agentId)
          .filter((s) => (s.archived === true) === (params.archived === true))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        const start = typeof params.cursor === 'string' ? Number(params.cursor.replace(/^cur_/, '')) : 0;
        if (!Number.isInteger(start) || start < 0) throw new HostError({ code: 'invalid_params', message: 'bad cursor', data: { path: 'cursor' } });
        const limit = params.limit ?? this.pageSize;
        const sessions = all.slice(start, start + limit);
        const next = start + sessions.length;
        return { result: next < all.length ? { sessions, nextCursor: `cur_${next}` } : { sessions } };
      }
      case 'agent/list':
        return { result: { agents: fakeAgents(this.settingsLocked) } };
      case 'model/list': {
        if (params.agentId === 'pi') return { result: { models: PI_MODELS } };
        if (params.agentId !== 'codex' && params.agentId !== 'claude') {
          throw new HostError({ code: 'agent_unavailable', message: `${params.agentId} is not available`, data: { agentId: params.agentId } });
        }
        // Effort levels per model (spec 4): Codex's default model has levels and a default, its mini none;
        // Claude lists levels without a default.
        const models =
          params.agentId === 'codex'
            ? [
                { id: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex', default: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
                { id: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini', default: false },
              ]
            : [{ id: 'claude-opus', displayName: 'Claude Opus', default: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }];
        return { result: { models } };
      }
      case 'project/list':
        return {
          result: {
            projects: [
              { path: '/Users/me/Desktop/phone-test', name: 'phone-test', lastUsedAt: 1760930400, sessions: this.sessions.size },
            ],
          },
        };
      case 'fs/readDirectory': {
        const entries = this.tree[params.path];
        if (entries === undefined) throw new HostError({ code: 'not_found', message: `no directory ${params.path}` });
        const base = params.path === '/' ? '' : params.path;
        return { result: { entries: entries.map((e) => ({ ...e, path: `${base}/${e.name}` })) } };
      }
      case 'session/start': {
        const sessionId = this.createSession({ agentId: params.agentId, cwd: params.cwd, title: params.title ?? 'New session' });
        const session = this.session(sessionId);
        if (params.settings !== undefined) session.settings = { ...session.settings, ...params.settings };
        if (!Array.isArray(params.input)) return { result: { session: this.full(session) } };
        const turn = this.newTurn(session, undefined);
        return {
          result: { session: this.full(session), turn: { ...turn, items: [] } },
          after: () => this.playTurn(sessionId, turn.turnId, params.input, undefined),
        };
      }
      case 'session/settings/update': {
        // Spec 6: the keys the agent declares, journaled at once as session/changed.
        const session = this.session(params.sessionId);
        const agent = fakeAgents(this.settingsLocked).find((a: Json) => a.id === session.summary.agentId);
        const allowed: string[] = agent?.capabilities?.settingsUpdate ?? [];
        for (const key of Object.keys(params.settings ?? {})) {
          if (!allowed.includes(key)) {
            throw new HostError({ code: 'not_supported', message: `${agent?.name ?? session.summary.agentId} cannot change the ${key} of an open session` });
          }
        }
        session.settings = { ...session.settings, ...params.settings };
        session.summary.updatedAt = Math.floor(Date.now() / 1000);
        this.emit(params.sessionId, 'session/changed', { session: { ...this.full(session), lastSeq: session.journal.length + 1 } });
        return { result: { session: this.full(session) } };
      }
      case 'session/open':
        return this.open(stream, params);
      case 'session/archive': {
        // Spec 6: ends a running turn and its helpers, journals session/closed, the row says archived.
        const session = this.session(params.sessionId);
        if (session.summary.archived === true) return { result: { ok: true } };
        return {
          result: { ok: true },
          after: () => {
            // Flag first, as the host does: the rows sent while the turn stops already say archived.
            session.summary.archived = true;
            this.shutdown(params.sessionId);
            this.emit(params.sessionId, 'session/closed', { reason: 'archived' });
            this.rowChanged(session);
          },
        };
      }
      case 'session/unarchive': {
        const session = this.session(params.sessionId);
        if (session.summary.archived !== true) return { result: { ok: true } };
        delete session.summary.archived;
        return {
          result: { ok: true },
          after: () => {
            this.emit(params.sessionId, 'status/changed', { status: 'idle' });
            this.rowChanged(session);
          },
        };
      }
      case 'session/delete': {
        // Marked first, as the host does: stopping the turn and helpers sends no session/updated.
        this.session(params.sessionId).deleted = true;
        this.shutdown(params.sessionId);
        this.emit(params.sessionId, 'session/closed', { reason: 'deleted' });
        this.sessions.delete(params.sessionId);
        for (const stream of this.openStreams) stream.subscriptions.delete(params.sessionId);
        return { result: { ok: true } };
      }
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
        // While background tasks run, the message waits in the engine (spec 5.1): queued until takeQueued().
        const play = this.runningTasks(session) > 0 ? this.queueTurn.bind(this) : this.playTurn.bind(this);
        return {
          result: { turn: { ...turn, items: [] } },
          after: () => play(params.sessionId, turn.turnId, params.input, params.clientMessageId),
        };
      }
      case 'turn/steer': {
        const session = this.session(params.sessionId);
        if (session.running === undefined || session.running.turnId !== params.turnId) {
          throw new HostError({ code: 'turn_mismatch', message: `${params.turnId} is not the running turn` });
        }
        const turn = session.turns.find((t) => t.turnId === params.turnId);
        const item = {
          itemId: `itm_fake_${++this.nextId}`,
          type: 'userMessage',
          turnId: params.turnId,
          status: 'completed',
          content: params.input,
          clientMessageId: params.clientMessageId,
        };
        return {
          result: { turn: { ...turn, items: [...turn.items] } },
          after: () => this.emit(params.sessionId, 'item/started', { turnId: params.turnId, item }),
        };
      }
      case 'session/history': {
        const session = this.session(params.sessionId);
        const end = Number(String(params.before).replace(/^old_/, ''));
        if (!Number.isInteger(end) || end < 0) throw new HostError({ code: 'invalid_params', message: 'bad cursor', data: { path: 'before' } });
        const start = Math.max(0, end - (params.limit ?? 5));
        const turns = session.turns.slice(start, end).reverse().map((turn) => this.inline(session, turn));
        return { result: start > 0 ? { turns, olderCursor: `old_${start}` } : { turns } };
      }
      case 'turn/interrupt': {
        const session = this.session(params.sessionId);
        if (session.running?.turnId !== params.turnId) return { result: { ok: true } };
        return { result: { ok: true }, after: () => this.interruptTurn(params.sessionId) };
      }
      case 'approval/resolve':
      case 'input/answer': {
        const session = this.session(params.sessionId);
        const pending = method === 'approval/resolve' ? session.approvals : session.inputs;
        if (!pending.has(params.requestId)) {
          const answered = session.journal.find((e) => e.method === 'request/resolved' && e.params.requestId === params.requestId);
          if (answered) throw new HostError({ code: 'already_resolved', message: 'answered', data: { resolvedBy: answered.params.resolvedBy } });
          throw new HostError({ code: 'not_found', message: 'no such request' });
        }
        const answer = method === 'approval/resolve' ? { decision: params.decision } : { answers: params.answers };
        return { result: { ok: true }, after: () => this.resolveRequest(params.sessionId, params.requestId, stream.clientId, answer) };
      }
      case 'device/list':
        return {
          result: {
            devices: [
              { clientId: stream.clientId, displayName: 'iPhone (Safari)', platform: 'ios-web', createdAt: 1760900000, lastSeenAt: 1760930400, current: true },
              { clientId: 'dev_desktop', displayName: 'Mabue MacBook', platform: 'macos', createdAt: 1760800000, lastSeenAt: 1760929000, current: false },
            ],
          },
        };
      case 'turn/diff': {
        const session = this.session(params.sessionId);
        if (this.noDiffs.has(params.sessionId)) throw new HostError({ code: 'not_supported', message: 'this adapter has no diffs' });
        const turn = session.turns.find((t) => t.turnId === params.turnId);
        if (turn === undefined) throw new HostError({ code: 'not_found', message: `no turn ${params.turnId}` });
        const set = this.turnDiffs.get(params.sessionId);
        if (set?.error !== undefined) throw new HostError(set.error);
        if (set?.result !== undefined) return { result: set.result };
        const files = new Map<string, Json>();
        for (const id of turn.items) {
          const item = session.items.get(id);
          if (item?.type === 'fileChange') for (const change of item.changes) files.set(change.path, change);
        }
        return { result: { files: [...files.values()] } };
      }
      case 'host/status':
        return { result: this.hostStatus() };
      case 'host/settings/update': {
        if (this.keepAwake === null) throw new HostError({ code: 'method_not_found', message: 'host/settings/update' });
        if (params.keepAwake !== 'pluggedIn' && params.keepAwake !== 'off') {
          throw new HostError({ code: 'invalid_params', message: 'keepAwake must be pluggedIn or off', data: { path: 'params.keepAwake' } });
        }
        this.keepAwake.setting = params.keepAwake;
        this.broadcast('host/status/changed', this.hostStatus());
        return { result: { keepAwake: this.keepAwakeStatus() } };
      }
      case 'push/subscribe': {
        const subscription = params.subscription;
        if (typeof subscription?.endpoint !== 'string' || typeof subscription?.keys?.p256dh !== 'string' || typeof subscription?.keys?.auth !== 'string') {
          throw new HostError({ code: 'invalid_params', message: 'subscription needs endpoint and keys', data: { path: 'subscription' } });
        }
        this.pushSubscriptions.set(stream.clientId, subscription);
        return { result: { ok: true } };
      }
      case 'push/unsubscribe':
        if (this.pushSubscriptions.get(stream.clientId)?.endpoint === params.endpoint) this.pushSubscriptions.delete(stream.clientId);
        return { result: { ok: true } };
      case 'push/test':
        this.pushTests.push(stream.clientId);
        if (this.pushTestError !== undefined) throw new HostError(this.pushTestError);
        if (!this.pushSubscriptions.has(stream.clientId)) {
          throw new HostError({ code: 'not_found', message: 'no push subscription for this device', data: { reason: 'no_subscription' } });
        }
        return { result: { ok: true } };
      case 'provider/list':
        return { result: { providers: this.hostProviders } };
      case 'provider/discover':
        return { result: { candidates: this.discoverCandidates } };
      case 'provider/models': {
        const target = String(params.providerId ?? params.baseURL);
        const answer = this.providerModels.get(target) ?? { reason: 'unreachable' };
        if (Array.isArray(answer)) return { result: { models: answer } };
        throw new HostError({ code: 'provider_unavailable', message: `${target}: ${answer.reason}`, data: { ...answer, message: answer.reason } });
      }
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
    const shown = session.turns.slice(-(params.turns ?? 5));
    const turns = shown.map((turn) => this.inline(session, turn));
    const older = session.turns.length - shown.length;
    return {
      result: { mode: 'snapshot', session: this.full(session), turns, ...(older > 0 ? { olderCursor: `old_${older}` } : {}), cursor, pending },
      after,
    };
  }

  private inline(session: FakeSession, turn: Json): Json {
    return { ...turn, items: turn.items.map((id: string) => session.items.get(id)).filter(Boolean) };
  }

  /**
   * Runs the steps of a scripted turn: all at once, or with paceMs one per tick. A paced turn stops
   * when it is no longer the running one (interrupted).
   */
  private play(session: FakeSession, steps: (() => void)[]): void {
    if (this.paceMs <= 0) {
      for (const step of steps) step();
      return;
    }
    const running = session.running;
    const next = (i: number) => {
      if (running === undefined || session.running !== running) return;
      running.timer = undefined;
      steps[i]!();
      if (i + 1 < steps.length) running.timer = setTimeout(() => next(i + 1), this.paceMs);
    };
    next(0);
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
    const steps: (() => void)[] = [];
    steps.push(() => {
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
    });
    const agent = exampleMessage('28').params.item;
    const text: string = agent.text;
    const agentId = `itm_fake_${++this.nextId}`;
    steps.push(() => this.emit(sessionId, 'item/started', { turnId, item: { ...agent, itemId: agentId, turnId, status: 'inProgress', text: '' } }));
    const size = Math.ceil(text.length / this.deltas);
    for (let i = 0; i < text.length; i += size) {
      const delta = text.slice(i, i + size);
      steps.push(() => this.emit(sessionId, 'item/delta', { itemId: agentId, turnId, field: 'text', delta }));
    }
    steps.push(() => {
      this.emit(sessionId, 'item/completed', { turnId, item: { ...agent, itemId: agentId, turnId, text } });
      const command = exampleMessage('29').params.item;
      this.emit(sessionId, 'item/started', { turnId, item: { ...command, itemId: running.commandItemId, turnId } });
      const request = exampleMessage('32').params.request;
      running.requestId = `req_fake_${++this.nextId}`;
      // pi offers no "for this session" decision (its approvals are accept, decline or cancel)
      const decisions = session.summary.agentId === 'pi' ? { availableDecisions: ['accept', 'decline', 'cancel'] } : {};
      this.emit(sessionId, 'approval/request', {
        request: { ...request, ...decisions, requestId: running.requestId, sessionId, turnId, itemId: running.commandItemId },
      });
      this.emit(sessionId, 'status/changed', { status: 'waiting_approval' });
    });
    this.play(session, steps);
  }

  /**
   * A turn for the review views: a command whose output (with ANSI colors) streams one chunk per paced
   * step and keeps running until finishReviewTurn(). Returns the command's itemId.
   */
  runReviewTurn(sessionId: string, chunks: string[], command = '/bin/zsh -lc "npm test"'): string {
    const session = this.session(sessionId);
    const turn = this.newTurn(session, undefined);
    const running = session.running!;
    const turnId = turn.turnId;
    const itemId = running.commandItemId;
    const steps: (() => void)[] = [
      () => {
        this.emit(sessionId, 'turn/started', { turn: { ...turn, items: [] } });
        this.emit(sessionId, 'status/changed', { status: 'running' });
        this.emit(sessionId, 'item/started', { turnId, item: { itemId, type: 'command', turnId, status: 'inProgress', command, cwd: session.summary.cwd, output: '' } });
      },
      ...chunks.map((delta) => () => {
        this.emit(sessionId, 'item/delta', { itemId, turnId, field: 'output', delta });
      }),
    ];
    this.play(session, steps);
    return itemId;
  }

  /**
   * A finished turn holding the given items in order (ids and turnId filled in), for layout checks that
   * need every item kind on screen at once.
   */
  runItemsTurn(sessionId: string, items: Json[]): void {
    const session = this.session(sessionId);
    const turn = this.newTurn(session, undefined);
    const turnId = turn.turnId;
    this.emit(sessionId, 'turn/started', { turn: { ...turn, items: [] } });
    for (const raw of items) {
      const item = { itemId: `itm_fake_${++this.nextId}`, status: 'completed', ...raw, turnId };
      this.emit(sessionId, 'item/started', { turnId, item: { ...item, status: 'inProgress' } });
      this.emit(sessionId, 'item/completed', { turnId, item });
    }
    this.finishTurn(sessionId, 'completed');
  }

  /** Ends the review turn: the command completes, files are changed, the turn completes. */
  finishReviewTurn(sessionId: string, changes: Json[]): void {
    const session = this.session(sessionId);
    const running = session.running;
    if (running === undefined) throw new Error('no review turn running');
    clearTimeout(running.timer);
    const turnId = running.turnId;
    const command = session.items.get(running.commandItemId);
    this.emit(sessionId, 'item/completed', { turnId, item: { ...command, status: 'completed', exitCode: 0, durationMs: 1500 } });
    const item = { itemId: `itm_fake_${++this.nextId}`, type: 'fileChange', turnId, status: 'completed', changes };
    this.emit(sessionId, 'item/started', { turnId, item: { ...item, status: 'inProgress' } });
    this.emit(sessionId, 'item/completed', { turnId, item });
    this.finishTurn(sessionId, 'completed');
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
  /** Background tasks of the session's agent (spec 5.1): journaled as session/changed, list row updated. */
  setBackgroundTasks(sessionId: string, tasks: Json[]): void {
    const session = this.session(sessionId);
    if (tasks.length > 0) session.summary.backgroundTasks = tasks.map((t) => ({ ...t }));
    else delete session.summary.backgroundTasks;
    this.emit(sessionId, 'session/changed', { session: { ...this.full(session), lastSeq: session.journal.length + 1 } });
    this.rowChanged(session);
  }

  /** The session's status changes by itself (an agent that stopped: `error`): journaled, list row updated. */
  setStatus(sessionId: string, status: string): void {
    const session = this.session(sessionId);
    this.emit(sessionId, 'status/changed', { status });
    this.rowChanged(session);
  }

  private runningTasks(session: FakeSession): number {
    return ((session.summary.backgroundTasks ?? []) as Json[]).filter((t) => t.status === 'running').length;
  }

  /** A turn whose message waits behind background tasks: the userMessage carries queued until taken. */
  private queueTurn(sessionId: string, turnId: string, input: Json, clientMessageId: string | undefined): void {
    const session = this.session(sessionId);
    this.emit(sessionId, 'turn/started', { turn: { turnId, status: 'inProgress', startedAt: 1760930100, completedAt: null, error: null, items: [] } });
    const user = { itemId: `itm_fake_${++this.nextId}`, type: 'userMessage', turnId, status: 'completed', content: input, queued: true, ...(clientMessageId !== undefined ? { clientMessageId } : {}) };
    this.emit(sessionId, 'item/started', { turnId, item: user });
    this.emit(sessionId, 'item/completed', { turnId, item: user });
    this.emit(sessionId, 'status/changed', { status: 'running' });
    session.running!.queued = user;
  }

  /** The engine takes the queued message: the item without the flag, a short answer, the turn ends. */
  takeQueued(sessionId: string, reply = 'All three reviews are still running; the parser one is halfway.'): void {
    const session = this.session(sessionId);
    const running = session.running;
    if (running?.queued === undefined) throw new Error(`no queued message in ${sessionId}`);
    const { queued: _flag, ...item } = running.queued;
    running.queued = undefined;
    this.emit(sessionId, 'item/completed', { turnId: running.turnId, item });
    const agentId = `itm_fake_${++this.nextId}`;
    this.emit(sessionId, 'item/completed', { turnId: running.turnId, item: { itemId: agentId, type: 'agentMessage', turnId: running.turnId, status: 'completed', text: reply } });
    this.finishTurn(sessionId, 'completed');
  }

  /** Archive and delete: the running turn ends interrupted and running helpers are cancelled (spec 5.1). */
  private shutdown(sessionId: string): void {
    const session = this.session(sessionId);
    if (session.running !== undefined) this.interruptTurn(sessionId);
    else if (this.runningTasks(session) > 0) {
      const now = Math.floor(Date.now() / 1000);
      this.setBackgroundTasks(sessionId, (session.summary.backgroundTasks as Json[]).map((t) => (t.status === 'running' ? { ...t, status: 'cancelled', endedAt: now } : t)));
    }
  }

  private interruptTurn(sessionId: string): void {
    const running = this.session(sessionId).running!;
    clearTimeout(running.timer);
    // Stopping the turn stops the agent's background tasks too (Claude Code's interrupt does).
    const session = this.session(sessionId);
    if (this.runningTasks(session) > 0) {
      const now = Math.floor(Date.now() / 1000);
      this.setBackgroundTasks(sessionId, (session.summary.backgroundTasks as Json[]).map((t) => (t.status === 'running' ? { ...t, status: 'cancelled', endedAt: now } : t)));
    }
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
