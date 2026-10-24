import { describe, expect, it } from 'vitest';

import { DEFAULT_CODEX_BINARY } from '../../config/codex.js';
import { CodexAgent } from './provider.js';
import { fakeCodex } from './testing/fake-codex.js';

describe('CodexAgent', () => {
  it('uses the host configuration by default', () => {
    const agent = new CodexAgent();
    expect(agent.config.binary).toBe(process.env.NANO_CODEX_BIN || DEFAULT_CODEX_BINARY);
    expect(['ready', 'unavailable']).toContain(agent.state().status);
    expect(agent.capabilities).toEqual({ steer: true, diff: true, approvalModes: ['untrusted', 'on-failure', 'on-request', 'never'], attachments: { images: true, files: true }, backgroundTasks: false, settingsUpdate: ['model', 'effort'] });
  });

  it('shares one model/list engine between concurrent callers and caches the result', async () => {
    const fake = fakeCodex();
    const agent = new CodexAgent({ config: fake.config });
    const [a, b] = await Promise.all([agent.models(), agent.models()]);
    expect(a).toBe(b);
    expect(await agent.models()).toBe(a);
    expect(fake.pids()).toHaveLength(1);
    expect(agent.state()).toEqual({ status: 'ready', version: '0.0.0-fake' });
  });

  it('a model/list engine that dies rejects, and the next call tries again', async () => {
    const fake = fakeCodex({ exitOn: 'model/list' });
    const agent = new CodexAgent({ config: fake.config });
    await expect(agent.models()).rejects.toMatchObject({ code: 'agent_unavailable' });
    await expect(agent.models()).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(fake.pids()).toHaveLength(2);
  });
});
