// SessionManager without a stream: engine failures, late engine ids, recovery after a host restart, and
// the adapter events the end-to-end tests do not reach.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Readable } from 'node:stream';

import { AttachmentStore, blobUrl } from '../attachments/store.js';
import { Journal } from '../journal/journal.js';
import type { JournalEvent } from '../journal/types.js';
import type { Adapter } from './adapter.js';
import { newId } from './ids.js';
import { DEFAULT_TITLE, SessionManager, TITLE_MAX, titleFrom } from './session-manager.js';
import { SessionStore } from './store.js';
import { FAKE_APPROVAL_MODES, FakeAdapter, FakeAgent, echoScript, scripted, type FakeAgentOptions } from './testing/fake-adapter.js';
import { makeRepo } from './testing/git-repo.js';

const cwd = mkdtempSync(path.join(tmpdir(), 'nano-sm-'));
const text = (value: string) => [{ type: 'text' as const, text: value }];
let n = 0;
const cmid = () => `cm-${++n}`;

const open: { journal: Journal; manager: SessionManager }[] = [];

afterEach(async () => {
  for (const { journal, manager } of open.splice(0)) {
    await manager.close();
    journal.close();
  }
});

function make(
  options: FakeAgentOptions = {},
  extra: { journal?: Journal; store?: SessionStore; log?: (m: string, e?: unknown) => void; attachments?: AttachmentStore } = {},
) {
  const journal = extra.journal ?? new Journal({ path: ':memory:' });
  const agent = new FakeAgent(options);
  const events: JournalEvent[] = [];
  const log = extra.log ?? vi.fn();
  const manager = new SessionManager({
    journal,
    agents: [agent],
    ...(extra.store ? { store: extra.store } : {}),
    ...(extra.attachments ? { attachments: extra.attachments } : {}),
    onEvent: (event) => events.push(event),
    log,
  });
  open.push({ journal, manager });
  return { journal, agent, manager, events, log };
}

function methods(events: JournalEvent[]): string[] {
  return events.map((e) => e.method);
}

