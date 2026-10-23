import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CODEX_BINARY } from '../config/codex.js';
import { ConfigError, defaultConfig, loadConfig, updateConfigFile, validateConfig } from './config.js';
import { defaultConfigPath } from './paths.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nano-config-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const mode = (file: string) => statSync(file).mode & 0o777;

describe('config file', () => {
  it('has the documented defaults', () => {
    const config = defaultConfig(home, 'host_abc');
    const dir = path.join(home, 'Library', 'Application Support', 'NanoHost');
    expect(config).toEqual({
      hostId: 'host_abc',
      listenAddresses: [],
      port: 7420,
      tls: { certPath: path.join(dir, 'tls-cert.pem'), keyPath: path.join(dir, 'tls-key.pem') },
      enabledAgents: ['codex', 'pi'],
      codexBinary: DEFAULT_CODEX_BINARY,
      journalPath: path.join(dir, 'journal.sqlite'),
      logFile: path.join(home, 'Library', 'Logs', 'NanoHost', 'host.log'),
    });
  });

  it('writes defaults on first start: folder 0700, file 0600, and reads them back unchanged', () => {
    const file = defaultConfigPath(home);
    const first = loadConfig(file, { home, create: true });
    expect(first.created).toBe(true);
    expect(mode(path.dirname(file))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(first.config.hostId).toMatch(/^host_[0-9a-f]{16}$/);
    const second = loadConfig(file, { home, create: true });
    expect(second).toEqual({ config: first.config, created: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(first.config);
  });

  it('tightens an existing folder that is too open', () => {
    const file = defaultConfigPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    chmodSync(path.dirname(file), 0o755);
    loadConfig(file, { home, create: true });
    expect(mode(path.dirname(file))).toBe(0o700);
  });

  it('does not touch the disk without create', () => {
    const file = defaultConfigPath(home);
    const { config, created } = loadConfig(file, { home });
    expect(created).toBe(false);
    expect(config.port).toBe(7420);
    expect(() => statSync(file)).toThrow();
  });

  it('fills missing keys from the defaults and persists a generated hostId', () => {
    const file = path.join(home, 'c.json');
    writeFileSync(file, JSON.stringify({ port: 9000, listenAddresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'] }));
    const { config } = loadConfig(file, { home, create: true });
    expect(config.port).toBe(9000);
    expect(config.listenAddresses).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::1']);
    expect(config.enabledAgents).toEqual(['codex', 'pi']);
    expect(JSON.parse(readFileSync(file, 'utf8')).hostId).toBe(config.hostId);
    expect(mode(file)).toBe(0o600);
  });

  it('reports JSON syntax errors with the file name', () => {
    const file = path.join(home, 'c.json');
    writeFileSync(file, '{"port": 7420,');
    expect(() => loadConfig(file, { home })).toThrow(ConfigError);
    expect(() => loadConfig(file, { home })).toThrow(`${file}: not valid JSON`);
  });

  it.each([
    [[], /must be a JSON object/],
    [{ prot: 1 }, /unknown key "prot"/],
    [{ hostId: 'abc' }, /hostId/],
    [{ port: 0 }, /port must be an integer from 1 to 65535/],
    [{ port: 70000 }, /port/],
    [{ port: '7420' }, /port/],
    [{ port: 74.2 }, /port/],
    [{ listenAddresses: '100.64.0.1' }, /listenAddresses must be an array/],
    [{ listenAddresses: ['mac.ts.net'] }, /listenAddresses\[0\] must be a literal IP address/],
    [{ listenAddresses: ['0.0.0.0'] }, /wildcard/],
    [{ listenAddresses: ['::'] }, /wildcard/],
    [{ tls: 'x' }, /tls must be an object/],
    [{ tls: { certPath: 'cert.pem' } }, /tls.certPath must be an absolute path/],
    [{ tls: { cert: '/a' } }, /unknown key tls.cert/],
    [{ enabledAgents: ['codex', 'gemini'] }, /unknown agent "gemini"/],
    [{ enabledAgents: 'codex' }, /enabledAgents must be an array/],
    [{ codexBinary: '' }, /codexBinary must be a non-empty string/],
    [{ enabledAgents: ['claude', 'kimi'] }, /unknown agent "kimi" \(known: codex, claude, pi\)/],
    [{ claudeConfigDir: '.config/claude' }, /claudeConfigDir must be an absolute path/],
    [{ claudeConfigDir: '' }, /claudeConfigDir must be a non-empty string/],
    [{ claudeExecutable: 'bin/claude' }, /claudeExecutable must be an absolute path/],
    [{ claudeExecutable: 7 }, /claudeExecutable/],
    [{ piBinary: 'bin/pi' }, /piBinary must be an absolute path/],
    [{ journalPath: 'journal.sqlite' }, /journalPath must be an absolute path/],
    [{ logFile: 3 }, /logFile/],
    [{ vapidContact: 'mailto:nano-remote@localhost' }, /vapidContact must be an https: URL or a mailto: address/],
    [{ vapidContact: 'http://example.com' }, /vapidContact/],
    [{ vapidContact: 7 }, /vapidContact/],
  ])('refuses %j', (value, message) => {
    expect(() => validateConfig(value, 'config.json', defaultConfig(home, 'host_x'))).toThrow(message);
  });

  it('accepts an optional vapidContact and omits it by default', () => {
    expect(defaultConfig(home, 'host_x')).not.toHaveProperty('vapidContact');
    expect(validateConfig({}, 'c', defaultConfig(home, 'host_x'))).not.toHaveProperty('vapidContact');
    for (const contact of ['mailto:me@example.org', 'https://example.com/contact']) {
      expect(validateConfig({ vapidContact: contact }, 'c', defaultConfig(home, 'host_x')).vapidContact).toBe(contact);
    }
  });

  it('accepts claude with optional claudeConfigDir and claudeExecutable, omitted by default', () => {
    const defaults = defaultConfig(home, 'host_x');
    expect(defaults.enabledAgents).toEqual(['codex', 'pi']);
    expect(defaults).not.toHaveProperty('claudeConfigDir');
    expect(defaults).not.toHaveProperty('claudeExecutable');
    expect(validateConfig({}, 'c', defaults)).not.toHaveProperty('claudeConfigDir');
    const config = validateConfig(
      { enabledAgents: ['codex', 'claude'], claudeConfigDir: '/Users/me/.config/claude', claudeExecutable: '/opt/claude/bin/claude' },
      'c',
      defaults,
    );
    expect(config).toMatchObject({
      enabledAgents: ['codex', 'claude'],
      claudeConfigDir: '/Users/me/.config/claude',
      claudeExecutable: '/opt/claude/bin/claude',
    });
  });

  it('accepts an optional piBinary, omitted by default', () => {
    expect(defaultConfig(home, 'host_x')).not.toHaveProperty('piBinary');
    expect(validateConfig({ piBinary: '/Users/me/.local/bin/pi' }, 'c', defaultConfig(home, 'host_x')).piBinary).toBe('/Users/me/.local/bin/pi');
  });

  it('accepts pi in enabledAgents', () => {
    expect(validateConfig({ enabledAgents: ['pi'] }, 'c', defaultConfig(home, 'host_x')).enabledAgents).toEqual(['pi']);
  });

  it('still loads config files written before pi joined enabledAgents', () => {
    // A Phase 5b file: Codex and Claude enabled, piBinary set beside them. Same shape, still valid.
    const file = path.join(home, 'old.json');
    const old = {
      hostId: 'host_0123456789abcdef',
      listenAddresses: [],
      port: 7420,
      tls: { certPath: '/Users/me/tls-cert.pem', keyPath: '/Users/me/tls-key.pem' },
      enabledAgents: ['codex', 'claude'],
      codexBinary: '/Applications/ChatGPT.app/Contents/Resources/codex',
      claudeConfigDir: '/Users/me/.config/claude',
      piBinary: '/Users/me/.local/bin/pi',
      journalPath: '/Users/me/journal.sqlite',
      logFile: '/Users/me/host.log',
    };
    writeFileSync(file, JSON.stringify(old));
    expect(loadConfig(file, { home, create: true })).toEqual({ config: old, created: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(old);
    // Older still: a Phase 3 file with Codex alone keeps Codex alone.
    writeFileSync(file, JSON.stringify({ ...old, enabledAgents: ['codex'], claudeConfigDir: undefined, piBinary: undefined }));
    expect(loadConfig(file, { home }).config.enabledAgents).toEqual(['codex']);
  });

  it('drops duplicate agents', () => {
    expect(validateConfig({ enabledAgents: ['codex', 'codex'] }, 'c', defaultConfig(home, 'host_x')).enabledAgents).toEqual(['codex']);
  });
});

describe('keepAwake', () => {
  it('is absent by default (meaning "pluggedIn"), accepts "pluggedIn" and "off", and rejects anything else', () => {
    const defaults = defaultConfig(home, 'host_x');
    expect(defaults).not.toHaveProperty('keepAwake');
    expect(validateConfig({}, 'c', defaults)).not.toHaveProperty('keepAwake');
    expect(validateConfig({ keepAwake: 'off' }, 'c', defaults).keepAwake).toBe('off');
    expect(validateConfig({ keepAwake: 'pluggedIn' }, 'c', defaults).keepAwake).toBe('pluggedIn');
    expect(() => validateConfig({ keepAwake: 'always' }, 'c', defaults)).toThrow('keepAwake must be one of "pluggedIn", "off"');
    expect(() => validateConfig({ keepAwake: true }, 'c', defaults)).toThrow(ConfigError);
  });
});

describe('updateConfigFile', () => {
  const written = {
    hostId: 'host_keep',
    port: 7999,
    enabledAgents: ['claude'],
    providers: [{ id: 'mac-ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434' }],
  };

  it('sets the key, keeps every other key as written (no defaults added), and keeps the old file as .bak', () => {
    const file = path.join(home, 'NanoHost', 'config.json');
    mkdirSync(path.dirname(file));
    const before = `${JSON.stringify(written, null, 2)}\n`;
    writeFileSync(file, before, { mode: 0o600 });

    const config = updateConfigFile(file, { keepAwake: 'off' }, { home });
    expect(config).toMatchObject({ hostId: 'host_keep', port: 7999, enabledAgents: ['claude'], keepAwake: 'off' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...written, keepAwake: 'off' });
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(before);
    expect(mode(file)).toBe(0o600);
    expect(mode(`${file}.bak`)).toBe(0o600);
    // No temporary file is left behind.
    expect(readdirSync(path.dirname(file)).sort()).toEqual(['config.json', 'config.json.bak']);
    // And the host reads it back.
    expect(loadConfig(file, { home }).config.keepAwake).toBe('off');

    updateConfigFile(file, { keepAwake: 'pluggedIn' }, { home });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...written, keepAwake: 'pluggedIn' });
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ ...written, keepAwake: 'off' });
  });

  it('replaces the file by rename: a reader holding the old file still sees the old text', () => {
    const file = path.join(home, 'config.json');
    writeFileSync(file, JSON.stringify(written));
    const inodeBefore = statSync(file).ino;
    updateConfigFile(file, { keepAwake: 'off' }, { home });
    expect(statSync(file).ino).not.toBe(inodeBefore);
  });

  it('writes a new file without a .bak when none existed', () => {
    const file = path.join(home, 'fresh', 'config.json');
    updateConfigFile(file, { keepAwake: 'off' }, { home });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ keepAwake: 'off' });
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  it('leaves the file untouched when the result would not validate, or the file is not a JSON object', () => {
    const file = path.join(home, 'config.json');
    writeFileSync(file, JSON.stringify({ port: 'nope' }));
    expect(() => updateConfigFile(file, { keepAwake: 'off' }, { home })).toThrow('port must be an integer');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 'nope' });
    expect(existsSync(`${file}.bak`)).toBe(false);
    writeFileSync(file, '[1]');
    expect(() => updateConfigFile(file, { keepAwake: 'off' }, { home })).toThrow('must be a JSON object');
    writeFileSync(file, '{');
    expect(() => updateConfigFile(file, { keepAwake: 'off' }, { home })).toThrow(ConfigError);
    expect(() => updateConfigFile(file, { keepAwake: 'never' as never }, { home })).toThrow(ConfigError);
  });

  it('removes the temporary file when the write fails', () => {
    const dir = path.join(home, 'locked');
    mkdirSync(dir);
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(written));
    chmodSync(dir, 0o500); // no new files in here
    try {
      expect(() => updateConfigFile(file, { keepAwake: 'off' }, { home })).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual(['config.json']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(written);
  });

  it('a patch with keepAwake undefined removes the key (back to the default)', () => {
    const file = path.join(home, 'config.json');
    writeFileSync(file, JSON.stringify({ ...written, keepAwake: 'off' }));
    expect(updateConfigFile(file, { keepAwake: undefined }, { home })).not.toHaveProperty('keepAwake');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(written);
  });
});
