// The flat session list's rules (docs/research/new-look-prototype.md item 6, look step 6): which phase a
// session is in, the status filter chips under the large title (All · Running · Needs you · Finished, kept
// across reloads), and the ONE sign at the end of each row. Shared by Home (HomeScreen.tsx) and the lab's
// New look (lab/look.ts, lab/NewLook.tsx), which render the same RowSign.
import type { StorageLike } from '../replica/storage';
import type { SessionSummary } from '../replica/types';

/** Where a session stands, for the filter: it waits for you, it works, or its turn is over. */
export type Phase = 'needs' | 'running' | 'finished';

export type StatusFilter = 'all' | Phase;

/** The chips, in order. No counts on them (a status is a dot and a word, never a badge). */
export const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'needs', label: 'Needs you' },
  { value: 'finished', label: 'Finished' },
];

type Phased = Pick<SessionSummary, 'status' | 'lastTurnStatus' | 'pending' | 'backgroundTasks'>;

/** Running background tasks; none count while the agent is stopped (they cannot still run). */
export function runningTasks(summary: Pick<SessionSummary, 'status' | 'backgroundTasks'>): number {
  if (summary.status === 'error') return 0;
  return (summary.backgroundTasks ?? []).filter((task) => task.status === 'running').length;
}

/**
 * Needs you: an approval or a question waits for an answer (it wins over everything else). Running: a turn
 * runs, or only its agent's background tasks still do. Finished: everything else (ended, failed, idle).
 */
export function phaseOf(summary: Phased): Phase {
  const pending = (summary.pending?.approvals ?? 0) + (summary.pending?.inputs ?? 0);
  if (pending > 0 || summary.status === 'waiting_approval' || summary.status === 'waiting_input') return 'needs';
  if (summary.status === 'running' || (summary.status === 'idle' && summary.lastTurnStatus === 'inProgress')) return 'running';
  if (runningTasks(summary) > 0) return 'running';
  return 'finished';
}

/** The rows the chip shows; `phaseOfRow` reads a row's phase. */
export function filterRows<T>(rows: readonly T[], filter: StatusFilter, phaseOfRow: (row: T) => Phase): T[] {
  return filter === 'all' ? [...rows] : rows.filter((row) => phaseOfRow(row) === filter);
}

/** The one sign at the end of a row: the running spinner, the needs-you dot and word, "!" on a failure, or nothing. */
export type RowSign =
  | { kind: 'spinner'; label: string }
  | { kind: 'needs'; label: 'Needs approval' | 'Needs your answer' }
  | { kind: 'failed'; label: string }
  | { kind: 'none'; label: string };

export const SIGNS = {
  running: { kind: 'spinner', label: 'Working' },
  approval: { kind: 'needs', label: 'Needs approval' },
  answer: { kind: 'needs', label: 'Needs your answer' },
} as const satisfies Record<string, RowSign>;

/**
 * The row's sign. A question waiting wins the word when the session says it waits for input, or when no
 * approval waits; a failure is the agent stopping (`error`) or the last turn failing. `label` is the
 * status word (shown for needs, read out for the others).
 */
export function signOf(summary: Phased): RowSign {
  const approvals = summary.pending?.approvals ?? 0;
  const inputs = summary.pending?.inputs ?? 0;
  switch (phaseOf(summary)) {
    case 'needs':
      if (summary.status === 'waiting_input' || (approvals === 0 && inputs > 0)) return SIGNS.answer;
      return SIGNS.approval;
    case 'running':
      return SIGNS.running;
    case 'finished':
      if (summary.status === 'error') return { kind: 'failed', label: 'Error' };
      if (summary.status === 'idle' && summary.lastTurnStatus === 'failed') return { kind: 'failed', label: 'Failed' };
      return { kind: 'none', label: finishedLabel(summary) };
  }
}

function finishedLabel(summary: Pick<SessionSummary, 'status' | 'lastTurnStatus'>): string {
  if (summary.status === 'closed') return 'Closed';
  if (summary.lastTurnStatus === 'completed') return 'Finished';
  if (summary.lastTurnStatus === 'interrupted') return 'Interrupted';
  return 'Idle';
}

// ---- the chosen chip, kept across reloads (the replica/storage.ts pattern: injected storage, never throws) ----

export const FILTER_STORAGE_KEY = 'nano-remote/home/filter/v1';

export function loadFilter(storage: Pick<StorageLike, 'getItem'> | null): StatusFilter {
  try {
    const raw = storage?.getItem(FILTER_STORAGE_KEY);
    return STATUS_FILTERS.find((f) => f.value === raw)?.value ?? 'all';
  } catch {
    return 'all'; // storage blocked
  }
}

export function saveFilter(storage: Pick<StorageLike, 'setItem'> | null, filter: StatusFilter): void {
  try {
    storage?.setItem(FILTER_STORAGE_KEY, filter);
  } catch {
    // storage full or blocked: the choice lasts for this page only
  }
}

/** Home's empty line under a chip that shows nothing. */
export function emptyFilterText(filter: Exclude<StatusFilter, 'all'>): string {
  switch (filter) {
    case 'running':
      return 'Nothing is running.';
    case 'needs':
      return 'Nothing needs you.';
    case 'finished':
      return 'No finished sessions.';
  }
}
