// Live: the pi adapter against the real pi (~/.local/bin/pi, or NANO_PI_BIN), through the whole session
// core. Runs only with NANO_LIVE_PI=1; never in the gate (it needs the operator's pi setup, the local
// llama.cpp server on 127.0.0.1:8080, and for the OpenRouter case real credit; the prompts are tiny).
//
//   NANO_LIVE_PI=1 pnpm -C host exec vitest run src/adapters/pi/live.test.ts
//
// Steps are printed and appended to $NANO_LIVE_PI_LOG (default $TMPDIR/nano-live-pi.log).
//
//   1. llamacpp/bonsai-27b: write hello.txt; the write arrives as an approval, accepted; the file exists and
//      the turn completes. The 27B reads its first prompt slowly (minutes): the timeouts are generous.
//   2. llamacpp/bonsai-27b: the same request declined (every approval); no file, the turn still ends.
//   3. One OpenRouter model (NANO_LIVE_PI_OPENROUTER_MODEL, else a cheap default), the accept case, when
//      `pi --list-models openrouter` lists models; skipped with a message otherwise.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JournalEvent } from '../../journal/types.js';
import type { TestClient } from '../../stream/testing/client.js';
import { eventsOf, rpc, startHarness, text, type Harness } from '../../core/testing/harness.js';
import { childPath, piConfig } from '../../config/pi.js';
import { PiAgent } from './provider.js';
import { until } from './testing/fake-pi-config.js';

const LIVE = process.env.NANO_LIVE_PI === '1';
/** NANO_LIVE_PI_MODEL overrides it (a fast cloud model to check the host path quickly). */
const LOCAL_MODEL = process.env.NANO_LIVE_PI_MODEL ?? 'llamacpp/bonsai-27b';
/** Cheap OpenRouter models that call tools, in order of preference (no anthropic/*: operator rule). */
const OPENROUTER_PREFERRED = ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash', 'google/gemini-3.1-flash-lite'];
const TURN_MS = 15 * 60_000;
const PROMPT =
  'Use the write tool to create a file named hello.txt in the current directory containing exactly the word hello. Do not use any other tool. Then reply with the single word done.';

