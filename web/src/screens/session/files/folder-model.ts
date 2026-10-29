// The folder browser of a session (docs/plan/file-viewer.md item P6): what the Files page shows for one
// level of the session folder. Pure: the page owns the DOM; this file owns state and rules, testable in Node.
//
// Listing. `fs/readDirectory {sessionId, path}` returns entries with `size` (files), `mtimeMs` and `hidden`.
// Folders come first, then files, both sorted by name; dot-files are hidden unless the switch is on. The list
// is capped at `ENTRY_CAP` entries; the page says how many more exist.
//
// Changed markers. A file whose path is among the last finished turn's changes gets a dot + the word
// "changed". The model merges `turn/diff` with the turn's own fileChange items, the same rule the Changes
// view uses (changes-model.ts), so git-tracked edits and agent edits outside git both show.
//
// Refresh. Pull-to-refresh calls `refresh()`, which re-reads the directory and the last turn's changes.
import type { DirEntry, FsReadDirectoryResult, TurnDiffResult } from '../../../generated/methods';
import type { SessionView } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { RequestError } from '../../../stream/client';
import { agentFiles, changedFile, mergeChanges } from '../views/changes-model';
import { formatBytes } from './file-model';

/** Most entries shown at once; the page says how many more exist (matches the research cap). */
export const ENTRY_CAP = 1000;
/** Storage key for the "Show hidden files" switch; kept per phone, not per session. */
export const HIDDEN_KEY = 'nano.files.showHidden';

export interface FolderReader {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** What the FolderModel needs from the Replica beyond plain requests. */
export interface FolderReplica {
  session(sessionId: string): SessionView | undefined;
  open(sessionId: string): Promise<void>;
  turnDiff(sessionId: string, turnId: string): Promise<TurnDiffResult>;
  subscribe(listener: () => void): () => void;
}

/** One entry as the page shows it, with the grey meta line and a changed marker. */
export interface FolderEntry extends DirEntry {
  /** "12 KB · Today 14:02" for files; the modified date for folders. */
  meta: string;
  /** This path changed in the last finished turn. */
  changed: boolean;
}

export type FolderState =
  | { state: 'loading' }
  | { state: 'ready'; entries: FolderEntry[]; capped: number }
  | { state: 'error'; message: string };

/** The last segment of a path; the empty path is the session folder root. */
export function folderName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts.at(-1) ?? '';
}

/** The path to show under the title: the parent chain, or the session folder name when at the root. */
export function folderSubtitle(path: string, sessionFolderName: string | undefined): string {
  if (path === '' || path === '.') return sessionFolderName ?? 'Session folder';
  const parts = path.split('/').filter((p) => p !== '');
  return parts.join(' / ');
}

/** A date relative to now: "Today 14:02", "Yesterday 14:02", or a short date. */
export function formatDate(mtimeMs: number, now = Date.now()): string {
  const date = new Date(mtimeMs);
  const nowDate = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, nowDate)) return `Today ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  if (sameDay(date, yesterday)) return `Yesterday ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Sort: folders first, then files; hidden entries last within their kind; by name. */
