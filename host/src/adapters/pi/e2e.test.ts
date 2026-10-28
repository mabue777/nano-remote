// End to end with the pi adapter: the session core with a PiAgent driving the fake pi (Nano's real
// approval extension loaded): model/list with providers, session/start on a chosen model, an approval
// accepted and one declined through approval/resolve, interrupt, and a host restart that resumes pi.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { JournalEvent } from '../../journal/types.js';
import type { TestClient } from '../../stream/testing/client.js';
import { eventsOf, rpc, startHarness, text, waitEvent, type Harness } from '../../core/testing/harness.js';
import { makeRepo } from '../../core/testing/git-repo.js';
import { PiAgent } from './provider.js';
import { fakePi, until, type FakePi } from './testing/fake-pi-config.js';
import type { FakePiFixture } from './testing/fixture.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(fixture: FakePiFixture = {}): Promise<{ h: Harness; fake: FakePi; phone: TestClient }> {
  const fake = fakePi(fixture);
  harness = await startHarness({ extraAgents: [new PiAgent({ config: fake.config })] });
  return { h: harness, fake, phone: await harness.connect() };
}

async function newSession(phone: TestClient, cwd: string, model?: string): Promise<{ sessionId: string; settings: Record<string, unknown> }> {
  const { session } = await rpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
    agentId: 'pi',
    cwd,
    ...(model ? { settings: { model } } : {}),
  });
  await rpc(phone, 'session/open', { sessionId: session.sessionId });
  return session;
}

async function startTurn(phone: TestClient, sessionId: string, prompt: string): Promise<string> {
  const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text(prompt), clientMessageId: randomUUID() });
  return turn.turnId;
}

const turnEnd = (phone: TestClient, sessionId: string, turnId: string) =>
  until(
    () =>
      eventsOf(phone, sessionId).find((e) => e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === turnId) as
        | JournalEvent
        | undefined,
    'turn/completed',
  );
const request = (event: JournalEvent) => (event.params as { request: Record<string, unknown> & { requestId: string } }).request;
const items = (phone: TestClient, sessionId: string) =>
  eventsOf(phone, sessionId)
    .filter((e) => e.method === 'item/completed')
    .map((e) => (e.params as { item: Record<string, unknown> }).item);

