import { describe, expect, it } from 'vitest';

import { ConfigError, defaultConfig, validateConfig } from '../cli/config.js';
import { formatStatus } from '../cli/commands.js';
import type { ControlStatus } from '../cli/control.js';
import { validateProviders } from './providers.js';

const fail = (message: string): never => {
  throw new Error(message);
};

describe('providers in config.json', () => {
  it('accepts entries, normalizes base URLs and trims names and keys', () => {
    expect(
      validateProviders(
        [
          { id: 'mac-ollama', name: ' Ollama ', baseURL: 'HTTP://127.0.0.1:11434/' },
          { id: 'lab_1', name: 'Lab', baseURL: 'http://lab.tail1.ts.net:8000/v1', apiKey: ' sk-x ' },
          { id: 'cloud', name: 'Claude', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant' },
        ],
        fail,
      ),
    ).toEqual([
      { id: 'mac-ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434' },
      { id: 'lab_1', name: 'Lab', baseURL: 'http://lab.tail1.ts.net:8000/v1', apiKey: 'sk-x' },
      { id: 'cloud', name: 'Claude', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant' },
    ]);
    expect(validateProviders(undefined, fail)).toEqual([]);
  });

  it('names the field in every error', () => {
    const ok = { id: 'a', name: 'A', baseURL: 'http://127.0.0.1:1' };
    const cases: [unknown, string][] = [
      [{}, 'providers must be an array'],
      [[null], 'providers[0] must be an object'],
      [[{ ...ok, extra: 1 }], 'providers[0]: unknown key "extra"'],
      [[{ ...ok, id: 'has space' }], 'providers[0].id must be'],
      [[ok, { ...ok, baseURL: 'http://127.0.0.1:2' }], 'providers[1].id "a" is used twice'],
      [[{ ...ok, name: '' }], 'providers[0].name must be'],
      [[{ ...ok, name: 'x'.repeat(101) }], 'providers[0].name must be'],
      [[{ ...ok, baseURL: 'ftp://x' }], 'providers[0].baseURL must be an http or https URL'],
      [[{ ...ok, baseURL: 7 }], 'providers[0].baseURL must be an http or https URL'],
      [[{ ...ok, baseURL: 'http://api.openai.com/v1' }], 'providers[0].baseURL must use https for a public host'],
      [[ok, { ...ok, id: 'b', baseURL: 'http://127.0.0.1:1/' }], 'providers[1].baseURL http://127.0.0.1:1 is used twice'],
      [[{ ...ok, apiKey: '' }], 'providers[0].apiKey must be a non-empty string'],
      [[{ ...ok, apiKey: 5 }], 'providers[0].apiKey must be a non-empty string'],
    ];
    for (const [value, message] of cases) {
      expect(() => validateProviders(value, fail), message).toThrow(message);
    }
  });

  it('is a key of the host config: absent stays absent, errors name the file and the field', () => {
    const defaults = defaultConfig('/tmp/home', 'host_abc');
    expect(validateConfig({}, '/c.json', defaults).providers).toBeUndefined();
    expect(
      validateConfig({ providers: [{ id: 'o', name: 'O', baseURL: 'http://127.0.0.1:11434' }] }, '/c.json', defaults).providers,
    ).toEqual([{ id: 'o', name: 'O', baseURL: 'http://127.0.0.1:11434' }]);
    expect(() => validateConfig({ providers: [{ id: 'o', name: 'O' }] }, '/c.json', defaults)).toThrow(
      new ConfigError('/c.json', 'providers[0].baseURL must be an http or https URL'),
    );
  });

  it('nano-host status lists the provider names, never keys', () => {
    const status: ControlStatus = {
      state: 'running',
      pid: 1,
      version: '0',
      hostId: 'host_abc',
      origin: 'https://mac.ts.net:7420',
      addresses: ['100.1.2.3'],
      port: 7420,
      uptimeSeconds: 5,
      devices: 1,
      streams: 0,
      sessionsActive: 0,
      agents: [],
    };
    expect(formatStatus(status)).toContain('providers: none');
    expect(formatStatus({ ...status, providers: ['Ollama on this Mac', 'Lab'] })).toContain('providers: Ollama on this Mac, Lab');
  });
});