describe('titleFrom', () => {
  it('joins text parts, collapses whitespace and cuts long input', () => {
    expect(titleFrom([{ type: 'text', text: '  Fix\n the   bug ' }, { type: 'mention', name: 'a', path: '/a' }])).toBe('Fix the bug');
    expect(titleFrom([{ type: 'image', url: 'x' }])).toBe(DEFAULT_TITLE);
    const long = titleFrom(text('word '.repeat(40)));
    expect(long.length).toBe(TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('newId is prefixed and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId('ses')));
    expect(ids.size).toBe(100);
    expect([...ids].every((id) => /^ses_[0-9a-z]{9}[0-9a-f]{16}$/.test(id))).toBe(true);
  });
});

describe('engine lifecycle', () => {
  it('learns a late engine session id and resumes with it after the engine dies', async () => {
    const { manager, agent, journal } = make({
      adapter: { engineSessionId: '' },
      script: scripted([[{ reply: 'one' }], [{ exit: 'segfault' }], [{ reply: 'three' }]]),
    });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    const sessionId = session.sessionId;
    expect(manager.store.get(sessionId).engineSessionId).toBe('');
    await manager.turnStart(sessionId, text('one'), cmid());
    const engineId = manager.store.get(sessionId).engineSessionId;
    expect(engineId).toMatch(/^eng_fake_/);

    const crashed = await manager.turnStart(sessionId, text('two'), cmid());
    expect(crashed.turnId).toBeDefined();
    const failed = journal.turn(sessionId, crashed.turnId)!;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'agent_exited', message: 'segfault' } });
    expect(journal.summary(sessionId)?.status).toBe('error');

    await manager.turnStart(sessionId, text('three'), cmid());
    expect(agent.adapters).toHaveLength(2);
    expect(agent.last.calls[0]).toEqual({ method: 'resume', args: [engineId, cwd, {}] });
    expect(journal.summary(sessionId)).toMatchObject({ status: 'idle', lastTurnStatus: 'completed' });
  });

  it('a failed engine start leaves the session in error and answers agent_unavailable', async () => {
    const { manager, agent, journal } = make({ adapter: { failOn: { start: 'no binary' } } });
    await expect(manager.start({ agentId: 'fake', cwd })).rejects.toMatchObject({
      code: 'agent_unavailable',
      data: { agentId: 'fake', reason: 'no binary' },
    });
    const [summary] = journal.list().sessions;
    expect(summary?.status).toBe('error');
    expect(agent.last.calls.map((c) => c.method)).toEqual(['start', 'kill']);

    // The next turn boots a fresh adapter; with input in session/start the failure fails the turn.
    agent.adapterOptions = {};
    const turn = await manager.turnStart(summary!.sessionId, text('retry'), cmid());
    expect(turn.status).toBe('completed');
    agent.adapterOptions = { failOn: { start: 'still broken' } };
    await expect(manager.start({ agentId: 'fake', cwd, input: text('hi') })).rejects.toMatchObject({ code: 'agent_unavailable' });
    const newest = journal.list().sessions[0]!;
    expect(newest.lastTurnStatus).toBe('failed');
    expect(newest.status).toBe('idle');
  });

  it('turnStart failure fails the turn; agent going unavailable answers agent_unavailable', async () => {
    const { manager, agent, journal } = make({ adapter: { failOn: { turnStart: 'pipe closed' } } });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    await expect(manager.turnStart(session.sessionId, text('a'), cmid())).rejects.toMatchObject({
      code: 'agent_unavailable',
      data: { reason: 'pipe closed' },
    });
    expect(journal.summary(session.sessionId)).toMatchObject({ status: 'idle', lastTurnStatus: 'failed' });

    const other = (await manager.start({ agentId: 'fake', cwd })).session.sessionId;
    await manager.close(); // drops every adapter: the next turn must boot one
    agent.setState({ status: 'unavailable', reason: 'logged out' });
    await expect(manager.turnStart(other, text('a'), cmid())).rejects.toMatchObject({
      code: 'agent_unavailable',
      data: { agentId: 'fake', reason: 'logged out' },
    });
  });

  it('a session of an agent the host no longer has answers agent_unavailable', async () => {
    const first = make();
    const { session } = await first.manager.start({ agentId: 'fake', cwd });
    const manager = new SessionManager({ journal: first.journal, agents: [] });
    await expect(manager.turnStart(session.sessionId, text('a'), cmid())).rejects.toMatchObject({
      code: 'agent_unavailable',
      data: { agentId: 'fake' },
    });
  });

  it('steer and interrupt report engine failures', async () => {
    const { manager, journal, log } = make({
      script: [[{ hold: true }]],
      adapter: { failOn: { steer: 'steer broke', interrupt: 'interrupt broke' } },
    });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    const sessionId = session.sessionId;
    const turn = await manager.turnStart(sessionId, text('a'), cmid());
    await expect(manager.steer(sessionId, turn.turnId, text('b'), cmid())).rejects.toMatchObject({
      code: 'agent_unavailable',
      data: { reason: 'steer broke' },
    });
    await manager.interrupt(sessionId, turn.turnId);
    expect(journal.turn(sessionId, turn.turnId)?.status).toBe('interrupted');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('interrupt failed'), expect.any(Error));
  });

  it('resolutions the engine rejects are logged; the Journal keeps the first resolution', async () => {
    const { manager, journal, log } = make({
      script: [[{ approval: {} }, { input: {} }]],
      adapter: { failOn: { resolveApproval: 'gone', answerInput: 'gone too' } },
    });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    const sessionId = session.sessionId;
    await manager.turnStart(sessionId, text('a'), cmid());
    const approval = journal.pending(sessionId).approvals[0]!;
    await manager.resolveApproval(sessionId, approval.requestId, 'accept', 'dev_a');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('resolveApproval failed'), expect.any(Error));
    expect(journal.pending(sessionId).approvals).toEqual([]);
  });

  it('kill failures are logged and do not block archive', async () => {
    const { manager, log } = make({ adapter: { failOn: { kill: 'zombie' } } });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    await manager.archive(session.sessionId);
    expect(log).toHaveBeenCalledWith('adapter kill failed', expect.any(Error));
  });

  it('steer racing a turn that ends, or an engine that fails to boot, gets turn_mismatch or agent_unavailable', async () => {
    const { manager } = make({ script: [[]] });
    const sessionId = (await manager.start({ agentId: 'fake', cwd })).session.sessionId;
    await manager.close(); // the next turn boots a new adapter, so steer has to wait for it
    const started = manager.turnStart(sessionId, text('a'), cmid());
    const turnId = manager.runningTurnId(sessionId)!;
    const steer = manager.steer(sessionId, turnId, text('b'), cmid());
    await started;
    await expect(steer).rejects.toMatchObject({ code: 'turn_mismatch', data: { turnId: null } });

    const broken = make({ adapter: { failOn: { start: 'boom' } } });
    const brokenId = (await broken.manager.start({ agentId: 'fake', cwd }).catch(() => undefined), broken.journal.list().sessions[0]!.sessionId);
    const failing = broken.manager.turnStart(brokenId, text('a'), cmid());
    const steerBroken = broken.manager.steer(brokenId, broken.manager.runningTurnId(brokenId)!, text('b'), cmid());
    await expect(failing).rejects.toMatchObject({ code: 'agent_unavailable' });
    await expect(steerBroken).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('a resolution of a compacted-away request answers not_found', async () => {
    const { manager, journal } = make({ script: [[{ approval: {} }]] });
    const sessionId = (await manager.start({ agentId: 'fake', cwd })).session.sessionId;
    await manager.turnStart(sessionId, text('a'), cmid());
    const requestId = journal.pending(sessionId).approvals[0]!.requestId;
    await manager.resolveApproval(sessionId, requestId, 'accept', 'dev_a');
    journal.compactForTesting(sessionId, 3);
    await expect(manager.resolveApproval(sessionId, requestId, 'accept', 'dev_b')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a failed turn from the script ends failed and withdraws what is pending', async () => {
    const { manager, journal } = make({ script: [[{ fail: 'model refused' }]] });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    const turn = await manager.turnStart(session.sessionId, text('a'), cmid());
    expect(journal.turn(session.sessionId, turn.turnId)).toMatchObject({
      status: 'failed',
      error: { code: 'agent_error', message: 'model refused' },
    });
  });
});

describe('adapter events', () => {
  async function running(options: FakeAgentOptions = { script: [[{ hold: true }]] }) {
    const made = make(options);
    const { session } = await made.manager.start({ agentId: 'fake', cwd });
    const turn = await made.manager.turnStart(session.sessionId, text('a'), cmid());
    return { ...made, sessionId: session.sessionId, turn, adapter: made.agent.last };
  }

  it('journals usage, adapter status, withdrawn requests; ignores stale adapters and turnless items', async () => {
    const { adapter, events, journal, sessionId, manager, log, turn } = await running();
    adapter.emit({ method: 'usage/updated', params: { usage: { inputTokens: 5, outputTokens: 7 } } });
    adapter.emit({
      method: 'approval/request',
      params: {
        request: {
          requestId: 'req_x',
          kind: 'fileChange',
          itemId: 'itm_x',
          changes: [],
          reason: 'write',
          availableDecisions: ['accept'],
          expiresAt: 99,
        },
      },
    });
    expect(journal.pending(sessionId).approvals[0]).toMatchObject({ requestId: 'req_x', expiresAt: 99, turnId: turn.turnId });
    adapter.emit({ method: 'request/withdrawn', params: { requestId: 'req_x' } });
    adapter.emit({ method: 'request/withdrawn', params: { requestId: 'req_unknown' } });
    expect(journal.pending(sessionId).approvals).toEqual([]);
    expect(events.find((e) => e.method === 'request/resolved')?.params).toMatchObject({ resolvedBy: 'agent', decision: 'cancel' });
    adapter.emit({ method: 'status/changed', params: { status: 'error' } });
    expect(journal.summary(sessionId)?.status).toBe('error');
    adapter.emit({ method: 'item/started', params: { item: { itemId: 'itm_c', type: 'command', status: 'inProgress', command: 'ls', cwd, output: '' } } });
    adapter.emit({ method: 'item/delta', params: { itemId: 'itm_c', field: 'output', delta: 'a.txt\n' } });
    adapter.emit({ method: 'item/completed', params: { item: { itemId: 'itm_c', type: 'command', status: 'completed', command: 'ls', cwd, output: 'a.txt\n', exitCode: 0 } } });
    expect(manager.turn(sessionId, turn.turnId)?.items).toHaveLength(2);

    adapter.release();
    const count = events.length;
    adapter.emit({ method: 'item/delta', params: { itemId: 'itm_c', field: 'output', delta: 'late' } });
    expect(events.length).toBe(count);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dropped item/delta'));

    await manager.archive(sessionId);
    const after = events.length;
    adapter.killed = false; // a killed adapter that still talks is ignored by the core
    adapter.emit({ method: 'usage/updated', params: { usage: { inputTokens: 1, outputTokens: 1 } } });
    expect(events.length).toBe(after);
    expect(methods(events)).toContain('usage/updated');
  });

  it('an engine turn/started opens a turn without a user message; ignored while a turn runs; a turn/start joins it', async () => {
    const { adapter, events, journal, sessionId, manager, turn } = await running({ script: [[{ hold: true }], [{ hold: true }]] });
    adapter.emit({ method: 'turn/started', params: {} });
    expect(manager.runningTurnId(sessionId)).toBe(turn.turnId);
    expect(methods(events).filter((m) => m === 'turn/started')).toHaveLength(1);
    adapter.release();
    expect(journal.summary(sessionId)?.status).toBe('idle');

    adapter.emit({ method: 'turn/started', params: {} });
    const engineTurnId = manager.runningTurnId(sessionId)!;
    expect(engineTurnId).not.toBe(turn.turnId);
    expect(journal.summary(sessionId)?.status).toBe('running');
    expect(manager.activeCount()).toBe(1);
    adapter.emit({ method: 'item/started', params: { item: { itemId: 'itm_c', type: 'command', status: 'inProgress', command: 'sleep 9', cwd, output: '' } } });

    const calls = adapter.calls.length;
    const joined = await manager.turnStart(sessionId, text('status?'), cmid());
    expect(joined.turnId).toBe(engineTurnId);
    expect(joined.items).toHaveLength(2); // the command, then the user message
    expect(adapter.calls.slice(calls).map((c) => c.method)).toEqual(['turnStart']);
    expect(methods(events).filter((m) => m === 'turn/started')).toHaveLength(2);

    adapter.release();
    expect(manager.runningTurnId(sessionId)).toBeUndefined();
    expect(journal.turn(sessionId, engineTurnId)?.status).toBe('completed');
    expect(journal.summary(sessionId)?.status).toBe('idle');
  });

  it('an engine-initiated turn gets a start snapshot: turn/diff shows only its own change, without a note', async () => {
    const repo = makeRepo({ 'readme.md': '# Demo\n' });
    repo.commit('initial');
    try {
      const journal = new Journal({ path: ':memory:' });
      const agent = new FakeAgent({ script: [[{ reply: 'done' }]] });
      const manager = new SessionManager({ journal, agents: [agent], startSnapshotWaitMs: 30_000 });
      open.push({ journal, manager });
      const { session } = await manager.start({ agentId: 'fake', cwd: repo.root });
      const sessionId = session.sessionId;
      // An earlier user turn leaves a change behind that the engine turn must not show.
      const userTurn = await manager.turnStart(sessionId, text('write'), cmid());
      repo.write('earlier.txt', 'from the user turn\n');
      expect(journal.turn(sessionId, userTurn.turnId)?.status).toBe('completed');

      agent.last.emit({ method: 'turn/started', params: {} });
      const engineTurnId = manager.runningTurnId(sessionId)!;
      // The git snapshot is best-effort and slow on a busy machine; wait well under the 30 s test limit.
      await vi.waitFor(() => expect(manager.store.turnTrees(sessionId, engineTurnId).start).toMatch(/^[0-9a-f]{40}$/), {
        timeout: 15_000,
        interval: 50,
      });
      repo.write('engine.txt', 'from the background task\n');
      agent.last.emit({ method: 'turn/completed', params: { status: 'completed' } });
      expect(journal.turn(sessionId, engineTurnId)?.status).toBe('completed');

      const diff = await manager.diff(sessionId, engineTurnId);
      expect(diff.files.map((f) => [f.path, f.kind])).toEqual([['engine.txt', 'add']]);
      expect(diff).not.toHaveProperty('note');
    } finally {
      repo.remove();
    }
  });

  it('an observer that throws is logged and does not stop the Journal', async () => {
    const journal = new Journal({ path: ':memory:' });
    const log = vi.fn();
    const manager = new SessionManager({
      journal,
      agents: [new FakeAgent()],
      onEvent: () => {
        throw new Error('observer bug');
      },
      log,
    });
    open.push({ journal, manager });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    expect(journal.head(session.sessionId)).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('event observer failed'), expect.any(Error));
  });
});

