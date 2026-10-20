// The launchd job that keeps the host running (ADR 0003): a per-user LaunchAgent at
// ~/Library/LaunchAgents/dev.nano-remote.host.plist, started at login (RunAtLoad) and restarted when it
// exits (KeepAlive), with stdout and stderr under ~/Library/Logs/NanoHost.
//
// Loading uses the modern launchctl verbs on the user's GUI domain:
//   launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/dev.nano-remote.host.plist
//   launchctl bootout gui/<uid>/dev.nano-remote.host
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LAUNCHD_LABEL } from './paths.js';

export const LAUNCHCTL = '/bin/launchctl';

/** PATH of the job: launchd starts agents with a bare environment. Homebrew first, like the gate. */
export const JOB_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export interface PlistOptions {
  label?: string;
  /** Absolute program and arguments, e.g. [node, dist/cli/main.js, 'start', '--config', file]. */
  programArguments: string[];
  stdoutPath: string;
  stderrPath: string;
  workingDirectory: string;
  environment?: Record<string, string>;
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The LaunchAgent property list. */
export function renderPlist(options: PlistOptions): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const env = { PATH: JOB_PATH, ...options.environment };
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${string(options.label ?? LAUNCHD_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...options.programArguments.map((arg) => `    ${string(arg)}`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>ExitTimeOut</key>',
    '  <integer>20</integer>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>WorkingDirectory</key>',
    `  ${string(options.workingDirectory)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    ${string(value)}`]),
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  ${string(options.stdoutPath)}`,
    '  <key>StandardErrorPath</key>',
    `  ${string(options.stderrPath)}`,
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

export type Run = (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const run: Run = (binary, args) =>
  new Promise((resolve) => {
    execFile(binary, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface LaunchdOptions {
  plistPath: string;
  uid: number;
  label?: string;
  run?: Run;
  /** Bootstrap attempts (default 5) and the pause between them (default 500 ms). */
  attempts?: number;
  retryDelayMs?: number;
}

function domain(options: LaunchdOptions): { target: string; service: string } {
  const target = `gui/${options.uid}`;
  return { target, service: `${target}/${options.label ?? LAUNCHD_LABEL}` };
}

/** True when launchd knows the job (`launchctl print gui/<uid>/<label>` succeeds). */
export async function isLoaded(options: LaunchdOptions): Promise<boolean> {
  const result = await (options.run ?? run)(LAUNCHCTL, ['print', domain(options).service]);
  return result.code === 0;
}

/**
 * Writes the plist (creating the log folder and LaunchAgents) and loads it. A job that is already loaded
 * is booted out first, so `install` also upgrades.
 */
export async function install(options: LaunchdOptions & { plist: PlistOptions }): Promise<void> {
  const exec = options.run ?? run;
  mkdirSync(path.dirname(options.plistPath), { recursive: true });
  mkdirSync(path.dirname(options.plist.stdoutPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(options.plist.stderrPath), { recursive: true, mode: 0o700 });
  const { target, service } = domain(options);
  if (await isLoaded(options)) await exec(LAUNCHCTL, ['bootout', service]);
  writeFileSync(options.plistPath, renderPlist(options.plist), { mode: 0o644 });
  // Right after a bootout launchd may still be tearing the old job down and answer EIO; retry briefly.
  let result = await exec(LAUNCHCTL, ['bootstrap', target, options.plistPath]);
  for (let attempt = 1; result.code !== 0 && attempt < (options.attempts ?? 5); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 500));
    result = await exec(LAUNCHCTL, ['bootstrap', target, options.plistPath]);
  }
  if (result.code !== 0) {
    throw new Error(`launchctl bootstrap ${target} ${options.plistPath} failed (${result.code}): ${result.stderr.trim()}`);
  }
}

/** Unloads the job (if loaded) and removes the plist. Returns false when neither existed. */
export async function uninstall(options: LaunchdOptions): Promise<boolean> {
  const exec = options.run ?? run;
  const loaded = await isLoaded(options);
  if (loaded) {
    const result = await exec(LAUNCHCTL, ['bootout', domain(options).service]);
    if (result.code !== 0) throw new Error(`launchctl bootout failed (${result.code}): ${result.stderr.trim()}`);
  }
  let removed = true;
  try {
    rmSync(options.plistPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    removed = false;
  }
  return loaded || removed;
}
