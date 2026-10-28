// The Changes view of one turn (turn/diff, spec 7): the files the turn changed, each with its kind and
// +/- counts, and one file's diff at a time (tap a file to open it, "All files" to go back). The host
// computes the diff from git snapshots of the session folder, the same for every agent.
//
// git does not see everything the agent changed: a folder outside git has no diff at all, and a file outside
// the folder (/tmp, another project) is never in it. The turn's fileChange items carry the agent's own diff
// of each edit, so the view merges those in (mergeChanges): files git listed keep git's diff, the others are
// shown from the agent's edits, marked as such. Only when neither has anything does the view say why.
//
// States: loading, the files (with the host's `note` when the diff is not exactly the turn's own change,
// and how much was cut at the host's caps), not_supported (an agent without diffs), not_a_repository (the
// session folder is not in git), or another error with a retry. A running turn's diff is not final, so the
// model fetches again whenever the turn's status changes.
import type { FileChange } from '../../../generated/common';
import type { TurnDiffResult } from '../../../generated/methods';
import type { SessionView } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { FILE_KIND_LABEL, fileKind, parseAgentDiff, parseUnifiedDiff, type DiffLine, type FileKind } from './diff';

/** What the Changes view needs from the Replica; Replica fits. */
export interface ChangesReplica {
  session(sessionId: string): SessionView | undefined;
  subscribe(listener: () => void): () => void;
  turnDiff(sessionId: string, turnId: string): Promise<TurnDiffResult>;
}

export interface ChangedFile {
  path: string;
  kind: FileKind;
  label: string;
  /** The path before a rename. */
  renamedFrom?: string;
  added: number;
  removed: number;
  binary: boolean;
  /** The host cut this file's diff text at its caps (spec 7). */
  truncated: boolean;
  lines: DiffLine[];
  /** Shown from the agent's own fileChange items, not from git. */
  fromAgent?: true;
  /** Some lines carry no line numbers: the agent sent them so. */
  unnumbered?: true;
}

export type ChangesState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; files: ChangedFile[]; note?: string; omittedFiles: number; truncated: boolean }
  | { state: 'unsupported' }
  | { state: 'notRepository' }
  | { state: 'error'; message: string };

export const NOT_SUPPORTED_TEXT = 'This agent does not provide diffs.';
export const NOT_A_REPOSITORY_TEXT = "This folder is not a git repository, so only the agent's own edits can be shown.";
/** The mark of a file shown from the agent's edits. */
export const FROM_AGENT_TEXT = "From the agent's edits, not git";
/** The footnote of a diff whose lines carry no line numbers. */
export const UNNUMBERED_TEXT = 'Lines as the agent sent them';

/** "1 file changed", "3 files changed". */
export function filesChangedText(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'} changed`;
}

/** git's header lines the file header already says: `diff --git a/x b/x` and `index <old>..<new> <mode>`. */
const NOISE = /^(diff --git |index [0-9a-f]+\.\.[0-9a-f]+)/;

/** A file of turn/diff as the view shows it: kind from the host (a patch that renames wins over modify). */
export function changedFile(file: TurnDiffResult['files'][number]): ChangedFile {
  const parsed = parseUnifiedDiff(file.diff);
  const renamedFrom = file.oldPath ?? parsed.renamedFrom;
  const kind = fileKind(file.kind, parsed);
  return {
    path: file.path,
    kind,
    label: FILE_KIND_LABEL[kind],
    ...(renamedFrom !== undefined && kind === 'renamed' ? { renamedFrom } : {}),
    added: parsed.added,
    removed: parsed.removed,
    binary: file.binary === true || parsed.binary,
    truncated: file.truncated === true,
    lines: parsed.lines.filter((line) => line.kind !== 'meta' || !NOISE.test(line.text)),
  };
}

/** An absolute path inside the session folder as git names it (relative to the folder); others stay as they are. */
export function folderPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || !path.startsWith('/')) return path;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/**
 * One file as the agent's edits of it show it: every edit's diff in order (a turn may edit a file several
 * times). Added when the first edit added it, deleted when the last one deleted it.
 */
export function agentFile(path: string, changes: readonly FileChange[]): ChangedFile {
  const parsed = changes.map((c) => parseAgentDiff(c.diff, c.kind));
  const first = changes[0]?.kind;
  const last = changes[changes.length - 1]?.kind;
  const kind: FileKind = last === 'delete' ? 'deleted' : first === 'add' ? 'added' : 'modified';
  return {
    path,
    kind,
    label: FILE_KIND_LABEL[kind],
    added: parsed.reduce((n, p) => n + p.added, 0),
    removed: parsed.reduce((n, p) => n + p.removed, 0),
    binary: parsed.length > 0 && parsed.every((p) => p.binary),
    truncated: false,
    lines: parsed.flatMap((p) => p.lines).filter((line) => line.kind !== 'meta' || !NOISE.test(line.text)),
    fromAgent: true,
    ...(parsed.some((p) => p.unnumbered === true) ? { unnumbered: true as const } : {}),
  };
}

