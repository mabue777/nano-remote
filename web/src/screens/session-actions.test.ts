import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exampleMessage } from '../../test/fixtures';
import { FakeTransport, rpcError, settle } from '../../test/replica-doubles';
import type { InitializeResult } from '../generated/methods';
import { Replica } from '../replica/replica';
import type { SessionSummary } from '../replica/types';
import type { ClientState } from '../stream/client';
import { HomeModel, type HomeClient } from './home-model';
import { DELETE_ALL_MESSAGE, DELETE_MESSAGE, deleteAllTitle, isWorking, SessionActions, STOP_MESSAGE, UNDO_MS } from './session-actions';

const INIT: InitializeResult = exampleMessage('08').result;

class HomeTransport extends FakeTransport implements HomeClient {
  reconnectAt: number | undefined;
  host: InitializeResult | undefined = INIT;
  override on(event: 'ready' | 'suspend' | 'state', listener: (...args: never[]) => void): () => void {
    if (event === 'state') return () => undefined;
    return super.on(event, listener as () => void);
  }
  retryNow(): void {}
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
    lastTurnStatus: 'completed',
    ...fields,
  };
}

/** A host with live sessions `a`, `b` and archived `old1`, `old2`; archive, unarchive and delete answer ok. */
async function setup(options: { refuse?: string } = {}) {
  const client = new HomeTransport();
  const live = [summary({ sessionId: 'a', title: 'Alpha', updatedAt: 30 }), summary({ sessionId: 'b', title: 'Beta', updatedAt: 20 })];
  const archived = [
    summary({ sessionId: 'old1', title: 'Old one', updatedAt: 10, archived: true, status: 'closed' }),
    summary({ sessionId: 'old2', title: '', updatedAt: 5, archived: true, status: 'closed' }),
  ];
  client.rule('session/list', (params) => ({ sessions: params?.archived === true ? archived : live }));
  client.rule('host/status', () => exampleMessage('44').params);
  for (const method of ['session/archive', 'session/unarchive', 'session/delete']) {
    client.rule(method, () => {
      if (options.refuse === method) throw rpcError('internal');
      return { ok: true };
    });
  }
  const replica = new Replica({ client, storage: null });
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const actions = new SessionActions({
    replica,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => ((timer as { cleared: boolean }).cleared = true),
  });
  const home = new HomeModel({ client, replica, now: () => 1760930400_000 });
  client.goReady();
  await settle();
  return { client, replica, actions, home, timers };
}

