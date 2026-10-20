// Points a CodexConfig at the fake app-server with a fixture, and reads back what the fake received.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexConfig, type CodexConfig } from '../../../config/codex.js';
import type { FakeFixture, FakeLogEntry } from './fixture.js';

export const FAKE_APP_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-app-server.ts');

export interface FakeCodex {
  config: CodexConfig;
  dir: string;
  /** Every message the fake engines received, in order. */
  log(): FakeLogEntry[];
  /** Params of every request (or notification) of `method` the fake received. */
  sent(method: string): Record<string, unknown>[];
  /** Replies the host sent to the fake's server requests. */
  replies(): FakeLogEntry['message'][];
  /** Process ids of every fake engine that started. */
  pids(): number[];
}

export function fakeCodex(fixture: FakeFixture = {}, overrides: Partial<CodexConfig> = {}): FakeCodex {
  const dir = mkdtempSync(path.join(tmpdir(), 'nano-fake-codex-'));
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'log.jsonl');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const config = codexConfig(
    {
      binary: process.execPath,
      args: ['--no-warnings', FAKE_APP_SERVER, 'app-server'],
      home: path.join(dir, 'home'),
      env: { FAKE_CODEX_FIXTURE: fixturePath, FAKE_CODEX_STATE: path.join(dir, 'state.json'), FAKE_CODEX_LOG: logPath },
      requestTimeoutMs: 10_000,
      killGraceMs: 500,
      ...overrides,
    },
    {},
  );
  const log = (): FakeLogEntry[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as FakeLogEntry)
      : [];
  return {
    config,
    dir,
    log,
    sent: (method) => log().flatMap((e) => (e.message.method === method ? [e.message.params ?? {}] : [])),
    replies: () => log().flatMap((e) => (e.message.method === undefined ? [e.message] : [])),
    pids: () => [...new Set(log().map((e) => e.pid))],
  };
}

/** Resolves when `check` returns a value other than undefined (polls every 10 ms, up to `ms`). */
export async function until<T>(check: () => T | undefined, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
