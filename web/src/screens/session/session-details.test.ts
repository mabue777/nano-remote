import { describe, expect, it } from 'vitest';

import { ASKS_FIRST, detailRows, detailsSubtitle, FULL_ACCESS, OFFLINE_WORD, statusLine, statusValue, type DetailsInput } from './session-details';

const WORKING = { label: 'Working', tone: 'busy', status: 'running' } as const;
const APPROVAL = { label: 'Needs approval', tone: 'attention', status: 'waiting_approval' } as const;
const FINISHED = { label: 'Finished', tone: 'ok', status: 'idle' } as const;
const NOW = 1_000_000_000; // ms

describe('statusLine: the header footnote, the session\'s one status', () => {
  it('running: the word and the live elapsed time from the running turn\'s start, ticking', () => {
    const line = statusLine({ status: WORKING, runningSince: NOW / 1000 - 134, now: NOW, fullAccess: false });
    expect(line).toEqual({ status: 'running', tone: 'busy', word: 'Working', detail: '2m 14s', text: 'Working · 2m 14s', fullAccess: false, ticking: true });
    expect(statusLine({ status: WORKING, runningSince: NOW / 1000 - 5, now: NOW, fullAccess: false }).text).toBe('Working · 5s');
    expect(statusLine({ status: WORKING, runningSince: NOW / 1000 - 3725, now: NOW, fullAccess: false }).text).toBe('Working · 1h 2m');
  });

  it('running without a known start, or a start in the future: no timer, or 0s', () => {
    expect(statusLine({ status: WORKING, now: NOW, fullAccess: false })).toMatchObject({ text: 'Working', ticking: false });
    expect(statusLine({ status: WORKING, runningSince: NOW / 1000 + 10, now: NOW, fullAccess: false }).text).toBe('Working · 0s');
  });

  it('waiting, finished, idle, failed: the dot and word only, no timer even while a turn runs', () => {
    expect(statusLine({ status: APPROVAL, runningSince: 1, now: NOW, fullAccess: false })).toEqual({
      status: 'waiting_approval',
      tone: 'attention',
      word: 'Needs approval',
      text: 'Needs approval',
      fullAccess: false,
      ticking: false,
    });
    expect(statusLine({ status: FINISHED, now: NOW, fullAccess: false })).toMatchObject({ text: 'Finished', tone: 'ok', status: 'idle', ticking: false });
    expect(statusLine({ status: { label: 'Failed', tone: 'error', status: 'idle' }, now: NOW, fullAccess: false }).text).toBe('Failed');
  });

  it('Mac offline takes precedence, in the error tone, with the retry countdown when known', () => {
    const offline = statusLine({ status: WORKING, connection: { kind: 'offline', retryInSeconds: 3 }, runningSince: 1, now: NOW, fullAccess: false });
    expect(offline).toEqual({ status: 'offline', tone: 'error', word: OFFLINE_WORD, detail: 'retrying in 3 s', text: 'Mac offline · retrying in 3 s', fullAccess: false, ticking: true });
    expect(statusLine({ status: APPROVAL, connection: { kind: 'offline' }, now: NOW, fullAccess: false })).toMatchObject({ text: 'Mac offline', ticking: false, status: 'offline' });
  });

  it('connected or connecting: the session\'s own status', () => {
    expect(statusLine({ status: FINISHED, connection: { kind: 'connected' }, now: NOW, fullAccess: false }).text).toBe('Finished');
    expect(statusLine({ status: FINISHED, connection: { kind: 'connecting' }, now: NOW, fullAccess: false }).text).toBe('Finished');
  });

  it('Full access is carried along, offline too', () => {
    expect(statusLine({ status: FINISHED, now: NOW, fullAccess: true }).fullAccess).toBe(true);
    expect(statusLine({ status: FINISHED, connection: { kind: 'offline' }, now: NOW, fullAccess: true }).fullAccess).toBe(true);
  });

  it('statusValue: the header\'s words, plus "Worked for" once the turn ended', () => {
    const finished = statusLine({ status: FINISHED, now: NOW, fullAccess: false });
    expect(statusValue(finished, 'Worked for 3m 12s')).toBe('Finished · Worked for 3m 12s');
    expect(statusValue(finished)).toBe('Finished');
    const running = statusLine({ status: WORKING, runningSince: NOW / 1000 - 12, now: NOW, fullAccess: false });
    expect(statusValue(running, 'Worked for 1m 0s')).toBe('Working · 12s');
  });
});

