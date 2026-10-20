// The phone's stream client (spec 2 to 4): one EnvelopeStream at a time, a new stream_id for every
// socket, `initialize` with protocolVersion 1 on every new stream, JSON-RPC requests matched to
// responses with timeouts, a notification dispatcher, presence pings, and the reconnect and close-code
// policy. Streams are never resumed (2.4): whoever needs continuity catches up from the Journal on
// 'ready' (the Replica does).
import type { InitializeResult } from '../generated/methods';
import { CloseCode, DEFAULT_TIMING, PROTOCOL_VERSION, STREAM_PATH, type Timing } from './constants';
import { EnvelopeStream, MessageTooLarge, type PongStatus, type SocketLike, type StreamClose } from './envelope-stream';
import { browserLifecycle, type Lifecycle } from './lifecycle';

export type ClientState =
  /** Not started yet. */
  | 'idle'
  /** A socket is opening or `initialize` is in flight. */
  | 'connecting'
  /** Initialized: requests flow. */
  | 'ready'
  /** Between attempts, waiting out the backoff. */
  | 'waiting'
  /** The page was hidden away (pagehide); reconnects on pageshow or when it comes to the foreground. */
  | 'suspended'
  /** Close 4001 or `unsupported_protocol`: show an update message. Terminal. */
  | 'update_required'
  /** Close 4003 or `unauthorized`: return to pairing. Terminal. */
  | 'unpaired'
  /** stop() was called. Terminal. */
  | 'stopped';

const TERMINAL: ReadonlySet<ClientState> = new Set(['update_required', 'unpaired', 'stopped']);

/** A failed request: a spec 10 error code from the host, or one of the local codes below. */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** Local failure codes, next to the host's spec 10 codes. */
export const LocalError = {
  /** No response within the request timeout (spec 3). */
  timeout: 'timeout',
  /** The stream closed with the request in flight; delivery is uncertain. */
  connectionLost: 'connection_lost',
  /** The client is stopped, unpaired or needs an update; nothing will be sent. */
  closed: 'client_closed',
  /** The message is above the 16 MiB cap (2.3). */
  tooLarge: 'message_too_large',
} as const;

export interface ClientInfo {
  name: string;
  version: string;
  platform: string;
  userAgent?: string;
}

export interface StreamClientOptions {
  /** Device id from pairing; sent as client_id on every envelope. */
  clientId: string;
  /** Defaults to the page's own origin, wss://<host>/v1/stream (spec 1). */
  url?: string;
  createSocket?: (url: string) => SocketLike;
  lifecycle?: Lifecycle;
  client?: ClientInfo;
  optOutNotifications?: string[];
  timing?: Partial<Timing>;
  newStreamId?: () => string;
}

export interface RequestOptions {
  timeoutMs?: number;
}

type NotificationHandler = (params: Record<string, unknown>, method: string) => void;

interface Events {
  state: (state: ClientState, detail: string) => void;
  /** A new stream finished `initialize`. Fires on every reconnect. */
  ready: (result: InitializeResult, streamId: string) => void;
  pong: (status: PongStatus) => void;
  closed: (close: StreamClose & { streamId: string }) => void;
  /** pagehide: the page may be frozen or discarded next; flush what must survive. */
  suspend: () => void;
}

interface Call {
  id: string;
  method: string;
  params: Record<string, unknown> | undefined;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: RequestError) => void;
  timer: ReturnType<typeof setTimeout>;
  stream?: EnvelopeStream;
}

