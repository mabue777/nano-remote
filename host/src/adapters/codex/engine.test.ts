// The engine process wrapper on its own: handshake, timeouts, loss, and killing the process group.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Engine, type EngineHandlers } from './engine.js';
import { fakeCodex, until } from './testing/fake-codex.js';

const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.kill()));
});

function handlers(): EngineHandlers & { exits: string[]; logs: string[] } {
  const exits: string[] = [];
  const logs: string[] = [];
  return { exits, logs, onNotification() {}, onRequest() {}, onExit: (r) => exits.push(r), log: (m) => logs.push(m) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Engine', () => {
  it('runs the handshake with CODEX_HOME set and survives junk on stdout and stderr', async () => {
    const fake = fakeCodex({ noise: true });
    const h = handlers();
    const engine = new Engine(fake.config, h);
    engines.push(engine);
    const info = await engine.start();
    expect(info).toEqual({ userAgent: 'codex_cli_rs/0.0.0-fake (fake app-server)', codexHome: fake.config.home });
    await until(() => (fake.log().length === 2 ? true : undefined), 'initialized logged');
    expect(fake.log().map((e) => e.message)).toEqual([
      { id: 1, method: 'initialize', params: expect.any(Object) },
      { method: 'initialized' },
    ]);
    await until(() => (h.logs.some((l) => l.includes('unparsable line')) && h.logs.some((l) => l.includes('warming up')) ? true : undefined), 'logs');
    expect(engine.alive).toBe(true);
  });

  it('a call the engine never answers times out as agent_unavailable', async () => {
    const fake = fakeCodex({ ignore: ['model/list'] });
    const engine = new Engine(fake.config, handlers());
    engines.push(engine);
    await engine.start();
    fake.config.requestTimeoutMs = 100;
    await expect(engine.call('model/list')).rejects.toMatchObject({
      code: 'agent_unavailable',
      data: { agentId: 'codex', reason: 'model/list timed out after 100 ms' },
    });
    // Answers to unknown ids are ignored.
    expect(engine.alive).toBe(true);
  });

  it('a userAgent-less initialize result is tolerated', async () => {
    const dir = fakeCodex().dir;
    const script = path.join(dir, 'bare.mjs');
    writeFileSync(
      script,
      `process.stdin.on('data', (d) => { for (const l of String(d).split('\\n')) { if (!l) continue; const m = JSON.parse(l);
         if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, error: { code: 5 } }) + '\\n');
         else if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: null }) + '\\n'); } });`,
    );
    const engine = new Engine({ ...fakeCodex().config, args: [script] }, handlers());
    engines.push(engine);
    expect(await engine.start()).toEqual({ userAgent: '' });
    await expect(engine.call('model/list')).rejects.toThrow('model/list failed: {"code":5}');
  });

  it('kill sends SIGKILL to a process group that ignores SIGTERM', async () => {
    const dir = fakeCodex().dir;
    const script = path.join(dir, 'stubborn.mjs');
    writeFileSync(
      script,
      `process.on('SIGTERM', () => {});
       process.stdin.on('data', (d) => { const m = JSON.parse(String(d).split('\\n')[0]); process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: 'x/1' } }) + '\\n'); });`,
    );
    const h = handlers();
    const engine = new Engine({ ...fakeCodex().config, args: [script], killGraceMs: 100 }, h);
    await engine.start();
    const pid = engine.pid!;
    const started = Date.now();
    await engine.kill();
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(alive(pid)).toBe(false);
    expect(h.exits).toEqual([]);
    await expect(engine.call('x')).rejects.toMatchObject({ code: 'agent_unavailable', data: { reason: 'killed by the host' } });
    expect(() => engine.notify('x')).toThrow(/killed by the host/);
    // Killing twice, or an engine that never started, is fine.
    await engine.kill();
    await new Engine(fakeCodex().config, handlers()).kill();
  });

  it('an exit reports the reason once', async () => {
    const fake = fakeCodex({ exitOn: 'model/list' });
    const h = handlers();
    const engine = new Engine(fake.config, h);
    engines.push(engine);
    await engine.start();
    await expect(engine.call('model/list')).rejects.toMatchObject({ code: 'agent_unavailable' });
    await until(() => (h.exits.length > 0 ? true : undefined), 'exit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]).toMatch(/code 3|closed its stdout/);
    expect(engine.alive).toBe(false);
  });
});
