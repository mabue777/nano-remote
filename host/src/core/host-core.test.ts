// The core's method handlers through the real stream server: discovery, folders, session lifecycle,
// catch-up, requests, and the error codes of protocol-v1 section 10.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Journal } from '../journal/journal.js';
import type { JournalEvent } from '../journal/types.js';
import type { TestClient } from '../stream/testing/client.js';
import { FAKE_APPROVAL_MODES, FakeAgent } from './testing/fake-adapter.js';
import { eventsOf, rpc, rpcError, startHarness, text, waitEvent, type Harness, type HarnessOptions } from './testing/harness.js';
import { readDirectory } from './host-core.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness(options);
  return harness;
}

async function newSession(h: Harness, client: TestClient, extra: Record<string, unknown> = {}): Promise<string> {
  const { session } = await rpc<{ session: { sessionId: string } }>(client, 'session/start', {
    agentId: 'fake',
    cwd: h.cwd,
    ...extra,
  });
  return session.sessionId;
}

describe('discovery', () => {
  it('host/status, agent/list and model/list', async () => {
    const down = new FakeAgent({ id: 'kimi', name: 'Kimi', state: { status: 'unavailable', reason: 'CLI not found' } });
    const h = await setup({ extraAgents: [down] });
    const phone = await h.connect();
    const status = await rpc<Record<string, unknown>>(phone, 'host/status');
    expect(status).toEqual({
      host: expect.objectContaining({ hostId: 'host_test' }),
      agents: [
        { id: 'fake', name: 'Fake Agent', status: 'ready', version: '0.0.0', capabilities: { steer: true, diff: true, approvalModes: [...FAKE_APPROVAL_MODES], attachments: { images: true, files: true }, backgroundTasks: false, settingsUpdate: ['model', 'effort'] } },
        { id: 'kimi', name: 'Kimi', status: 'unavailable', reason: 'CLI not found', capabilities: { steer: true, diff: true, approvalModes: [...FAKE_APPROVAL_MODES], attachments: { images: true, files: true }, backgroundTasks: false, settingsUpdate: ['model', 'effort'] } },
      ],
      sessionsActive: 0,
      uptimeSeconds: 42,
    });
    expect(await rpc(phone, 'agent/list')).toEqual({ agents: status.agents });
    expect(await rpc(phone, 'model/list', { agentId: 'fake' })).toEqual({
      models: [{ id: 'fake-1', displayName: 'Fake 1', default: true }],
    });
    expect(await rpcError(phone, 'model/list', { agentId: 'nope' })).toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.agentId' },
    });
    expect(await rpcError(phone, 'model/list', {})).toMatchObject({ code: 'invalid_params', data: { path: 'params.agentId' } });
  });

  it('model/list answers agent_unavailable when the agent cannot list models', async () => {
    const broken = new FakeAgent({ id: 'broken' });
    broken.models = () => {
      throw new Error('engine down');
    };
    const asyncBroken = new FakeAgent({ id: 'broken2' });
    (asyncBroken as { models: () => unknown }).models = () => Promise.reject('nope');
    const h = await setup({ extraAgents: [broken, asyncBroken] });
    const phone = await h.connect();
    expect(await rpcError(phone, 'model/list', { agentId: 'broken' })).toMatchObject({
      code: 'agent_unavailable',
      data: { agentId: 'broken', reason: 'engine down' },
    });
    expect(await rpcError(phone, 'model/list', { agentId: 'broken2' })).toMatchObject({ data: { reason: 'nope' } });
  });

  it('broadcasts host/status/changed when an agent changes state, and stops after close', async () => {
    const h = await setup();
    const phone = await h.connect();
    h.agent.setState({ status: 'unavailable', reason: 'updating' });
    const changed = await phone.until(() => phone.messages.find((m) => m.method === 'host/status/changed'));
    expect((changed.params as { agents: unknown[] }).agents).toEqual([
      { id: 'fake', name: 'Fake Agent', status: 'unavailable', reason: 'updating', capabilities: { steer: true, diff: true, approvalModes: [...FAKE_APPROVAL_MODES], attachments: { images: true, files: true }, backgroundTasks: false, settingsUpdate: ['model', 'effort'] } },
    ]);
    await h.core.close();
    const before = phone.messages.length;
    h.agent.setState({ status: 'ready' });
    expect(phone.messages.length).toBe(before);
  });
});

