// The pi agent: health, version, models with their provider, and the cache.
import { describe, expect, it } from 'vitest';

import { describeAgent } from '../../core/adapter.js';
import { PiAdapter } from './adapter.js';
import { PiAgent, piInstalled } from './provider.js';
import { fakePi, until } from './testing/fake-pi-config.js';

describe('PiAgent', () => {
  it('is unavailable without the pi program', () => {
    const agent = new PiAgent({ config: { ...fakePi().config, binary: '/nonexistent/pi' } });
    expect(piInstalled(agent.config)).toBe(false);
    expect(describeAgent(agent)).toEqual({ id: 'pi', name: 'Pi', status: 'unavailable', reason: 'pi is not installed at /nonexistent/pi', capabilities: { steer: true, diff: true, approvalModes: [], attachments: { images: true, files: true }, backgroundTasks: false } });
  });

  it('is ready when found and learns its version from pi --version', async () => {
    const agent = new PiAgent({ config: fakePi({ version: '1.3.0' }).config });
    let changes = 0;
    const off = agent.onStateChange(() => changes++);
    expect(agent.state()).toEqual({ status: 'ready' });
    await until(() => (changes > 0 ? true : undefined), 'version');
    expect(describeAgent(agent)).toEqual({ id: 'pi', name: 'Pi', status: 'ready', version: '1.3.0', capabilities: { steer: true, diff: true, approvalModes: [], attachments: { images: true, files: true }, backgroundTasks: false } });
    off();
    expect(agent.createAdapter()).toBeInstanceOf(PiAdapter);
  });

  it('keeps no version when pi --version says nothing useful', async () => {
    const logs: string[] = [];
    const agent = new PiAgent({ config: fakePi({ version: 'unknown' }).config, log: (m) => logs.push(m) });
    agent.state();
    await until(() => (logs.length > 0 ? true : undefined), 'log');
    expect(logs).toEqual(['pi: no version from --version']);
    expect(agent.state()).toEqual({ status: 'ready' });
  });

  it('a pi --version that fails is logged; the adapter gets the log', async () => {
    const logs: string[] = [];
    const agent = new PiAgent({ config: { ...fakePi().config, binary: '/usr/bin/false', args: [] }, log: (m) => logs.push(m) });
    expect(agent.state().status).toBe('ready');
    await until(() => (logs.length > 0 ? true : undefined), 'log');
    expect(logs[0]).toMatch(/^pi: no version from --version \(Command failed/);
    expect(agent.createAdapter()).toBeInstanceOf(PiAdapter);
    expect(new PiAgent().config.binary).toMatch(/pi$/);
  });

  it('models: get_available_models with the provider per entry, pi default marked; cached, then asked again', async () => {
    const fake = fakePi({ models: [{ provider: 'openrouter', id: 'm/a', name: 'A' }, { provider: 'llamacpp', id: 'bonsai-27b' }] });
    let now = 0;
    const agent = new PiAgent({ config: fake.config, now: () => now });
    const models = await agent.models();
    expect(models).toEqual([
      { id: 'openrouter/m/a', displayName: 'A', default: true, provider: 'openrouter' },
      { id: 'llamacpp/bonsai-27b', displayName: 'bonsai-27b', default: false, provider: 'llamacpp' },
    ]);
    // A one-off pi without a session file.
    expect(fake.argvs()[0]).toContain('--no-session');
    expect(await agent.models()).toBe(models);
    expect(fake.pids()).toHaveLength(1);
    now = fake.config.modelsTtlMs;
    await agent.models();
    expect(fake.pids()).toHaveLength(2);
  });

  it('models carry their thinking levels and pi\'s current level fitted to each', async () => {
    const fake = fakePi({
      thinkingLevel: 'medium',
      models: [
        { provider: 'kimi-coding', id: 'k3', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
        { provider: 'llamacpp', id: 'bonsai-27b' },
      ],
    });
    const models = await new PiAgent({ config: fake.config }).models();
    expect(models.map((m) => [m.id, m.efforts, m.defaultEffort])).toEqual([
      ['kimi-coding/k3', ['low', 'high', 'max'], 'high'],
      ['llamacpp/bonsai-27b', undefined, undefined],
    ]);
  });

  it('a pi that cannot list models rejects', async () => {
    const agent = new PiAgent({ config: fakePi({ exitAtBoot: 'broken install' }).config });
    await expect(agent.models()).rejects.toThrow(/broken install/);
  });
});