describe('attachments (spec 8.1)', () => {
  async function withUploads(options: FakeAgentOptions) {
    const attachments = new AttachmentStore({ dir: mkdtempSync(path.join(tmpdir(), 'nano-sm-att-')) });
    const rig = make({ script: [[{ hold: true }, { reply: 'ok' }]], ...options }, { attachments });
    const { session } = await rig.manager.start({ agentId: 'fake', cwd });
    const sessionId = session.sessionId;
    const image = await attachments.save(sessionId, { name: 'a.png', mediaType: 'image/png' }, Readable.from([Buffer.from('png')]));
    const file = await attachments.save(sessionId, { name: 'b.pdf', mediaType: 'application/pdf' }, Readable.from([Buffer.from('pdf')]));
    return { ...rig, attachments, sessionId, image, file };
  }

  it('an agent without image input gets image attachments as file parts', async () => {
    const { manager, agent, sessionId, image } = await withUploads({ capabilities: { attachments: { images: false, files: true } } });
    await manager.turnStart(sessionId, [{ type: 'image', url: blobUrl(image.blobId) }], cmid());
    expect(agent.last.calls.find((c) => c.method === 'turnStart')!.args[0]).toEqual([
      { type: 'file', url: blobUrl(image.blobId), name: 'a.png', mediaType: 'image/png', path: image.path },
    ]);
  });

  it('an agent that takes no files answers not_supported for a file part, and starts no turn', async () => {
    const { manager, agent, sessionId, file, events } = await withUploads({ capabilities: { attachments: { images: true, files: false } } });
    const before = events.length;
    await expect(
      manager.turnStart(sessionId, [{ type: 'file', url: blobUrl(file.blobId), name: 'b.pdf', mediaType: 'application/pdf' }], cmid()),
    ).rejects.toMatchObject({ code: 'not_supported', data: { agentId: 'fake' } });
    expect(events.length).toBe(before);
    expect(agent.last.calls.map((c) => c.method)).toEqual(['start']);
  });

  it('steer resolves attachments the same way and refuses foreign ones before the adapter sees them', async () => {
    const { manager, agent, sessionId, image } = await withUploads({});
    const turn = await manager.turnStart(sessionId, text('first'), cmid());
    await expect(manager.steer(sessionId, turn.turnId, [{ type: 'image', url: '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA' }], cmid())).rejects.toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.input.0.url' },
    });
    await manager.steer(sessionId, turn.turnId, [{ type: 'image', url: blobUrl(image.blobId) }], cmid());
    const steers = agent.last.calls.filter((c) => c.method === 'steer');
    expect(steers).toHaveLength(1);
    expect(steers[0]!.args[0]).toEqual([{ type: 'image', url: blobUrl(image.blobId), path: image.path, mediaType: 'image/png' }]);
  });

  it('a message that joins an engine-initiated turn has its attachments resolved; foreign ones are refused unjournaled', async () => {
    const { manager, agent, sessionId, image, journal } = await withUploads({});
    agent.last.emit({ method: 'turn/started', params: {} });
    const engineTurnId = manager.runningTurnId(sessionId)!;
    const head = journal.head(sessionId);
    await expect(manager.turnStart(sessionId, [{ type: 'image', url: '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA' }], cmid())).rejects.toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.input.0.url' },
    });
    expect(journal.head(sessionId)).toBe(head);
    const joined = await manager.turnStart(sessionId, [{ type: 'image', url: blobUrl(image.blobId) }], cmid());
    expect(joined.turnId).toBe(engineTurnId);
    const starts = agent.last.calls.filter((c) => c.method === 'turnStart');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.args[0]).toEqual([{ type: 'image', url: blobUrl(image.blobId), path: image.path, mediaType: 'image/png' }]);
  });

  it('without a store every blob URL is invalid_params; an image URL the engine fetches passes', async () => {
    const { manager, agent } = make();
    const { session } = await manager.start({ agentId: 'fake', cwd });
    await expect(manager.turnStart(session.sessionId, [{ type: 'image', url: '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA' }], cmid())).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await manager.turnStart(session.sessionId, [{ type: 'image', url: 'https://example.com/a.png' }], cmid());
    expect(agent.last.calls.find((c) => c.method === 'turnStart')!.args[0]).toEqual([{ type: 'image', url: 'https://example.com/a.png' }]);
    expect(manager.exists(session.sessionId)).toBe(true);
    expect(manager.exists('ses_0none')).toBe(false);
  });
});

