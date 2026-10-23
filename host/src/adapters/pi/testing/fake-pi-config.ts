// Points a PiConfig at the fake pi with a fixture, and reads back what the fake received.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { piConfig, type PiConfig } from '../../../config/pi.js';
import type { FakePiFixture, FakePiLogEntry } from './fixture.js';

export const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-pi.ts');

export interface FakePi {
  config: PiConfig;
  /** A scratch folder for the test; `cwd` is an empty session folder inside it. */
  dir: string;
  cwd: string;
  log(): FakePiLogEntry[];
  /** Every command of `type` the fake received. */
  sent(type: string): Record<string, unknown>[];
  /** The command lines the fake processes started with (pi's own arguments). */
  argvs(): string[][];
  /** Process ids of every fake pi that started. */
  pids(): number[];
}

export function fakePi(fixture: FakePiFixture = {}, overrides: Partial<PiConfig> = {}): FakePi {
  const dir = mkdtempSync(path.join(tmpdir(), 'nano-fake-pi-'));
  const cwd = path.join(dir, 'work');
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'log.jsonl');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  mkdirSync(cwd);
  const config = piConfig(
    {
      binary: process.execPath,
      args: ['--no-warnings', FAKE_PI],
      env: { FAKE_PI_FIXTURE: fixturePath, FAKE_PI_STATE: path.join(dir, 'state.json'), FAKE_PI_LOG: logPath },
      requestTimeoutMs: 10_000,
      killGraceMs: 500,
      ...overrides,
    },
    {},
  );
  const log = (): FakePiLogEntry[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as FakePiLogEntry)
      : [];
  return {
    config,
    dir,
    cwd,
    log,
    sent: (type) => log().flatMap((e) => (e.record?.type === type ? [e.record] : [])),
    argvs: () => log().flatMap((e) => (e.argv ? [e.argv] : [])),
    pids: () => [...new Set(log().map((e) => e.pid))],
  };
}

/** Resolves when `check` returns a value other than undefined (polls every 10 ms, up to `ms`). */
export async function until<T>(check: () => T | undefined, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
