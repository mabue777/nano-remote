// Test harness for the session core: a real StreamServer and Journal on loopback with FakeAgents, and
// helpers to read a client's Journal events and responses.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Journal } from '../../journal/journal.js';
import type { JournalEvent } from '../../journal/types.js';
import { MAX_MESSAGE_BYTES } from '../../stream/constants.js';
import { MethodRegistry } from '../../stream/router.js';
import { StreamServer } from '../../stream/server.js';
import { TestClient } from '../../stream/testing/client.js';
import type { AgentProvider } from '../adapter.js';
import { HostCore, type HostCoreOptions } from '../host-core.js';
import { FakeAgent, type FakeAgentOptions } from './fake-adapter.js';

export const HOST = { hostId: 'host_test', name: 'test-host', version: '0.0.0', os: 'darwin', arch: 'arm64' };

/** token -> clientId */
export const DEVICES: Record<string, string> = { 'good-token': 'dev_test', 'other-token': 'dev_other' };

export interface Harness {
  journal: Journal;
  agent: FakeAgent;
  core: HostCore;
  server: StreamServer;
  /** A fresh working folder for sessions. */
  cwd: string;
  /** Connects and finishes the handshake (initialize + initialized). */
  connect(token?: string, initialize?: Record<string, unknown>): Promise<TestClient>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  agent?: FakeAgentOptions;
  extraAgents?: AgentProvider[];
  journal?: Journal;
  core?: Partial<HostCoreOptions>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const journal = options.journal ?? new Journal({ path: ':memory:' });
  const agent = new FakeAgent(options.agent);
  const core = new HostCore({
    journal,
    agents: [agent, ...(options.extraAgents ?? [])],
    host: HOST,
    uptime: () => 42,
    ...options.core,
  });
  const registry = core.register(
    new MethodRegistry().register('initialize', (_params, context) => ({
      protocolVersion: 1,
      host: HOST,
      device: { clientId: context.clientId, displayName: 'Test' },
      agents: [],
      push: { vapidPublicKey: 'k', subscribed: false },
      limits: { maxMessageBytes: MAX_MESSAGE_BYTES, snapshotTurns: 5 },
    })),
  );
  const server = new StreamServer({ authenticate: (token) => DEVICES[token] ?? null, registry });
  await server.listen();
  core.attach(server);
  const clients: TestClient[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), 'nano-core-'));
  return {
    journal,
    agent,
    core,
    server,
    cwd,
    async connect(token = 'good-token', initialize = {}) {
      const client = await TestClient.connect(server.url, { token, clientId: DEVICES[token] });
      clients.push(client);
      await client.handshake(initialize);
      // A round trip after `initialized`: the host has processed it, so the stream is ready for broadcasts.
      await client.call('agent/list');
      return client;
    },
    async close() {
      for (const client of clients) client.close();
      await core.close();
      await server.close();
      journal.close();
    },
  };
}

/** Journal events a client received live, optionally of one session. */
export function eventsOf(client: TestClient, sessionId?: string): JournalEvent[] {
  return client.messages.filter((m): m is JournalEvent & Record<string, unknown> => {
    const params = m.params as { sessionId?: unknown; seq?: unknown } | undefined;
    return (
      typeof m.method === 'string' &&
      typeof params?.seq === 'number' &&
      (sessionId === undefined || params.sessionId === sessionId)
    );
  }) as JournalEvent[];
}

/** Waits for a live Journal event matching `method` (and `match`), returns it. */
export function waitEvent(
  client: TestClient,
  method: string,
  match: (params: Record<string, unknown>) => boolean = () => true,
): Promise<JournalEvent> {
  return client.until(
    () => eventsOf(client).find((e) => e.method === method && match(e.params as Record<string, unknown>)),
    `event ${method}`,
  );
}

interface OpenedTurns {
  turns: { turnId: string; status: string; items: { type: string; text?: string }[] }[];
}

/**
 * Opens a session and returns its snapshot once the given turn has finished, whatever the timing.
 * A turn started by session/start may finish before the client subscribes; the snapshot then already
 * shows it, and no live turn/completed will come. Otherwise the open subscribes this client in the same
 * tick, so the live event cannot be missed; wait for it and read the snapshot again.
 */
export async function openAfterTurn<T extends OpenedTurns = OpenedTurns>(
  client: TestClient,
  sessionId: string,
  turnId: string,
): Promise<T> {
  const finished = (snapshot: T) => snapshot.turns.some((t) => t.turnId === turnId && t.status !== 'inProgress');
  const first = await rpc<T>(client, 'session/open', { sessionId });
  if (finished(first)) return first;
  await waitEvent(client, 'turn/completed', (p) => (p.turn as { turnId?: string } | undefined)?.turnId === turnId);
  return rpc<T>(client, 'session/open', { sessionId });
}

/** Sends a request; resolves with `result`, rejects with an Error carrying `code` and `data`. */
export async function rpc<T = Record<string, unknown>>(
  client: TestClient,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const response = await client.call(method, params);
  if ('error' in response) {
    const body = response.error as { code: string; message: string; data?: unknown };
    throw Object.assign(new Error(`${method}: ${body.code} ${body.message}`), { code: body.code, data: body.data });
  }
  return response.result as T;
}

/** The error body of a request that must fail. */
export async function rpcError(
  client: TestClient,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ code: string; message: string; data?: Record<string, unknown> }> {
  const response = await client.call(method, params);
  if (!('error' in response)) throw new Error(`${method} succeeded: ${JSON.stringify(response.result)}`);
  return response.error as { code: string; message: string; data?: Record<string, unknown> };
}

export const text = (value: string) => [{ type: 'text' as const, text: value }];