describe('agent capabilities', () => {
  it('turn/diff on a dormant session starts no engine: not_supported without the capability, the git answer with it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-dormant-'));
    const file = path.join(dir, 'journal.sqlite');
    const store = new SessionStore(path.join(dir, 'core.sqlite'));
    const journal = new Journal({ path: file });
    const before = new SessionManager({ journal, agents: [new FakeAgent()], store });
    const { session, turn } = await before.start({ agentId: 'fake', cwd, input: text('a') });
    await before.close();
    journal.close();

    // After a host restart the session is dormant: no adapter, a known engine session id to resume.
    const reopened = new Journal({ path: file });
    const agent = new FakeAgent({ capabilities: { diff: false } });
    const after = new SessionManager({ journal: reopened, agents: [agent], store });
    open.push({ journal: reopened, manager: after });
    expect(store.get(session.sessionId).engineSessionId).toMatch(/^eng_fake_/);
    await expect(after.diff(session.sessionId, turn!.turnId)).rejects.toMatchObject({
      code: 'not_supported',
      data: { agentId: 'fake' },
    });
    expect(agent.adapters).toHaveLength(0);
    // With the capability the host answers from git alone (this folder is no repository): still no engine.
    const withDiff = new FakeAgent();
    const third = new SessionManager({ journal: reopened, agents: [withDiff], store });
    await expect(third.diff(session.sessionId, turn!.turnId)).rejects.toMatchObject({ code: 'not_a_repository', data: { cwd } });
    expect(withDiff.adapters).toHaveLength(0);
    store.close();
  });

  it('steer on an agent that cannot steer answers not_supported and never reaches the adapter', async () => {
    const { manager, agent } = make({ script: [[{ hold: true }]], capabilities: { steer: false } });
    const { session, turn } = await manager.start({ agentId: 'fake', cwd, input: text('a') });
    await expect(manager.steer(session.sessionId, turn!.turnId, text('b'), cmid())).rejects.toMatchObject({ code: 'not_supported' });
    expect(agent.last.calls.map((c) => c.method)).toEqual(['start', 'turnStart']);
  });

  it('stores and reports an approvalMode only when the agent honours it', async () => {
    const pi = make({ id: 'pi', capabilities: { approvalModes: [] } });
    const { session } = await pi.manager.start({ agentId: 'pi', cwd, settings: { approvalMode: 'never', model: 'm' } });
    expect(session.settings).toEqual({ model: 'm' });
    expect(pi.journal.session(session.sessionId)?.settings).toEqual({ model: 'm' });
    expect(pi.agent.last.calls[0]).toEqual({ method: 'start', args: [cwd, { model: 'm' }] });

    const codex = make();
    const bypass = await codex.manager.start({ agentId: 'fake', cwd, settings: { approvalMode: 'never' } });
    expect(bypass.session.settings).toEqual({ approvalMode: 'never' });
    const unknown = await codex.manager.start({ agentId: 'fake', cwd, settings: { approvalMode: 'sometimes' } });
    expect(unknown.session.settings).toEqual({});
  });

  it('drops an approvalMode the adapter reports when the agent does not honour it', async () => {
    const { manager } = make({ capabilities: { approvalModes: [] }, adapter: { effectiveSettings: { approvalMode: 'never', sandbox: 'x' } } });
    const { session } = await manager.start({ agentId: 'fake', cwd });
    expect(session.settings).toEqual({ sandbox: 'x' });
    const honouring = make({ adapter: { effectiveSettings: { approvalMode: 'on-request' } } });
    const started = await honouring.manager.start({ agentId: 'fake', cwd });
    expect(started.session.settings).toEqual({ approvalMode: 'on-request' });
  });
});