const started = Date.now();
const LOG_FILE = process.env.NANO_LIVE_PI_LOG ?? path.join(tmpdir(), 'nano-live-pi.log');
function step(message: string): void {
  const line = `[live pi +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

let harness: Harness | undefined;
let phone: TestClient;
let keepAlive: NodeJS.Timeout | undefined;
let models: { id: string; displayName: string; default: boolean; provider?: string }[] = [];

describe.skipIf(!LIVE)('pi adapter, live against the real pi', () => {
  beforeAll(async () => {
    const agent = new PiAgent({
      log: (m) => {
        if (!m.startsWith('pi stderr') || process.env.NANO_LIVE_PI_VERBOSE) step(`  pi: ${m.slice(0, 300)}`);
      },
    });
    harness = await startHarness({ extraAgents: [agent] });
    phone = await harness.connect();
    // Like the web app: a ping every 30 s, or the host closes the stream after 90 s without one (a slow
    // first prompt on the 27B is silent for minutes).
    keepAlive = setInterval(() => phone.ping(), 30_000);
    ({ models } = await slowRpc<{ models: typeof models }>(phone, 'model/list', { agentId: 'pi' }));
    await until(() => agent.state().version, 'pi --version', 30_000);
    const { agents } = await rpc<{ agents: { id: string }[] }>(phone, 'agent/list');
    const providers = [...new Set(models.map((m) => m.provider))];
    step(`agent ${JSON.stringify(agents.find((a) => a.id === 'pi'))}; ${models.length} models from providers ${providers.join(', ')}; default ${models.find((m) => m.default)?.id}`);
  }, 120_000);

  afterAll(async () => {
    clearInterval(keepAlive);
    await harness?.close();
  });

  it(
    `${LOCAL_MODEL}: the write is an approval; accepted, hello.txt exists and the turn completes`,
    async () => {
      expect(models.find((m) => m.id === LOCAL_MODEL)).toMatchObject({ provider: LOCAL_MODEL.split('/')[0] });
      const result = await writeHello(LOCAL_MODEL, 'accept');
      expect(result.approvals[0]).toMatchObject({ kind: 'fileChange' });
      expect(result.status).toBe('completed');
      expect(readFileSync(path.join(result.cwd, 'hello.txt'), 'utf8').trim()).toBe('hello');
    },
    TURN_MS,
  );

  it(
    `${LOCAL_MODEL}: declined, no hello.txt and the turn still ends`,
    async () => {
      const result = await writeHello(LOCAL_MODEL, 'decline');
      expect(result.approvals.length).toBeGreaterThan(0);
      expect(['completed', 'failed']).toContain(result.status);
      expect(existsSync(path.join(result.cwd, 'hello.txt'))).toBe(false);
    },
    TURN_MS,
  );

  it(
    'one OpenRouter model: the accept case',
    async (context) => {
      const listed = await listOpenRouter();
      const offered = models.filter((m) => m.provider === 'openrouter' && !m.id.startsWith('openrouter/anthropic/') && !m.id.includes('~anthropic/'));
      if (listed.length === 0 || offered.length === 0) {
        step(`OpenRouter: skipped, pi --list-models openrouter lists ${listed.length} models and pi offers ${offered.length} with credentials`);
        context.skip();
      }
      const wanted = process.env.NANO_LIVE_PI_OPENROUTER_MODEL;
      const model =
        (wanted !== undefined ? offered.find((m) => m.id === `openrouter/${wanted}`) : undefined) ??
        OPENROUTER_PREFERRED.map((id) => offered.find((m) => m.id === `openrouter/${id}`)).find((m) => m !== undefined) ??
        offered[0]!;
      step(`OpenRouter: ${listed.length} models listed; using ${model.id}`);
      const result = await writeHello(model.id, 'accept');
      expect(result.approvals[0]).toMatchObject({ kind: 'fileChange' });
      expect(result.status).toBe('completed');
      expect(readFileSync(path.join(result.cwd, 'hello.txt'), 'utf8').trim()).toBe('hello');
    },
    TURN_MS,
  );
});

interface Outcome {
  cwd: string;
  status: string;
  approvals: Record<string, unknown>[];
}

/** A new session on `model` in a fresh temp folder; one turn asking for hello.txt, every approval answered with `decision`. */
async function writeHello(model: string, decision: 'accept' | 'decline'): Promise<Outcome> {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'nano-live-pi-')));
  const { session } = await slowRpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
    agentId: 'pi',
    cwd,
    settings: { model },
  });
  const sessionId = session.sessionId;
  await rpc(phone, 'session/open', { sessionId });
  const t0 = Date.now();
  const { turn } = await slowRpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text(PROMPT), clientMessageId: randomUUID() });
  step(`${model} ${decision}: session ${sessionId} settings=${JSON.stringify(session.settings)} turn ${turn.turnId} cwd=${cwd}`);
  const approvals: Record<string, unknown>[] = [];
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
      TURN_MS,
    );
    if (next.method === 'turn/completed') break;
    const request = (next.params as { request: Record<string, unknown> & { requestId: string; kind: string } }).request;
    answered.add(request.requestId);
    if (next.method === 'input/request') throw new Error(`unexpected question: ${JSON.stringify(request)}`);
    approvals.push(request);
    step(
      `${model} ${decision}: approval/request after ${((Date.now() - t0) / 1000).toFixed(0)} s kind=${request.kind} ${JSON.stringify(request.changes ?? request.command ?? request.permissions).slice(0, 200)} -> ${decision}`,
    );
    await rpc(phone, 'approval/resolve', { sessionId, requestId: request.requestId, decision });
  }
  const events = eventsOf(phone, sessionId);
  const final = finalTurn(events, turn.turnId);
  for (const e of events) {
    if (e.method !== 'item/completed') continue;
    const item = (e.params as { item: Record<string, unknown> }).item;
    step(`  item ${String(item.type)} ${String(item.status)} ${JSON.stringify(item.text ?? item.command ?? item.changes ?? item.tool ?? '').slice(0, 160)}`);
  }
  const usage = events.filter((e) => e.method === 'usage/updated').at(-1);
  step(
    `${model} ${decision}: turn/completed status=${final.status} error=${JSON.stringify(final.error)} after ${((Date.now() - t0) / 1000).toFixed(0)} s; approvals=${approvals.length}; hello.txt ${existsSync(path.join(cwd, 'hello.txt')) ? 'exists' : 'absent'}; usage ${JSON.stringify((usage?.params as { usage?: unknown } | undefined)?.usage)}`,
  );
  return { cwd, status: final.status, approvals };
}

/** The model ids `pi --list-models openrouter` prints (the table's second column). */
function listOpenRouter(): Promise<string[]> {
  const config = piConfig();
  return new Promise((resolve) => {
    execFile(config.binary, ['--list-models', 'openrouter'], { env: { ...process.env, PATH: childPath(process.env.PATH) }, timeout: 60_000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        String(stdout)
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter((cols) => cols[0] === 'openrouter' && cols[1] !== undefined)
          .map((cols) => cols[1]!),
      );
    });
  });
}

/** Like `rpc`, but waits as long as a real pi may take (spawn, set_model, a slow first prompt). */
async function slowRpc<T>(client: TestClient, method: string, params: Record<string, unknown>): Promise<T> {
  const id = client.request(method, params);
  const response = await until(() => client.messages.find((m) => m.id === id && !('method' in m)), `response to ${method}`, TURN_MS);
  if ('error' in response) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result as T;
}

function finalTurn(events: JournalEvent[], turnId: string): { status: string; error: unknown } {
  const event = events.find((e) => e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === turnId)!;
  return (event.params as { turn: { status: string; error: unknown } }).turn;
}
