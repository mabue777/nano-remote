// The Changes view's bookkeeping (protocol-v1.md section 7, `turn/diff`), the same for every agent: a git
// snapshot of the session folder when a turn starts and when it ends, both tree ids stored with the turn,
// and the diff between them on request. Adapters take no part.
//
// The start snapshot runs alongside the engine start and may hold the turn back by at most `startWaitMs`
// before the input goes to the engine. A snapshot that finishes later is discarded, because the agent may
// already be writing; the diff then compares the end tree with HEAD and says so in `note`.
import type { TurnDiffResult } from '../generated/methods.js';
import { RpcError } from '../errors.js';
import * as realGit from './git-changes.js';
import type { SessionStore } from './store.js';

/** Longest a turn start waits for its start snapshot once the engine is ready (spec 7). */
export const START_SNAPSHOT_WAIT_MS = 250;

export const NOT_A_REPOSITORY = 'Changes need a git repository in the session folder.';
export const START_NOTE = 'The snapshot at the start of this turn was not ready in time, so these are the changes since the last commit.';
export const END_NOTE = 'No snapshot was recorded at the end of this turn, so this compares with the folder as it is now.';

/** Diffs of finished turns kept in memory (they never change). */
const CACHE_SIZE = 64;

/** The git operations used; tests swap in slow or failing ones. */
export type ChangesGit = Pick<typeof realGit, 'isWorkTree' | 'snapshotTree' | 'headTree' | 'diffTrees'>;

export interface TurnChangesOptions {
  store: SessionStore;
  git?: ChangesGit;
  startWaitMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** The start snapshot of a running turn, as `turnStart` sees it. */
export interface StartSnapshot {
  /** Resolves once the snapshot is recorded or `startWaitMs` passed; a later snapshot is discarded. */
  seal(): Promise<void>;
}

export class TurnChanges {
  private readonly store: SessionStore;
  private readonly git: ChangesGit;
  private readonly startWaitMs: number;
  private readonly log: (message: string, error?: unknown) => void;
  /** Snapshots still being taken, by `sessionId/turnId`; turn/diff waits for them. */
  private readonly inFlight = new Map<string, Promise<void>[]>();
  private readonly cache = new Map<string, realGit.TreeDiff>();

  constructor(options: TurnChangesOptions) {
    this.store = options.store;
    this.git = options.git ?? realGit;
    this.startWaitMs = options.startWaitMs ?? START_SNAPSHOT_WAIT_MS;
    this.log = options.log ?? (() => {});
  }

  /** Starts the turn's start snapshot. Never rejects; a folder outside git just gets no snapshot. */
  begin(sessionId: string, turnId: string, cwd: string): StartSnapshot {
    let sealed = false;
    let done = false;
    const taken = this.track(
      sessionId,
      turnId,
      this.take(cwd, 'start', sessionId, turnId).then((tree) => {
        done = true;
        if (tree !== undefined && !sealed) this.store.setTurnTree(sessionId, turnId, 'start', tree);
        else if (tree !== undefined) this.log(`session ${sessionId}: the start snapshot of ${turnId} was late; discarded`);
      }),
    );
    return {
      seal: async () => {
        if (!done) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([taken, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.startWaitMs)))]);
          clearTimeout(timer);
        }
        sealed = true;
      },
    };
  }

  /** Starts the turn's end snapshot. Never rejects. */
  end(sessionId: string, turnId: string, cwd: string): void {
    void this.track(
      sessionId,
      turnId,
      this.take(cwd, 'end', sessionId, turnId).then((tree) => {
        if (tree !== undefined) this.store.setTurnTree(sessionId, turnId, 'end', tree);
      }),
    );
  }

  /**
   * `turn/diff`: start tree against end tree. Without a start tree, HEAD; without an end tree, the folder
   * as it is now (expected while the turn runs, noted when it has ended).
   */
  async diff(sessionId: string, turnId: string, cwd: string, running: boolean): Promise<TurnDiffResult> {
    if (!(await this.git.isWorkTree(cwd))) throw new RpcError('not_a_repository', NOT_A_REPOSITORY, { cwd });
    await Promise.all(this.inFlight.get(key(sessionId, turnId)) ?? []);
    const trees = this.store.turnTrees(sessionId, turnId);
    const notes: string[] = [];
    let from = trees.start;
    if (from === undefined) {
      notes.push(START_NOTE);
      from = await this.git.headTree(cwd);
    }
    let to = trees.end;
    if (to === undefined) {
      if (!running) notes.push(END_NOTE);
      to = await this.git.snapshotTree(cwd);
    }
    const final = trees.start !== undefined && trees.end !== undefined;
    const id = `${cwd}\0${from}\0${to}`;
    let diff = final ? this.cache.get(id) : undefined;
    if (diff === undefined) {
      diff = await this.git.diffTrees(cwd, from, to);
      if (final) this.remember(id, diff);
    }
    return notes.length > 0 ? { ...diff, note: notes.join(' ') } : { ...diff };
  }

  private async take(cwd: string, which: string, sessionId: string, turnId: string): Promise<string | undefined> {
    try {
      if (!(await this.git.isWorkTree(cwd))) return undefined;
      return await this.git.snapshotTree(cwd);
    } catch (error) {
      this.log(`session ${sessionId}: the ${which} snapshot of ${turnId} failed`, error);
      return undefined;
    }
  }

  private track(sessionId: string, turnId: string, task: Promise<void>): Promise<void> {
    const k = key(sessionId, turnId);
    const work = task.catch((error: unknown) => this.log(`session ${sessionId}: recording a snapshot of ${turnId} failed`, error));
    const list = this.inFlight.get(k) ?? [];
    list.push(work);
    this.inFlight.set(k, list);
    return work.finally(() => {
      const rest = (this.inFlight.get(k) ?? []).filter((p) => p !== work);
      if (rest.length > 0) this.inFlight.set(k, rest);
      else this.inFlight.delete(k);
    });
  }

  private remember(id: string, diff: realGit.TreeDiff): void {
    this.cache.set(id, diff);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }
}

function key(sessionId: string, turnId: string): string {
  return `${sessionId}/${turnId}`;
}