describe('recovery after a host restart', () => {
  it('fails turns that were running, withdraws their requests and sets sessions idle', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-recover-'));
    const file = path.join(dir, 'journal.sqlite');
    let clock = 500;
    const journal = new Journal({ path: file, now: () => clock });
    const store = new SessionStore(path.join(dir, 'nested', 'core.sqlite'));
    const before = new SessionManager({ journal, agents: [new FakeAgent({ script: [[{ approval: {} }]] })], store, now: () => clock });
    const { session } = await before.start({ agentId: 'fake', cwd });
    const turn = await before.turnStart(session.sessionId, text('a'), cmid());
    const idle = (await before.start({ agentId: 'fake', cwd })).session.sessionId;
    expect(journal.summary(session.sessionId)?.status).toBe('waiting_approval');
    await before.close();
    journal.close();

    clock = 600;
    const reopened = new Journal({ path: file, now: () => clock });
    const after = new SessionManager({ journal: reopened, agents: [new FakeAgent()], store, now: () => clock });
    open.push({ journal: reopened, manager: after });
    expect(reopened.turn(session.sessionId, turn.turnId)).toMatchObject({
      status: 'failed',
      completedAt: 600,
      error: { code: 'host_restarted' },
      items: [expect.stringMatching(/^itm_/)],
    });
    expect(reopened.pending(session.sessionId)).toEqual({ approvals: [], inputs: [] });
    expect(reopened.summary(session.sessionId)).toMatchObject({ status: 'idle', pending: { approvals: 0, inputs: 0 } });
    expect(reopened.head(idle)).toBe(1);
    expect(store.get(session.sessionId).engineSessionId).toMatch(/^eng_fake_/);
    store.close();
    store.close(); // idempotent
  });
});

