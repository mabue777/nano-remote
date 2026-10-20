import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CODEX_BINARY, codexConfig, defaultCodexHome, isSandbox } from './index.js';

describe('codex config', () => {
  it('defaults to the engine bundled with ChatGPT.app, an XDG home and workspace-write', () => {
    const config = codexConfig({}, {});
    expect(config.binary).toBe(DEFAULT_CODEX_BINARY);
    expect(config.args).toEqual(['app-server']);
    expect(config.home).toBe(path.join(homedir(), '.config', 'codex'));
    expect(config.sandbox).toBe('workspace-write');
    expect(config.approvalPolicy).toBe('on-request');
  });

  it('reads the environment, then explicit overrides', () => {
    const env = { NANO_CODEX_BIN: '/opt/codex', NANO_CODEX_HOME: '/tmp/ch', NANO_CODEX_SANDBOX: 'read-only' };
    expect(codexConfig({}, env)).toMatchObject({ binary: '/opt/codex', home: '/tmp/ch', sandbox: 'read-only' });
    expect(codexConfig({ binary: '/x', sandbox: 'danger-full-access' }, env)).toMatchObject({
      binary: '/x',
      sandbox: 'danger-full-access',
    });
    expect(codexConfig({}, { NANO_CODEX_SANDBOX: 'bogus' }).sandbox).toBe('workspace-write');
  });

  it('honours an absolute CODEX_HOME, never XDG_CONFIG_HOME', () => {
    expect(defaultCodexHome({ CODEX_HOME: '/opt/codex-home' })).toBe('/opt/codex-home');
    expect(defaultCodexHome({ CODEX_HOME: 'relative' })).toBe(path.join(homedir(), '.config', 'codex'));
    expect(defaultCodexHome({ XDG_CONFIG_HOME: '/Users/Shared/dotfiles/config' })).toBe(path.join(homedir(), '.config', 'codex'));
  });

  it('recognizes sandbox modes', () => {
    expect(isSandbox('workspace-write')).toBe(true);
    expect(isSandbox('full')).toBe(false);
    expect(isSandbox(3)).toBe(false);
  });
});
