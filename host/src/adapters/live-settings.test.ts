// Live: session/settings/update against the real engines, through the whole session core (spec 6). For
// each agent a session starts on model A, runs one turn, switches to model B, and runs a second turn; the
// engine's own record says which model answered each turn. Runs only with NANO_LIVE_SETTINGS=1; never in
// the gate (it needs the operator's logins and spends real tokens; the prompts are tiny).
//
//   NANO_LIVE_SETTINGS=1 pnpm -C host exec vitest run src/adapters/live-settings.test.ts
//   NANO_LIVE_SETTINGS_AGENTS=pi ...   (a comma list of codex, claude, pi; default all three)
//
// Steps are printed and appended to $NANO_LIVE_SETTINGS_LOG (default $TMPDIR/nano-live-settings.log).
// Evidence per engine:
// - Codex: the thread's rollout file in its home (sessions/**/rollout-*-<thread id>.jsonl) has one
//   `turn_context` per turn with the model and effort the turn ran with.
// - Claude Code: every assistant message carries the API model id (`message.model`), read off the query.
// - pi: its session file (~/.pi/agent/sessions/<folder>/*_<session id>.jsonl) has the model on every
//   assistant message.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { codexConfig } from '../config/codex.js';
import type { AgentProvider } from '../core/adapter.js';
import { eventsOf, rpc, startHarness, text, type Harness } from '../core/testing/harness.js';
import type { TestClient } from '../stream/testing/client.js';
import { loadQuery, type QueryFn } from './claude/adapter.js';
import { ClaudeAgent } from './claude/provider.js';
import { CodexAgent } from './codex/provider.js';
import { until } from './codex/testing/fake-codex.js';
import { PiAgent } from './pi/provider.js';

const LIVE = process.env.NANO_LIVE_SETTINGS === '1';
const AGENTS = (process.env.NANO_LIVE_SETTINGS_AGENTS ?? 'codex,claude,pi').split(',');
const STEP_MS = 300_000;
const PI_MODELS = [process.env.NANO_LIVE_SETTINGS_PI_A ?? 'ollama/kimi-k3:cloud', process.env.NANO_LIVE_SETTINGS_PI_B ?? 'ollama/glm-5.2:cloud'] as const;