describe('FakeAdapter', () => {
  it('echoes by default, records calls, and refuses release without a hold', async () => {
    const adapter = new FakeAdapter();
    const seen: string[] = [];
    const off = adapter.onEvent((e) => seen.push(e.method));
    expect(await adapter.start(cwd, {})).toMatch(/^eng_fake_/);
    await adapter.turnStart([{ type: 'image', url: 'x' }], 'c1');
    expect(seen).toEqual(['item/started', 'item/delta', 'item/completed', 'turn/completed']);
    expect(adapter.running).toBe(false);
    expect(() => adapter.release()).toThrow(/no hold/);
    await adapter.resolveApproval('req_none', 'accept');
    await adapter.answerInput('req_none', {});
    await adapter.interrupt();
    off();
    expect(echoScript(text('hi'), 0)).toEqual([{ reply: 'You said: hi' }]);
    expect(new FakeAgent().capabilities).toEqual({ steer: true, diff: true, approvalModes: FAKE_APPROVAL_MODES, attachments: { images: true, files: true } });
    expect(() => new FakeAgent().last).toThrow(/no adapter/);
  });

  it('satisfies the Adapter contract structurally', () => {
    const adapter: Adapter = new FakeAdapter();
    expect(typeof adapter.onEvent).toBe('function');
  });
});
