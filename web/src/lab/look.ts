// The lab's "Look" switch (Now = today's look, New = the redesign from docs/research/visual-gap-openai-2026-10.md)
// and the few rules the New look adds: the one trailing status indicator per session row and the host chips
// that filter the list. The "Worked for" and "previous messages" wording moved to screens/session/transcript.ts.
// Kept apart from the technique switches: All Now / All Smooth never change the look, so every look combines
// with every motion setting.
import type { StorageLike } from '../replica/storage';
import type { LabSession, Tone } from './fixtures';

export type Look = 'now' | 'new';

export const LOOK_KEY = 'nano-remote/lab/look/v1';

export function loadLook(storage: StorageLike | null): Look {
  try {
    return storage?.getItem(LOOK_KEY) === 'new' ? 'new' : 'now';
  } catch {
    return 'now';
  }
}

export function saveLook(storage: StorageLike | null, look: Look): void {
  try {
    storage?.setItem(LOOK_KEY, look);
  } catch {
    // storage full or blocked: the choice lasts for this page only
  }
}

// "Worked for 3m 12s" and "N previous messages" moved to the session view, which adopted them.
export { previousMessages, workedFor } from '../screens/session/transcript';

/** The one thing at the end of a session row: a spinner, a tinted pill, a "?" bubble, an alert, or nothing. */
export type Indicator = { kind: 'spinner' | 'question' | 'alert' | 'none'; label: string } | { kind: 'pill'; label: string };

export function indicatorOf(session: Pick<LabSession, 'tone' | 'status'>): Indicator {
  const byTone: Record<Tone, Indicator> = {
    busy: { kind: 'spinner', label: 'Running' },
    attention: /input|question/i.test(session.status) ? { kind: 'question', label: 'Needs your input' } : { kind: 'pill', label: 'Awaiting approval' },
    error: { kind: 'alert', label: 'Failed' },
    ok: { kind: 'none', label: 'Finished' },
    muted: { kind: 'none', label: 'Idle' },
  };
  return byTone[session.tone];
}

export const ALL_HOSTS = 'All';

/** The host chips, in first-seen order, after "All". */
export function hostsOf(sessions: readonly Pick<LabSession, 'host'>[]): string[] {
  return [ALL_HOSTS, ...new Set(sessions.map((s) => s.host))];
}

/** The rows on one host (all of them for "All"); `hostOf` reads a row's host. */
export function onHost<T>(rows: readonly T[], host: string, hostOf: (row: T) => string): T[] {
  return host === ALL_HOSTS ? [...rows] : rows.filter((row) => hostOf(row) === host);
}
