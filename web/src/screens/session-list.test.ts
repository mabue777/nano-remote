import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../replica/types';
import { emptyFilterText, FILTER_STORAGE_KEY, filterRows, loadFilter, phaseOf, runningTasks, saveFilter, signOf, SIGNS, STATUS_FILTERS } from './session-list';

type Phased = Pick<SessionSummary, 'status' | 'lastTurnStatus' | 'pending' | 'backgroundTasks'>;

const s = (fields: Partial<Phased> = {}): Phased => ({ status: 'idle', pending: { approvals: 0, inputs: 0 }, ...fields });
const task = (status: 'running' | 'finished') => ({ id: `t-${status}`, title: 't', status, startedAt: 1 });

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe('phaseOf: where a session stands, for the filter chips', () => {
  it('needs you: a pending approval or question, or a waiting status, wins over running', () => {
    expect(phaseOf(s({ status: 'running', pending: { approvals: 1, inputs: 0 } }))).toBe('needs');
    expect(phaseOf(s({ pending: { approvals: 0, inputs: 2 } }))).toBe('needs');
    expect(phaseOf(s({ status: 'waiting_approval' }))).toBe('needs');
    expect(phaseOf(s({ status: 'waiting_input' }))).toBe('needs');
  });

  it('running: a running turn, an idle row whose turn is in progress, or background tasks only', () => {
    expect(phaseOf(s({ status: 'running' }))).toBe('running');
    expect(phaseOf(s({ lastTurnStatus: 'inProgress' }))).toBe('running');
    expect(phaseOf(s({ lastTurnStatus: 'completed', backgroundTasks: [task('running')] }))).toBe('running');
  });

  it('finished: everything else, including ended tasks and a stopped agent with tasks still listed', () => {
    expect(phaseOf(s({ lastTurnStatus: 'completed' }))).toBe('finished');
    expect(phaseOf(s({ lastTurnStatus: 'failed' }))).toBe('finished');
    expect(phaseOf(s())).toBe('finished');
    expect(phaseOf(s({ status: 'closed' }))).toBe('finished');
    expect(phaseOf(s({ lastTurnStatus: 'completed', backgroundTasks: [task('finished')] }))).toBe('finished');
    expect(phaseOf(s({ status: 'error', backgroundTasks: [task('running')] }))).toBe('finished');
    expect(phaseOf({ status: 'idle' } as Phased)).toBe('finished'); // no pending field at all
  });

  it('runningTasks counts running ones, none while the agent is stopped', () => {
    expect(runningTasks({ status: 'idle', backgroundTasks: [task('running'), task('finished'), task('running')] })).toBe(2);
    expect(runningTasks({ status: 'idle' })).toBe(0);
    expect(runningTasks({ status: 'error', backgroundTasks: [task('running')] })).toBe(0);
  });
});

describe('signOf: one sign per row', () => {
  it('the running spinner, for a turn and for background tasks alone', () => {
    expect(signOf(s({ status: 'running' }))).toEqual({ kind: 'spinner', label: 'Working' });
    expect(signOf(s({ lastTurnStatus: 'completed', backgroundTasks: [task('running')] }))).toBe(SIGNS.running);
  });

  it('the needs-you word: approval, or your answer when a question waits', () => {
    expect(signOf(s({ status: 'waiting_approval', pending: { approvals: 1, inputs: 0 } }))).toEqual({ kind: 'needs', label: 'Needs approval' });
    expect(signOf(s({ status: 'waiting_input', pending: { approvals: 1, inputs: 1 } }))).toEqual({ kind: 'needs', label: 'Needs your answer' });
    expect(signOf(s({ pending: { approvals: 0, inputs: 1 } }))).toBe(SIGNS.answer);
    expect(signOf(s({ pending: { approvals: 2, inputs: 1 } }))).toBe(SIGNS.approval);
    expect(signOf(s({ status: 'waiting_approval' }))).toBe(SIGNS.approval);
  });

  it('"!" on a failure: the agent stopped or the last turn failed', () => {
    expect(signOf(s({ status: 'error' }))).toEqual({ kind: 'failed', label: 'Error' });
    expect(signOf(s({ lastTurnStatus: 'failed' }))).toEqual({ kind: 'failed', label: 'Failed' });
  });

  it('nothing when it finished, with the word read out', () => {
    expect(signOf(s({ lastTurnStatus: 'completed' }))).toEqual({ kind: 'none', label: 'Finished' });
    expect(signOf(s({ lastTurnStatus: 'interrupted' }))).toEqual({ kind: 'none', label: 'Interrupted' });
    expect(signOf(s({ status: 'closed', lastTurnStatus: 'completed' }))).toEqual({ kind: 'none', label: 'Closed' });
    expect(signOf(s())).toEqual({ kind: 'none', label: 'Idle' });
  });
});

describe('the filter chips', () => {
  const rows = [
    { id: 'a', phase: 'needs' as const },
    { id: 'b', phase: 'running' as const },
    { id: 'c', phase: 'finished' as const },
    { id: 'd', phase: 'running' as const },
  ];
  const ids = (list: { id: string }[]) => list.map((r) => r.id);

  it('All · Running · Needs you · Finished, with no counts', () => {
    expect(STATUS_FILTERS.map((f) => f.label)).toEqual(['All', 'Running', 'Needs you', 'Finished']);
    expect(STATUS_FILTERS.every((f) => !/\d/.test(f.label))).toBe(true);
  });

  it('shows the subset of each chip in the list order; All is a copy of everything', () => {
    const all = filterRows(rows, 'all', (r) => r.phase);
    expect(ids(all)).toEqual(['a', 'b', 'c', 'd']);
    expect(all).not.toBe(rows);
    expect(ids(filterRows(rows, 'running', (r) => r.phase))).toEqual(['b', 'd']);
    expect(ids(filterRows(rows, 'needs', (r) => r.phase))).toEqual(['a']);
    expect(ids(filterRows(rows, 'finished', (r) => r.phase))).toEqual(['c']);
  });

  it('keeps the chosen chip in storage; anything unknown, missing or unreadable is All', () => {
    const storage = new MemoryStorage();
    expect(loadFilter(storage)).toBe('all');
    saveFilter(storage, 'needs');
    expect(storage.getItem(FILTER_STORAGE_KEY)).toBe('needs');
    expect(loadFilter(storage)).toBe('needs');
    storage.setItem(FILTER_STORAGE_KEY, 'bogus');
    expect(loadFilter(storage)).toBe('all');
    expect(loadFilter(null)).toBe('all');
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadFilter(blocked)).toBe('all');
    expect(() => saveFilter(blocked, 'running')).not.toThrow();
    expect(() => saveFilter(null, 'running')).not.toThrow();
  });

  it('says why a chip shows nothing', () => {
    expect(emptyFilterText('running')).toBe('Nothing is running.');
    expect(emptyFilterText('needs')).toBe('Nothing needs you.');
    expect(emptyFilterText('finished')).toBe('No finished sessions.');
  });
});
