// Live: the Claude adapter against the real engine (the Claude Code executable bundled with the Claude
// Agent SDK), through the whole session core. Runs only with NANO_LIVE_CLAUDE=1; never in the gate (it
// needs the operator's login and spends real tokens; the prompts are kept tiny).
//
//   NANO_LIVE_CLAUDE=1 pnpm -C host exec vitest run src/adapters/claude/live.test.ts
//
// The Claude config folder is the host default (NANO_CLAUDE_CONFIG_DIR, CLAUDE_CONFIG_DIR, ~/.claude).
// Steps are printed and appended to $NANO_LIVE_CLAUDE_LOG (default $TMPDIR/nano-live-claude.log).
//
// The phone session of the spike: start, a turn that writes hello.txt with an approval accepted through
// approval/resolve, SIGKILL the engine, a follow-up turn on a new engine that resumes the session, then
// an interrupted turn. It logs what the unit tests cannot know: the model list, whether deltas stream,
// how often system/init comes, and the result subtype after an interrupt.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { JournalEvent } from '../../journal/types.js';
import type { TestClient } from '../../stream/testing/client.js';
import { eventsOf, rpc, startHarness, text, waitEvent, type Harness } from '../../core/testing/harness.js';
import type { ClaudeAdapter } from './adapter.js';
import { ClaudeAgent } from './provider.js';
import { until } from './testing/fake-query.js';

const LIVE = process.env.NANO_LIVE_CLAUDE === '1';
const STEP_MS = 240_000;

class RecordingAgent extends ClaudeAgent {
  readonly adapters: ClaudeAdapter[] = [];
  override createAdapter(): ClaudeAdapter {
    const adapter = super.createAdapter();
    this.adapters.push(adapter);
    return adapter;
  }
}

