import { describe, expect, it } from 'vitest';

import type { Agent } from '../generated/common';import { attachmentsFor, canAcceptEdits, canBypass, canSteer, changeableApprovalModes, findAgent, hasDiff, settingsKeys } from './capabilities';

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

  it('Accept edits: offered for an agent that lists acceptEdits (Claude Code, Pi), never guessed for an older host', () => {
    const pi = agent({ steer: true, diff: true, approvalModes: ['ask', 'acceptEdits', 'never'] });
    expect([canAcceptEdits(pi), canBypass(pi)]).toEqual([true, true]);
    expect(canAcceptEdits(agent({ steer: true, diff: true, approvalModes: ['untrusted', 'on-failure', 'on-request', 'never'] }))).toBe(false);
    expect(canAcceptEdits(agent())).toBe(false);
    expect(canAcceptEdits(undefined)).toBe(false);
  });

  it('an agent without capabilities (older host) or no agent at all allows everything', () => {
    expect([canBypass(agent()), canSteer(agent()), hasDiff(agent())]).toEqual([true, true, true]);
    expect([canBypass(undefined), canSteer(undefined), hasDiff(undefined)]).toEqual([true, true, true]);
  });

  it('settingsKeys lists what an open session can change, nothing for an older host or no agent', () => {
    const codex = { ...agent({ steer: true, diff: true, approvalModes: [] }), capabilities: { steer: true, diff: true, approvalModes: [], settingsUpdate: ['model', 'effort'] as ('model' | 'effort')[] } };
    expect(settingsKeys(codex)).toEqual(['model', 'effort']);
    expect(settingsKeys(agent({ steer: true, diff: true, approvalModes: [] }))).toEqual([]);
    expect(settingsKeys(agent())).toEqual([]);
    expect(settingsKeys(undefined)).toEqual([]);
  });

  it('settingsKeys leaves the approval mode to the Permissions sheet; changeableApprovalModes lists the modes only when they can change', () => {
    type Key = 'model' | 'effort' | 'approvalMode';
    const withModes = (approvalModes: string[], settingsUpdate?: Key[]) => ({
      ...agent(),
      capabilities: { steer: true, diff: true, approvalModes, ...(settingsUpdate ? { settingsUpdate } : {}) },
    });
    const codex = withModes(['untrusted', 'on-failure', 'on-request', 'never'], ['model', 'effort', 'approvalMode']);
    expect(settingsKeys(codex)).toEqual(['model', 'effort']);
    expect(changeableApprovalModes(codex)).toEqual(['untrusted', 'on-failure', 'on-request', 'never']);
    // Pi: settings change, approval mode does not.
    expect(changeableApprovalModes(withModes([], ['model', 'effort']))).toEqual([]);
    // A host that cannot change the mode of an open session, an older host, no agent.
    expect(changeableApprovalModes(withModes(['default', 'never'], ['model', 'effort']))).toEqual([]);
    expect(changeableApprovalModes(agent())).toEqual([]);
    expect(changeableApprovalModes(undefined)).toEqual([]);
  });

  it('findAgent looks the id up in the current list', () => {
    const list = [agent(), { ...agent(), id: 'b' }];
    expect(findAgent(() => list, 'b')?.id).toBe('b');
    expect(findAgent(() => list, 'c')).toBeUndefined();
    expect(findAgent(() => undefined, 'a')).toBeUndefined();
    expect(findAgent(undefined, 'a')).toBeUndefined();
    expect(findAgent(() => list, undefined)).toBeUndefined();
  });

  it('attachmentsFor needs a host limit and an agent that declares images or files; older hosts get none', () => {
    const agent = (attachments?: { images: boolean; files: boolean }): Agent => ({
      id: 'a',
      name: 'A',
      status: 'ready',
      capabilities: { steer: true, diff: true, approvalModes: [], ...(attachments ? { attachments } : {}) },
    });
    expect(attachmentsFor(agent({ images: true, files: false }), 10)).toEqual({ images: true, files: false });
    expect(attachmentsFor(agent({ images: true, files: true }), undefined)).toBeUndefined();
    expect(attachmentsFor(agent(), 10)).toBeUndefined();
    expect(attachmentsFor(agent({ images: false, files: false }), 10)).toBeUndefined();
    expect(attachmentsFor(undefined, 10)).toBeUndefined();
  });
});
