import { describe, expect, it, vi } from 'vitest';

import { APPLIES_NEXT_TURN, BYPASS_TITLE, BYPASS_WARNING, PermissionsModel, modeWords, permissionsValue } from './permissions-model';
import { ASKS_FIRST, FULL_ACCESS } from './session-details';

const CODEX = ['untrusted', 'on-failure', 'on-request', 'never'];
const CLAUDE = ['default', 'acceptEdits', 'plan', 'never'];

function make(options: { modes?: string[]; current?: string; appliesAt?: 'now' | 'nextTurn'; reported?: string | null; fail?: Error } = {}) {
  const updateSettings = vi.fn(async (_sessionId: string, settings: { approvalMode?: string }) => {
    if (options.fail) throw options.fail;
    const mode = options.reported === null ? undefined : (options.reported ?? settings.approvalMode);
    return {
      session: { settings: mode === undefined ? {} : { approvalMode: mode } } as never,
      ...(options.appliesAt !== undefined ? { appliesAt: options.appliesAt } : {}),
    };
  });
  const model = new PermissionsModel({ sessionId: 'ses_1', modes: options.modes ?? CLAUDE, current: options.current, replica: { updateSettings } });
  const changed = vi.fn();
  model.subscribe(changed);
  return { model, updateSettings, changed };
}

describe('approval mode words', () => {
  it('every Codex and Claude mode has a title, a line and a row value; full access uses the New session words', () => {
    for (const mode of [...CODEX, ...CLAUDE]) {
      const words = modeWords(mode);
      expect(words.title).not.toBe(mode);
      expect(words.detail).not.toBe('');
    }
    expect(modeWords('never')).toEqual({ title: BYPASS_TITLE, detail: BYPASS_WARNING, short: FULL_ACCESS });
    expect(BYPASS_TITLE).toBe('Bypass approvals (full access)');
    expect(modeWords('default').short).toBe(ASKS_FIRST);
    expect(modeWords('acceptEdits').short).toBe('Accepts edits');
  });

  it('an unknown mode shows its name; no mode reads "Asks before running"', () => {
    expect(modeWords('auto')).toEqual({ title: 'auto', detail: '', short: 'auto' });
    expect(permissionsValue(undefined)).toBe(ASKS_FIRST);
    expect(permissionsValue('never')).toBe(FULL_ACCESS);
    expect(permissionsValue('plan')).toBe('Plans only');
  });
});

describe('PermissionsModel', () => {
  it('lists the agent\'s modes in its order with the current one marked and full access as danger', () => {
    const { model } = make({ modes: CODEX, current: 'on-request' });
    expect(model.rows.map((row) => [row.mode, row.current, row.danger])).toEqual([
      ['untrusted', false, false],
      ['on-failure', false, false],
      ['on-request', true, false],
      ['never', false, true],
    ]);
    expect(model.note).toBeUndefined();
  });

  it('switches to a mode at once; the host\'s answer is the mode in effect; applied now: no footnote', async () => {
    const { model, updateSettings, changed } = make({ current: 'default', appliesAt: 'now' });
    expect(await model.choose('acceptEdits')).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith('ses_1', { approvalMode: 'acceptEdits' });
    expect(model.current).toBe('acceptEdits');
    expect(model.note).toBeUndefined();
    expect(changed).toHaveBeenCalled();
  });

  it('full access asks first; Cancel changes nothing, Allow switches', async () => {
    const { model, updateSettings } = make({ current: 'default', appliesAt: 'now' });
    expect(await model.choose('never')).toBe(false);
    expect(model.confirming).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
    model.cancelConfirm();
    expect(model.confirming).toBe(false);
    model.cancelConfirm(); // nothing open: nothing happens
    expect(await model.confirmBypass()).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
    await model.choose('never');
    expect(await model.confirmBypass()).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith('ses_1', { approvalMode: 'never' });
    expect(model.current).toBe('never');
  });

  it('a change for the next turn, or an older host that does not say, shows "Applies from the next turn"', async () => {
    const next = make({ modes: CODEX, current: 'never', appliesAt: 'nextTurn' });
    await next.model.choose('on-request');
    expect(next.model.note).toBe(APPLIES_NEXT_TURN);
    const older = make({ modes: CODEX, current: 'never' });
    await older.model.choose('on-request');
    expect(older.model.note).toBe(APPLIES_NEXT_TURN);
    // A later change applied now clears it.
    const options: Parameters<typeof make>[0] = { current: 'never', appliesAt: 'nextTurn' };
    const both = make(options);
    await both.model.choose('default');
    expect(both.model.note).toBe(APPLIES_NEXT_TURN);
    options.appliesAt = 'now';
    await both.model.choose('plan');
    expect(both.model.note).toBeUndefined();
  });

  it('the current mode, a mode the agent does not list and a tap while saving do nothing', async () => {
    const { model, updateSettings } = make({ current: 'plan' });
    expect(await model.choose('plan')).toBe(false);
    expect(await model.choose('on-request')).toBe(false);
    model.saving = true;
    expect(await model.choose('default')).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('a host that answers without a mode keeps the one asked for; a refusal shows in plain words', async () => {
    const quiet = make({ current: 'default', reported: null });
    await quiet.model.choose('plan');
    expect(quiet.model.current).toBe('plan');
    const refused = make({ current: 'default', fail: new Error('Claude Code cannot change the approvalMode of an open session') });
    expect(await refused.model.choose('plan')).toBe(false);
    expect(refused.model.error).toBe('Could not change the permissions: Claude Code cannot change the approvalMode of an open session');
    expect(refused.model.current).toBe('default');
    expect(refused.model.saving).toBe(false);
  });
});