describe('session core end to end with the pi adapter', () => {
  it('pi honours ask, acceptEdits and never: agent/list says so, session/start stores and reports the mode', async () => {
    const { h, phone } = await setup();
    const { agents } = await rpc<{ agents: { id: string; capabilities?: unknown }[] }>(phone, 'agent/list');
    expect(agents.find((a) => a.id === 'pi')?.capabilities).toEqual({ steer: true, diff: true, approvalModes: ['ask', 'acceptEdits', 'never'], attachments: { images: true, files: true }, backgroundTasks: false, settingsUpdate: ['model', 'effort', 'approvalMode'] });
    const { session } = await rpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
      agentId: 'pi',
      cwd: h.cwd,
      settings: { approvalMode: 'never' },
    });
    expect(session.settings).toMatchObject({ approvalMode: 'never' });
    expect(h.journal.session(session.sessionId)?.settings).toMatchObject({ approvalMode: 'never' });
    const opened = await rpc<{ session: { settings: Record<string, unknown> } }>(phone, 'session/open', {
      sessionId: session.sessionId,
    });
    expect(opened.session.settings).toMatchObject({ approvalMode: 'never' });
    // A mode of another agent is not Pi's: the session runs, and reports, ask.
    const other = await rpc<{ session: { settings: Record<string, unknown> } }>(phone, 'session/start', {
      agentId: 'pi',
      cwd: h.cwd,
      settings: { approvalMode: 'default' },
    });
    expect(other.session.settings).toMatchObject({ approvalMode: 'ask' });
  });

  it('session/settings/update to never mid-turn answers appliesAt now, and the next tool call runs unasked', async () => {
    const bash = (command: string) => ({ tool: { name: 'bash', args: { command }, output: 'ok' } });
    const { h, phone } = await setup({ turns: [[bash('echo one'), bash('echo two'), { reply: 'done' }]] });
    const { sessionId } = await newSession(phone, h.cwd);
    const turnId = await startTurn(phone, sessionId, 'two commands');
    const approval = await waitEvent(phone, 'approval/request');
    expect(request(approval)).toMatchObject({ kind: 'command', command: 'echo one' });
    const update = await rpc<{ session: { settings: Record<string, unknown> }; appliesAt: string }>(phone, 'session/settings/update', {
      sessionId,
      settings: { approvalMode: 'never' },
    });
    expect(update).toMatchObject({ appliesAt: 'now', session: { settings: { approvalMode: 'never' } } });
    await rpc(phone, 'approval/resolve', { sessionId, requestId: request(approval).requestId, decision: 'accept' });
    const end = await turnEnd(phone, sessionId, turnId);
    expect((end.params as { turn: { status: string } }).turn.status).toBe('completed');
    expect(eventsOf(phone, sessionId).filter((e) => e.method === 'approval/request')).toHaveLength(1);
    expect(items(phone, sessionId).filter((i) => i.type === 'command').map((i) => [i.command, i.status])).toEqual([
      ['echo one', 'completed'],
      ['echo two', 'completed'],
    ]);
  });

  it('model/list carries the provider; session/start on a model; a write approved through approval/resolve', async () => {
    const write = { tool: { name: 'write', args: { path: 'hello.txt', content: 'hello' }, output: 'ok' } };
    const { h, fake, phone } = await setup({ turns: [[{ thinking: 'use write' }, write, { reply: 'done' }]] });
    const { models } = await rpc<{ models: Record<string, unknown>[] }>(phone, 'model/list', { agentId: 'pi' });
    expect(models).toEqual([
      { id: 'llamacpp/bonsai-27b', displayName: 'Bonsai 27B', default: true, provider: 'llamacpp' },
      { id: 'openrouter/~deepseek/deepseek-v4-flash-latest', displayName: 'DeepSeek V4 Flash', default: false, provider: 'openrouter' },
    ]);
    const session = await newSession(phone, h.cwd, 'openrouter/~deepseek/deepseek-v4-flash-latest');
    expect(session.settings).toEqual({ approvalMode: 'ask', model: 'openrouter/~deepseek/deepseek-v4-flash-latest' });
    const turnId = await startTurn(phone, session.sessionId, 'write hello');
    const approval = await waitEvent(phone, 'approval/request');
    expect(request(approval)).toMatchObject({
      kind: 'fileChange',
      sessionId: session.sessionId,
      turnId,
      changes: [{ path: 'hello.txt', kind: 'add', diff: '+hello' }],
      availableDecisions: ['accept', 'decline', 'cancel'],
    });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'waiting_approval');
    await rpc(phone, 'approval/resolve', { sessionId: session.sessionId, requestId: request(approval).requestId, decision: 'accept' });
    const end = await turnEnd(phone, session.sessionId, turnId);
    expect((end.params as { turn: { status: string } }).turn.status).toBe('completed');
    expect(readFileSync(path.join(h.cwd, 'hello.txt'), 'utf8')).toBe('hello');
    expect(items(phone, session.sessionId).map((i) => [i.type, i.status])).toEqual([
      ['userMessage', 'completed'],
      ['reasoning', 'completed'],
      ['fileChange', 'completed'],
      ['agentMessage', 'completed'],
    ]);
    expect(eventsOf(phone, session.sessionId).some((e) => e.method === 'usage/updated')).toBe(true);
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    expect(fake.sent('set_model')).toHaveLength(1);
  });

  it('a bash call declined through approval/resolve is blocked; interrupt ends a held turn', async () => {
    const bash = { tool: { name: 'bash', args: { command: 'rm -rf build' }, output: 'removed' } };
    const { h, phone } = await setup({ turns: [[bash, { reply: 'blocked' }], [{ hold: true }]] });
    const { sessionId } = await newSession(phone, h.cwd);
    const first = await startTurn(phone, sessionId, 'clean');
    const approval = await waitEvent(phone, 'approval/request');
    expect(request(approval)).toMatchObject({ kind: 'command', command: 'rm -rf build', cwd: h.cwd });
    await rpc(phone, 'approval/resolve', { sessionId, requestId: request(approval).requestId, decision: 'decline' });
    await turnEnd(phone, sessionId, first);
    expect(items(phone, sessionId).find((i) => i.type === 'command')).toMatchObject({ status: 'declined', output: 'bash was not approved in Nano' });

    const second = await startTurn(phone, sessionId, 'wait');
    await rpc(phone, 'turn/interrupt', { sessionId, turnId: second });
    const end = await turnEnd(phone, sessionId, second);
    expect((end.params as { turn: { status: string } }).turn.status).toBe('interrupted');
    expect(existsSync(path.join(h.cwd, 'build'))).toBe(false);
  });

  it('a delta whose text holds U+2028 and U+2029 reaches the Journal intact (LF-only framing)', async () => {
    const reply = 'one\u2028two\u2029three';
    const { h, phone } = await setup({ turns: [[{ reply, chunks: 1 }]] });
    const { sessionId } = await newSession(phone, h.cwd);
    const turnId = await startTurn(phone, sessionId, 'say it');
    await turnEnd(phone, sessionId, turnId);
    const stored = h.journal.since(sessionId, 0).events;
    const deltas = stored.filter((e) => e.method === 'item/delta').map((e) => (e.params as { delta: string }).delta);
    expect(deltas).toEqual([reply]);
    const message = stored
      .filter((e) => e.method === 'item/completed')
      .map((e) => (e.params as { item: { type: string; text?: string } }).item)
      .find((i) => i.type === 'agentMessage');
    expect(message?.text).toBe(reply);
  });
});

