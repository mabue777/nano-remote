import { describe, expect, it } from 'vitest';

import { RequestError } from '../../../stream/client';
import type { TurnDiffResult } from '../../../generated/methods';
import type { SessionView } from '../../../replica/types';
import {
  ENTRY_CAP,
  folderName,
  folderSubtitle,
  FolderModel,
  formatDate,
  isHidden,
  sortEntries,
  visibleEntries,
  type FolderReader,
  type FolderReplica,
} from './folder-model';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

function dirEntry(name: string, kind: 'dir' | 'file', options: { size?: number; mtimeMs?: number; hidden?: boolean; path?: string } = {}) {
  return {
    name,
    kind,
    path: options.path ?? name,
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(options.mtimeMs !== undefined ? { mtimeMs: options.mtimeMs } : {}),
    ...(options.hidden === true ? { hidden: true } : {}),
  };
}

function makeReader(entries: ReturnType<typeof dirEntry>[], error?: unknown): FolderReader & { calls: { method: string; params?: Record<string, unknown> }[] } {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  return {
    calls,
    request: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (error !== undefined) throw error;
      return { entries } as T;
    },
  };
}

function sessionView(turnId: string, status: 'completed' | 'interrupted' | 'failed' = 'completed'): SessionView {
  return {
    sessionId: 's',
    session: { sessionId: 's', cwd: '/s', agentId: 'codex', title: 'T', status: 'idle', createdAt: 1, updatedAt: 1 } as SessionView['session'],
    cursor: 0,
    turns: [{ turnId, status, items: [], optimistic: undefined, startedAt: 1, completedAt: status === 'completed' ? 2 : null, error: null }] as SessionView['turns'],
    items: {},
    status: 'idle',
    loaded: true,
    olderCursor: undefined,
    usage: null,
    approvals: {},
    inputs: {},
  };
}

function makeReplica(options: { turnDiff?: () => Promise<TurnDiffResult>; view?: SessionView } = {}): FolderReplica {
  return {
    session: () => options.view,
    open: async () => undefined,
    turnDiff: options.turnDiff ?? (async () => ({ files: [] })),
    subscribe: () => () => undefined,
  };
}

describe('folder helpers', () => {
  it('names and subtitles', () => {
    expect(folderName('src/components')).toBe('components');
    expect(folderName('')).toBe('');
    expect(folderName('src/')).toBe('src');
    expect(folderSubtitle('', 'phone-test')).toBe('phone-test');
    expect(folderSubtitle('', undefined)).toBe('Session folder');
    expect(folderSubtitle('src/components', 'phone-test')).toBe('src / components');
  });

  it('formats dates relative to now', () => {
    const now = Date.parse('2026-10-28T14:02:00Z');
    expect(formatDate(now, now)).toMatch(/^Today /);
    expect(formatDate(now - 24 * 60 * 60 * 1000, now)).toMatch(/^Yesterday /);
    expect(formatDate(Date.parse('2026-10-20T14:02:00Z'), now)).toContain('Oct 20');
  });

  it('sorts folders first, then files, dot-files last within their kind', () => {
    const entries = [
      dirEntry('b.ts', 'file'),
      dirEntry('.gitignore', 'file'),
      dirEntry('a', 'dir'),
      dirEntry('.env', 'dir'),
    ];
    expect(sortEntries(entries, false).map((e) => e.name)).toEqual(['a', 'b.ts', '.env', '.gitignore']);
    expect(sortEntries(entries, true).map((e) => e.name)).toEqual(['a', 'b.ts', '.env', '.gitignore']);
  });

  it('recognises hidden entries by name or flag', () => {
    expect(isHidden(dirEntry('.env', 'file'))).toBe(true);
    expect(isHidden(dirEntry('a', 'file'))).toBe(false);
    expect(isHidden(dirEntry('a', 'file', { hidden: true }))).toBe(true);
  });

  it('caps and hides dot-files', () => {
    const entries = Array.from({ length: ENTRY_CAP + 5 }, (_, i) => dirEntry(`f${String(i).padStart(4, '0')}.txt`, 'file'));
    entries.push(dirEntry('.hidden', 'file'));
    const { visible, capped } = visibleEntries(entries, false);
    expect(visible).toHaveLength(ENTRY_CAP);
    expect(capped).toBe(5);
    expect(visibleEntries(entries, true).visible).toHaveLength(ENTRY_CAP);
    expect(visibleEntries([dirEntry('.hidden', 'file'), dirEntry('a', 'file')], false).visible.map((e) => e.name)).toEqual(['a']);
  });
});

