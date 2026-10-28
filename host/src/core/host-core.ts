// The protocol surface of the session core: the method handlers of protocol-v1.md sections 4 to 7 on top
// of the SessionManager and the Journal, and the per-stream session subscriptions that carry live Journal
// events to clients.
//
// Wiring: build the core, register it on the stream router, build the StreamServer with that router,
// then attach the server so the core can send notifications on streams.
//
//   const core = new HostCore({ journal, agents, host });
//   const registry = core.register(new MethodRegistry().register('initialize', ...));
//   const server = new StreamServer({ registry, authenticate });
//   core.attach(server);
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { AttachmentStore } from '../attachments/store.js';
import type { DirEntry, Host, HostStatus, KeepAwakeStatus, ProjectEntry } from '../generated/common.js';
import { CursorExpired } from '../journal/errors.js';
import { DEFAULT_SNAPSHOT_TURNS, MAX_SINCE_LIMIT, type Journal } from '../journal/journal.js';
import type { JournalEvent, Subscription } from '../journal/types.js';
import { RpcError } from '../errors.js';
import { readSessionDirectory, readSessionFile } from '../files/read.js';
import type { MethodMap, MethodRegistry, RequestContext } from '../stream/router.js';
import type { StreamServer } from '../stream/server.js';
import { describeAgent, type AgentProvider } from './adapter.js';
import * as p from './params.js';
import { SessionManager } from './session-manager.js';
import type { SessionStore } from './store.js';

/** Most recent working folders `project/list` returns. */
export const MAX_PROJECTS = 50;

/** Journal events that do not change the session list row, so they send no `session/updated`. */
const NOT_SUMMARY_CHANGES: ReadonlySet<string> = new Set(['item/started', 'item/delta', 'usage/updated']);

export interface HostCoreOptions {
  journal: Journal;
  agents: readonly AgentProvider[];
  host: Host;
  store?: SessionStore;
  /** Unix seconds. */
  now?: () => number;
  /** Seconds since the host started. Default: process uptime. */
  uptime?: () => number;
  log?: (message: string, error?: unknown) => void;
  /** Sees every appended Journal event, right after the append (the push notifier). Must not block. */
  onJournalEvent?: (event: JournalEvent) => void;
  /** Longest a turn start waits for its git snapshot (turn/diff, spec 7); tests on a busy machine raise it. */
  startSnapshotWaitMs?: number;
  /** The keep-awake status `host/status` carries (spec 4); absent: the field is left out. */
  keepAwake?: () => KeepAwakeStatus;
  /** Uploaded attachments (spec 8.1), resolved in turn input and deleted with their session. */
  attachments?: AttachmentStore;
}

type Result<M extends keyof MethodMap> = MethodMap[M]['result'];

export class HostCore {
  readonly sessions: SessionManager;
  readonly journal: Journal;
  private readonly host: Host;
  private readonly uptime: () => number;
  private readonly log: (message: string, error?: unknown) => void;
  private server: StreamServer | undefined;
  /** streamId -> sessionId -> the subscription feeding that stream. */
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();
  private readonly unwatch: (() => void)[] = [];
  private readonly observer: ((event: JournalEvent) => void) | undefined;
  private readonly keepAwake: (() => KeepAwakeStatus) | undefined;