describe('folders', () => {
  it('fs/readDirectory lists folders first, follows symlinks and skips broken ones', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-fs-'));
    mkdirSync(path.join(dir, 'b-dir'));
    writeFileSync(path.join(dir, 'a-file.txt'), 'x');
    symlinkSync(path.join(dir, 'b-dir'), path.join(dir, 'c-link-dir'));
    symlinkSync(path.join(dir, 'a-file.txt'), path.join(dir, 'd-link-file'));
    symlinkSync(path.join(dir, 'missing'), path.join(dir, 'e-broken'));
    const h = await setup();
    const phone = await h.connect();
    expect(await rpc(phone, 'fs/readDirectory', { path: dir })).toEqual({
      entries: [
        { name: 'b-dir', kind: 'dir', path: path.join(dir, 'b-dir') },
        { name: 'c-link-dir', kind: 'dir', path: path.join(dir, 'c-link-dir') },
        { name: 'a-file.txt', kind: 'file', path: path.join(dir, 'a-file.txt') },
        { name: 'd-link-file', kind: 'file', path: path.join(dir, 'd-link-file') },
      ],
    });
    expect(await rpcError(phone, 'fs/readDirectory', { path: path.join(dir, 'missing') })).toMatchObject({ code: 'not_found' });
    expect(await rpcError(phone, 'fs/readDirectory', { path: path.join(dir, 'a-file.txt') })).toMatchObject({ code: 'not_found' });
    expect(await rpcError(phone, 'fs/readDirectory', { path: 'relative/dir' })).toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.path' },
    });
  });

  it('expands ~ to the home folder and reports other read errors as internal', async () => {
    const home = await readDirectory('~');
    expect(home.every((e) => e.path.startsWith(homedir()))).toBe(true);
    await expect(readDirectory('/\0bad')).rejects.toThrow();
  });

  it('project/list groups visible sessions by working folder, most recent first', async () => {
    let clock = 1000;
    const h = await setup({ journal: new Journal({ path: ':memory:', now: () => clock }), core: { now: () => clock } });
    const phone = await h.connect();
    const other = mkdtempSync(path.join(tmpdir(), 'nano-proj-'));
    await newSession(h, phone);
    clock = 2000;
    await newSession(h, phone, { cwd: other });
    clock = 3000;
    await newSession(h, phone);
    clock = 4000;
    const hidden = await newSession(h, phone, { cwd: mkdtempSync(path.join(tmpdir(), 'nano-hidden-')) });
    await rpc(phone, 'session/delete', { sessionId: hidden });
    expect(await rpc(phone, 'project/list')).toEqual({
      projects: [
        { path: h.cwd, name: path.basename(h.cwd), lastUsedAt: 3000, sessions: 2 },
        { path: other, name: path.basename(other), lastUsedAt: 2000, sessions: 1 },
      ],
    });
  });
});