const BASE: DetailsInput = {
  status: 'Finished · Worked for 3m 12s',
  statusTone: 'ok',
  agent: 'Codex',
  model: 'gpt-5.5-codex',
  effort: 'High',
  canChangeSettings: true,
  folder: '/Users/me/code/nano-remote',
  fullAccess: false,
  changes: '3 files changed',
  archived: false,
};

describe('detailRows: the ⋯ sheet', () => {
  it('everything the old header showed, Changes, then Archive and Delete', () => {
    const rows = detailRows(BASE);
    expect(rows.map((row) => row.label)).toEqual(['Status', 'Agent', 'Model', 'Folder', 'Permissions', 'Changes', 'Archive', 'Delete…']);
    expect(rows[0]).toEqual({ key: 'status', icon: 'check', label: 'Status', value: [{ text: 'Finished · Worked for 3m 12s' }] });
    expect(rows[2]).toEqual({
      key: 'model',
      icon: 'gear',
      label: 'Model',
      value: [
        { text: 'gpt-5.5-codex', label: 'Model' },
        { text: 'High', label: 'Effort' },
      ],
      action: 'settings',
      title: 'Change model and effort',
    });
    expect(rows[3]!.value).toEqual([{ text: '/Users/me/code/nano-remote' }]);
    expect(rows[4]!.value).toEqual([{ text: ASKS_FIRST }]);
    expect(rows[5]).toMatchObject({ action: 'changes', value: [{ text: '3 files changed' }] });
    expect(rows[6]).toMatchObject({ key: 'archive', action: 'archive' });
    expect(rows[7]).toMatchObject({ key: 'delete', action: 'delete', tone: 'error', icon: 'trash' });
  });

  it('a Full-access session says so; an archived one offers Unarchive; no Changes row without changes', () => {
    const rows = detailRows({ ...BASE, fullAccess: true, archived: true, changes: undefined } as DetailsInput);
    expect(rows.find((row) => row.key === 'permissions')!.value).toEqual([{ text: FULL_ACCESS }]);
    expect(rows.map((row) => row.key)).toEqual(['status', 'agent', 'model', 'folder', 'permissions', 'unarchive', 'delete']);
  });

  it('a model the agent cannot change is a plain row; nothing known and nothing to change: no Model row', () => {
    const fixed = detailRows({ ...BASE, canChangeSettings: false }).find((row) => row.key === 'model')!;
    expect(fixed.action).toBeUndefined();
    expect(fixed.title).toBeUndefined();
    const bare: DetailsInput = { status: 'Idle', statusTone: 'muted', canChangeSettings: false, fullAccess: false, archived: false };
    expect(detailRows(bare).map((row) => row.key)).toEqual(['status', 'permissions', 'archive', 'delete']);
    expect(detailRows(bare)[0]!.icon).toBe('list');
  });

  it('a changeable model not known yet reads "Default model"; effort alone shows without a model', () => {
    const unknown = detailRows({ ...BASE, model: undefined, effort: undefined } as DetailsInput).find((row) => row.key === 'model')!;
    expect(unknown.value).toEqual([{ text: 'Default model', label: 'Model' }]);
    const effortOnly = detailRows({ ...BASE, model: undefined, canChangeSettings: false } as DetailsInput).find((row) => row.key === 'model')!;
    expect(effortOnly.value).toEqual([{ text: 'High', label: 'Effort' }]);
  });

  it('status icons by tone', () => {
    const icon = (statusTone: DetailsInput['statusTone']) => detailRows({ ...BASE, statusTone })[0]!.icon;
    expect([icon('busy'), icon('attention'), icon('error')]).toEqual(['spinner', 'question', 'alert']);
  });

  it('detailsSubtitle: host · folder, whichever is known', () => {
    expect(detailsSubtitle('Mac mini', 'nano-remote')).toBe('Mac mini · nano-remote');
    expect(detailsSubtitle(undefined, 'nano-remote')).toBe('nano-remote');
    expect(detailsSubtitle('', undefined)).toBe('');
  });
});