const started = Date.now();
/** The steps also go to this file (vitest may hide console output of passing tests). */
const LOG_FILE = process.env.NANO_LIVE_CLAUDE_LOG ?? path.join(tmpdir(), 'nano-live-claude.log');
function step(message: string): void {
  const line = `[live claude +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

let harness: Harness | undefined;
afterAll(async () => {
  await harness?.close();
});

describe.skipIf(!LIVE)('Claude adapter, live against the real engine', () => {
  it(
    'start, approve, complete, kill the engine, resume and remember, interrupt',
    async () => {
      const engineLog: string[] = [];
      const agent = new RecordingAgent({
        log: (m) => {
          engineLog.push(m);
          if (!m.startsWith('claude stderr') || process.env.NANO_LIVE_CLAUDE_VERBOSE) step(`  engine: ${m.slice(0, 300)}`);
        },
      });
      harness = await startHarness({ extraAgents: [agent] });
      const h = harness;
      const phone = await h.connect();
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'nano-live-claude-')));

      const { models } = await slowRpc<{ models: { id: string; default: boolean }[] }>(phone, 'model/list', { agentId: 'claude' });
      const { agents } = await rpc<{ agents: { id: string; status: string; version?: string }[] }>(phone, 'agent/list');
      const modelsFromEngine = !engineLog.some((m) => m.includes('using the static list'));
      step(
        `agent ${JSON.stringify(agents.find((a) => a.id === 'claude'))}; models (${modelsFromEngine ? 'supportedModels()' : 'STATIC fallback'}) ${models.map((m) => (m.default ? `${m.id}*` : m.id)).join(', ')}`,
      );
      expect(models.some((m) => m.default)).toBe(true);

      const { session } = await slowRpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
        agentId: 'claude',
        cwd,
      });
      const sessionId = session.sessionId;
      step(`session/start ok sessionId=${sessionId} settings=${JSON.stringify(session.settings)} pid=${agent.adapters[0]?.pid} cwd=${cwd}`);
      await rpc(phone, 'session/open', { sessionId });

      const turn = await runTurn(
        phone,
        sessionId,
        'Use the Write tool to create hello.txt in the current directory containing exactly the word hello. Then reply with "done" only.',
        'accept',
      );
      const engineSessionId = h.core.sessions.store.get(sessionId).engineSessionId;
      const first = finalTurn(eventsOf(phone, sessionId), turn);
      step(`turn/completed status=${first.status} error=${JSON.stringify(first.error)} engineSession=${engineSessionId}`);
      logItems(phone, sessionId, turn);
      const deltas = eventsOf(phone, sessionId).filter((e) => e.method === 'item/delta' && (e.params as { turnId: string }).turnId === turn);
      step(`deltas in the first turn: ${deltas.length} (${[...new Set(deltas.map((d) => (d.params as { field: string }).field))].join(',')})`);
      expect(first.status).toBe('completed');
      expect(engineSessionId).not.toBe('');
      const content = readFileSync(path.join(cwd, 'hello.txt'), 'utf8');
      step(`hello.txt=${JSON.stringify(content)}`);
      expect(content.trim()).toBe('hello');
      const usage = eventsOf(phone, sessionId).filter((e) => e.method === 'usage/updated').at(-1);
      step(`usage ${JSON.stringify((usage?.params as { usage?: unknown } | undefined)?.usage)}`);
      const { agents: after } = await rpc<{ agents: { id: string; version?: string }[] }>(phone, 'agent/list');
      step(`agent version after system/init: ${after.find((a) => a.id === 'claude')?.version}`);

      const pid = agent.adapters[0]!.pid!;
      process.kill(pid, 'SIGKILL');
      const exited = await waitEvent(phone, 'status/changed', (p) => p.status === 'error');
      step(`engine SIGKILLed pid=${pid}; session status error at seq=${exited.params.seq}`);

      const follow = await runTurn(phone, sessionId, 'What is the name of the file you created in this conversation? Reply with the file name only.', 'accept');
      const second = finalTurn(eventsOf(phone, sessionId), follow);
      const reply = replyOf(phone, sessionId, follow);
      step(
        `resumed on a new engine pid=${agent.adapters[1]?.pid} same session=${h.core.sessions.store.get(sessionId).engineSessionId === engineSessionId}; follow-up status=${second.status} reply=${JSON.stringify(reply)}`,
      );
      expect(second.status).toBe('completed');
      expect(reply).toContain('hello.txt');

      // Interrupt: once the reply streams, stop the turn and see what the engine reports.
      const { turn: long } = await slowRpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
        sessionId,
        input: text('Count from 1 to 300 in words, one number per line. No tools.'),
        clientMessageId: randomUUID(),
      });
      await until(
        () =>
          eventsOf(phone, sessionId).find(
            (e) => (e.method === 'item/delta' || e.method === 'turn/completed') && (e.params as { turnId: string; turn?: { turnId: string } }).turnId === long.turnId,
          ),
        'the long turn to stream',
        STEP_MS,
      );
      await rpc(phone, 'turn/interrupt', { sessionId, turnId: long.turnId });
      await until(
        () =>
          eventsOf(phone, sessionId).find((e) => e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === long.turnId),
        'the interrupted turn to end',
        STEP_MS,
      );
      const third = finalTurn(eventsOf(phone, sessionId), long.turnId);
      const results = engineLog.filter((m) => m.startsWith('claude result'));
      const inits = engineLog.filter((m) => m.startsWith('claude system/init'));
      step(`interrupt: turn status=${third.status}; engine result after interrupt: ${results.at(-1)}`);
      step(`system/init seen ${inits.length} times over 3 turns on 2 engines: ${inits.map((m) => m.replace('claude system/init ', '')).join(' | ')}`);
      expect(third.status).toBe('interrupted');
      step(`journal head=${h.journal.head(sessionId)} events=${eventsOf(phone, sessionId).length}`);
    },
    STEP_MS * 4,
  );
});

/** Starts a turn and answers every approval with `decision` until the turn ends; returns the turn id. */
async function runTurn(phone: TestClient, sessionId: string, prompt: string, decision: string): Promise<string> {
  const { turn } = await slowRpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
    sessionId,
    input: text(prompt),
    clientMessageId: randomUUID(),
  });
  step(`turn/start ok turnId=${turn.turnId}`);
  const answered = new Set<string>();
  for (;;) {
    const next = await until(
      () =>
        eventsOf(phone, sessionId).find(
          (e) =>
            (e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === turn.turnId) ||
            ((e.method === 'approval/request' || e.method === 'input/request') &&
              (e.params as { request: { turnId: string } }).request.turnId === turn.turnId &&
              !answered.has((e.params as { request: { requestId: string } }).request.requestId)),
        ),
      'approval or turn end',
      STEP_MS,
    );
    if (next.method === 'turn/completed') return turn.turnId;
    const request = (next.params as { request: Record<string, unknown> & { requestId: string; kind: string; availableDecisions?: string[] } }).request;
    answered.add(request.requestId);
    if (next.method === 'input/request') throw new Error(`unexpected question: ${JSON.stringify(request)}`);
    step(
      `approval/request seq=${next.params.seq} kind=${request.kind} ${JSON.stringify(request.command ?? request.changes ?? request.permissions)} availableDecisions=${request.availableDecisions?.join(',')} -> ${decision}`,
    );
    await rpc(phone, 'approval/resolve', { sessionId, requestId: request.requestId, decision });
  }
}

function logItems(phone: TestClient, sessionId: string, turnId: string): void {
  for (const e of eventsOf(phone, sessionId)) {
    if (e.method !== 'item/completed' || (e.params as { turnId: string }).turnId !== turnId) continue;
    const item = (e.params as { item: Record<string, unknown> }).item;
    step(`  item ${String(item.type)} ${String(item.status)} ${JSON.stringify(item.text ?? item.command ?? item.changes ?? item.tool ?? '').slice(0, 160)}`);
  }
}

function replyOf(phone: TestClient, sessionId: string, turnId: string): string {
  return eventsOf(phone, sessionId)
    .filter((e) => e.method === 'item/completed' && (e.params as { turnId: string }).turnId === turnId)
    .map((e) => (e.params as { item: { type: string; text?: string } }).item)
    .filter((item) => item.type === 'agentMessage')
    .map((item) => item.text)
    .join(' ');
}

/** Like `rpc`, but waits as long as a real engine may take (spawn, system/init). */
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
