import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exampleMessage } from '../../test/fixtures';
import { FakeTransport, rpcError, settle } from '../../test/replica-doubles';
import type { InitializeResult } from '../generated/methods';
import { Replica } from '../replica/replica';
import type { SessionSummary } from '../replica/types';
import type { ClientState } from '../stream/client';
import {
  backgroundTasksText,
  agentRow,
  connectionOf,
  folderOf,
  formatAgo,
  formatUptime,
  AWAY_STORAGE_KEY,
  awayTransition,
  AwayTracker,
  HomeModel,
  isFinished,
  orderSessions,
  rankOf,
  sessionRow,
  statusOf,
  type HomeClient,
} from './home-model';

const INIT: InitializeResult = exampleMessage('08').result;
const STATUS = exampleMessage('44').params;

/** FakeTransport plus what the home screen reads: state events, the initialize result, reconnectAt. */
class HomeTransport extends FakeTransport implements HomeClient {
  reconnectAt: number | undefined;
  host: InitializeResult | undefined;
  retries = 0;
  private readonly states = new Set<(state: ClientState, detail: string) => void>();

  override on(event: 'ready' | 'suspend' | 'state', listener: (...args: never[]) => void): () => void {
    if (event !== 'state') return super.on(event, listener as () => void);
    const fn = listener as (state: ClientState, detail: string) => void;
    this.states.add(fn);
    return () => this.states.delete(fn);
  }

  setState(state: ClientState, reconnectAt?: number): void {
    this.state = state;
    this.reconnectAt = reconnectAt;
    for (const fn of this.states) fn(state, '');
  }

  connect(): void {
    this.host = INIT;
    this.setState('ready');
    this.goReady();
  }

  retryNow(): void {
    this.retries += 1;
  }
}

function summary(fields: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'ses_1',
    agentId: 'codex',
    title: 'Create hello.txt',
    cwd: '/Users/me/Desktop/phone-test',
    status: 'idle',
    createdAt: 1760930000,
    updatedAt: 1760930400,
    lastSeq: 1,
    pending: { approvals: 0, inputs: 0 },
    ...fields,
  };
}

const NOW = 1760930400_000;