  constructor(options: HostCoreOptions) {
    this.journal = options.journal;
    this.host = options.host;
    this.uptime = options.uptime ?? (() => Math.floor(process.uptime()));
    this.log = options.log ?? (() => {});
    this.observer = options.onJournalEvent;
    this.keepAwake = options.keepAwake;
    this.sessions = new SessionManager({
      journal: options.journal,
      agents: options.agents,
      ...(options.store ? { store: options.store } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.startSnapshotWaitMs !== undefined ? { startSnapshotWaitMs: options.startSnapshotWaitMs } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      onEvent: (event) => this.onJournalEvent(event),
      log: this.log,
    });
    for (const provider of options.agents) {
      const off = provider.onStateChange?.(() => this.notifyHostStatusChanged());
      if (off) this.unwatch.push(off);
    }
    // Last: restart recovery journals events, and onJournalEvent needs the whole core (sessions included).
    this.sessions.recover();
  }

  /** Lets the core send notifications on the server's streams. */
  attach(server: StreamServer): void {
    this.server = server;
  }

  /** Stops engines and subscriptions. The Journal and store stay open (their owner closes them). */
  async close(): Promise<void> {
    for (const off of this.unwatch.splice(0)) off();
    for (const streamId of [...this.subscriptions.keys()]) this.dropStream(streamId);
    await this.sessions.close();
  }

  // ---- notifications ---------------------------------------------------------------------------

  hostStatus(): HostStatus {
    return {
      host: this.host,
      agents: this.sessions.agents().map(describeAgent),
      sessionsActive: this.sessions.activeCount(),
      uptimeSeconds: this.uptime(),
      ...(this.keepAwake ? { keepAwake: this.keepAwake() } : {}),
    };
  }

  /** Sends `host/status/changed` (spec 4) to every stream that finished its handshake. */
  notifyHostStatusChanged(): void {
    this.broadcast('host/status/changed', this.hostStatus());
  }

  private broadcast(method: string, params: Record<string, unknown>): void {
    for (const connection of this.server?.streams() ?? []) {
      if (connection.ready) connection.notify(method, params);
    }
  }

  /** Unsequenced `session/updated {summary}` for the session list (spec 5.2), after the observer. */
  private onJournalEvent(event: JournalEvent): void {
    try {
      this.observer?.(event);
    } catch (error) {
      this.log(`journal observer failed on ${event.method}`, error);
    }
    if (NOT_SUMMARY_CHANGES.has(event.method)) return;
    const summary = this.sessions.summary(event.params.sessionId);
    if (summary && !this.sessions.store.get(summary.sessionId).deleted) this.broadcast('session/updated', { summary });
  }

  // ---- subscriptions ---------------------------------------------------------------------------

  /** Feeds the session's events after `after` to the stream, then live events. Replaces an older feed. */
  private subscribe(context: RequestContext, sessionId: string, after: number): void {
    const { streamId } = context;
    let feeds = this.subscriptions.get(streamId);
    if (!feeds) {
      feeds = new Map();
      this.subscriptions.set(streamId, feeds);
      context.onClose(() => this.dropStream(streamId));
      if (!this.subscriptions.has(streamId)) return; // the stream closed before the response went out
    }
    feeds.get(sessionId)?.close();
    const map = feeds;
    // Declared first: catch-up runs inside subscribe(), so onExpired may fire before it returns.
    let subscription: Subscription | undefined;
    subscription = this.journal.subscribe(
      sessionId,
      (event) => {
        this.server?.notifyStream(streamId, event.method, event.params, { journal: true });
      },
      {
        after,
        // Compaction overtook this stream: stop feeding; the client's next events/since sees cursor_expired.
        onExpired: () => {
          if (subscription !== undefined && map.get(sessionId) === subscription) map.delete(sessionId);
        },
      },
    );
    if (!subscription.closed) map.set(sessionId, subscription);
  }

  private unsubscribe(streamId: string, sessionId: string): void {
    const feeds = this.subscriptions.get(streamId);
    feeds?.get(sessionId)?.close();
    feeds?.delete(sessionId);
  }

  private dropStream(streamId: string): void {
    const feeds = this.subscriptions.get(streamId);
    if (!feeds) return;
    this.subscriptions.delete(streamId);
    for (const subscription of feeds.values()) subscription.close();
  }

  private dropSession(sessionId: string): void {
    for (const streamId of this.subscriptions.keys()) this.unsubscribe(streamId, sessionId);
  }

  /** Subscribed (stream, session) pairs, for diagnostics and tests. */
  subscribers(sessionId: string): string[] {
    return [...this.subscriptions].filter(([, feeds]) => feeds.has(sessionId)).map(([streamId]) => streamId);
  }

  // ---- handlers --------------------------------------------------------------------------------

  /** Registers every core method (spec 4 to 7) on the router and returns it. */
  register(registry: MethodRegistry): MethodRegistry {
    const s = this.sessions;
    const ok = { ok: true as const };
    return registry
      .register('host/status', () => this.hostStatus())
      .register('agent/list', () => ({ agents: s.agents().map(describeAgent) }))
      .register('model/list', async (params) => {
        const provider = s.agent(p.str(params, 'agentId'));
        try {
          return { models: await provider.models() };
        } catch (error) {
          throw new RpcError('agent_unavailable', `agent ${provider.id} cannot list models`, {
            agentId: provider.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .register('fs/readDirectory', async (params) => {
        const sessionId = p.optStr(params, 'sessionId');
        if (sessionId === undefined) return { entries: await readDirectory(p.str(params, 'path')) };
        if (typeof params.path !== 'string') throw RpcError.invalidParams('params.path', 'path must be a string');
        return { entries: await readSessionDirectory(this.sessionFolder(sessionId), params.path) };
      })
      .register('fs/readFile', async (params) =>
        readSessionFile(this.sessionFolder(p.str(params, 'sessionId')), p.str(params, 'path'), {
          offset: p.optInt(params, 'offset'),
          maxBytes: p.optInt(params, 'maxBytes', 1),
        }),
      )
      .register('project/list', () => ({ projects: this.projects() }))
      .register('session/list', (params) => {
        const options: { agentId?: string; cursor?: string; limit?: number; archived?: boolean } = {};
        const archived = p.optBool(params, 'archived');
        if (archived !== undefined) options.archived = archived;
        const agentId = p.optStr(params, 'agentId');
        const cursor = p.optStr(params, 'cursor');
        const limit = p.optInt(params, 'limit', 1);
        if (agentId !== undefined) options.agentId = agentId;
        if (cursor !== undefined) options.cursor = cursor;
        if (limit !== undefined) options.limit = limit;
        return s.list(options) as Result<'session/list'>;
      })
      .register('session/start', async (params) => {
        const start: Parameters<SessionManager['start']>[0] = { agentId: p.str(params, 'agentId'), cwd: p.str(params, 'cwd') };
        const title = params.title === undefined ? undefined : typeof params.title === 'string' ? params.title : null;
        if (title === null) throw RpcError.invalidParams('params.title', 'title must be a string');
        if (title !== undefined) start.title = title;
        const settings = p.optSettings(params, 'settings');
        if (settings !== undefined) start.settings = settings;
        const input = p.optInput(params, 'input');
        if (input !== undefined) start.input = input;
        return (await s.start(start)) as Result<'session/start'>;
      })
      .register('session/open', (params, context) => this.open(params, context))
      .register('session/close', (params, context) => {
        this.unsubscribe(context.streamId, p.str(params, 'sessionId'));
        return ok;
      })
      .register('session/archive', async (params) => {
        await s.archive(p.str(params, 'sessionId'));
        return ok;
      })
      .register('session/unarchive', (params) => {
        s.unarchive(p.str(params, 'sessionId'));
        return ok;
      })
      .register('session/delete', async (params) => {
        const sessionId = p.str(params, 'sessionId');
        await s.delete(sessionId);
        this.dropSession(sessionId);
        return ok;
      })
      .register('session/rename', (params) => {
        const title = params.title;
        if (typeof title !== 'string' || title.trim() === '') {
          throw RpcError.invalidParams('params.title', 'title must be a non-empty string');
        }
        s.rename(p.str(params, 'sessionId'), title.trim());
        return ok;
      })
      .register('session/settings/update', async (params) => {
        const session = await s.updateSettings(p.str(params, 'sessionId'), p.settingsPatch(params, 'settings'));
        return { session } as Result<'session/settings/update'>;
      })
      .register('events/since', (params, context) => {
        const sessionId = p.str(params, 'sessionId');
        const cursor = p.int(params, 'cursor');
        const limit = p.optInt(params, 'limit', 1);
        const includeOptedOut = p.optBool(params, 'includeOptedOut') ?? false;
        s.session(sessionId);
        const page = this.journal.since(sessionId, cursor, limit);
        const events = includeOptedOut ? page.events : page.events.filter((e) => !context.isOptedOut(e.method));
        return { ...page, events } as Result<'events/since'>;
      })
      .register('session/history', (params) => {
        const sessionId = p.str(params, 'sessionId');
        const before = p.str(params, 'before');
        const limit = p.optInt(params, 'limit', 1);
        s.session(sessionId);
        return this.journal.history(sessionId, before, limit) as Result<'session/history'>;
      })
      .register('turn/start', async (params) => ({
        turn: await s.turnStart(p.str(params, 'sessionId'), p.input(params, 'input'), p.str(params, 'clientMessageId')),
      }))
      .register('turn/steer', async (params) => ({
        turn: await s.steer(
          p.str(params, 'sessionId'),
          p.str(params, 'turnId'),
          p.input(params, 'input'),
          p.str(params, 'clientMessageId'),
        ),
      }))
      .register('turn/interrupt', async (params) => {
        await s.interrupt(p.str(params, 'sessionId'), p.str(params, 'turnId'));
        return ok;
      })
      .register('turn/diff', (params) => s.diff(p.str(params, 'sessionId'), p.str(params, 'turnId')))
      .register('approval/resolve', async (params, context) => {
        await s.resolveApproval(
          p.str(params, 'sessionId'),
          p.str(params, 'requestId'),
          p.decision(params, 'decision'),
          context.clientId,
        );
        return ok;
      })
      .register('input/answer', async (params, context) => {
        await s.answerInput(
          p.str(params, 'sessionId'),
          p.str(params, 'requestId'),
          p.answers(params, 'answers'),
          context.clientId,
        );
        return ok;
      });
  }

  /**
   * `session/open` (spec 6): events mode when the cursor is still in the Journal, snapshot mode otherwise.
   * The stream's live feed starts after the response, from the response's cursor: no event is lost or
   * delivered twice, and none overtakes the response.
   */
  private open(params: MethodMap['session/open']['params'], context: RequestContext): Result<'session/open'> {
    const sessionId = p.str(params, 'sessionId');
    const cursor = p.optInt(params, 'cursor');
    const turns = p.optInt(params, 'turns', 1);
    const session = this.sessions.session(sessionId);
    let result: Result<'session/open'> | undefined;
    if (cursor !== undefined) {
      try {
        const page = this.journal.since(sessionId, cursor, MAX_SINCE_LIMIT);
        // A gap longer than one page is cheaper to send as a snapshot.
        if (page.complete) {
          result = {
            mode: 'events',
            session,
            events: page.events.filter((e) => !context.isOptedOut(e.method)),
            cursor: page.cursor,
            pending: this.journal.pending(sessionId),
          } as Result<'session/open'>;
        }
      } catch (error) {
        if (!(error instanceof CursorExpired)) throw error;
      }
    }
    if (!result) {
      const snapshot = this.journal.snapshot(sessionId, turns ?? DEFAULT_SNAPSHOT_TURNS);
      result = { mode: 'snapshot', session, ...snapshot } as Result<'session/open'>;
    }
    const after = result.cursor;
    context.afterResponse(() => this.subscribe(context, sessionId, after));
    return result;
  }

  /**
   * The folder file reads are scoped to (spec 4.1): the session's `cwd`. `not_found` for an unknown or
   * deleted session, so a deleted session's folder is never readable through the host.
   */
  sessionFolder(sessionId: string): string {
    return this.sessions.session(sessionId).cwd;
  }

  /** `project/list` (spec 4): working folders of visible sessions, most recently used first. */
  private projects(): ProjectEntry[] {
    const byPath = new Map<string, ProjectEntry>();
    for (const summary of this.sessions.allSessions()) {
      if (summary.cwd === '') continue;
      const entry = byPath.get(summary.cwd);
      if (entry) {
        entry.sessions += 1;
        entry.lastUsedAt = Math.max(entry.lastUsedAt, summary.updatedAt);
      } else {
        byPath.set(summary.cwd, {
          path: summary.cwd,
          name: path.basename(summary.cwd) || summary.cwd,
          lastUsedAt: summary.updatedAt,
          sessions: 1,
        });
      }
    }
    return [...byPath.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_PROJECTS);
  }
}

/**
 * `fs/readDirectory` (spec 4): folders first, then files, by name. `~` means the host user's home.
 * Symlinks are reported as what they point to; entries that are neither (sockets, broken links) are skipped.
 */
export async function readDirectory(requested: string): Promise<DirEntry[]> {
  const dir = requested === '~' || requested.startsWith('~/') ? path.join(homedir(), requested.slice(1)) : requested;
  if (!path.isAbsolute(dir)) throw RpcError.invalidParams('params.path', 'path must be absolute or start with ~');
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      throw new RpcError('not_found', `cannot read directory ${dir} (${code})`, { path: requested });
    }
    throw error;
  }
  const entries: DirEntry[] = [];
  for (const dirent of names) {
    const full = path.join(dir, dirent.name);
    let kind: DirEntry['kind'] | undefined;
    if (dirent.isDirectory()) kind = 'dir';
    else if (dirent.isFile()) kind = 'file';
    else if (dirent.isSymbolicLink()) {
      const target = await stat(full).catch(() => undefined);
      kind = target?.isDirectory() ? 'dir' : target?.isFile() ? 'file' : undefined;
    }
    if (kind) entries.push({ name: dirent.name, kind, path: full });
  }
  return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}