function defaultUrl(): string {
  const location = (globalThis as { location?: { protocol: string; host: string } }).location;
  if (location === undefined) throw new Error('StreamClient needs a url outside the browser');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${STREAM_PATH}`;
}

function defaultClient(): ClientInfo {
  const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return { name: 'Nano Remote Web', version: '0.1.0', platform: 'web', ...(userAgent ? { userAgent } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class StreamClient {
  private stateValue: ClientState = 'idle';
  private stream: EnvelopeStream | undefined;
  private initResult: InitializeResult | undefined;
  private readonly timing: Timing;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly lifecycle: Lifecycle;
  private readonly newStreamId: () => string;
  private unsubscribeLifecycle: (() => void) | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private nextId = 0;
  private readonly queued: Call[] = [];
  private readonly inflight = new Map<string, Call>();
  private readonly listeners: { [K in keyof Events]: Set<Events[K]> } = {
    state: new Set(),
    ready: new Set(),
    pong: new Set(),
    closed: new Set(),
    suspend: new Set(),
  };
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();

  constructor(private readonly options: StreamClientOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.lifecycle = options.lifecycle ?? browserLifecycle();
    this.newStreamId = options.newStreamId ?? (() => crypto.randomUUID());
  }

  get state(): ClientState {
    return this.stateValue;
  }

  /** The `initialize` result of the current stream; undefined until the first stream is ready. */
  get host(): InitializeResult | undefined {
    return this.initResult;
  }

  get streamId(): string | undefined {
    return this.stream?.streamId;
  }

  /** Opens the first stream. Idempotent. */
  start(): void {
    if (this.stateValue !== 'idle') return;
    this.unsubscribeLifecycle = this.lifecycle.subscribe({
      visibility: (presence) => {
        this.stream?.ping(presence);
        if (presence === 'foreground') this.wake();
      },
      pagehide: () => this.suspend(),
      pageshow: () => this.wake(),
    });
    this.connect();
  }

  /** Says `client_closed {reason: user}`, closes the socket and fails everything pending. */
  stop(): void {
    if (TERMINAL.has(this.stateValue)) return;
    this.terminate('stopped', 'stopped by the app');
    this.unsubscribeLifecycle?.();
  }

  /** Skips the backoff wait and connects now (for a "retry" button). */
  retryNow(): void {
    this.wake();
  }

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  /** Dispatches host notifications by method; `*` receives every notification. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Sends a request and resolves with its result. While no stream is ready the request waits for the
   * next one; the timeout counts from this call. Rejects with RequestError: the host's error code, or a
   * LocalError code.
   */
  request<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (TERMINAL.has(this.stateValue)) {
        reject(new RequestError(LocalError.closed, `client is ${this.stateValue}`));
        return;
      }
      const id = `c-${++this.nextId}`;
      const call: Call = {
        id,
        method,
        params,
        resolve: resolve as (result: Record<string, unknown>) => void,
        reject,
        timer: setTimeout(() => {
          this.forget(call);
          reject(new RequestError(LocalError.timeout, `${method} got no response`));
        }, options.timeoutMs ?? this.timing.requestTimeoutMs),
      };
      if (this.stateValue === 'ready' && this.stream !== undefined) this.transmit(call, this.stream);
      else this.queued.push(call);
    });
  }

  /** Sends a notification on the current stream; false when no stream is ready. */
  notify(method: string, params?: Record<string, unknown>): boolean {
    if (this.stateValue !== 'ready' || this.stream === undefined) return false;
    return this.stream.send(params === undefined ? { method } : { method, params });
  }

  // ---- connection lifecycle ---------------------------------------------------------------------

  private setState(state: ClientState, detail = ''): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const listener of this.listeners.state) listener(state, detail);
  }

  private connect(): void {
    this.clearReconnect();
    this.setState('connecting');
    const streamId = this.newStreamId();
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.options.url ?? defaultUrl());
    } catch (error) {
      this.scheduleReconnect(0, `cannot open a socket: ${String(error)}`);
      return;
    }
    const stream: EnvelopeStream = new EnvelopeStream({
      socket,
      clientId: this.options.clientId,
      streamId,
      timing: this.timing,
      presence: () => this.lifecycle.presence(),
      onOpen: () => this.initialize(stream),
      onMessage: (message) => this.receive(stream, message),
      onPong: (status) => {
        for (const listener of this.listeners.pong) listener(status);
      },
      onClose: (close) => this.closed(stream, close),
    });
    this.stream = stream;
  }

  private initialize(stream: EnvelopeStream): void {
    const params = {
      protocolVersion: PROTOCOL_VERSION,
      client: this.options.client ?? defaultClient(),
      ...(this.options.optOutNotifications ? { optOutNotifications: this.options.optOutNotifications } : {}),
    };
    const call: Call = {
      id: `c-${++this.nextId}`,
      method: 'initialize',
      params,
      resolve: (result) => this.initialized(stream, result as InitializeResult),
      reject: (error) => this.initializeFailed(stream, error),
      timer: setTimeout(() => {
        this.forget(call);
        this.initializeFailed(stream, new RequestError(LocalError.timeout, 'initialize got no response'));
      }, this.timing.requestTimeoutMs),
    };
    this.transmit(call, stream);
  }

  private initialized(stream: EnvelopeStream, result: InitializeResult): void {
    if (stream !== this.stream) return;
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      this.terminate('update_required', `host speaks protocol ${result.protocolVersion}`);
      return;
    }
    this.initResult = result;
    stream.send({ method: 'initialized', params: {} });
    this.attempt = 0;
    this.setState('ready');
    for (const listener of this.listeners.ready) listener(result, stream.streamId);
    // A listener may have closed the stream; queued requests then wait for the next one.
    if (this.stream !== stream || this.stateValue !== 'ready') return;
    for (const call of this.queued.splice(0)) this.transmit(call, stream);
  }

  private initializeFailed(stream: EnvelopeStream, error: RequestError): void {
    if (stream !== this.stream) return;
    if (error.code === 'unsupported_protocol') this.terminate('update_required', error.message);
    else if (error.code === 'unauthorized') this.terminate('unpaired', error.message);
    else if (error.code !== LocalError.connectionLost) stream.close(CloseCode.normal, `initialize failed: ${error.code}`);
  }

  private closed(stream: EnvelopeStream, close: StreamClose): void {
    if (stream !== this.stream) return;
    this.stream = undefined;
    for (const call of [...this.inflight.values()]) {
      if (call.stream !== stream) continue;
      this.forget(call);
      call.reject(new RequestError(LocalError.connectionLost, `stream closed (${close.code}) before ${call.method} was answered`));
    }
    for (const listener of this.listeners.closed) listener({ ...close, streamId: stream.streamId });
    if (TERMINAL.has(this.stateValue) || this.stateValue === 'suspended') return;
    switch (close.code) {
      case CloseCode.unsupportedProtocol:
        this.terminate('update_required', close.reason);
        return;
      case CloseCode.unauthorized:
        this.terminate('unpaired', close.reason);
        return;
      case CloseCode.draining:
        this.scheduleReconnect(this.timing.drainingDelayMs, `host draining: ${close.reason}`);
        return;
      default:
        // 4002 (sequence), 4008 (ping timeout), 4009, network loss: a new stream after the backoff.
        this.scheduleReconnect(0, `closed ${close.code}: ${close.reason}`);
    }
  }

  private scheduleReconnect(minimumMs: number, detail: string): void {
    const backoff = Math.min(this.timing.backoffMaxMs, this.timing.backoffMinMs * 2 ** this.attempt);
    this.attempt += 1;
    this.setState('waiting', detail);
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => this.connect(), Math.max(minimumMs, backoff));
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** Foreground or pageshow: a waiting or suspended client connects now. */
  private wake(): void {
    if (this.stateValue === 'waiting' || this.stateValue === 'suspended') this.connect();
  }

  private suspend(): void {
    if (TERMINAL.has(this.stateValue) || this.stateValue === 'idle') return;
    this.clearReconnect();
    this.setState('suspended', 'page hidden');
    this.stream?.clientClosed('background');
    for (const listener of this.listeners.suspend) listener();
  }

  private terminate(state: 'update_required' | 'unpaired' | 'stopped', detail: string): void {
    this.clearReconnect();
    this.setState(state, detail);
    const stream = this.stream;
    this.stream = undefined; // its close must not fail calls as connection_lost or reconnect
    if (stream !== undefined) {
      if (state === 'stopped') stream.clientClosed('user');
      else stream.close(CloseCode.normal, state);
    }
    for (const call of [...this.queued, ...this.inflight.values()]) {
      this.forget(call);
      call.reject(new RequestError(LocalError.closed, `client is ${state}`));
    }
  }

  // ---- messages ---------------------------------------------------------------------------------

  private transmit(call: Call, stream: EnvelopeStream): void {
    const { id, method, params } = call;
    try {
      if (!stream.send(params === undefined ? { id, method } : { id, method, params })) {
        this.queued.push(call); // the stream is closing; wait for the next one
        return;
      }
    } catch (error) {
      clearTimeout(call.timer);
      call.reject(new RequestError(LocalError.tooLarge, (error as MessageTooLarge).message));
      return;
    }
    call.stream = stream;
    this.inflight.set(call.id, call);
  }

  private forget(call: Call): void {
    clearTimeout(call.timer);
    this.inflight.delete(call.id);
    const index = this.queued.indexOf(call);
    if (index >= 0) this.queued.splice(index, 1);
  }

  private receive(stream: EnvelopeStream, message: unknown): void {
    if (!isObject(message)) return;
    const { id, method } = message;
    if (typeof method === 'string') {
      if (id !== undefined) {
        // The host sends no requests in v1 (spec 3.1); answer like any peer would.
        stream.send({ id, error: { code: 'method_not_found', message: `client does not serve ${method}` } });
        return;
      }
      this.dispatch(method, isObject(message.params) ? message.params : {});
      return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const call = this.inflight.get(String(id));
    if (call === undefined || call.stream !== stream) return; // late answer to a timed-out request
    this.forget(call);
    if (isObject(message.error)) {
      const error = message.error;
      call.reject(
        new RequestError(
          String(error.code ?? 'internal'),
          String(error.message ?? ''),
          isObject(error.data) ? error.data : undefined,
        ),
      );
    } else {
      call.resolve(isObject(message.result) ? message.result : {});
    }
  }

  private dispatch(method: string, params: Record<string, unknown>): void {
    for (const key of [method, '*']) {
      for (const handler of this.notificationHandlers.get(key) ?? []) handler(params, method);
    }
  }
}