const started = Date.now();
const LOG_FILE = process.env.NANO_LIVE_SETTINGS_LOG ?? path.join(tmpdir(), 'nano-live-settings.log');
function step(message: string): void {
  const line = `[live settings +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

const harnesses: Harness[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
});

async function slowRpc<T>(client: TestClient, method: string, params: Record<string, unknown>): Promise<T> {
  const id = client.request(method, params);
  const response = await until(() => client.messages.find((m) => m.id === id && !('method' in m)), `response to ${method}`, STEP_MS);
  if ('error' in response) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result as T;
}

/** Runs one turn to its end and returns its final status. */
async function turn(phone: TestClient, sessionId: string, prompt: string): Promise<string> {
  const { turn: started } = await slowRpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text(prompt), clientMessageId: randomUUID() });
  const done = await until(
    () =>
      eventsOf(phone, sessionId).find(
        (e) => e.method === 'turn/completed' && (e.params as { turn: { turnId: string } }).turn.turnId === started.turnId,
      ),
    `turn ${started.turnId} completed`,
    STEP_MS,
  );
  const final = (done.params as { turn: { status: string; error: unknown } }).turn;
  const reply = eventsOf(phone, sessionId)
    .filter((e) => e.method === 'item/completed')
    .map((e) => (e.params as { item: { type: string; turnId: string; text?: string } }).item)
    .filter((item) => item.type === 'agentMessage' && item.turnId === started.turnId)
    .map((item) => item.text)
    .join(' ');
  step(`  turn ${started.turnId}: ${final.status} ${final.error ? JSON.stringify(final.error) : ''} reply=${JSON.stringify(reply.slice(0, 80))}`);
  return final.status;
}

/** Start on model A, one turn, switch to B, one more turn; returns the session id and folder. */
async function switchOnce(agent: AgentProvider, from: string, to: string): Promise<{ sessionId: string; cwd: string; harness: Harness }> {
  const harness = await startHarness({ extraAgents: [agent] });
  harnesses.push(harness);
  const phone = await harness.connect();
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), `nano-live-settings-${agent.id}-`)));
  const { agents } = await rpc<{ agents: { id: string; version?: string; capabilities?: { settingsUpdate?: string[] } }[] }>(phone, 'agent/list');
  const listed = agents.find((a) => a.id === agent.id);
  step(`${agent.id}: version ${listed?.version} settingsUpdate ${JSON.stringify(listed?.capabilities?.settingsUpdate)}`);
  const { session } = await slowRpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
    agentId: agent.id,
    cwd,
    settings: { model: from },
  });
  const sessionId = session.sessionId;
  await rpc(phone, 'session/open', { sessionId });
  step(`${agent.id}: session ${sessionId} on ${from}; settings ${JSON.stringify(session.settings)}`);
  expect(await turn(phone, sessionId, 'Reply with the single word one.')).toBe('completed');
  const updated = await rpc<{ session: { settings: Record<string, unknown> } }>(phone, 'session/settings/update', { sessionId, settings: { model: to } });
  step(`${agent.id}: session/settings/update {model: ${to}} -> settings ${JSON.stringify(updated.session.settings)}`);
  expect(updated.session.settings.model).toBe(to);
  expect(await turn(phone, sessionId, 'Reply with the single word two.')).toBe('completed');
  step(`${agent.id}: settings after the second turn ${JSON.stringify(harness.core.sessions.session(sessionId).settings)}`);
  return { sessionId, cwd, harness };
}

/** Every file under `dir` (recursively) whose name passes `match`. */
function filesUnder(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, match));
    else if (match(entry.name)) out.push(full);
  }
  return out;
}

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe.skipIf(!LIVE)('session/settings/update, live against the real engines', () => {
  it.skipIf(!AGENTS.includes('codex'))(
    'Codex: the second turn runs on the new model (turn_context in the rollout)',
    async () => {
      const agent = new CodexAgent();
      const models = (await agent.models()).map((m) => m.id);
      const from = (await agent.models()).find((m) => m.default)?.id ?? models[0]!;
      const to = process.env.NANO_LIVE_SETTINGS_CODEX_B ?? models.find((id) => id !== from)!;
      step(`codex: models ${models.join(', ')}; switching ${from} -> ${to}`);
      const { sessionId, harness } = await switchOnce(agent, from, to);
      const threadId = harness.core.sessions.store.get(sessionId).engineSessionId;
      const [rollout] = filesUnder(path.join(codexConfig().home, 'sessions'), (name) => name.includes(threadId) && name.endsWith('.jsonl'));
      const contexts = lines(rollout!)
        .filter((line) => line.type === 'turn_context')
        .map((line) => line.payload as { model?: string; effort?: string });
      step(`codex: rollout ${rollout} turn_context ${JSON.stringify(contexts.map((c) => ({ model: c.model, effort: c.effort })))}`);
      expect(contexts.map((c) => c.model)).toEqual([from, to]);
    },
    2 * STEP_MS,
  );

  it.skipIf(!AGENTS.includes('claude'))(
    'Claude Code: the second turn runs on the new model (assistant message.model)',
    async () => {
      const real = await loadQuery();
      const answered: string[] = [];
      // Reads every assistant message's model off the query, as the adapter iterates it.
      const query: QueryFn = (params) => {
        const q = real(params);
        const iterate = q[Symbol.asyncIterator].bind(q);
        return Object.assign(q, {
          async *[Symbol.asyncIterator]() {
            for await (const message of { [Symbol.asyncIterator]: iterate } as AsyncIterable<SDKMessage>) {
              if (message.type === 'assistant' && message.parent_tool_use_id === null) answered.push(message.message.model);
              yield message;
            }
          },
        });
      };
      const agent = new ClaudeAgent({ query });
      const { sessionId, harness } = await switchOnce(agent, 'haiku', 'opus');
      const engineId = harness.core.sessions.store.get(sessionId).engineSessionId;
      step(`claude: engine session ${engineId}; assistant models in order ${JSON.stringify(answered)}`);
      expect(answered.length).toBeGreaterThanOrEqual(2);
      expect(answered[0]).toMatch(/haiku/);
      expect(answered.at(-1)).toMatch(/opus/);
    },
    2 * STEP_MS,
  );

  it.skipIf(!AGENTS.includes('pi'))(
    'pi: the second turn runs on the new model (assistant messages in the session file)',
    async () => {
      const agent = new PiAgent();
      const [from, to] = PI_MODELS;
      const { sessionId, harness } = await switchOnce(agent, from, to);
      const piSession = harness.core.sessions.store.get(sessionId).engineSessionId;
      const [file] = filesUnder(path.join(homedir(), '.pi', 'agent', 'sessions'), (name) => name.endsWith(`_${piSession}.jsonl`));
      const replies = lines(file!)
        .map((line) => line.message as { role?: string; provider?: string; model?: string } | undefined)
        .filter((message) => message?.role === 'assistant')
        .map((message) => `${message!.provider}/${message!.model}`);
      step(`pi: session file ${file} assistant models ${JSON.stringify(replies)}`);
      expect(replies[0]).toBe(from);
      expect(replies.at(-1)).toBe(to);
    },
    2 * STEP_MS,
  );
});