describe('the Changes view with the pi adapter', () => {
  it('turn/diff lists exactly the files pi wrote during the turn', async () => {
    const repo = makeRepo({ 'notes.md': '# Notes\n' });
    repo.commit('initial');
    const writeNew = { tool: { name: 'write', args: { path: 'hello.txt', content: 'hello\n' }, output: 'ok' } };
    const rewrite = { tool: { name: 'write', args: { path: 'notes.md', content: '# Notes\n\n- pi was here\n' }, output: 'ok' } };
    const fake = fakePi({ turns: [[writeNew, rewrite, { reply: 'done' }]] });
    harness = await startHarness({ extraAgents: [new PiAgent({ config: fake.config })], core: { startSnapshotWaitMs: 30_000 } });
    try {
      const phone = await harness.connect();
      const { sessionId } = await newSession(phone, repo.root);
      const turnId = await startTurn(phone, sessionId, 'write two files');
      const resolved = new Set<string>();
      for (let answered = 0; answered < 2; answered += 1) {
        const approval = await waitEvent(phone, 'approval/request', (p) => !resolved.has((p.request as { requestId: string }).requestId));
        resolved.add(request(approval).requestId);
        await rpc(phone, 'approval/resolve', { sessionId, requestId: request(approval).requestId, decision: 'accept' });
      }
      await turnEnd(phone, sessionId, turnId);

      // Blob ids are git's (git hash-object) for the contents above.
      expect(await rpc(phone, 'turn/diff', { sessionId, turnId })).toEqual({
        files: [
          {
            path: 'hello.txt',
            kind: 'add',
            diff: 'diff --git a/hello.txt b/hello.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n',
          },
          {
            path: 'notes.md',
            kind: 'modify',
            diff: 'diff --git a/notes.md b/notes.md\nindex 17e0f0d..528c087 100644\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1,3 @@\n # Notes\n+\n+- pi was here\n',
          },
        ],
      });
    } finally {
      repo.remove();
    }
  });
});
