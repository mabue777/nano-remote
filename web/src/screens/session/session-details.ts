// The session header's one status line and the rows of its ⋯ details sheet (docs/research/new-look-prototype.md
// item 8). Pure: SessionModel feeds it the session's status, the host connection (home-model connectionOf),
// the running turn's start and the clock; the lab's New look feeds it its fixtures.
import type { IconName } from '../../ui/Icon';
import type { SessionSummary } from '../../replica/types';
import type { Connection } from '../home-model';
import { shortDuration } from './transcript';

export type StatusTone = 'ok' | 'busy' | 'attention' | 'error' | 'muted';

export const OFFLINE_WORD = 'Mac offline';
export const FULL_ACCESS = 'Full access';
export const ASKS_FIRST = 'Asks before running';

export interface StatusLineInput {
  /** The session's status as statusOf words it (home-model). */
  status: { label: string; tone: StatusTone; status: SessionSummary['status'] };
  /** The host connection; offline takes precedence over the session's own status. */
  connection?: Pick<Connection, 'kind' | 'retryInSeconds'>;
  /** The running turn's start, Unix seconds (Turn.startedAt, the same source as "Worked for"). */
  runningSince?: number;
  /** Milliseconds since the epoch. */
  now: number;
  /** Approvals bypassed: the line ends in " · Full access". */
  fullAccess: boolean;
}

export interface StatusLine {
  /** data-status: the session's status, or "offline" while the Mac cannot be reached. */
  status: SessionSummary['status'] | 'offline';
  tone: StatusTone;
  /** "Working", "Needs approval", "Mac offline". */
  word: string;
  /** "2m 14s" while running, "retrying in 3 s" while offline with a retry scheduled. */
  detail?: string;
  /** The word and its detail: "Working · 2m 14s". */
  text: string;
  fullAccess: boolean;
  /** The detail counts: the view re-renders every second while this is true. */
  ticking: boolean;
}

/** The header's footnote: the session's one status, with the live elapsed time or the offline countdown. */
export function statusLine({ status, connection, runningSince, now, fullAccess }: StatusLineInput): StatusLine {
  if (connection?.kind === 'offline') {
    const detail = connection.retryInSeconds === undefined ? undefined : `retrying in ${connection.retryInSeconds} s`;
    return line('offline', 'error', OFFLINE_WORD, detail, fullAccess);
  }
  const elapsed = status.tone === 'busy' && runningSince !== undefined ? shortDuration(now - runningSince * 1000) : undefined;
  return line(status.status, status.tone, status.label, elapsed, fullAccess);
}

function line(status: StatusLine['status'], tone: StatusTone, word: string, detail: string | undefined, fullAccess: boolean): StatusLine {
  return {
    status,
    tone,
    word,
    ...(detail !== undefined ? { detail } : {}),
    text: detail === undefined ? word : `${word} · ${detail}`,
    fullAccess,
    ticking: detail !== undefined,
  };
}

/** The details sheet's Status value: the header's words, plus the last turn's "Worked for" once it ended. */
export function statusValue(line: StatusLine, workedFor?: string): string {
  return line.detail === undefined && workedFor !== undefined ? `${line.text} · ${workedFor}` : line.text;
}

export type DetailAction = 'settings' | 'changes' | 'archive' | 'unarchive' | 'delete';

/** One part of a row's value; `label` names it for assistive tech (and the tests): "Model", "Effort". */
export interface ValuePart {
  text: string;
  label?: string;
}

export interface DetailRow {
  key: string;
  icon: IconName;
  label: string;
  /** Shown at the right, joined by " · ". */
  value: ValuePart[];
  /** A tap does this; a row without one is plain text. */
  action?: DetailAction;
  /** A hover title for the control. */
  title?: string;
  tone?: 'error';
}

export interface DetailsInput {
  /** statusValue(): the header's words. */
  status: string;
  statusTone: StatusTone;
  agent?: string;
  model?: string;
  effort?: string;
  /** The agent lets the model and effort change (SessionModel.canChangeSettings). */
  canChangeSettings: boolean;
  /** The full path of the working folder. */
  folder?: string;
  fullAccess: boolean;
  /** The last turn's "N files changed"; no Changes row without it. */
  changes?: string;
  archived: boolean;
}

const STATUS_ICON: Readonly<Record<StatusTone, IconName>> = { busy: 'spinner', ok: 'check', attention: 'question', error: 'alert', muted: 'list' };

/** The ⋯ sheet: what the old header carried (status, agent, model and effort, folder, Full access), Changes, then archive and delete. */
export function detailRows(input: DetailsInput): DetailRow[] {
  const rows: DetailRow[] = [{ key: 'status', icon: STATUS_ICON[input.statusTone], label: 'Status', value: [{ text: input.status }] }];
  if (input.agent !== undefined) rows.push({ key: 'agent', icon: 'terminal', label: 'Agent', value: [{ text: input.agent }] });
  const model: ValuePart[] = [];
  if (input.model !== undefined || input.canChangeSettings) model.push({ text: input.model ?? 'Default model', label: 'Model' });
  if (input.effort !== undefined) model.push({ text: input.effort, label: 'Effort' });
  if (model.length > 0 || input.canChangeSettings) {
    rows.push({
      key: 'model',
      icon: 'gear',
      label: 'Model',
      value: model,
      ...(input.canChangeSettings ? { action: 'settings' as const, title: 'Change model and effort' } : {}),
    });
  }
  if (input.folder !== undefined) rows.push({ key: 'folder', icon: 'folder', label: 'Folder', value: [{ text: input.folder }] });
  rows.push({ key: 'permissions', icon: 'shield', label: 'Permissions', value: [{ text: input.fullAccess ? FULL_ACCESS : ASKS_FIRST }] });
  if (input.changes !== undefined) rows.push({ key: 'changes', icon: 'file-diff', label: 'Changes', value: [{ text: input.changes }], action: 'changes' });
  rows.push(
    input.archived
      ? { key: 'unarchive', icon: 'archive', label: 'Unarchive', value: [], action: 'unarchive' }
      : { key: 'archive', icon: 'archive', label: 'Archive', value: [], action: 'archive' },
    { key: 'delete', icon: 'trash', label: 'Delete…', value: [], action: 'delete', tone: 'error' },
  );
  return rows;
}

/** "Mac mini · nano-remote": the sheet's subtitle, whichever parts are known. */
export function detailsSubtitle(host: string | undefined, folder: string | undefined): string {
  return [host, folder].filter((part): part is string => part !== undefined && part !== '').join(' · ');
}
