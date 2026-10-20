import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { install, LAUNCHCTL, renderPlist, uninstall, type Run } from './launchd.js';
import { LAUNCHD_LABEL, launchAgentPath, logsDir } from './paths.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nano-launchd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A fake launchctl: records calls; `print` succeeds while the job is "loaded". */
function fakeLaunchctl(options: { loaded?: boolean; bootstrapFailures?: number } = {}) {
  const calls: string[][] = [];
  let loaded = options.loaded ?? false;
  let failures = options.bootstrapFailures ?? 0;
  const run: Run = async (binary, args) => {
    expect(binary).toBe(LAUNCHCTL);
    calls.push(args);
    const ok = { code: 0, stdout: '', stderr: '' };
    switch (args[0]) {
      case 'print':
        return loaded ? ok : { code: 113, stdout: '', stderr: 'Could not find service' };
      case 'bootout':
        loaded = false;
        return ok;
      case 'bootstrap':
        if (failures > 0) {
          failures -= 1;
          return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
        }
        loaded = true;
        return ok;
      default:
        return { code: 64, stdout: '', stderr: 'unknown' };
    }
  };
  return { run, calls, isLoaded: () => loaded };
}

const PLIST = () => ({
  programArguments: ['/opt/homebrew/bin/node', '/repo/host/dist/cli/main.js', 'start'],
  stdoutPath: path.join(logsDir(home), 'stdout.log'),
  stderrPath: path.join(logsDir(home), 'stderr.log'),
  workingDirectory: path.join(home, 'Library', 'Application Support', 'NanoHost'),
});

describe('plist rendering', () => {
  it('renders the LaunchAgent with RunAtLoad, KeepAlive, PATH and the log files', () => {
    const text = renderPlist({
      programArguments: ['/opt/homebrew/bin/node', '/Users/me/Library/Application Support/x/main.js', 'start'],
      stdoutPath: '/Users/me/Library/Logs/NanoHost/stdout.log',
      stderrPath: '/Users/me/Library/Logs/NanoHost/stderr.log',
      workingDirectory: '/Users/me/Library/Application Support/NanoHost',
    });
    expect(text).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.nano-remote.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/me/Library/Application Support/x/main.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>/Users/me/Library/Application Support/NanoHost</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/me/Library/Logs/NanoHost/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/me/Library/Logs/NanoHost/stderr.log</string>
</dict>
</plist>
`);
  });

  it('escapes XML in every string', () => {
    const text = renderPlist({
      programArguments: ['/a&b/<node>', '"quoted"', "it's"],
      stdoutPath: '/l/o',
      stderrPath: '/l/e',
      workingDirectory: '/w',
      environment: { NANO_X: 'a<b' },
    });
    expect(text).toContain('<string>/a&amp;b/&lt;node&gt;</string>');
    expect(text).toContain('<string>&quot;quoted&quot;</string>');
    expect(text).toContain('<string>it&apos;s</string>');
    expect(text).toContain('<key>NANO_X</key>\n    <string>a&lt;b</string>');
  });
});

describe('install and uninstall', () => {
  it('writes the plist, creates the log folder and bootstraps into gui/<uid>', async () => {
    const launchctl = fakeLaunchctl();
    const plistPath = launchAgentPath(home);
    await install({ plistPath, uid: 501, run: launchctl.run, plist: PLIST() });
    expect(readFileSync(plistPath, 'utf8')).toBe(renderPlist(PLIST()));
    expect(statSync(logsDir(home)).isDirectory()).toBe(true);
    expect(launchctl.calls).toEqual([
      ['print', `gui/501/${LAUNCHD_LABEL}`],
      ['bootstrap', 'gui/501', plistPath],
    ]);
  });

  it('boots out a loaded job first, and retries bootstrap while launchd is still tearing it down', async () => {
    const launchctl = fakeLaunchctl({ loaded: true, bootstrapFailures: 2 });
    const plistPath = launchAgentPath(home);
    await install({ plistPath, uid: 501, run: launchctl.run, plist: PLIST(), retryDelayMs: 1 });
    expect(launchctl.calls.map((c) => c[0])).toEqual(['print', 'bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    expect(launchctl.isLoaded()).toBe(true);
  });

  it('reports a bootstrap that keeps failing', async () => {
    const launchctl = fakeLaunchctl({ bootstrapFailures: 10 });
    await expect(
      install({ plistPath: launchAgentPath(home), uid: 501, run: launchctl.run, plist: PLIST(), attempts: 2, retryDelayMs: 1 }),
    ).rejects.toThrow(/bootstrap gui\/501 .* failed \(5\): Bootstrap failed: 5: Input\/output error/);
  });

  it('uninstall boots out and removes the plist; a second uninstall has nothing to do', async () => {
    const launchctl = fakeLaunchctl();
    const plistPath = launchAgentPath(home);
    await install({ plistPath, uid: 501, run: launchctl.run, plist: PLIST() });
    launchctl.calls.length = 0;
    expect(await uninstall({ plistPath, uid: 501, run: launchctl.run })).toBe(true);
    expect(launchctl.calls).toEqual([
      ['print', `gui/501/${LAUNCHD_LABEL}`],
      ['bootout', `gui/501/${LAUNCHD_LABEL}`],
    ]);
    expect(() => statSync(plistPath)).toThrow();
    expect(await uninstall({ plistPath, uid: 501, run: launchctl.run })).toBe(false);
  });
});
