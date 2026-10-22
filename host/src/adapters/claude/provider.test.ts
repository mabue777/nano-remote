import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeConfig } from '../../config/claude.js';
import { ClaudeAdapter, type QueryFn } from './adapter.js';
import { ClaudeAgent, resolveSdkVersion } from './provider.js';
import { FakeClaude, until } from './testing/fake-query.js';

const configDir = () => mkdtempSync(path.join(tmpdir(), 'nano-claude-cfg-'));

describe('ClaudeAgent', () => {
  it('is ready with the SDK version when the SDK loads and the config folder exists', () => {
    const agent = new ClaudeAgent({ config: claudeConfig({ configDir: configDir() }, {}) });
    expect(agent.id).toBe('claude');
    expect(agent.name).toBe('Claude Code');
    expect(agent.state()).toEqual({ status: 'ready', version: '0.3.308' });
    expect(resolveSdkVersion()).toBe('0.3.308');
  });

  it('is unavailable without the SDK or without the config folder', () => {
    const noSdk = new ClaudeAgent({
      config: claudeConfig({ configDir: configDir() }, {}),
      sdkVersion: () => {
        throw new Error('Cannot find package');
      },
    });
    expect(noSdk.state()).toEqual({ status: 'unavailable', reason: 'the Claude Agent SDK does not load: Cannot find package' });
    const noDir = new ClaudeAgent({ config: claudeConfig({ configDir: '/nonexistent/claude' }, {}), sdkVersion: () => '1.0.0' });
    expect(noDir.state()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('/nonexistent/claude') });
  });

  it('reports the Claude Code version once a system/init named it, and tells listeners once', async () => {
    const fake = new FakeClaude();
    const agent = new ClaudeAgent({ config: claudeConfig({ configDir: configDir(), killGraceMs: 200 }, {}), query: fake.query, sdkVersion: () => '0.3.308' });
    let changes = 0;
    const off = agent.onStateChange(() => changes++);
    const adapter = agent.createAdapter();
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
    const ended: unknown[] = [];
    adapter.onEvent((e) => e.method === 'turn/completed' && ended.push(e));
    await adapter.start(configDir(), {});
    await adapter.turnStart([{ type: 'text', text: 'hi' }], 'c1');
    await until(() => (ended.length === 1 ? true : undefined), 'one turn');
    await adapter.turnStart([{ type: 'text', text: 'again' }], 'c2');
    await until(() => (ended.length === 2 ? true : undefined), 'two turns');
    expect(agent.state()).toEqual({ status: 'ready', version: '2.1.999' });
    expect(changes).toBe(1);
    off();
    await adapter.kill();
  });

  it('lists models with supportedModels() on a short-lived query, closed afterwards, then from the cache', async () => {
    const fake = new FakeClaude();
    const cfg = claudeConfig({ configDir: configDir() }, {});
    const agent = new ClaudeAgent({ config: cfg, query: fake.query });
    const [first, second] = await Promise.all([agent.models(), agent.models()]);
    expect(first).toEqual([
      { id: 'opus', displayName: 'Opus 5.5', default: true },
      { id: 'sonnet', displayName: 'Sonnet 5.5', default: false },
      { id: 'haiku', displayName: 'Haiku 5.5', default: false },
    ]);
    expect(second).toBe(first);
    expect(fake.queries).toHaveLength(1);
    const query = fake.last;
    expect(query.closed).toBe(true);
    expect(query.userMessages).toEqual([]);
    expect(query.options).toMatchObject({ settingSources: [], permissionMode: 'default' });
    expect(query.options.env).toMatchObject({ CLAUDE_CONFIG_DIR: cfg.configDir });
    expect(query.options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(await agent.models()).toBe(first);
    expect(fake.queries).toHaveLength(1);
  });

  it('falls back to the static list, uncached, when the engine cannot list models', async () => {
    const logs: string[] = [];
    const fake = new FakeClaude({ models: new Error('not logged in') });
    const agent = new ClaudeAgent({ config: claudeConfig({ configDir: configDir(), executable: '/opt/claude' }, {}), query: fake.query, log: (m) => logs.push(m) });
    expect((await agent.models()).map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(fake.last.options.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(logs[0]).toContain('not logged in');
    await agent.models();
    expect(fake.queries).toHaveLength(2);
    const empty = new ClaudeAgent({ config: claudeConfig({ configDir: configDir() }, {}), query: new FakeClaude({ models: [] }).query });
    expect((await empty.models()).map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('a model list that never comes times out; a query() that throws falls back too', async () => {
    const hanging: QueryFn = (params) => {
      const query = new FakeClaude().query(params);
      return Object.assign(query, { supportedModels: () => new Promise<never>(() => {}) });
    };
    const agent = new ClaudeAgent({ config: claudeConfig({ configDir: configDir(), requestTimeoutMs: 50 }, {}), query: hanging });
    expect((await agent.models()).map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    const throwing = new ClaudeAgent({ config: claudeConfig({ configDir: configDir() }, {}), query: new FakeClaude({ throwOnQuery: 'boom' }).query });
    expect((await throwing.models()).map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });
});
