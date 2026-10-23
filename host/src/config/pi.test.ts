import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NANO_APPROVAL_EXTENSION, childPath, defaultPiBinary, piConfig } from './index.js';

describe('pi config', () => {
  it('defaults to ~/.local/bin/pi and Nano approval extension shipped in host/', () => {
    const config = piConfig({}, {});
    expect(config.binary).toBe(path.join(homedir(), '.local', 'bin', 'pi'));
    expect(defaultPiBinary('/Users/x')).toBe('/Users/x/.local/bin/pi');
    expect(config.args).toEqual([]);
    expect(config.extensionPath).toBe(NANO_APPROVAL_EXTENSION);
    expect(existsSync(NANO_APPROVAL_EXTENSION)).toBe(true);
    expect(path.basename(path.dirname(NANO_APPROVAL_EXTENSION))).toBe('pi-extension');
  });

  it('reads NANO_PI_BIN, then explicit overrides', () => {
    expect(piConfig({}, { NANO_PI_BIN: '/opt/pi' }).binary).toBe('/opt/pi');
    expect(piConfig({ binary: '/x/pi' }, { NANO_PI_BIN: '/opt/pi' }).binary).toBe('/x/pi');
  });

  it('puts the host node first on the pi PATH (launchd gives a bare PATH)', () => {
    expect(childPath('/usr/bin:/bin', '/opt/homebrew/bin/node')).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(childPath('/opt/homebrew/bin:/usr/bin', '/opt/homebrew/bin/node')).toBe('/opt/homebrew/bin:/usr/bin');
    expect(childPath(undefined, '/n/bin/node')).toBe('/n/bin:/usr/bin:/bin');
  });
});