const ids = (rows: { sessionId: string }[]) => rows.map((r) => r.sessionId);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the home list: archive, undo, delete', () => {
  it('loads the archived sessions into a collapsed section with a count', async () => {
    const { home, client } = await setup();
    expect(ids(home.sessions)).toEqual(['a', 'b']);
    expect(ids(home.archived)).toEqual(['old1', 'old2']);
    expect(home.archived.map((r) => r.title)).toEqual(['Old one', 'Untitled session']);
    expect(home.archivedCount).toBe(2);
    expect(home.archivedOpen).toBe(false);
    home.toggleArchived();
    expect(home.archivedOpen).toBe(true);
    expect(client.calls.filter((c) => c.method === 'session/list').map((c) => c.params)).toEqual([{}, { archived: true }]);
    // pull to refresh asks for both again
    await home.refresh();
    expect(client.calls.filter((c) => c.method === 'session/list' && c.params?.archived === true)).toHaveLength(2);
  });

  it('archive moves a row to Archived at once, with no confirmation, and shows Undo for a few seconds', async () => {
    const { home, actions, client, timers } = await setup();
    await actions.archive('a');
    expect(client.last('session/archive').params).toEqual({ sessionId: 'a' });
    expect(ids(home.sessions)).toEqual(['b']);
    expect(ids(home.archived)).toContain('a');
    expect(home.archivedCount).toBe(3);
    expect(actions.confirm).toBeUndefined();
    expect(actions.undo).toEqual({ sessionId: 'a', text: 'Archived Alpha' });
    expect(timers.at(-1)!.ms).toBe(UNDO_MS);
    timers.at(-1)!.fn(); // the toast times out
    expect(actions.undo).toBeUndefined();
  });

  it('undo restores the archived row (session/unarchive)', async () => {
    const { home, actions, client, timers } = await setup();
    await actions.archive('b');
    expect(ids(home.sessions)).toEqual(['a']);
    await actions.undoArchive();
    expect(client.last('session/unarchive').params).toEqual({ sessionId: 'b' });
    expect(ids(home.sessions)).toEqual(['a', 'b']);
    expect(ids(home.archived)).toEqual(['old1', 'old2']);
    expect(actions.undo).toBeUndefined();
    expect(timers.at(-1)!.cleared).toBe(true);
    await actions.undoArchive(); // nothing left to undo
    expect(client.count('session/unarchive')).toBe(1);
    // a second archive replaces the first toast
    await actions.archive('a');
    await actions.archive('b');
    expect(actions.undo?.sessionId).toBe('b');
    expect(timers.at(-2)!.cleared).toBe(true);
    actions.dispose();
    expect(timers.at(-1)!.cleared).toBe(true);
  });

  it('a refused archive puts the row back and says so; the Undo goes', async () => {
    const { home, actions } = await setup({ refuse: 'session/archive' });
    await actions.archive('a');
    expect(ids(home.sessions)).toEqual(['a', 'b']);
    expect(actions.undo).toBeUndefined();
    expect(actions.error).toBe('Could not archive Alpha: internal');
  });

  it('a refused unarchive leaves the row archived and says so', async () => {
    const { home, actions } = await setup({ refuse: 'session/unarchive' });
    await actions.unarchive('old1');
    expect(ids(home.archived)).toEqual(['old1', 'old2']);
    expect(actions.error).toBe('Could not bring back Old one: internal');
  });

  it('delete asks first; only the confirmation removes the row', async () => {
    const { home, actions, client } = await setup();
    actions.askDelete('a');
    expect(actions.confirm).toMatchObject({ kind: 'session', title: 'Delete Alpha?', message: DELETE_MESSAGE, confirmLabel: 'Delete' });
    expect(DELETE_MESSAGE).toBe('Its history and attachments are removed from your Mac. This cannot be undone.');
    expect(client.count('session/delete')).toBe(0);
    expect(ids(home.sessions)).toEqual(['a', 'b']);
    actions.cancelConfirm();
    expect(actions.confirm).toBeUndefined();
    actions.cancelConfirm(); // already closed
    expect(await actions.confirmDelete()).toBe(false); // nothing confirmed
    expect(client.count('session/delete')).toBe(0);

    actions.askDelete('a');
    expect(await actions.confirmDelete()).toBe(true);
    expect(client.last('session/delete').params).toEqual({ sessionId: 'a' });
    expect(ids(home.sessions)).toEqual(['b']);
    expect(actions.confirm).toBeUndefined();
    expect(actions.deleting).toBe(false);
  });

  it('deleting a session that is still working says its turn and background tasks stop', async () => {
    const { client, actions } = await setup();
    client.notify('session/updated', { summary: summary({ sessionId: 'a', title: 'Alpha', status: 'running', lastTurnStatus: 'inProgress' }) });
    actions.askDelete('a');
    expect(actions.confirm).toMatchObject({ message: `${DELETE_MESSAGE} ${STOP_MESSAGE}`, confirmLabel: 'Stop and delete' });
    expect(STOP_MESSAGE).toBe('It is still working: its turn and any background tasks will be stopped.');
  });

  it('archiving a working session asks first ("Stop and archive"); any other is archived without asking', async () => {
    const { client, actions, home } = await setup();
    expect(actions.askArchive('b')).toBe(true);
    await settle();
    expect(client.last('session/archive').params).toEqual({ sessionId: 'b' });
    expect(actions.confirm).toBeUndefined();

    client.notify('session/updated', { summary: summary({ sessionId: 'a', title: 'Alpha', backgroundTasks: [{ id: 't', title: 'watch', status: 'running', startedAt: 1 }] }) });
    expect(actions.askArchive('a')).toBe(false);
    expect(actions.confirm).toEqual({ kind: 'archive', sessionId: 'a', count: 1, title: 'Archive Alpha?', message: STOP_MESSAGE, confirmLabel: 'Stop and archive' });
    expect(client.count('session/archive')).toBe(1);
    expect(ids(home.sessions)).toEqual(['a']);
    actions.cancelConfirm();
    expect(client.count('session/archive')).toBe(1);

    actions.askArchive('a');
    expect(await actions.confirmDelete()).toBe(true);
    await settle();
    expect(client.last('session/archive').params).toEqual({ sessionId: 'a' });
    expect(client.count('session/delete')).toBe(0);
    expect(ids(home.sessions)).toEqual([]);
    expect(actions.confirm).toBeUndefined();
    expect(actions.undo).toEqual({ sessionId: 'a', text: 'Archived Alpha' });
  });

  it('isWorking: a turn running or waiting, or a background task running (not while the agent stopped)', () => {
    const task = { id: 't', title: 'watch', status: 'running' as const, startedAt: 1 };
    expect(isWorking(summary({ status: 'running' }))).toBe(true);
    expect(isWorking(summary({ status: 'waiting_approval' }))).toBe(true);
    expect(isWorking(summary({ status: 'waiting_input' }))).toBe(true);
    expect(isWorking(summary({ status: 'idle', lastTurnStatus: 'inProgress' }))).toBe(true);
    expect(isWorking(summary({ backgroundTasks: [task] }))).toBe(true);
    expect(isWorking(summary({ backgroundTasks: [{ ...task, status: 'finished' }] }))).toBe(false);
    expect(isWorking(summary({ status: 'error', backgroundTasks: [task] }))).toBe(false);
    expect(isWorking(summary())).toBe(false);
  });

  it('Delete all archived states the count and deletes each archived session', async () => {
    const { home, actions, client } = await setup();
    actions.askDeleteArchived();
    expect(actions.confirm).toMatchObject({ kind: 'archived', count: 2, title: 'Delete 2 archived sessions?', message: DELETE_ALL_MESSAGE, confirmLabel: 'Delete 2' });
    expect(deleteAllTitle(1)).toBe('Delete 1 archived session?');
    expect(client.count('session/delete')).toBe(0);
    expect(await actions.confirmDelete()).toBe(true);
    expect(client.calls.filter((c) => c.method === 'session/delete').map((c) => c.params.sessionId)).toEqual(['old1', 'old2']);
    expect(home.archivedCount).toBe(0);
    expect(ids(home.sessions)).toEqual(['a', 'b']);
    actions.askDeleteArchived(); // none left: nothing to ask
    expect(actions.confirm).toBeUndefined();
  });

  it('a delete the host refuses puts the rows back and names what failed', async () => {
    const { home, actions } = await setup({ refuse: 'session/delete' });
    actions.askDelete('a');
    expect(await actions.confirmDelete()).toBe(false);
    expect(ids(home.sessions)).toEqual(['a', 'b']);
    expect(actions.error).toBe('Could not delete Alpha: internal');
    actions.askDeleteArchived();
    expect(await actions.confirmDelete()).toBe(false);
    expect(actions.error).toBe('Could not delete 2 sessions: internal');
    expect(home.archivedCount).toBe(2);
  });

  it('deleting the session whose Undo shows takes the toast away; one delete at a time', async () => {
    const { actions, client } = await setup();
    await actions.archive('a');
    client.unrule('session/delete');
    actions.askDelete('a');
    const done = actions.confirmDelete();
    expect(actions.deleting).toBe(true);
    expect(await actions.confirmDelete()).toBe(false); // ignored while one runs
    client.last('session/delete').resolve({ ok: true });
    expect(await done).toBe(true);
    expect(actions.undo).toBeUndefined();
  });

  it('a title the list does not have comes from the opened session, else "Untitled session"', async () => {
    const { actions } = await setup();
    const replica = {
      sessions: [],
      archivedSessions: [],
      archiveSession: async () => undefined,
      unarchiveSession: async () => undefined,
      deleteSession: async () => undefined,
      session: (id: string) => (id === 'known' ? { session: { title: 'Opened title' } } : undefined),
    };
    const own = new SessionActions({ replica });
    own.askDelete('known');
    expect(own.confirm?.title).toBe('Delete Opened title?');
    own.askDelete('unknown');
    expect(own.confirm?.title).toBe('Delete Untitled session?');
    await own.archive('known'); // default timers
    expect(own.undo?.text).toBe('Archived Opened title');
    vi.advanceTimersByTime(UNDO_MS);
    expect(own.undo).toBeUndefined();
    own.dismissUndo(); // nothing showing
    own.dispose();
    actions.dispose();
  });

  it('swipe reveals one row at a time; a long-press opens the actions sheet for its row', async () => {
    const { home, actions } = await setup();
    const changes = vi.fn();
    home.subscribe(changes);
    home.reveal('a');
    home.reveal('a'); // no change
    expect(home.revealedId).toBe('a');
    home.reveal('b');
    expect(home.revealedId).toBe('b');
    home.conceal();
    home.conceal();
    expect(home.revealedId).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(3);

    home.reveal('a');
    home.openMenu('old1');
    expect(home.revealedId).toBeUndefined();
    expect(home.menuRow).toMatchObject({ sessionId: 'old1', title: 'Old one' });
    home.closeMenu();
    home.closeMenu();
    expect(home.menuRow).toBeUndefined();
    home.openMenu('a');
    await actions.archive('a');
    expect(home.menuRow?.sessionId).toBe('a'); // still listed, now under Archived
    home.openMenu('gone');
    expect(home.menuRow).toBeUndefined();
    home.dispose();
  });
});