function setup(options: { connect?: boolean } = {}) {
  const client = new HomeTransport();
  const replica = new Replica({ client, storage: null });
  if (options.connect) client.connect();
  const model = new HomeModel({ client, replica });
  const changes = vi.fn();
  model.subscribe(changes);
  return { client, replica, model, changes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('home formatting', () => {
  it('connectionOf maps every client state', () => {
    expect(connectionOf('idle', undefined, 0)).toMatchObject({ kind: 'connecting' });
    expect(connectionOf('connecting', undefined, 0)).toMatchObject({ kind: 'connecting', label: 'Connecting…' });
    expect(connectionOf('ready', undefined, 0)).toMatchObject({ kind: 'connected', label: 'Connected' });
    expect(connectionOf('waiting', 4200, 1000)).toEqual({ kind: 'offline', retryInSeconds: 4, label: 'Offline, retrying in 4 s' });
    expect(connectionOf('waiting', 500, 1000)).toMatchObject({ retryInSeconds: 0 });
    expect(connectionOf('waiting', undefined, 0)).toEqual({ kind: 'offline', label: 'Offline' });
    expect(connectionOf('suspended', undefined, 0)).toMatchObject({ kind: 'offline' });
    expect(connectionOf('stopped', undefined, 0)).toMatchObject({ kind: 'offline' });
    expect(connectionOf('update_required', undefined, 0)).toMatchObject({ kind: 'update_required' });
    expect(connectionOf('unpaired', undefined, 0)).toMatchObject({ kind: 'unpaired' });
  });

  it('formatUptime and formatAgo', () => {
    expect(formatUptime(40.7)).toBe('40 s');
    expect(formatUptime(-3)).toBe('0 s');
    expect(formatUptime(7 * 60 + 5)).toBe('7 min');
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe('2 h 5 min');
    expect(formatUptime(86_400 * 3 + 4 * 3600)).toBe('3 d 4 h');
    const now = 1_000_000_000;
    expect(formatAgo(now / 1000 - 10, now)).toBe('just now');
    expect(formatAgo(now / 1000 - 300, now)).toBe('5 min ago');
    expect(formatAgo(now / 1000 - 3 * 3600, now)).toBe('3 h ago');
    expect(formatAgo(now / 1000 - 2 * 86_400, now)).toBe('2 d ago');
  });

  it('agentRow tones and details', () => {
    expect(agentRow({ id: 'codex', name: 'Codex', status: 'ready', version: '0.163.0' })).toEqual({
      id: 'codex',
      name: 'Codex',
      status: 'ready',
      tone: 'ok',
      detail: 'ready · 0.163.0',
    });
    expect(agentRow({ id: 'k', name: 'Kimi', status: 'unavailable', reason: 'CLI not found' })).toMatchObject({ tone: 'off', detail: 'unavailable · CLI not found' });
    expect(agentRow({ id: 'c', name: 'Codex', status: 'degraded' })).toMatchObject({ tone: 'warn' });
  });

  it('statusOf: live status first, then how the last turn ended', () => {
    expect(statusOf(summary({ status: 'running' }))).toEqual({ label: 'Working', tone: 'busy' });
    expect(statusOf(summary({ status: 'waiting_approval' }))).toMatchObject({ label: 'Needs approval', tone: 'attention' });
    expect(statusOf(summary({ status: 'waiting_input' }))).toMatchObject({ label: 'Needs an answer' });
    expect(statusOf(summary({ status: 'error' }))).toMatchObject({ label: 'Error', tone: 'error' });
    expect(statusOf(summary({ status: 'closed' }))).toMatchObject({ label: 'Closed' });
    expect(statusOf(summary({ lastTurnStatus: 'completed' }))).toMatchObject({ label: 'Finished', tone: 'ok' });
    expect(statusOf(summary({ lastTurnStatus: 'interrupted' }))).toMatchObject({ label: 'Interrupted' });
    expect(statusOf(summary({ lastTurnStatus: 'failed' }))).toMatchObject({ label: 'Failed', tone: 'error' });
    expect(statusOf(summary({ lastTurnStatus: 'inProgress' }))).toMatchObject({ label: 'Working' });
    expect(statusOf(summary())).toMatchObject({ label: 'Idle' });
  });

  it('sessionRow: agent name, folder, pending count, preview and age', () => {
    const row = sessionRow(
      summary({ pending: { approvals: 1, inputs: 2 }, preview: 'Done.', updatedAt: NOW / 1000 - 120 }),
      new Map([['codex', 'Codex']]),
      NOW,
    );
    expect(row).toMatchObject({ agentName: 'Codex', folder: 'phone-test', pending: 3, preview: 'Done.', updated: '2 min ago', statusLabel: 'Idle' });
    expect(sessionRow(summary({ title: ' ', agentId: 'other' }), new Map(), NOW)).toMatchObject({ title: 'Untitled session', agentName: 'other', preview: '' });
    expect(row.model).toBeUndefined();
    expect(sessionRow(summary(), new Map(), NOW, 'llamacpp/bonsai-27b').model).toBe('bonsai-27b · llamacpp');
    expect(sessionRow(summary(), new Map(), NOW, '').model).toBeUndefined();
    // Running background tasks (spec 5.1), for the "N background tasks" badge; ended ones do not count.
    expect(row.backgroundTasks).toBe(0);
    const tasks = (['running', 'finished', 'running', 'cancelled'] as const).map((status, n) => ({ id: `t${n}`, title: 't', status, startedAt: 1 }));
    expect(sessionRow(summary({ backgroundTasks: tasks }), new Map(), NOW).backgroundTasks).toBe(2);
    // A session whose agent stopped runs nothing, whatever its list still says.
    expect(sessionRow(summary({ status: 'error', backgroundTasks: tasks }), new Map(), NOW).backgroundTasks).toBe(0);
    expect(backgroundTasksText(1)).toBe('1 background task');
    expect(backgroundTasksText(2)).toBe('2 background tasks');
    expect(folderOf('/')).toBe('/');
    expect(folderOf('/a/b/')).toBe('b');
  });
});

describe('HomeModel', () => {
  it('a row shows the model the Replica knows from the opened session (pi: model · provider)', () => {
    const client = new HomeTransport();
    const settings: Record<string, { model?: string }> = { ses_pi: { model: 'openrouter/qwen/qwen3.5-coder' }, ses_plain: {} };
    const replica = {
      sessions: [summary({ sessionId: 'ses_pi', agentId: 'pi' }), summary({ sessionId: 'ses_plain' }), summary({ sessionId: 'ses_unopened' })],
      sessionsNextCursor: undefined,
      refreshSessions: async () => undefined,
      loadMoreSessions: async () => false,
      subscribe: () => () => undefined,
      session: (id: string) => (id === 'ses_unopened' ? undefined : { session: { settings: settings[id]! } }),
    };
    const model = new HomeModel({ client, replica });
    expect(Object.fromEntries(model.sessions.map((row) => [row.sessionId, row.model]))).toEqual({
      ses_pi: 'qwen/qwen3.5-coder · openrouter',
      ses_plain: undefined,
      ses_unopened: undefined,
    });
    model.dispose();
  });

  it('connecting, then connected with host and agents from initialize, then uptime from host/status', async () => {
    const { client, model } = setup();
    expect(model.connection.kind).toBe('connecting');
    expect(model.host).toBeUndefined();
    client.rule('session/list', () => ({ sessions: [] }));
    client.connect();
    expect(model.connection.kind).toBe('connected');
    expect(model.host).toMatchObject({ name: 'mabue-mbp', version: '0.1.0' });
    expect(model.host!.agents.map((a) => [a.name, a.tone])).toEqual([
      ['Codex', 'ok'],
      ['Claude Code', 'ok'],
      ['Kimi', 'off'],
    ]);
    expect(model.host!.uptime).toBeUndefined();
    client.last('host/status').resolve({ ...STATUS, uptimeSeconds: 3600, sessionsActive: 2 });
    await settle();
    expect(model.host).toMatchObject({ uptime: '1 h 0 min', sessionsActive: 2 });
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(model.host!.uptime).toBe('1 h 30 min');
  });

  it('host/status/changed replaces the agents (a degraded adapter shows at once)', () => {
    const { client, model, changes } = setup({ connect: true });
    changes.mockClear();
    client.notify('host/status/changed', STATUS);
    expect(changes).toHaveBeenCalled();
    expect(model.host!.agents.map((a) => [a.name, a.tone, a.detail])).toEqual([
      ['Codex', 'warn', 'degraded · adapter restarting'],
      ['Claude Code', 'ok', 'ready'],
    ]);
    expect(model.host!.uptime).toBe('1 d 0 h');
  });

  it('keeps the initialize data when host/status fails; asks again on the next stream', async () => {
    const { client, model } = setup({ connect: true });
    client.last('host/status').reject(rpcError('method_not_found'));
    await settle();
    expect(model.host!.uptime).toBeUndefined();
    client.connect();
    expect(client.count('host/status')).toBe(2);
  });

  it('offline: a countdown that ticks every second, and retry now', () => {
    const { client, model, changes } = setup({ connect: true });
    client.setState('waiting', NOW + 4000);
    expect(model.connection).toMatchObject({ kind: 'offline', retryInSeconds: 4 });
    changes.mockClear();
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(model.connection.retryInSeconds).toBe(3);
    model.retryNow();
    expect(client.retries).toBe(1);
    client.setState('connecting');
    changes.mockClear();
    vi.advanceTimersByTime(5000);
    expect(changes).not.toHaveBeenCalled();
  });

  it('sessions come from the Replica, waiting first, with agent names, pending counters and last status', async () => {
    const { client, model } = setup();
    client.rule('session/list', () => ({
      sessions: [
        summary({ sessionId: 'old', updatedAt: 1760930000, lastTurnStatus: 'completed' }),
        summary({ sessionId: 'new', updatedAt: 1760930300, status: 'waiting_approval', pending: { approvals: 1, inputs: 0 } }),
      ],
      nextCursor: 'p2',
    }));
    client.connect();
    await settle();
    expect(model.sessions.map((s) => [s.sessionId, s.agentName, s.statusLabel, s.pending])).toEqual([
      ['new', 'Codex', 'Needs approval', 1],
      ['old', 'Codex', 'Finished', 0],
    ]);
    expect(model.hasMore).toBe(true);
    // session/updated (via the Replica) moves a row: running stays below waiting, then the approval ends
    client.notify('session/updated', { summary: summary({ sessionId: 'old', updatedAt: 1760930399, status: 'running' }) });
    expect(model.sessions.map((s) => [s.sessionId, s.statusLabel])).toEqual([
      ['new', 'Needs approval'],
      ['old', 'Working'],
    ]);
    client.notify('session/updated', { summary: summary({ sessionId: 'new', updatedAt: 1760930500, lastTurnStatus: 'completed' }) });
    expect(model.sessions.map((s) => [s.sessionId, s.statusLabel])).toEqual([
      ['old', 'Working'],
      ['new', 'Finished'],
    ]);
  });

  it('shows "Finished while away" for rows the tracker marked, only while they are finished', async () => {
    const client = new HomeTransport();
    const replica = new Replica({ client, storage: null });
    const marked = new Set(['done']);
    const listeners = new Set<() => void>();
    const away = { isMarked: (id: string) => marked.has(id), subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)) };
    const model = new HomeModel({ client, replica, away });
    const changes = vi.fn();
    model.subscribe(changes);
    client.rule('session/list', () => ({
      sessions: [summary({ sessionId: 'done', lastTurnStatus: 'completed' }), summary({ sessionId: 'busy', status: 'running', lastTurnStatus: 'inProgress' })],
    }));
    client.connect();
    await settle();
    expect(model.sessions.map((s) => [s.sessionId, s.finishedWhileAway])).toEqual([
      ['busy', false],
      ['done', true],
    ]);
    marked.add('busy'); // a stale mark on a running session shows nothing
    expect(model.sessions.find((s) => s.sessionId === 'busy')?.finishedWhileAway).toBe(false);
    changes.mockClear();
    for (const fn of listeners) fn();
    expect(changes).toHaveBeenCalledTimes(1);
    model.dispose();
    expect(listeners.size).toBe(0);
  });

  it('pull to refresh: list and status again; one at a time; failures show and clear', async () => {
    const { client, model } = setup({ connect: true });
    client.last('session/list').resolve({ sessions: [] });
    client.last('host/status').resolve(STATUS);
    await settle();
    const first = model.refresh();
    expect(model.refreshing).toBe(true);
    void model.refresh(); // ignored while one runs
    expect(client.count('session/list')).toBe(2);
    client.last('session/list').reject(rpcError('internal'));
    client.last('host/status').resolve(STATUS);
    await first;
    expect(model.refreshing).toBe(false);
    expect(model.error).toBe('Could not refresh: internal');
    client.rule('session/list', () => ({ sessions: [summary()] }));
    client.rule('host/status', () => STATUS);
    await model.refresh();
    expect(model.error).toBeUndefined();
    expect(model.sessions).toHaveLength(1);
  });

  it('infinite paging: loads the next page by cursor until there is none', async () => {
    const { client, model } = setup();
    client.rule('host/status', () => STATUS);
    client.rule('session/list', (params) => {
      if (params?.cursor === undefined) return { sessions: [summary({ sessionId: 'a', updatedAt: 9 })], nextCursor: 'p2' };
      if (params.cursor === 'p2') return { sessions: [summary({ sessionId: 'b', updatedAt: 5 })], nextCursor: 'p3' };
      throw rpcError('cursor_expired');
    });
    client.connect();
    await settle();
    const more = model.loadMore();
    expect(model.loadingMore).toBe(true);
    void model.loadMore(); // one page at a time
    await more;
    expect(model.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(client.calls.filter((c) => c.method === 'session/list').map((c) => c.params?.cursor)).toEqual([undefined, 'p2']);
    await model.loadMore();
    expect(model.error).toBe('Could not load more sessions: cursor_expired');
    expect(model.loadingMore).toBe(false);
    client.rule('session/list', () => ({ sessions: [summary({ sessionId: 'a' })] }));
    await model.refresh();
    expect(model.hasMore).toBe(false);
    await model.loadMore();
    expect(client.calls.filter((c) => c.method === 'session/list')).toHaveLength(4);
  });

  it('update needed and unpaired are their own indicator states; dispose stops everything', () => {
    const { client, model, changes } = setup({ connect: true });
    client.setState('update_required');
    expect(model.connection.kind).toBe('update_required');
    client.setState('unpaired');
    expect(model.connection.kind).toBe('unpaired');
    model.dispose();
    changes.mockClear();
    client.setState('waiting', NOW + 1000);
    client.notify('host/status/changed', STATUS);
    vi.advanceTimersByTime(3000);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('home list order', () => {
  it('rankOf: pending or waiting first, then running, then the rest', () => {
    expect(rankOf(summary({ pending: { approvals: 1, inputs: 0 } }))).toBe(0);
    expect(rankOf(summary({ pending: { approvals: 0, inputs: 2 } }))).toBe(0);
    expect(rankOf(summary({ status: 'waiting_input' }))).toBe(0);
    expect(rankOf(summary({ status: 'waiting_approval' }))).toBe(0);
    expect(rankOf(summary({ status: 'running' }))).toBe(1);
    expect(rankOf(summary({ status: 'idle', lastTurnStatus: 'inProgress' }))).toBe(1);
    expect(rankOf(summary({ lastTurnStatus: 'completed' }))).toBe(2);
    expect(rankOf(summary({ status: 'error' }))).toBe(2);
    expect(rankOf({ status: 'closed', updatedAt: 0 } as unknown as SessionSummary)).toBe(2); // no pending field
  });

  it('orderSessions: waiting, running, rest; newest first within each; input untouched', () => {
    const input = [
      summary({ sessionId: 'idle-new', updatedAt: 900 }),
      summary({ sessionId: 'run-old', status: 'running', updatedAt: 100 }),
      summary({ sessionId: 'wait-old', status: 'waiting_approval', pending: { approvals: 1, inputs: 0 }, updatedAt: 50 }),
      summary({ sessionId: 'idle-old', updatedAt: 10, lastTurnStatus: 'failed' }),
      summary({ sessionId: 'run-new', status: 'running', updatedAt: 800 }),
      summary({ sessionId: 'wait-new', status: 'waiting_input', pending: { approvals: 0, inputs: 1 }, updatedAt: 60 }),
    ];
    expect(orderSessions(input).map((s) => s.sessionId)).toEqual(['wait-new', 'wait-old', 'run-new', 'run-old', 'idle-new', 'idle-old']);
    expect(input[0]!.sessionId).toBe('idle-new');
  });
});

describe('finished while away', () => {
  it('isFinished: idle after a turn that ended', () => {
    expect(isFinished({ status: 'idle', lastTurnStatus: 'completed' })).toBe(true);
    expect(isFinished({ status: 'idle', lastTurnStatus: 'failed' })).toBe(true);
    expect(isFinished({ status: 'idle', lastTurnStatus: 'interrupted' })).toBe(true);
    expect(isFinished({ status: 'idle', lastTurnStatus: 'inProgress' })).toBe(false);
    expect(isFinished({ status: 'idle' })).toBe(false);
    expect(isFinished({ status: 'running', lastTurnStatus: 'completed' })).toBe(false);
    expect(isFinished({ status: 'closed', lastTurnStatus: 'completed' })).toBe(false);
  });

  it('awayTransition: marks a finish the app did not watch live', () => {
    const done = summary({ lastSeq: 9, lastTurnStatus: 'completed' });
    expect(awayTransition(4, done, undefined)).toBe('mark'); // moved on, nothing heard live
    expect(awayTransition(4, done, 7)).toBe('mark'); // heard only part of it live
    expect(awayTransition(4, done, 9)).toBe('none'); // watched it finish
    expect(awayTransition(9, done, undefined)).toBe('none'); // nothing new
    expect(awayTransition(undefined, done, undefined)).toBe('none'); // first look: nothing to compare with
    expect(awayTransition(4, summary({ lastSeq: 9, status: 'running' }), undefined)).toBe('unmark');
  });

  class Doc {
    visibilityState = 'visible';
    private readonly listeners = new Set<() => void>();
    addEventListener(_: 'visibilitychange', fn: () => void) {
      this.listeners.add(fn);
    }
    removeEventListener(_: 'visibilitychange', fn: () => void) {
      this.listeners.delete(fn);
    }
    set(state: 'visible' | 'hidden') {
      this.visibilityState = state;
      for (const fn of this.listeners) fn();
    }
    get count() {
      return this.listeners.size;
    }
  }

  class MemoryStorage {
    readonly data = new Map<string, string>();
    getItem(key: string) {
      return this.data.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      this.data.set(key, value);
    }
  }

  function trackerSetup(storage: MemoryStorage | null = new MemoryStorage()) {
    const client = new HomeTransport();
    const replica = new Replica({ client, storage: null });
    const doc = new Doc();
    const away = new AwayTracker({ client, replica, storage, doc });
    const changes = vi.fn();
    away.subscribe(changes);
    return { client, replica, doc, away, changes, storage };
  }

  const running = (seq: number) => summary({ sessionId: 's1', lastSeq: seq, status: 'running', lastTurnStatus: 'inProgress' });
  const finished = (seq: number) => summary({ sessionId: 's1', lastSeq: seq, status: 'idle', lastTurnStatus: 'completed' });

  it('a turn that ends while the stream is down is marked when the list catches up; opening clears it', async () => {
    const { client, replica, away, changes, storage } = trackerSetup();
    client.rule('session/list', () => ({ sessions: [running(3)] }));
    client.connect();
    await settle();
    expect(away.present).toBe(true);
    expect(away.isMarked('s1')).toBe(false);

    client.setState('waiting', NOW + 1000); // offline: the turn ends meanwhile
    client.rule('session/list', () => ({ sessions: [finished(6)] }));
    client.connect();
    await settle();
    expect(away.isMarked('s1')).toBe(true);
    expect(changes).toHaveBeenCalled();
    expect(JSON.parse(storage!.getItem(AWAY_STORAGE_KEY)!)).toEqual({ seen: { s1: 6 }, marks: { s1: 6 } });

    // A reload in the same tab keeps it (sessionStorage).
    const again = new AwayTracker({ client, replica, storage });
    expect(again.isMarked('s1')).toBe(true);
    again.dispose();

    changes.mockClear();
    away.opened('s1');
    expect(away.isMarked('s1')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    away.opened('s1'); // nothing to clear
    away.opened('unknown');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('a turn that ends while the app watches it live gets no mark; a new turn removes an old mark', async () => {
    const { client, away, doc } = trackerSetup();
    client.rule('session/list', () => ({ sessions: [running(3)] }));
    client.connect();
    await settle();
    client.notify('session/updated', { summary: finished(6) });
    await settle();
    expect(away.isMarked('s1')).toBe(false);

    // Hidden: the socket stays up, the update arrives, but nobody saw it.
    client.notify('session/updated', { summary: running(7) });
    await settle();
    doc.set('hidden');
    await settle();
    client.notify('session/updated', { summary: finished(9) });
    await settle();
    expect(away.isMarked('s1')).toBe(false); // nothing is judged while away
    doc.set('visible');
    await settle();
    expect(away.isMarked('s1')).toBe(true);

    client.notify('session/updated', { summary: running(10) });
    await settle();
    expect(away.isMarked('s1')).toBe(false);
  });

  it('Journal events of the open session count as live, and the open session is never marked', async () => {
    const { client, replica, away } = trackerSetup();
    client.rule('session/list', () => ({ sessions: [running(3), summary({ sessionId: 's2', lastSeq: 1, status: 'running' })] }));
    client.connect();
    await settle();
    client.notify('item/delta', { sessionId: 's1', seq: 4 }); // no view open: the Replica ignores it, the tracker hears it
    client.notify('session/updated', { summary: finished(4) });
    await settle();
    expect(away.isMarked('s1')).toBe(false);

    void replica.open('s2');
    client.setState('waiting', NOW + 1000);
    client.rule('session/list', () => ({ sessions: [finished(4), summary({ sessionId: 's2', lastSeq: 5, lastTurnStatus: 'completed' })] }));
    client.connect();
    await settle();
    expect(away.isMarked('s2')).toBe(false);
    client.notify('turn/started', {}); // no session, no seq: ignored
    client.notify('host/status/changed', STATUS);
    await settle();
  });

  it('broken or blocked storage starts empty and never throws; dispose stops listening', async () => {
    const broken = new MemoryStorage();
    broken.data.set(AWAY_STORAGE_KEY, '{not json');
    expect(trackerSetup(broken).away.isMarked('s1')).toBe(false);
    const odd = new MemoryStorage();
    odd.data.set(AWAY_STORAGE_KEY, JSON.stringify({ seen: { s1: 'x', s2: 2 }, marks: null }));
    const restored = trackerSetup(odd);
    restored.client.rule('session/list', () => ({ sessions: [] }));
    restored.client.connect();
    await settle();
    expect(JSON.parse(odd.getItem(AWAY_STORAGE_KEY)!)).toEqual({ seen: { s2: 2 }, marks: {} });

    const full = new MemoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const { client, away, doc } = trackerSetup(full);
    client.rule('session/list', () => ({ sessions: [running(1)] }));
    client.connect();
    await settle();
    expect(() => away.evaluate()).not.toThrow();
    away.dispose();
    expect(doc.count).toBe(0);

    const none = trackerSetup(null);
    none.client.rule('session/list', () => ({ sessions: [running(1)] }));
    none.client.connect();
    await settle();
    expect(none.away.isMarked('s1')).toBe(false);
  });

  it('without a document only the stream decides presence', async () => {
    const client = new HomeTransport();
    const replica = new Replica({ client, storage: null });
    const away = new AwayTracker({ client, replica });
    expect(away.present).toBe(false);
    client.rule('session/list', () => ({ sessions: [running(1)] }));
    client.connect();
    await settle();
    expect(away.present).toBe(true);
    away.dispose();
  });
});
