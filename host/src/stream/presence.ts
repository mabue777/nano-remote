// Presence (spec 2.2): a client counts as connected while it has any open stream, whatever its pings
// say. The `state` from the latest ping is kept per stream for diagnostics and future rules. The push
// rules (spec 9) read `isConnected`; `onChange` fires when a client goes from zero streams to one or back.

export type PresenceState = 'foreground' | 'background';

export interface StreamPresence {
  streamId: string;
  /** State from the latest ping on the stream; undefined until the first ping. */
  state: PresenceState | undefined;
  openedAt: number;
  lastPingAt: number | undefined;
}

export type PresenceListener = (clientId: string, connected: boolean) => void;

export class PresenceRegistry {
  private readonly clients = new Map<string, Map<object, StreamPresence>>();
  private readonly listeners = new Set<PresenceListener>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers an open socket. `handle` identifies it until it closes (its stream_id may come later). */
  open(clientId: string, handle: object): void {
    let streams = this.clients.get(clientId);
    const first = !streams;
    if (!streams) this.clients.set(clientId, (streams = new Map()));
    streams.set(handle, { streamId: '', state: undefined, openedAt: this.now(), lastPingAt: undefined });
    if (first) this.emit(clientId, true);
  }

  /** Records the stream id once the first envelope names it. */
  identify(clientId: string, handle: object, streamId: string): void {
    const entry = this.clients.get(clientId)?.get(handle);
    if (entry) entry.streamId = streamId;
  }

  ping(clientId: string, handle: object, state: PresenceState): void {
    const entry = this.clients.get(clientId)?.get(handle);
    if (!entry) return;
    entry.state = state;
    entry.lastPingAt = this.now();
  }

  close(clientId: string, handle: object): void {
    const streams = this.clients.get(clientId);
    if (!streams?.delete(handle)) return;
    if (streams.size === 0) {
      this.clients.delete(clientId);
      this.emit(clientId, false);
    }
  }

  isConnected(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /** Open streams of a client, oldest first. Empty when the client is not connected. */
  streams(clientId: string): StreamPresence[] {
    return [...(this.clients.get(clientId)?.values() ?? [])].map((entry) => ({ ...entry }));
  }

  /** Client ids with at least one open stream. */
  connectedClients(): string[] {
    return [...this.clients.keys()];
  }

  onChange(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(clientId: string, connected: boolean): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(clientId, connected);
      } catch {
        // A broken listener must not keep a socket from closing or other listeners from hearing.
      }
    }
  }
}
