// Live: the Codex adapter against the real engine (Codex app-server bundled with ChatGPT.app), through
// the whole session core. Runs only with NANO_LIVE_CODEX=1; never in the gate (it needs the operator's
// login and spends real tokens).
//
//   NANO_LIVE_CODEX=1 pnpm -C host exec vitest run src/adapters/codex/live.test.ts
//
// Steps are printed and appended to $NANO_LIVE_CODEX_LOG (default $TMPDIR/nano-live-codex.log).
//
// The phone session of the spike: start (read-only sandbox, so writing needs an approval), approve,
// check the file, SIGKILL the engine, then a follow-up turn on a new engine that resumes the thread.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { JournalEvent } from '../../journal/types.js';
import type { TestClient } from '../../stream/testing/client.js';
import { eventsOf, rpc, startHarness, text, waitEvent, type Harness } from '../../core/testing/harness.js';
import type { CodexAdapter } from './adapter.js';
import { CodexAgent } from './provider.js';
import { until } from './testing/fake-codex.js';

const LIVE = process.env.NANO_LIVE_CODEX === '1';
const STEP_MS = 240_000;

class RecordingAgent extends CodexAgent {
  readonly adapters: CodexAdapter[] = [];
  override createAdapter(): CodexAdapter {
    const adapter = super.createAdapter();
    this.adapters.push(adapter);
    return adapter;
  }
}

