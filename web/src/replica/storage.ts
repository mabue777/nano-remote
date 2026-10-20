// What survives a lock or a discarded page: session summaries, the open session id, and the open
// session's view with its cursor (the two only travel together: a cursor without the state it refers to
// would make events mode skip history). localStorage in the browser; injected in tests.
import type { SessionSummary, SessionView } from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedReplica {
  v: 1;
  openSessionId?: string;
  sessions: SessionSummary[];
  views: SessionView[];
}

export const DEFAULT_STORAGE_KEY = 'nano-remote/replica/v1';

export function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null; // some browsers throw on access when storage is disabled
  }
}

export function load(storage: StorageLike | null, key: string): PersistedReplica | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const data = JSON.parse(raw) as Partial<PersistedReplica>;
    if (data.v !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.views)) return null;
    return data as PersistedReplica;
  } catch {
    return null;
  }
}

/**
 * Writes the state. When the full write fails (quota), writes it again without views, so the list and
 * open session survive and the next open falls back to a snapshot. Returns what was written.
 */
export function save(storage: StorageLike | null, key: string, data: PersistedReplica): 'full' | 'summaries' | 'none' {
  if (storage === null) return 'none';
  try {
    storage.setItem(key, JSON.stringify(data));
    return 'full';
  } catch {
    try {
      storage.setItem(key, JSON.stringify({ ...data, views: [] }));
      return 'summaries';
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // nothing more to do
      }
      return 'none';
    }
  }
}
