// The keep-awake supervisor with an injected process spawner and power-source reader: no caffeinate or
// pmset runs here (the live check on a real Mac is in the commit message of the ticket that added it).
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAFFEINATE,
  KeepAwake,
  parsePmset,
  readPmset,
  spawnProcess,
  type ChildLike,
  type KeepAwakeOptions,
  type KeepAwakeStatus,
  type PowerSource,
} from './keep-awake.js';

class FakeChild extends EventEmitter implements ChildLike {
  killed: NodeJS.Signals[] = [];
  constructor(readonly args: readonly string[]) {
    super();
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
  started(): void {
    this.emit('spawn');
  }
  die(code = 1): void {
    this.emit('exit', code, null);
  }
}

interface Rig {
  keepAwake: KeepAwake;
  children: FakeChild[];
  changes: KeepAwakeStatus[];
  power: { source: PowerSource };
  logs: string[];
}

function rig(options: Partial<KeepAwakeOptions> = {}, autoStart = true): Rig {
  const children: FakeChild[] = [];
  const changes: KeepAwakeStatus[] = [];
  const power = { source: 'ac' as PowerSource };
  const logs: string[] = [];
  const keepAwake = new KeepAwake({
    setting: 'pluggedIn',
    pid: 4242,
    supported: true,
    spawn: (command, args) => {
      expect(command).toBe(CAFFEINATE);
      const child = new FakeChild(args);
      children.push(child);
      if (autoStart) queueMicrotask(() => child.started());
      return child;
    },
    readPower: async () => power.source,
    onChange: (status) => changes.push(status),
    log: (event) => logs.push(event),
    pollMs: 1_000,
    restartMs: 100,
    maxRestartMs: 400,
    ...options,
  });
  return { keepAwake, children, changes, power, logs };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KeepAwake', () => {
  it('with "pluggedIn" starts `caffeinate -s -w <host pid>` on boot and is active on AC power', async () => {
    const r = rig();
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: false, onBattery: false });
    await r.keepAwake.start();
    await flush();
    expect(r.children).toHaveLength(1);
    expect(r.children[0]!.args).toEqual(['-s', '-w', '4242']);
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: true, onBattery: false });
    expect(r.changes.at(-1)).toEqual({ setting: 'pluggedIn', active: true, onBattery: false });
    r.keepAwake.stop();
  });

  it('with "off" starts nothing, and still reports the power source', async () => {
    const r = rig({ setting: 'off' });
    r.power.source = 'battery';
    await r.keepAwake.start();
    await flush();
    expect(r.children).toHaveLength(0);
    expect(r.keepAwake.status()).toEqual({ setting: 'off', active: false, onBattery: true });
    r.keepAwake.stop();
  });

  it('restarts the child when it exits, with a doubling delay that resets after a long run', async () => {
    const r = rig();
    await r.keepAwake.start();
    await flush();
    r.children[0]!.die();
    expect(r.keepAwake.status().active).toBe(false);
    expect(r.changes.at(-1)).toEqual({ setting: 'pluggedIn', active: false, onBattery: false });
    await vi.advanceTimersByTimeAsync(99);
    expect(r.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.children).toHaveLength(2);
    expect(r.keepAwake.status().active).toBe(true);

    r.children[1]!.die(); // died at once again: twice the delay
    await vi.advanceTimersByTimeAsync(199);
    expect(r.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.children).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(10_000); // ran a long while: back to the short delay
    r.children[2]!.die();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.children).toHaveLength(4);
    expect(r.logs).toContain('keep_awake.exited');
    r.keepAwake.stop();
  });

  it('caps the restart delay, and treats a spawn error (no caffeinate) like an exit', async () => {
    const r = rig({}, false);
    await r.keepAwake.start();
    for (let i = 0; i < 5; i++) {
      r.children.at(-1)!.emit('error', new Error('spawn ENOENT'));
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(r.children).toHaveLength(6);
    expect(r.keepAwake.status().active).toBe(false);
    // A late exit after the error changes nothing.
    r.children[0]!.die();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.children.length).toBeGreaterThanOrEqual(6);
    r.keepAwake.stop();
  });

  it('retries when the spawner throws', async () => {
    let calls = 0;
    const r = rig({
      spawn: () => {
        calls += 1;
        throw new Error('EAGAIN');
      },
    });
    await r.keepAwake.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    expect(r.logs).toContain('keep_awake.spawn_failed');
    r.keepAwake.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  it('kills the child on host stop and does not restart it', async () => {
    const r = rig();
    await r.keepAwake.start();
    await flush();
    r.keepAwake.stop();
    expect(r.children[0]!.killed).toEqual(['SIGTERM']);
    expect(r.keepAwake.status().active).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.children).toHaveLength(1);
    expect(r.logs).toContain('keep_awake.released');
  });

  it('stop before the first power read finishes leaves no polling behind', async () => {
    let resolveRead: (s: PowerSource) => void = () => {};
    const r = rig({ readPower: () => new Promise((resolve) => (resolveRead = resolve)) });
    const started = r.keepAwake.start();
    r.keepAwake.stop();
    resolveRead('battery');
    await started;
    expect(r.keepAwake.status().onBattery).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reflects battery versus AC as the poll sees it, and is not active on battery', async () => {
    const r = rig();
    await r.keepAwake.start();
    await flush();
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: true, onBattery: false });
    r.power.source = 'battery';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: false, onBattery: true });
    expect(r.changes.at(-1)).toEqual({ setting: 'pluggedIn', active: false, onBattery: true });
    const count = r.changes.length;
    await vi.advanceTimersByTimeAsync(1_000); // no change, no notification
    expect(r.changes).toHaveLength(count);
    r.power.source = 'ac';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: true, onBattery: false });
    // The assertion stays held on battery (macOS ignores it there); no restart happened.
    expect(r.children).toHaveLength(1);
    r.keepAwake.stop();
  });

  it('a failing power reader counts as not on battery', async () => {
    const r = rig({ readPower: () => Promise.reject(new Error('pmset gone')) });
    await r.keepAwake.start();
    await flush();
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: true, onBattery: false });
    r.keepAwake.stop();
  });

  it('set() applies at once: "off" kills the child, "pluggedIn" starts a new one', async () => {
    const r = rig();
    await r.keepAwake.start();
    await flush();
    r.keepAwake.set('off');
    expect(r.children[0]!.killed).toEqual(['SIGTERM']);
    expect(r.keepAwake.status()).toEqual({ setting: 'off', active: false, onBattery: false });
    expect(r.changes.at(-1)).toEqual({ setting: 'off', active: false, onBattery: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.children).toHaveLength(1);
    r.keepAwake.set('off'); // same setting: nothing happens
    r.keepAwake.set('pluggedIn');
    await flush();
    expect(r.children).toHaveLength(2);
    expect(r.keepAwake.status().active).toBe(true);
    r.keepAwake.stop();
  });

  it('set() before start only records the setting; start() is idempotent', async () => {
    const r = rig({ setting: 'off' });
    r.keepAwake.set('pluggedIn');
    expect(r.children).toHaveLength(0);
    await r.keepAwake.start();
    await r.keepAwake.start();
    await flush();
    expect(r.children).toHaveLength(1);
    r.keepAwake.stop();
  });

  it('where caffeinate does not exist, spawns nothing and stays inactive', async () => {
    const r = rig({ supported: false });
    await r.keepAwake.start();
    await flush();
    expect(r.children).toHaveLength(0);
    expect(r.keepAwake.status()).toEqual({ setting: 'pluggedIn', active: false, onBattery: false });
    r.keepAwake.stop();
  });

  it('uses the real spawner and pmset reader by default', () => {
    const k = new KeepAwake({ setting: 'off' });
    expect(k.status().setting).toBe('off');
  });
});

describe('parsePmset', () => {
  it('reads the source pmset -g ps names', () => {
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t67%; AC attached; not charging present: true")).toBe('ac');
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging")).toBe('battery');
    expect(parsePmset("Now drawing from 'UPS Power'")).toBe('ac');
    expect(parsePmset('')).toBe('unknown');
  });
});

describe('real processes', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('spawnProcess runs a program and reports its exit', async () => {
    const child = spawnProcess(process.execPath, ['-e', 'process.exit(3)']);
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    expect(code).toBe(3);
  });

  it('readPmset answers a power source (unknown where pmset does not exist)', async () => {
    const source = await readPmset();
    expect(['ac', 'battery', 'unknown']).toContain(source);
    if (process.platform !== 'darwin') expect(source).toBe('unknown');
  });
});