export function sortEntries(entries: DirEntry[], _showHidden: boolean): DirEntry[] {
  return [...entries].sort((a, b) => {
    const aHidden = isHidden(a) ? 1 : 0;
    const bHidden = isHidden(b) ? 1 : 0;
    // Hidden entries stay after visible ones of the same kind.
    if (aHidden !== bHidden) return aHidden - bHidden;
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** True when the entry is a dot-file or marked hidden. */
export function isHidden(entry: DirEntry): boolean {
  return entry.hidden === true || entry.name.startsWith('.');
}

/** Visible entries and how many are hidden by the cap or the switch. */
export function visibleEntries(entries: DirEntry[], showHidden: boolean, cap = ENTRY_CAP): { visible: DirEntry[]; capped: number } {
  const sorted = sortEntries(entries, showHidden);
  let visible = sorted;
  let capped = 0;
  if (!showHidden) {
    const kept: DirEntry[] = [];
    for (const entry of sorted) {
      if (isHidden(entry)) continue;
      kept.push(entry);
    }
    visible = kept;
  }
  if (visible.length > cap) {
    capped = visible.length - cap;
    visible = visible.slice(0, cap);
  }
  return { visible, capped };
}

/** The icon name for an entry. */
export function entryIcon(entry: DirEntry): 'folder' | 'image' | 'file' {
  if (entry.kind === 'dir') return 'folder';
  // Entries from fs/readDirectory do not carry mediaType; guess from the name.
  const ext = entry.name.split('.').pop()?.toLowerCase();
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'heic' || ext === 'heif' || ext === 'avif') return 'image';
  return 'file';
}

function readError(error: unknown): { message: string } {
  if (error instanceof RequestError) {
    if (error.code === 'not_found') return { message: 'That folder is not in the session folder.' };
    if (error.code === 'timeout' || error.code === 'connection_lost' || error.code === 'client_closed') {
      return { message: "Couldn't load this folder. Check the connection to your Mac." };
    }
  }
  return { message: errorText(error) };
}

/** Builds the changed-path Set for the last finished turn from turn/diff + the turn's fileChange items. */
async function lastChangedPaths(replica: FolderReplica, sessionId: string): Promise<Set<string>> {
  const view = replica.session(sessionId);
  if (view === undefined) return new Set();
  let last: { turnId: string } | undefined;
  for (let i = view.turns.length - 1; i >= 0; i -= 1) {
    const turn = view.turns[i]!;
    if (turn.optimistic === undefined && (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed')) {
      last = turn;
      break;
    }
  }
  if (last === undefined) return new Set();
  try {
    const result = await replica.turnDiff(sessionId, last.turnId);
    const git = result.files.map(changedFile);
    const agent = agentFiles(view, last.turnId);
    const merged = mergeChanges(git, agent);
    return new Set(merged.map((f) => f.path));
  } catch {
    return new Set();
  }
}

/** Loads a directory relative to the session folder. */
async function loadDirectory(reader: FolderReader, sessionId: string, path: string): Promise<DirEntry[]> {
  const result = await reader.request<FsReadDirectoryResult>('fs/readDirectory', { sessionId, path });
  return result.entries ?? [];
}

/** Reads the saved hidden-files switch, default off. */
function readHidden(storage: Pick<Storage, 'getItem'> | null): boolean {
  if (storage === null) return false;
  try {
    return JSON.parse(storage.getItem(HIDDEN_KEY) ?? 'false') === true;
  } catch {
    return false;
  }
}

/** Saves the hidden-files switch. */
function writeHidden(storage: Pick<Storage, 'setItem'> | null, on: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(HIDDEN_KEY, JSON.stringify(on));
  } catch {
    // storage full or blocked: the choice lasts for this page only
  }
}

export interface FolderModelOptions {
  sessionId: string;
  /** Relative to the session folder; '' is the root. */
  path: string;
  reader: FolderReader;
  replica: FolderReplica;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export class FolderModel extends Model {
  readonly sessionId: string;
  path: string;
  hidden: boolean;
  private _state: FolderState = { state: 'loading' };
  private request = 0;
  private disposed = false;
  private readonly reader: FolderReader;
  private readonly replica: FolderReplica;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private changedPaths = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private allEntries: DirEntry[] = [];

  constructor(options: FolderModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.path = options.path;
    this.reader = options.reader;
    this.replica = options.replica;
    this.storage = options.storage;
    this.hidden = readHidden(options.storage);
    this.unsubscribe = this.replica.subscribe(() => {
      // The Replica may signal a turn end: refresh changed markers without a full reload.
      void this.refreshChanged();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
  }

  get state(): FolderState {
    return this._state;
  }

  private setState(next: FolderState): void {
    this._state = next;
  }

  /** The title of the page: the current folder's name, or "Files" at the root. */
  get title(): string {
    return folderName(this.path) || 'Files';
  }

  /** True while the first load is in flight. */
  get loading(): boolean {
    return this._state.state === 'loading';
  }

  /** Re-read the directory and the last turn's changes. */
  async load(): Promise<void> {
    const ticket = ++this.request;
    this.setState({ state: 'loading' });
    this.changed();
    try {
      await this.replica.open(this.sessionId).catch(() => undefined);
      const [entries, changed] = await Promise.all([loadDirectory(this.reader, this.sessionId, this.path), lastChangedPaths(this.replica, this.sessionId)]);
      if (this.stale(ticket)) return;
      this.changedPaths = changed;
      this.present(entries);
    } catch (error) {
      if (this.stale(ticket)) return;
      this.setState({ state: 'error', message: readError(error).message });
      this.changed();
    }
  }

  /** A pull-to-refresh re-reads the directory but keeps the list on screen until it returns. */
  async refresh(): Promise<void> {
    const ticket = ++this.request;
    try {
      await this.replica.open(this.sessionId).catch(() => undefined);
      const [entries, changed] = await Promise.all([loadDirectory(this.reader, this.sessionId, this.path), lastChangedPaths(this.replica, this.sessionId)]);
      if (this.stale(ticket)) return;
      this.changedPaths = changed;
      this.present(entries);
    } catch (error) {
      if (this.stale(ticket)) return;
      this.setState({ state: 'error', message: readError(error).message });
      this.changed();
    }
  }

  /** Toggle the hidden-files switch; the list re-sorts and re-caps in place. */
  toggleHidden(): void {
    this.hidden = !this.hidden;
    writeHidden(this.storage, this.hidden);
    if (this.allEntries.length > 0) {
      this.present(this.allEntries);
    }
    this.changed();
  }

  private async refreshChanged(): Promise<void> {
    const changed = await lastChangedPaths(this.replica, this.sessionId);
    this.changedPaths = changed;
    if (this.allEntries.length > 0) {
      this.present(this.allEntries);
    }
  }

  private present(entries: DirEntry[]): void {
    this.allEntries = entries;
    const { visible, capped } = visibleEntries(entries, this.hidden);
    this.setState({
      state: 'ready',
      entries: visible.map((entry) => ({
        ...entry,
        meta: entryMeta(entry),
        changed: this.changedPaths.has(entry.path),
      })),
      capped,
    });
    this.changed();
  }

  private stale(ticket: number): boolean {
    return this.disposed || ticket !== this.request;
  }
}

function entryMeta(entry: DirEntry, now = Date.now()): string {
  const date = formatDate(entry.mtimeMs ?? now, now);
  if (entry.kind === 'dir' || entry.size === undefined) return date;
  return `${formatBytes(entry.size)} · ${date}`;
}