describe('session lifecycle', () => {
  it('session/start validates the agent, its state, the folder and the params', async () => {
    const down = new FakeAgent({ id: 'kimi', state: { status: 'unavailable' } });
    const h = await setup({ extraAgents: [down] });
    const phone = await h.connect();
    expect(await rpcError(phone, 'session/start', { agentId: 'nope', cwd: h.cwd })).toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.agentId' },
    });
    expect(await rpcError(phone, 'session/start', { agentId: 'kimi', cwd: h.cwd })).toMatchObject({
      code: 'agent_unavailable',
      data: { agentId: 'kimi', reason: 'unavailable' },
    });
    for (const cwd of ['relative', path.join(h.cwd, 'missing')]) {
      expect(await rpcError(phone, 'session/start', { agentId: 'fake', cwd })).toMatchObject({ data: { path: 'params.cwd' } });
    }
    expect(await rpcError(phone, 'session/start', { agentId: 'fake', cwd: h.cwd, title: 5 })).toMatchObject({
      data: { path: 'params.title' },
    });
    expect(await rpcError(phone, 'session/start', { agentId: 'fake', cwd: h.cwd, settings: [] })).toMatchObject({
      data: { path: 'params.settings' },
    });
    expect(await rpcError(phone, 'session/start', { agentId: 'fake', cwd: h.cwd, input: [] })).toMatchObject({
      data: { path: 'params.input' },
    });
    expect(
      await rpcError(phone, 'session/start', { agentId: 'fake', cwd: h.cwd, input: [{ type: 'audio' }] }),
    ).toMatchObject({ data: { path: 'params.input.0' } });
    expect(await rpcError(phone, 'session/start', { agentId: 'fake', cwd: h.cwd, input: [7] })).toMatchObject({
      data: { path: 'params.input.0' },
    });
  });

  it('session/start keeps a given title and settings and starts the engine', async () => {
    const h = await setup();
    const phone = await h.connect();
    const { session } = await rpc<{ session: Record<string, unknown> }>(phone, 'session/start', {
      agentId: 'fake',
      cwd: h.cwd,
      title: 'My title',
      settings: { model: 'fake-1' },
      input: [
        { type: 'mention', name: 'a', path: '/a' },
        { type: 'image', url: 'data:image/png;base64,' },
      ],
    });
    expect(session).toMatchObject({ title: 'My title', settings: { model: 'fake-1' }, agentId: 'fake', cwd: h.cwd });
    expect(h.agent.last.calls[0]).toEqual({ method: 'start', args: [h.cwd, { model: 'fake-1' }] });
  });

  it('session/list hides archived and deleted sessions and pages with a cursor', async () => {
    let clock = 100;
    const now = () => clock++;
    const h = await setup({ journal: new Journal({ path: ':memory:', now }), core: { now } });
    const phone = await h.connect();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await newSession(h, phone));
    await rpc(phone, 'session/archive', { sessionId: ids[3] });
    await rpc(phone, 'session/delete', { sessionId: ids[2] });

    const all = await rpc<{ sessions: { sessionId: string }[] }>(phone, 'session/list');
    expect(all.sessions.map((s) => s.sessionId)).toEqual([ids[4], ids[1], ids[0]]);

    const first = await rpc<{ sessions: { sessionId: string }[]; nextCursor?: string }>(phone, 'session/list', { limit: 2 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual([ids[4], ids[1]]);
    const second = await rpc<{ sessions: { sessionId: string }[]; nextCursor?: string }>(phone, 'session/list', {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.sessions.map((s) => s.sessionId)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeUndefined();

    expect((await rpc<{ sessions: unknown[] }>(phone, 'session/list', { agentId: 'other' })).sessions).toEqual([]);
    expect(await rpcError(phone, 'session/list', { limit: 0 })).toMatchObject({ data: { path: 'params.limit' } });
    expect(await rpcError(phone, 'session/list', { cursor: 'garbage!' })).toMatchObject({ code: 'invalid_params' });
  });

  it('session/rename journals session/changed; empty titles are rejected', async () => {
    const h = await setup();
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    expect(await rpc(phone, 'session/rename', { sessionId, title: '  New name ' })).toEqual({ ok: true });
    const changed = await waitEvent(phone, 'session/changed');
    expect((changed.params as { session: { title: string } }).session.title).toBe('New name');
    expect(await rpcError(phone, 'session/rename', { sessionId, title: ' ' })).toMatchObject({ data: { path: 'params.title' } });
    expect(await rpcError(phone, 'session/rename', { sessionId: 'ses_missing', title: 'x' })).toMatchObject({
      code: 'not_found',
    });
  });

  it('session/settings/update answers with the session and journals session/changed; bad params are invalid_params', async () => {
    const h = await setup({ agent: { capabilities: { settingsUpdate: ['effort'] } } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const result = await rpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/settings/update', {
      sessionId,
      settings: { effort: 'low' },
    });
    expect(result.session).toMatchObject({ sessionId, settings: { effort: 'low' } });
    const changed = await waitEvent(phone, 'session/changed');
    expect((changed.params as { session: { settings: Record<string, unknown> } }).session.settings).toMatchObject({ effort: 'low' });
    expect(await rpcError(phone, 'session/settings/update', { sessionId, settings: { model: 'fake-1' } })).toMatchObject({
      code: 'not_supported',
      message: 'Fake Agent cannot change the model of an open session',
    });
    expect(await rpcError(phone, 'session/settings/update', { sessionId })).toMatchObject({ data: { path: 'params.settings' } });
    expect(await rpcError(phone, 'session/settings/update', { sessionId, settings: {} })).toMatchObject({ data: { path: 'params.settings' } });
    expect(await rpcError(phone, 'session/settings/update', { sessionId, settings: { effort: '' } })).toMatchObject({
      data: { path: 'params.settings.effort' },
    });
    expect(await rpcError(phone, 'session/settings/update', { sessionId, settings: [] })).toMatchObject({ data: { path: 'params.settings' } });
  });

  it('session/archive closes the session; a new turn brings it back', async () => {
    const h = await setup({ agent: { script: [[{ hold: true }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('run'), clientMessageId: randomUUID() });
    const adapter = h.agent.last;
    expect(await rpc(phone, 'session/archive', { sessionId })).toEqual({ ok: true });
    const closed = await waitEvent(phone, 'session/closed');
    expect(closed.params).toMatchObject({ reason: 'archived' });
    expect(adapter.killed).toBe(true);
    const methods = eventsOf(phone, sessionId).map((e) => e.method);
    expect(methods.slice(-3)).toEqual(['turn/completed', 'status/changed', 'session/closed']);
    expect(h.journal.summary(sessionId)?.status).toBe('closed');
    expect(await rpc(phone, 'session/archive', { sessionId })).toEqual({ ok: true }); // idempotent

    await rpc(phone, 'turn/start', { sessionId, input: text('again'), clientMessageId: randomUUID() });
    expect(h.agent.adapters).toHaveLength(2);
    expect(h.agent.last.calls[0]!.method).toBe('resume');
    const listed = await rpc<{ sessions: { sessionId: string }[] }>(phone, 'session/list');
    expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);
  });

  it('session/list archived:true lists the archived sessions; session/unarchive brings one back', async () => {
    // A ticking clock: with the wall clock (seconds) the order of the list depends on where a second ends.
    let clock = 100;
    const now = () => clock++;
    const h = await setup({ journal: new Journal({ path: ':memory:', now }), core: { now } });
    const phone = await h.connect();
    const kept = await newSession(h, phone);
    const sessionId = await newSession(h, phone);
    type Summary = { sessionId: string; archived?: boolean; status: string };
    const listUpdate = (match: (summary: Summary) => boolean) =>
      phone.until(
        () => phone.messages.find((m) => m.method === 'session/updated' && match((m.params as { summary: Summary }).summary)),
        'session/updated',
      );
    await rpc(phone, 'session/archive', { sessionId });
    const updated = await listUpdate((summary) => summary.sessionId === sessionId && summary.archived === true);
    expect((updated.params as { summary: { archived?: boolean } }).summary).toMatchObject({ sessionId, archived: true, status: 'closed' });
    type Listed = { sessions: { sessionId: string; archived?: boolean; status: string }[] };
    const archived = await rpc<Listed>(phone, 'session/list', { archived: true });
    expect(archived.sessions).toEqual([expect.objectContaining({ sessionId, archived: true })]);
    expect((await rpc<Listed>(phone, 'session/list', { archived: false })).sessions.map((s) => s.sessionId)).toEqual([kept]);
    expect(await rpcError(phone, 'session/list', { archived: 'yes' })).toMatchObject({ data: { path: 'params.archived' } });

    expect(await rpc(phone, 'session/unarchive', { sessionId })).toEqual({ ok: true });
    const back = await listUpdate((summary) => summary.sessionId === sessionId && summary.status === 'idle');
    expect((back.params as { summary: { archived?: boolean; status: string } }).summary).toMatchObject({ sessionId, status: 'idle' });
    expect((back.params as { summary: { archived?: boolean } }).summary.archived).toBeUndefined();
    const listed = await rpc<Listed>(phone, 'session/list');
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId, kept]);
    expect((await rpc<Listed>(phone, 'session/list', { archived: true })).sessions).toEqual([]);
    expect(await rpc(phone, 'session/unarchive', { sessionId })).toEqual({ ok: true }); // not archived: nothing changes
    expect(await rpcError(phone, 'session/unarchive', { sessionId: 'ses_missing' })).toMatchObject({ code: 'not_found' });
  });

  it('session/delete closes the session, drops subscriptions and then answers not_found', async () => {
    const h = await setup();
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    expect(h.core.subscribers(sessionId)).toEqual([phone.streamId]);
    expect(await rpc(phone, 'session/delete', { sessionId })).toEqual({ ok: true });
    const closed = await waitEvent(phone, 'session/closed');
    expect(closed.params).toMatchObject({ reason: 'deleted' });
    expect(h.core.subscribers(sessionId)).toEqual([]);
    for (const [method, params] of [
      ['session/open', { sessionId }],
      ['turn/start', { sessionId, input: text('x'), clientMessageId: randomUUID() }],
      ['session/delete', { sessionId }],
    ] as const) {
      expect(await rpcError(phone, method, params)).toMatchObject({ code: 'not_found', data: { sessionId } });
    }
  });

  it('session/delete of a working session sends no session/updated for it: the turn and helpers stop unseen by the list', async () => {
    const h = await setup({ agent: { capabilities: { backgroundTasks: true }, script: [[{ hold: true }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('run'), clientMessageId: randomUUID() });
    h.agent.last.emit({ method: 'background/changed', params: { tasks: [{ id: 'toolu_a', title: 'npm test', status: 'running', startedAt: 1 }] } });
    type Row = { sessionId: string; backgroundTasks?: unknown[] };
    const rowUpdates = () => phone.messages.filter((m) => m.method === 'session/updated' && (m.params as { summary: Row }).summary.sessionId === sessionId);
    await phone.until(() => rowUpdates().find((m) => (m.params as { summary: Row }).summary.backgroundTasks !== undefined), 'row with the task');
    const before = rowUpdates().length;

    expect(await rpc(phone, 'session/delete', { sessionId })).toEqual({ ok: true });
    await waitEvent(phone, 'session/closed');
    // The turn ended and the helper was cancelled (journaled to the open session) ...
    const methods = eventsOf(phone, sessionId).map((e) => e.method);
    expect(methods).toContain('turn/completed');
    const cancelled = eventsOf(phone, sessionId).filter((e) => e.method === 'session/changed').at(-1)!;
    expect((cancelled.params as { session: { backgroundTasks: { status: string }[] } }).session.backgroundTasks.map((t) => t.status)).toEqual(['cancelled']);
    // ... but the list heard nothing more about the session, so no client re-adds the deleted row.
    await rpc(phone, 'host/status');
    expect(rowUpdates().length).toBe(before);
  });

  it('session/close stops live delivery on that stream only; closing the socket unsubscribes everything', async () => {
    const h = await setup();
    const phone = await h.connect();
    const laptop = await h.connect('other-token');
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(laptop, 'session/open', { sessionId });
    await rpc(phone, 'session/open', { sessionId }); // re-open replaces the feed, no duplicates
    expect(await rpc(phone, 'session/close', { sessionId })).toEqual({ ok: true });
    expect(await rpc(phone, 'session/close', { sessionId: 'ses_never_opened' })).toEqual({ ok: true });
    await rpc(laptop, 'session/rename', { sessionId, title: 'x' });
    await waitEvent(laptop, 'session/changed');
    expect(eventsOf(phone, sessionId)).toEqual([]);

    laptop.close();
    await laptop.closed;
    await phone.until(() => h.core.subscribers(sessionId).length === 0, 'unsubscribe on socket close');
  });

  it('broadcasts session/updated summaries to every ready stream', async () => {
    const h = await setup();
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    const update = await phone.until(() =>
      phone.messages.find((m) => m.method === 'session/updated' && (m.params as { summary: { sessionId: string } }).summary.sessionId === sessionId),
    );
    expect((update.params as { summary: Record<string, unknown> }).summary).toMatchObject({ sessionId, agentId: 'fake' });
  });
});

describe('catch-up', () => {
  async function sessionWithTurns(h: Harness, phone: TestClient, turns: number): Promise<string> {
    const sessionId = await newSession(h, phone);
    for (let i = 0; i < turns; i++) {
      await rpc(phone, 'turn/start', { sessionId, input: text(`turn ${i}`), clientMessageId: randomUUID() });
    }
    return sessionId;
  }

  it('events/since pages the Journal and reports cursor_expired', async () => {
    const h = await setup();
    const phone = await h.connect();
    const sessionId = await sessionWithTurns(h, phone, 2);
    const head = h.journal.head(sessionId);
    const page = await rpc<{ events: JournalEvent[]; cursor: number; complete: boolean }>(phone, 'events/since', {
      sessionId,
      cursor: 0,
      limit: 3,
    });
    expect(page.events.map((e) => e.params.seq)).toEqual([1, 2, 3]);
    expect(page).toMatchObject({ cursor: 3, complete: false });
    const rest = await rpc<{ events: JournalEvent[]; cursor: number; complete: boolean }>(phone, 'events/since', {
      sessionId,
      cursor: 3,
    });
    expect(rest).toMatchObject({ cursor: head, complete: true });

    h.journal.compactForTesting(sessionId, 4);
    expect(await rpcError(phone, 'events/since', { sessionId, cursor: 1 })).toMatchObject({ code: 'cursor_expired' });
    expect(await rpcError(phone, 'events/since', { sessionId })).toMatchObject({ data: { path: 'params.cursor' } });
    expect(await rpcError(phone, 'events/since', { sessionId, cursor: -1 })).toMatchObject({ data: { path: 'params.cursor' } });
    expect(await rpcError(phone, 'events/since', { sessionId, cursor: 0, includeOptedOut: 'yes' })).toMatchObject({
      data: { path: 'params.includeOptedOut' },
    });
    expect(await rpcError(phone, 'events/since', { sessionId: 'ses_missing', cursor: 0 })).toMatchObject({ code: 'not_found' });
  });

  it('honours optOutNotifications in live delivery, session/open and events/since', async () => {
    const h = await setup({ agent: { script: [[{ reply: 'abcdef', chunks: 3 }], [{ reply: 'more', chunks: 2 }]] } });
    const phone = await h.connect('good-token', { optOutNotifications: ['item/delta'] });
    const sessionId = await newSession(h, phone);
    const opened = await rpc<{ cursor: number }>(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('x'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'turn/completed');
    expect(eventsOf(phone, sessionId).some((e) => e.method === 'item/delta')).toBe(false);

    const since = await rpc<{ events: JournalEvent[] }>(phone, 'events/since', { sessionId, cursor: opened.cursor });
    expect(since.events.some((e) => e.method === 'item/delta')).toBe(false);
    const all = await rpc<{ events: JournalEvent[] }>(phone, 'events/since', {
      sessionId,
      cursor: opened.cursor,
      includeOptedOut: true,
    });
    expect(all.events.filter((e) => e.method === 'item/delta')).toHaveLength(3);

    const reopened = await rpc<{ mode: string; events: JournalEvent[] }>(phone, 'session/open', { sessionId, cursor: opened.cursor });
    expect(reopened.mode).toBe('events');
    expect(reopened.events.some((e) => e.method === 'item/delta')).toBe(false);
  });

  it('session/open falls back to a snapshot when the gap is longer than one page', async () => {
    const h = await setup({ agent: { script: () => [{ reply: 'x'.repeat(5001), chunks: 5001 }] } });
    const phone = await h.connect();
    const sessionId = await sessionWithTurns(h, phone, 1);
    expect(h.journal.head(sessionId)).toBeGreaterThan(5000);
    const opened = await rpc<{ mode: string }>(phone, 'session/open', { sessionId, cursor: 0 });
    expect(opened.mode).toBe('snapshot');
  });

  it('session/history pages older turns newest first', async () => {
    const h = await setup();
    const phone = await h.connect();
    const sessionId = await sessionWithTurns(h, phone, 3);
    const snapshot = await rpc<{ olderCursor?: string; turns: unknown[] }>(phone, 'session/open', { sessionId, turns: 1 });
    expect(snapshot.turns).toHaveLength(1);
    const older = await rpc<{ turns: { items: { type: string; content?: unknown }[] }[]; olderCursor?: string }>(
      phone,
      'session/history',
      { sessionId, before: snapshot.olderCursor, limit: 1 },
    );
    expect(older.turns).toHaveLength(1);
    expect(older.turns[0]!.items[0]).toMatchObject({ type: 'userMessage', content: text('turn 1') });
    expect(older.olderCursor).toBeDefined();
    expect(await rpcError(phone, 'session/history', { sessionId, before: 'bogus' })).toMatchObject({ code: 'invalid_params' });
    expect(await rpcError(phone, 'session/history', { sessionId, before: 'turn:1', limit: 0 })).toMatchObject({
      data: { path: 'params.limit' },
    });
    expect(await rpcError(phone, 'session/history', { sessionId: 'ses_x', before: 'turn:1' })).toMatchObject({ code: 'not_found' });
  });
});

describe('turns and requests', () => {
  it('turn/start with a repeated clientMessageId returns the existing turn', async () => {
    const h = await setup({ agent: { script: [[{ hold: true }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    const clientMessageId = randomUUID();
    const first = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('a'), clientMessageId });
    const again = await rpc<{ turn: { turnId: string; items: string[] } }>(phone, 'turn/start', {
      sessionId,
      input: text('a'),
      clientMessageId,
    });
    expect(again.turn.turnId).toBe(first.turn.turnId);
    expect(again.turn.items).toHaveLength(1);
    const steerAgain = await rpc<{ turn: { turnId: string } }>(phone, 'turn/steer', {
      sessionId,
      turnId: 'trn_whatever',
      input: text('a'),
      clientMessageId,
    });
    expect(steerAgain.turn.turnId).toBe(first.turn.turnId);
    expect(h.agent.last.calls.filter((c) => c.method === 'turnStart')).toHaveLength(1);
    expect(await rpcError(phone, 'turn/start', { sessionId, input: text('a') })).toMatchObject({
      data: { path: 'params.clientMessageId' },
    });
  });

  it('turn/steer answers not_supported for adapters that cannot steer, turn_mismatch when idle', async () => {
    const h = await setup({ agent: { script: [[{ hold: true }]], capabilities: { steer: false } } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    const idle = await rpcError(phone, 'turn/steer', { sessionId, turnId: 'trn_x', input: text('a'), clientMessageId: randomUUID() });
    expect(idle).toMatchObject({ code: 'turn_mismatch', data: { turnId: null } });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('a'),
      clientMessageId: randomUUID(),
    });
    const unsupported = await rpcError(phone, 'turn/steer', {
      sessionId,
      turnId: turn.turnId,
      input: text('b'),
      clientMessageId: randomUUID(),
    });
    expect(unsupported).toMatchObject({ code: 'not_supported', data: { agentId: 'fake' } });
  });

  it('turn/interrupt answers not_found for an unknown turn', async () => {
    const h = await setup();
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    expect(await rpcError(phone, 'turn/interrupt', { sessionId, turnId: 'trn_nope' })).toMatchObject({ code: 'not_found' });
  });

  it('turn/diff answers not_supported without the capability, not_found for an unknown turn, not_a_repository outside git', async () => {
    const h = await setup({ agent: { capabilities: { diff: false } } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('a'),
      clientMessageId: randomUUID(),
    });
    expect(await rpcError(phone, 'turn/diff', { sessionId, turnId: turn.turnId })).toMatchObject({ code: 'not_supported' });
    expect(await rpcError(phone, 'turn/diff', { sessionId, turnId: 'trn_nope' })).toMatchObject({ code: 'not_found' });

    const withDiff = await setup();
    const client = await withDiff.connect();
    const sid = await newSession(withDiff, client);
    const started = await rpc<{ turn: { turnId: string } }>(client, 'turn/start', {
      sessionId: sid,
      input: text('a'),
      clientMessageId: randomUUID(),
    });
    expect(await rpcError(client, 'turn/diff', { sessionId: sid, turnId: started.turn.turnId })).toEqual({
      code: 'not_a_repository',
      message: 'Changes need a git repository in the session folder.',
      data: { cwd: withDiff.cwd },
    });
    await h.close();
  });

  it('input/request, input/answer, and the request errors', async () => {
    const h = await setup({
      agent: { script: [[{ input: {} }, { approval: { availableDecisions: ['accept', 'cancel'] } }, { reply: 'blue it is' }]] },
    });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('ask me'), clientMessageId: randomUUID() });
    const asked = await waitEvent(phone, 'input/request');
    const inputId = (asked.params as { request: { requestId: string } }).request.requestId;
    await waitEvent(phone, 'status/changed', (p) => p.status === 'waiting_input');

    expect(await rpcError(phone, 'approval/resolve', { sessionId, requestId: inputId, decision: 'accept' })).toMatchObject({
      code: 'not_found',
    });
    expect(await rpcError(phone, 'input/answer', { sessionId, requestId: inputId, answers: { q1: [1] } })).toMatchObject({
      data: { path: 'params.answers.q1' },
    });
    expect(await rpcError(phone, 'input/answer', { sessionId, requestId: inputId, answers: [] })).toMatchObject({
      data: { path: 'params.answers' },
    });
    expect(await rpc(phone, 'input/answer', { sessionId, requestId: inputId, answers: { q1: ['blue'] } })).toEqual({ ok: true });
    const resolved = await waitEvent(phone, 'request/resolved');
    expect(resolved.params).toMatchObject({ requestId: inputId, kind: 'input', resolvedBy: 'dev_test', answers: { q1: ['blue'] } });
    expect(h.agent.last.resolutions.get(inputId)).toEqual({ q1: ['blue'] });
    expect(await rpcError(phone, 'input/answer', { sessionId, requestId: inputId, answers: {} })).toMatchObject({
      code: 'already_resolved',
      data: { resolvedBy: 'dev_test' },
    });

    const approval = await waitEvent(phone, 'approval/request');
    const approvalId = (approval.params as { request: { requestId: string } }).request.requestId;
    expect(await rpcError(phone, 'input/answer', { sessionId, requestId: approvalId, answers: {} })).toMatchObject({
      code: 'not_found',
    });
    expect(await rpcError(phone, 'approval/resolve', { sessionId, requestId: approvalId, decision: 'decline' })).toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.decision' },
    });
    expect(await rpcError(phone, 'approval/resolve', { sessionId, requestId: approvalId, decision: 'maybe' })).toMatchObject({
      data: { path: 'params.decision' },
    });
    expect(await rpcError(phone, 'approval/resolve', { sessionId, requestId: 'req_unknown', decision: 'accept' })).toMatchObject({
      code: 'not_found',
    });
    // An already-resolved input id asked as an approval stays not_found (different family).
    expect(await rpcError(phone, 'approval/resolve', { sessionId, requestId: inputId, decision: 'accept' })).toMatchObject({
      code: 'not_found',
    });
    await rpc(phone, 'approval/resolve', { sessionId, requestId: approvalId, decision: 'cancel' });
    const done = await waitEvent(phone, 'turn/completed');
    expect((done.params as { turn: { status: string } }).turn.status).toBe('interrupted');
  });

  it('counts running sessions in host/status', async () => {
    const h = await setup({ agent: { script: [[{ hold: true }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'turn/start', { sessionId, input: text('a'), clientMessageId: randomUUID() });
    expect((await rpc<{ sessionsActive: number }>(phone, 'host/status')).sessionsActive).toBe(1);
    h.agent.last.release();
    expect((await rpc<{ sessionsActive: number }>(phone, 'host/status')).sessionsActive).toBe(0);
  });
});

describe('restart recovery', () => {
  it('runs once the core is built: its events reach the observer and the session/updated path, no observer error', async () => {
    const { SessionStore } = await import('./store.js');
    const { HOST } = await import('./testing/harness.js');
    const { HostCore } = await import('./host-core.js');
    const { DeviceStore } = await import('../devices/store.js');
    const { PresenceRegistry } = await import('../stream/presence.js');
    const { PushNotifier } = await import('../push/notifier.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-core-recover-'));
    const file = path.join(dir, 'journal.sqlite');
    const store = new SessionStore(file);

    // A host that died while a turn waited on an approval and a background task was running.
    const first = new Journal({ path: file });
    const before = new HostCore({ journal: first, agents: [new FakeAgent({ script: [[{ approval: {} }]] })], host: HOST, store });
    const { session } = await before.sessions.start({ agentId: 'fake', cwd: dir, title: 'Fix the parser' });
    const sessionId = session.sessionId;
    const turn = await before.sessions.turnStart(sessionId, text('a'), randomUUID());
    first.append(sessionId, {
      method: 'session/changed',
      params: {
        session: {
          ...first.session(sessionId)!,
          backgroundTasks: [{ id: 'toolu_a', title: 'npm test', status: 'running', startedAt: 1 }],
          lastSeq: first.head(sessionId) + 1,
        },
      },
    });
    expect(first.summary(sessionId)?.status).toBe('waiting_approval');
    first.close(); // no close(): a crash leaves the turn running

    const journal = new Journal({ path: file });
    const head = journal.head(sessionId);
    const devices = new DeviceStore({ path: ':memory:' });
    const { device } = devices.create({ displayName: 'phone', platform: 'ios-web' });
    devices.push.subscribe(device.clientId, { endpoint: 'https://web.push.apple.com/phone', keys: { p256dh: 'k', auth: 'a' } });
    const sent: { clientId: string; body: string; topic: string | undefined }[] = [];
    let core: InstanceType<typeof HostCore> | undefined;
    const notifier = new PushNotifier({
      subscriptions: devices.push,
      presence: new PresenceRegistry(),
      sender: {
        send: (clientId, _subscription, payload, options = {}) => {
          sent.push({ clientId, body: payload.body, topic: options.topic });
          return Promise.resolve({ outcome: 'delivered', status: 201 });
        },
      },
      title: (id) => core!.sessions.summary(id)?.title,
    });
    const observed: JournalEvent[] = [];
    const logged: string[] = [];
    core = new HostCore({
      journal,
      agents: [new FakeAgent()],
      host: HOST,
      store,
      log: (message) => logged.push(message),
      onJournalEvent: (event) => {
        observed.push(event);
        notifier.handle(event);
      },
    });
    await notifier.idle();

    // Every recovery event went through the observer, in Journal order.
    const recovered = journal.since(sessionId, head).events;
    expect(recovered.map((e) => e.method)).toEqual(['session/changed', 'request/resolved', 'turn/completed', 'status/changed']);
    expect(observed).toEqual(recovered);
    expect(journal.turn(sessionId, turn.turnId)).toMatchObject({ status: 'failed', error: { code: 'host_restarted' } });
    const cancelled = recovered[0]!.params as { session: { backgroundTasks: { status: string }[] } };
    expect(cancelled.session.backgroundTasks.map((t) => t.status)).toEqual(['cancelled']);
    // Push: the failed turn is announced; the restart-cancelled task is not "Background tasks finished".
    expect(sent).toEqual([{ clientId: device.clientId, body: 'Turn failed', topic: turn.turnId }]);
    // No observer (or session/updated) failure was logged: the core was whole when recovery ran.
    expect(logged).toEqual([]);

    await notifier.close();
    await core.close();
    journal.close();
    devices.close();
    store.close();
  });
});

describe('HostCore without a stream server', () => {
  function context(streamId = 'stream-1') {
    const closers: (() => void)[] = [];
    const after: (() => void)[] = [];
    return {
      ctx: {
        clientId: 'dev_x',
        streamId,
        onClose: (fn: () => void) => closers.push(fn),
        afterResponse: (fn: () => void) => after.push(fn),
        isOptedOut: () => false,
      },
      runAfter: () => after.splice(0).forEach((fn) => fn()),
      close: () => closers.splice(0).forEach((fn) => fn()),
    };
  }

  it('works before attach, with an explicit store and agents without state events', async () => {
    const { MethodRegistry } = await import('../stream/router.js');
    const { SessionStore } = await import('./store.js');
    const { HOST } = await import('./testing/harness.js');
    const journal = new Journal({ path: ':memory:' });
    const quiet = new FakeAgent({ id: 'quiet' });
    (quiet as { onStateChange?: unknown }).onStateChange = undefined;
    const store = new SessionStore();
    const { HostCore } = await import('./host-core.js');
    const core = new HostCore({ journal, agents: [quiet], host: HOST, store });
    const registry = core.register(new MethodRegistry());
    const a = context();
    const { session } = (await registry.dispatch('session/start', { agentId: 'quiet', cwd: tmpdir() }, a.ctx)) as {
      session: { sessionId: string };
    };
    expect(store.get(session.sessionId).engineSessionId).toMatch(/^eng_fake_/);
    await registry.dispatch('session/open', { sessionId: session.sessionId }, a.ctx);
    a.runAfter();
    expect(core.subscribers(session.sessionId)).toEqual(['stream-1']);
    // Live events go nowhere without a server, and nothing throws.
    await registry.dispatch('session/rename', { sessionId: session.sessionId, title: 'x' }, a.ctx);
    core.notifyHostStatusChanged();

    // A stream that closed before its open response went out never gets a feed.
    const b = context('stream-2');
    b.ctx.onClose = (fn) => {
      fn();
      return 0;
    };
    await registry.dispatch('session/open', { sessionId: session.sessionId }, b.ctx);
    b.runAfter();
    expect(core.subscribers(session.sessionId)).toEqual(['stream-1']);

    expect(await registry.dispatch('session/close', { sessionId: session.sessionId }, context('stream-3').ctx)).toEqual({ ok: true });
    a.close();
    expect(core.subscribers(session.sessionId)).toEqual([]);
    expect(await readDirectory('~/')).toEqual(await readDirectory(homedir()));
    await core.close();
    journal.close();
  });
});
