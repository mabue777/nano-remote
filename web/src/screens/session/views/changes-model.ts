// The Changes view of one turn (turn/diff, spec 7): the files the turn changed, each with its kind and
// +/- counts, and one file's diff at a time (tap a file to open it, "All files" to go back). The host
// computes the diff from git snapshots of the session folder, the same for every agent.
//
// States: loading, the files (with the host's `note` when the diff is not exactly the turn's own change,
// and how much was cut at the host's caps), not_supported (an agent without diffs), not_a_repository (the
// session folder is not in git), or another error with a retry. A running turn's diff is not final, so the
// model fetches again whenever the turn's status changes.
import type { TurnDiffResult } from '../../../generated/methods';
import type { SessionView } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { FILE_KIND_LABEL, fileKind, parseUnifiedDiff, type DiffLine, type FileKind } from './diff';

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
}

export type ChangesState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; files: ChangedFile[]; note?: string; omittedFiles: number; truncated: boolean }
  | { state: 'unsupported' }
  | { state: 'notRepository' }
  | { state: 'error'; message: string };

export const NOT_SUPPORTED_TEXT = 'This agent does not provide diffs.';
export const NOT_A_REPOSITORY_TEXT = 'Changes need a git repository in the session folder.';

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
    try {
      const result = await this.replica.turnDiff(this.sessionId, turnId);
      next = {
        state: 'ready',
        files: result.files.map(changedFile),
        omittedFiles: result.omittedFiles ?? 0,
        truncated: result.truncated === true,
        ...(result.note !== undefined && result.note !== '' ? { note: result.note } : {}),
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      next =
        code === 'not_supported'
          ? { state: 'unsupported' }
          : code === 'not_a_repository'
            ? { state: 'notRepository' }
            : { state: 'error', message: `Could not load the changes: ${errorText(error)}` };
    }
    if (request !== this.request || this.disposed) return;
    // A turn that changed one file opens it right away the first time.
    if (next.state === 'ready' && this.current.state !== 'ready' && next.files.length === 1) this.selected = next.files[0]!.path;
    this.current = next;
    this.changed();
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