/** The files the turn's fileChange items changed, in the order first changed, named as git names them. */
export function agentFiles(view: SessionView | undefined, turnId: string | undefined): ChangedFile[] {
  const turn = view?.turns.find((t) => t.turnId === turnId);
  if (view === undefined || turn === undefined) return [];
  const cwd = view.session?.cwd;
  const byPath = new Map<string, FileChange[]>();
  for (const id of turn.items) {
    const item = view.items[id];
    if (item?.type !== 'fileChange') continue;
    for (const change of item.changes) {
      if (change.path === '') continue;
      const path = folderPath(change.path, cwd);
      byPath.set(path, [...(byPath.get(path) ?? []), change]);
    }
  }
  return [...byPath].map(([path, changes]) => agentFile(path, changes));
}

/**
 * The merge rule: git's files keep git's diff; the files the agent reported that git did not list (outside
 * the session folder, or no git at all) follow, from the agent's edits.
 */
export function mergeChanges(git: readonly ChangedFile[], agent: readonly ChangedFile[]): ChangedFile[] {
  const listed = new Set(git.map((f) => f.path));
  return [...git, ...agent.filter((f) => !listed.has(f.path))];
}

/** What turn/diff answered, before the agent's edits are merged in. */
type GitAnswer = { files: ChangedFile[]; omittedFiles: number; truncated: boolean; note?: string } | 'notRepository';

/** The Changes of a turn: git's answer merged with the turn's agent edits (undefined: nothing to show). */
export function mergedState(git: GitAnswer, agent: readonly ChangedFile[]): Extract<ChangesState, { state: 'ready' }> | undefined {
  if (git === 'notRepository') {
    return agent.length === 0 ? undefined : { state: 'ready', files: [...agent], omittedFiles: 0, truncated: false, note: NOT_A_REPOSITORY_TEXT };
  }
  return { state: 'ready', ...git, files: mergeChanges(git.files, agent) };
}

export interface ChangesModelOptions {
  sessionId: string;
  /** The turn whose changes are shown; undefined while unknown (an item that is gone). */
  turnId: string | undefined;
  replica: ChangesReplica;
}

export class ChangesModel extends Model {
  readonly sessionId: string;
  readonly turnId: string | undefined;
  /** The file whose diff is open; undefined shows the list. */
  selected: string | undefined;
  private current: ChangesState = { state: 'idle' };
  /** turn/diff's last answer, merged with the agent's edits whenever the Replica changes. */
  private git: GitAnswer | undefined;
  /** The turn status the shown diff was fetched for. */
  private fetchedFor: string | undefined;
  private request = 0;
  private disposed = false;
  private readonly replica: ChangesReplica;
  private readonly unsubscribe: () => void;

  constructor(options: ChangesModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.turnId = options.turnId;
    this.replica = options.replica;
    this.unsubscribe = this.replica.subscribe(() => {
      if (this.fetchedFor !== undefined && this.fetchedFor !== this.turnStatus) void this.load();
      else if (this.git !== undefined) this.current = this.merged(this.git);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  get state(): ChangesState {
    return this.current;
  }

  /** The open file, when one is selected and still in the list. */
  get file(): ChangedFile | undefined {
    const state = this.current;
    if (state.state !== 'ready' || this.selected === undefined) return undefined;
    return state.files.find((f) => f.path === this.selected);
  }

  /** "3 files changed" once loaded (counting files past the host's cap), else ''. */
  get summary(): string {
    const state = this.current;
    return state.state === 'ready' ? filesChangedText(state.files.length + state.omittedFiles) : '';
  }

  private get turnStatus(): string | undefined {
    const turnId = this.turnId;
    return this.replica.session(this.sessionId)?.turns.find((t) => t.turnId === turnId)?.status;
  }

  /** Fetches once, unless already loaded or loading. */
  start(): void {
    if (this.current.state === 'idle') void this.load();
  }

  /** turn/diff for the turn. A newer fetch wins over one still in flight; a shown diff stays while it loads. */
  async load(): Promise<void> {
    const turnId = this.turnId;
    if (turnId === undefined) return;
    const request = ++this.request;
    this.fetchedFor = this.turnStatus ?? '';
    if (this.current.state !== 'ready') this.current = { state: 'loading' };
    this.changed();
    let next: ChangesState;
    let git: GitAnswer | undefined;
    try {
      const result = await this.replica.turnDiff(this.sessionId, turnId);
      git = {
        files: result.files.map(changedFile),
        omittedFiles: result.omittedFiles ?? 0,
        truncated: result.truncated === true,
        ...(result.note !== undefined && result.note !== '' ? { note: result.note } : {}),
      };
      next = this.merged(git);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'not_a_repository') {
        git = 'notRepository';
        next = this.merged(git);
      } else {
        next = code === 'not_supported' ? { state: 'unsupported' } : { state: 'error', message: `Could not load the changes: ${errorText(error)}` };
      }
    }
    if (request !== this.request || this.disposed) return;
    this.git = git;
    // A turn that changed one file opens it right away the first time.
    if (next.state === 'ready' && this.current.state !== 'ready' && next.files.length === 1) this.selected = next.files[0]!.path;
    this.current = next;
    this.changed();
  }

  private merged(git: GitAnswer): ChangesState {
    return mergedState(git, agentFiles(this.replica.session(this.sessionId), this.turnId)) ?? { state: 'notRepository' };
  }

  /** Opens a file's diff. */
  open(path: string): void {
    if (this.selected === path) return;
    this.selected = path;
    this.changed();
  }

  /** Back to the list of files. */
  back(): void {
    if (this.selected === undefined) return;
    this.selected = undefined;
    this.changed();
  }
}
