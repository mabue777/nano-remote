import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeConfig, defaultClaudeConfigDir } from './index.js';

describe('claude config', () => {
  it('defaults to ~/.claude, the SDK executable and opus', () => {
    const config = claudeConfig({}, {});
    expect(config).toEqual({
      configDir: path.join(homedir(), '.claude'),
      executable: undefined,
      defaultModel: 'opus',
      env: {},
      requestTimeoutMs: 120_000,
      killGraceMs: 2_000,
    });
  });

  it('takes NANO_CLAUDE_CONFIG_DIR first, then an absolute CLAUDE_CONFIG_DIR', () => {
    expect(defaultClaudeConfigDir({ NANO_CLAUDE_CONFIG_DIR: '/a', CLAUDE_CONFIG_DIR: '/b' })).toBe('/a');
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/b' })).toBe('/b');
    expect(defaultClaudeConfigDir({ NANO_CLAUDE_CONFIG_DIR: 'relative', CLAUDE_CONFIG_DIR: 'also/relative' })).toBe(
      path.join(homedir(), '.claude'),
    );
  });

  it('reads the executable from the environment, then explicit overrides win', () => {
    expect(claudeConfig({}, { NANO_CLAUDE_BIN: '/opt/claude' }).executable).toBe('/opt/claude');
    expect(claudeConfig({ configDir: '/x', defaultModel: 'sonnet' }, { CLAUDE_CONFIG_DIR: '/b' })).toMatchObject({
      configDir: '/x',
      defaultModel: 'sonnet',
    });
  });
});