describe('FolderModel', () => {
  it('loads, sorts, caps and marks changed files', async () => {
    const reader = makeReader([
      dirEntry('src', 'dir', { mtimeMs: Date.now() - 60_000 }),
      dirEntry('a.md', 'file', { size: 120, mtimeMs: Date.now() - 120_000 }),
      dirEntry('b.png', 'file', { size: 70, mtimeMs: Date.now() - 180_000 }),
    ]);
    const replica = makeReplica({
      turnDiff: async () => ({ files: [{ path: 'a.md', kind: 'modify', diff: '' }] }),
      view: sessionView('t1'),
    });
    const model = new FolderModel({ sessionId: 's', path: '', reader, replica, storage: memoryStorage() });
    expect(model.state).toEqual({ state: 'loading' });
    await model.load();
    expect(reader.calls).toContainEqual({ method: 'fs/readDirectory', params: { sessionId: 's', path: '' } });
    expect(model.state.state).toBe('ready');
    const entries = model.state.state === 'ready' ? model.state.entries : [];
    expect(entries.map((e) => e.name)).toEqual(['src', 'a.md', 'b.png']);
    expect(entries[1]!.changed).toBe(true);
    expect(entries[2]!.changed).toBe(false);
    expect(entries[1]!.meta).toContain('120 bytes');
  });

  it('shows an error when readDirectory fails', async () => {
    const reader = makeReader([], new RequestError('not_found', 'no folder'));
    const model = new FolderModel({ sessionId: 's', path: '../out', reader, replica: makeReplica(), storage: memoryStorage() });
    await model.load();
    expect(model.state).toEqual({ state: 'error', message: 'That folder is not in the session folder.' });
  });

  it('toggles hidden files and remembers the choice', async () => {
    const storage = memoryStorage();
    const reader = makeReader([dirEntry('a', 'file'), dirEntry('.hidden', 'file')]);
    const model = new FolderModel({ sessionId: 's', path: '', reader, replica: makeReplica(), storage });
    await model.load();
    expect(model.state.state === 'ready' && model.state.entries.map((e) => e.name)).toEqual(['a']);
    model.toggleHidden();
    expect(model.hidden).toBe(true);
    expect(storage.data['nano.files.showHidden']).toBe('true');
    expect(model.state.state === 'ready' && model.state.entries.map((e) => e.name)).toEqual(['a', '.hidden']);
    const again = new FolderModel({ sessionId: 's', path: '', reader, replica: makeReplica(), storage });
    expect(again.hidden).toBe(true);
  });

  it('refresh re-reads and updates changed markers', async () => {
    const reader = makeReader([dirEntry('a', 'file')]);
    let diff: TurnDiffResult = { files: [{ path: 'a', kind: 'modify', diff: '' }] };
    const replica = makeReplica({ turnDiff: async () => diff, view: sessionView('t1') });
    const model = new FolderModel({ sessionId: 's', path: '', reader, replica, storage: memoryStorage() });
    await model.load();
    expect(model.state.state === 'ready' && model.state.entries[0]!.changed).toBe(true);
    diff = { files: [] };
    await model.refresh();
    expect(model.state.state === 'ready' && model.state.entries[0]!.changed).toBe(false);
  });

  it('ignores stale answers after dispose or a newer load', async () => {
    let release: (() => void) | undefined;
    let requestedResolve: () => void;
    const requested = new Promise<void>((resolve) => {
      requestedResolve = resolve;
    });
    const reader: FolderReader = {
      request: <T>() => {
        requestedResolve();
        return new Promise<T>((resolve) => {
          release = () => resolve({ entries: [dirEntry('a', 'file')] } as T);
        });
      },
    };
    const model = new FolderModel({ sessionId: 's', path: '', reader, replica: makeReplica(), storage: memoryStorage() });
    const first = model.load();
    await requested;
    model.dispose();
    release!();
    await first;
    expect(model.state).toEqual({ state: 'loading' });
  });
});
