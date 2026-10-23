// Keeps this Mac awake while it is plugged in, so a phone away from home can still reach the host
// (protocol-v1.md section 4, `keepAwake`). A sleeping Mac drops off the tailnet.
//
// With the setting `pluggedIn` the host runs `/usr/bin/caffeinate -s -w <host pid>` as a supervised child:
// `-s` holds a PreventSystemSleep assertion that macOS honours on AC power only, `-w` ends it when the
// host process dies (even on a crash). The display may still sleep, and a closed lid without an external
// display still sleeps (a macOS rule). The child is restarted with a backoff when it exits on its own and
// killed when the setting turns `off` or the host stops. The power source comes from `pmset -g ps`,
// polled lightly; `active` is true only while the child runs and the Mac is on AC power.
import { execFile, spawn } from 'node:child_process';

import type { KeepAwakeSetting, KeepAwakeStatus } from '../generated/common.js';

export type { KeepAwakeSetting, KeepAwakeStatus };

export const KEEP_AWAKE_SETTINGS: readonly KeepAwakeSetting[] = ['pluggedIn', 'off'];
export const DEFAULT_KEEP_AWAKE: KeepAwakeSetting = 'pluggedIn';

export const CAFFEINATE = '/usr/bin/caffeinate';
export const PMSET = '/usr/bin/pmset';
/** How often the power source is read. */
export const DEFAULT_POWER_POLL_MS = 60_000;
/** First restart delay after the child exits; doubles up to the maximum, resets once a child ran a while. */
export const DEFAULT_RESTART_MS = 1_000;
export const MAX_RESTART_MS = 60_000;

export type PowerSource = 'ac' | 'battery' | 'unknown';

/** The parts of a ChildProcess the supervisor uses. */
export interface ChildLike {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type Spawner = (command: string, args: readonly string[]) => ChildLike;
export type PowerReader = () => Promise<PowerSource>;

/** Starts a detached-from-stdio child (stdout and stderr ignored). */
export const spawnProcess: Spawner = (command, args) => spawn(command, [...args], { stdio: 'ignore' });

/** "Now drawing from 'AC Power'" or "'Battery Power'" (UPS counts as AC: it is not the internal battery). */
export function parsePmset(output: string): PowerSource {
  const match = /drawing from '([^']+)'/.exec(output);
  if (!match) return 'unknown';
  return /battery/i.test(match[1]!) ? 'battery' : 'ac';
}

/** Reads the power source with `pmset -g ps`; `unknown` when it cannot be read. */
export const readPmset: PowerReader = () =>
  new Promise((resolve) => {
    execFile(PMSET, ['-g', 'ps'], { timeout: 5_000 }, (error, stdout) => resolve(error ? 'unknown' : parsePmset(String(stdout))));
  });

export interface KeepAwakeOptions {
  setting: KeepAwakeSetting;
  /** The process the assertion follows (`-w`). Default: this process. */
  pid?: number;
  spawn?: Spawner;
  readPower?: PowerReader;
  /** False where caffeinate does not exist (not macOS): the setting is kept, nothing is spawned. */
  supported?: boolean;
  pollMs?: number;
  restartMs?: number;
  maxRestartMs?: number;
  /** Called whenever status() changes. */
  onChange?: (status: KeepAwakeStatus) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class KeepAwake {
  private setting: KeepAwakeSetting;
  private readonly pid: number;
  private readonly spawnChild: Spawner;
  private readonly readPower: PowerReader;
  private readonly supported: boolean;
  private readonly pollMs: number;
  private readonly restartMs: number;
  private readonly maxRestartMs: number;
  private readonly onChange: (status: KeepAwakeStatus) => void;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;

  private child: ChildLike | undefined;
  private held = false;
  private power: PowerSource = 'unknown';
  private running = false;
  private restartDelay: number;
  private restartTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private last: string;

  constructor(options: KeepAwakeOptions) {
    this.setting = options.setting;
    this.pid = options.pid ?? process.pid;
    this.spawnChild = options.spawn ?? spawnProcess;
    this.readPower = options.readPower ?? readPmset;
    this.supported = options.supported ?? process.platform === 'darwin';
    this.pollMs = options.pollMs ?? DEFAULT_POWER_POLL_MS;
    this.restartMs = options.restartMs ?? DEFAULT_RESTART_MS;
    this.maxRestartMs = options.maxRestartMs ?? MAX_RESTART_MS;
    this.onChange = options.onChange ?? (() => {});
    this.log = options.log ?? (() => {});
    this.restartDelay = this.restartMs;
    this.last = JSON.stringify(this.status());
  }

  status(): KeepAwakeStatus {
    const onBattery = this.power === 'battery';
    return { setting: this.setting, active: this.setting === 'pluggedIn' && this.held && !onBattery, onBattery };
  }

  /** Starts the assertion (for `pluggedIn`) and the power-source polling; resolves after the first read. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.setting === 'pluggedIn') this.launch();
    await this.poll();
    if (!this.running) return;
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
    this.pollTimer.unref();
  }

  /** Applies a new setting at once: starts or ends the assertion. */
  set(setting: KeepAwakeSetting): void {
    if (setting === this.setting) return;
    this.setting = setting;
    this.log('keep_awake.setting', { setting });
    if (this.running) {
      if (setting === 'pluggedIn') {
        this.restartDelay = this.restartMs;
        this.launch();
      } else this.end();
    }
    this.changed();
  }

  /** Ends the assertion and the polling (host shutdown). */
  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.end();
  }

  private async poll(): Promise<void> {
    let power: PowerSource;
    try {
      power = await this.readPower();
    } catch {
      power = 'unknown';
    }
    if (!this.running || power === this.power) return;
    this.power = power;
    this.log('keep_awake.power', { power });
    this.changed();
  }

  private launch(): void {
    if (!this.supported || this.child) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const startedAt = Date.now();
    let child: ChildLike;
    try {
      child = this.spawnChild(CAFFEINATE, ['-s', '-w', String(this.pid)]);
    } catch (error) {
      this.log('keep_awake.spawn_failed', { error: error instanceof Error ? error.message : String(error) });
      this.scheduleRestart(startedAt);
      return;
    }
    this.child = child;
    let gone = false;
    const exited = (fields: Record<string, unknown>): void => {
      if (gone) return;
      gone = true;
      if (this.child !== child) return; // ended on purpose
      this.child = undefined;
      this.held = false;
      this.log('keep_awake.exited', fields);
      this.changed();
      this.scheduleRestart(startedAt);
    };
    child.once('spawn', () => {
      if (this.child !== child) return;
      this.held = true;
      this.log('keep_awake.held', { pid: this.pid });
      this.changed();
    });
    child.once('exit', (code, signal) => exited({ code, signal }));
    child.once('error', (error) => exited({ error: error.message }));
  }

  private scheduleRestart(startedAt: number): void {
    if (!this.running || this.setting !== 'pluggedIn') return;
    // A child that ran for a while died of something new: start over from the short delay.
    if (Date.now() - startedAt > this.maxRestartMs) this.restartDelay = this.restartMs;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, this.maxRestartMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.running && this.setting === 'pluggedIn') this.launch();
    }, delay);
    this.restartTimer.unref();
  }

  private end(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.child = undefined;
    const wasHeld = this.held;
    this.held = false;
    if (child) {
      child.kill('SIGTERM');
      this.log('keep_awake.released', {});
    }
    if (wasHeld) this.changed();
  }

  private changed(): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.last) return;
    this.last = key;
    this.onChange(status);
  }
}
