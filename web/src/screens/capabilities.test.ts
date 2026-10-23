import { describe, expect, it } from 'vitest';

import { canBypass, canSteer, findAgent, hasDiff } from './capabilities';

const agent = (capabilities?: { steer: boolean; diff: boolean; approvalModes: string[] }) => ({
  id: 'a',
  name: 'A',
  status: 'ready',
  ...(capabilities ? { capabilities } : {}),
});

describe('agent capabilities', () => {
  it('reads steer, diff and the never approval mode', () => {
    const codex = agent({ steer: true, diff: false, approvalModes: ['untrusted', 'on-failure', 'on-request', 'never'] });
    expect([canBypass(codex), canSteer(codex), hasDiff(codex)]).toEqual([true, true, false]);
    const claude = agent({ steer: false, diff: false, approvalModes: ['default', 'acceptEdits', 'plan', 'never'] });
    expect([canBypass(claude), canSteer(claude), hasDiff(claude)]).toEqual([true, false, false]);
    const pi = agent({ steer: true, diff: false, approvalModes: [] });
    expect([canBypass(pi), canSteer(pi), hasDiff(pi)]).toEqual([false, true, false]);
  });

  it('an agent without capabilities (older host) or no agent at all allows everything', () => {
    expect([canBypass(agent()), canSteer(agent()), hasDiff(agent())]).toEqual([true, true, true]);
    expect([canBypass(undefined), canSteer(undefined), hasDiff(undefined)]).toEqual([true, true, true]);
  });

  it('findAgent looks the id up in the current list', () => {
    const list = [agent(), { ...agent(), id: 'b' }];
    expect(findAgent(() => list, 'b')?.id).toBe('b');
    expect(findAgent(() => list, 'c')).toBeUndefined();
    expect(findAgent(() => undefined, 'a')).toBeUndefined();
    expect(findAgent(undefined, 'a')).toBeUndefined();
    expect(findAgent(() => list, undefined)).toBeUndefined();
  });
});