const started = Date.now();
/** The steps also go to this file (vitest may hide console output of passing tests). */
const LOG_FILE = process.env.NANO_LIVE_CODEX_LOG ?? path.join(tmpdir(), 'nano-live-codex.log');
function step(message: string): void {
  const line = `[live codex +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

let harness: Harness | undefined;
afterAll(async () => {
  await harness?.close();
});

describe.skipIf(!LIVE)('Codex adapter, live against the real engine', () => {
  it(
    'start, approve, complete, kill the engine, resume and remember',
    async () => {
      const agent = new RecordingAgent({ log: (m) => process.env.NANO_LIVE_CODEX_VERBOSE && step(m) });
      harness = await startHarness({ extraAgents: [agent] });
      const h = harness;
      const phone = await h.connect();
      const cwd = mkdtempSync(path.join(tmpdir(), 'nano-live-codex-'));

      const { models } = await slowRpc<{ models: { id: string; default: boolean }[] }>(phone, 'model/list', { agentId: 'codex' });
      const { agents } = await rpc<{ agents: { id: string; status: string; version?: string }[] }>(phone, 'agent/list');
      step(`agent ${JSON.stringify(agents.find((a) => a.id === 'codex'))}; models ${models.map((m) => (m.default ? `${m.id}*` : m.id)).join(', ')}`);
      expect(models.some((m) => m.default)).toBe(true);

      const { session } = await slowRpc<{ session: { sessionId: string } }>(phone, 'session/start', {
        agentId: 'codex',
        cwd,
        settings: { sandbox: 'read-only' },
      });
      const sessionId = session.sessionId;
      const threadId = h.core.sessions.store.get(sessionId).engineSessionId;
      step(`session/start ok sessionId=${sessionId} thread=${threadId} pid=${agent.adapters[0]?.pid} cwd=${cwd}`);
      await rpc(phone, 'session/open', { sessionId });

      const { turn } = await slowRpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
        sessionId,
        input: text(
          'Create a file named hello.txt in the current directory containing exactly the word hello, without a newline. ' +
            'The sandbox is read-only, so run the shell command with escalated permissions; I will approve it. Then reply with "done".',
        ),
        clientMessageId: randomUUID(),
      });
      step(`turn/start ok turnId=${turn.turnId}`);

      // Approve whatever the engine asks for until the turn ends.
      const answered = new Set<string>();
      for (;;) {
        const next = await until(
          () =>
            eventsOf(phone, sessionId).find(
              (e) =>
                (e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === turn.turnId) ||
                ((e.method === 'approval/request' || e.method === 'input/request') &&
                  !answered.has((e.params as { request: { requestId: string } }).request.requestId)),
            ),
          'approval or turn end',
          STEP_MS,
        );
        if (next.method === 'turn/completed') break;
        const request = (next.params as { request: { requestId: string; kind: string; availableDecisions?: string[]; command?: string } }).request;
        answered.add(request.requestId);
        if (next.method === 'input/request') throw new Error(`unexpected question: ${JSON.stringify(request)}`);
        const decision = request.availableDecisions?.includes('accept') ? 'accept' : request.availableDecisions![0]!;
        step(`approval/request seq=${next.params.seq} kind=${request.kind} command=${JSON.stringify(request.command ?? '')} availableDecisions=${request.availableDecisions?.join(',')} -> ${decision}`);
        await rpc(phone, 'approval/resolve', { sessionId, requestId: request.requestId, decision });
      }
      const first = finalTurn(eventsOf(phone, sessionId), turn.turnId);
      step(`turn/completed status=${first.status} error=${JSON.stringify(first.error)}`);
      for (const e of eventsOf(phone, sessionId)) {
        if (e.method !== 'item/completed') continue;
        const item = (e.params as { item: Record<string, unknown> }).item;
        step(`  item ${String(item.type)} ${String(item.status)} ${JSON.stringify(item.text ?? item.command ?? item.changes ?? item.summary ?? '').slice(0, 160)}`);
      }
      expect(first.status).toBe('completed');
      const content = readFileSync(path.join(cwd, 'hello.txt'), 'utf8');
      step(`hello.txt=${JSON.stringify(content)}`);
      expect(content.trim()).toBe('hello');
      const usage = eventsOf(phone, sessionId).filter((e) => e.method === 'usage/updated').at(-1);
      step(`usage ${JSON.stringify((usage?.params as { usage?: unknown } | undefined)?.usage)}`);

      const pid = agent.adapters[0]!.pid!;
      process.kill(pid, 'SIGKILL');
      await waitEvent(phone, 'status/changed', (p) => p.status === 'error');
      step(`engine SIGKILLed pid=${pid}; session status error`);

      const follow = await slowRpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
        sessionId,
        input: text('What is the name of the file you created in this conversation? Reply with the file name only.'),
        clientMessageId: randomUUID(),
      });
      await until(
        () =>
          eventsOf(phone, sessionId).find(
            (e) => e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === follow.turn.turnId,
          ),
        'follow-up turn end',
        STEP_MS,
      );
      const second = finalTurn(eventsOf(phone, sessionId), follow.turn.turnId);
      const reply = eventsOf(phone, sessionId)
        .filter((e) => e.method === 'item/completed' && (e.params as { turnId: string }).turnId === follow.turn.turnId)
        .map((e) => (e.params as { item: { type: string; text?: string } }).item)
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text)
        .join(' ');
      step(
        `resumed on a new engine pid=${agent.adapters[1]?.pid} same thread=${h.core.sessions.store.get(sessionId).engineSessionId === threadId}; follow-up status=${second.status} reply=${JSON.stringify(reply)}`,
      );
      expect(second.status).toBe('completed');
      expect(reply).toContain('hello.txt');
      step(`journal head=${h.journal.head(sessionId)} events=${eventsOf(phone, sessionId).length}`);
    },
    STEP_MS * 3,
  );
});

/** Like `rpc`, but waits as long as a real engine may take (boot, thread/resume, MCP startup). */
async function slowRpc<T>(client: TestClient, method: string, params: Record<string, unknown>): Promise<T> {
  const id = client.request(method, params);
  const response = await until(() => client.messages.find((m) => m.id === id && !('method' in m)), `response to ${method}`, STEP_MS);
  if ('error' in response) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result as T;
}

function finalTurn(events: JournalEvent[], turnId: string): { status: string; error: unknown } {
  const event = events.find((e) => e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === turnId)!;
  return (event.params as { turn: { status: string; error: unknown } }).turn;
}
