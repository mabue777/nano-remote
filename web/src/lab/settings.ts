// The lab's switches: one Now/Smooth choice per interaction technique, kept in localStorage so a reload on
// the phone keeps what the operator picked. "Now" is today's behaviour, "Smooth" the proposal.
import type { StorageLike } from '../replica/storage';

export type Mode = 'now' | 'smooth';

export interface Technique {
  id: TechniqueId;
  /** Short name in the Lab panel. */
  name: string;
  /** One line: what to do to feel the difference. */
  tryIt: string;
}

export type TechniqueId = 'press' | 'page' | 'sheet' | 'stream' | 'scroll' | 'send' | 'keyboard' | 'list' | 'expand' | 'haptic';

export const TECHNIQUES: readonly Technique[] = [
  { id: 'press', name: 'Press feedback', tryIt: 'Tap and hold a session row or a button.' },
  { id: 'page', name: 'Page push and back swipe', tryIt: 'Open a session, then go back, or swipe from the left edge.' },
  { id: 'sheet', name: 'Sheets', tryIt: 'Open Changes or New session; drag the sheet down.' },
  { id: 'stream', name: 'Streaming text', tryIt: 'Watch the answer arrive (Replay restarts it).' },
  { id: 'scroll', name: 'Auto-scroll', tryIt: 'Let the answer stream, scroll up, then jump to latest.' },
  { id: 'send', name: 'Sending', tryIt: 'Type two lines and send.' },
  { id: 'keyboard', name: 'Keyboard', tryIt: 'Tap the message field so the keyboard opens.' },
  { id: 'list', name: 'List changes', tryIt: 'Tap "Simulate activity" on the session list.' },
  { id: 'expand', name: 'Expand and collapse', tryIt: 'Tap a tool row; approve the approval card.' },
  { id: 'haptic', name: 'Haptic tick', tryIt: 'Send or approve on an iPhone with iOS 18 or later.' },
];

export type LabSettings = Record<TechniqueId, Mode>;

export const STORAGE_KEY = 'nano-remote/lab/v1';

/** Everything at one mode. */
export function allAt(mode: Mode): LabSettings {
  return Object.fromEntries(TECHNIQUES.map((t) => [t.id, mode])) as LabSettings;
}

/** The stored choices; missing, unknown or broken entries fall back to Now. */
export function loadSettings(storage: StorageLike | null): LabSettings {
  const settings = allAt('now');
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return settings;
  }
  if (raw === null) return settings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (typeof parsed !== 'object' || parsed === null) return settings;
  for (const t of TECHNIQUES) {
    const value = (parsed as Record<string, unknown>)[t.id];
    if (value === 'now' || value === 'smooth') settings[t.id] = value;
  }
  return settings;
}

export function saveSettings(storage: StorageLike | null, settings: LabSettings): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage full or blocked: the choice lasts for this page only
  }
}
