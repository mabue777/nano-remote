// Archive and delete for sessions (spec 6), shared by Home's list and the session view's header menu.
// Archive needs no confirmation: the row moves to "Archived" at once and an Undo toast stays for UNDO_MS
// (undo = session/unarchive). Only a session that is still working asks first ("Stop and archive"), since
// archiving stops its turn and background tasks too. Delete always asks first, naming the session and saying that its history
// and attachments leave the Mac for good; for a session that is still working it also says that its turn
// and any background tasks stop (the host stops them as part of session/delete). "Delete all archived"
// asks once with the count. One instance lives as long as the stream client, so an archive started in the
// session view shows its Undo on Home.
import type { SessionSummary } from '../replica/types';
import { errorText, Model } from './model';

/** How long the Undo toast of an archive stays. */
export const UNDO_MS = 5000;

/** What the actions need from the Replica; Replica fits. */
export interface ActionsReplica {
  readonly sessions: SessionSummary[];
  readonly archivedSessions: SessionSummary[];
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** The session as last opened, for a title the list does not have. */
  session?(sessionId: string): { session: { title: string } | null } | undefined;
}

export interface DeleteConfirm {
  /** What it confirms: deleting one session or every archived one, or archiving a working session. */
  kind: 'session' | 'archived' | 'archive';
  /** The session (kinds `session` and `archive`). */
  sessionId?: string;
  /** How many sessions go. */
  count: number;
  title: string;
  message: string;
  /** The danger button: "Delete", "Stop and delete", "Delete 3", "Stop and archive". */
  confirmLabel: string;
}

export interface UndoToast {
  sessionId: string;
  text: string;
}

export const DELETE_MESSAGE = 'Its history and attachments are removed from your Mac. This cannot be undone.';
export const DELETE_ALL_MESSAGE = 'Their history and attachments are removed from your Mac. This cannot be undone.';
export const STOP_MESSAGE = 'It is still working: its turn and any background tasks will be stopped.';

function titleOf(title: string | undefined): string {
  return title === undefined || title.trim() === '' ? 'Untitled session' : title;
}

/** Working right now: a turn running or waiting for this user, or a background task still running. */
export function isWorking(summary: Pick<SessionSummary, 'status' | 'lastTurnStatus' | 'backgroundTasks'>): boolean {
  if (summary.status === 'running' || summary.status === 'waiting_approval' || summary.status === 'waiting_input') return true;
  if (summary.status === 'idle' && summary.lastTurnStatus === 'inProgress') return true;
  return summary.status !== 'error' && (summary.backgroundTasks ?? []).some((task) => task.status === 'running');
}

/** "Delete 1 archived session?", "Delete 3 archived sessions?" */
export function deleteAllTitle(count: number): string {
  return `Delete ${count} archived session${count === 1 ? '' : 's'}?`;
}

export interface SessionActionsOptions {
  replica: ActionsReplica;
  /** Timers, injected in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SessionActions extends Model {
  undo: UndoToast | undefined;
  confirm: DeleteConfirm | undefined;
  /** The last failed archive, undo or delete. */
  error: string | undefined;
  /** A confirmed delete is going out. */
  deleting = false;
  private readonly replica: ActionsReplica;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private undoTimer: unknown;

  constructor(options: SessionActionsOptions) {
    super();
    this.replica = options.replica;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  dispose(): void {
    this.stopUndoTimer();
  }

  /** Archives the session and shows Undo for UNDO_MS. */
  async archive(sessionId: string): Promise<void> {
    const title = this.titleFor(sessionId);
    this.error = undefined;
    this.showUndo({ sessionId, text: `Archived ${title}` });
    try {
      await this.replica.archiveSession(sessionId);
    } catch (error) {
      if (this.undo?.sessionId === sessionId) this.dismissUndo();
      this.fail(`Could not archive ${title}: ${errorText(error)}`);
    }
  }

  /**
   * Archive from a button: a working session asks first (its turn and helpers stop); any other is
   * archived at once. True when it was archived without asking.
   */
  askArchive(sessionId: string): boolean {
    const summary = this.summaryOf(sessionId);
    if (summary === undefined || !isWorking(summary)) {
      void this.archive(sessionId);
      return true;
    }
    this.confirm = { kind: 'archive', sessionId, count: 1, title: `Archive ${this.titleFor(sessionId)}?`, message: STOP_MESSAGE, confirmLabel: 'Stop and archive' };
    this.changed();
    return false;
  }

  /** The toast's Undo: the archived session comes back to the list. */
  async undoArchive(): Promise<void> {
    const undo = this.undo;
    if (undo === undefined) return;
    this.dismissUndo();
    await this.unarchive(undo.sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    this.error = undefined;
    try {
      await this.replica.unarchiveSession(sessionId);
    } catch (error) {
      this.fail(`Could not bring back ${this.titleFor(sessionId)}: ${errorText(error)}`);
    }
  }

  dismissUndo(): void {
    this.stopUndoTimer();
    if (this.undo === undefined) return;
    this.undo = undefined;
    this.changed();
  }

  /** Asks before deleting one session. */
  askDelete(sessionId: string): void {
    const title = this.titleFor(sessionId);
    const summary = this.summaryOf(sessionId);
    const working = summary !== undefined && isWorking(summary);
    this.confirm = {
      kind: 'session',
      sessionId,
      count: 1,
      title: `Delete ${title}?`,
      message: working ? `${DELETE_MESSAGE} ${STOP_MESSAGE}` : DELETE_MESSAGE,
      confirmLabel: working ? 'Stop and delete' : 'Delete',
    };
    this.changed();
  }

  /** Asks before deleting every archived session; nothing to ask with none. */
  askDeleteArchived(): void {
    const count = this.replica.archivedSessions.length;
    if (count === 0) return;
    this.confirm = { kind: 'archived', count, title: deleteAllTitle(count), message: DELETE_ALL_MESSAGE, confirmLabel: `Delete ${count}` };
    this.changed();
  }

  cancelConfirm(): void {
    if (this.confirm === undefined) return;
    this.confirm = undefined;
    this.changed();
  }

  /** Runs what the user confirmed; true when every session it named is gone (or, for archive, archiving). */
  async confirmDelete(): Promise<boolean> {
    const confirm = this.confirm;
    if (confirm === undefined || this.deleting) return false;
    if (confirm.kind === 'archive') {
      this.confirm = undefined;
      void this.archive(confirm.sessionId!);
      return true;
    }
    const ids = confirm.kind === 'session' ? [confirm.sessionId!] : this.replica.archivedSessions.map((s) => s.sessionId);
    this.deleting = true;
    this.error = undefined;
    this.changed();
    const failed: string[] = [];
    let reason = '';
    for (const sessionId of ids) {
      const title = this.titleFor(sessionId);
      try {
        await this.replica.deleteSession(sessionId);
        if (this.undo?.sessionId === sessionId) this.dismissUndo();
      } catch (error) {
        failed.push(title);
        reason = errorText(error);
      }
    }
    this.deleting = false;
    this.confirm = undefined;
    if (failed.length > 0) this.error = failed.length === 1 ? `Could not delete ${failed[0]}: ${reason}` : `Could not delete ${failed.length} sessions: ${reason}`;
    this.changed();
    return failed.length === 0;
  }

  private titleFor(sessionId: string): string {
    return titleOf(this.summaryOf(sessionId)?.title ?? this.replica.session?.(sessionId)?.session?.title);
  }

  private summaryOf(sessionId: string): SessionSummary | undefined {
    return this.replica.sessions.find((s) => s.sessionId === sessionId) ?? this.replica.archivedSessions.find((s) => s.sessionId === sessionId);
  }

  private showUndo(undo: UndoToast): void {
    this.stopUndoTimer();
    this.undo = undo;
    this.undoTimer = this.setTimer(() => {
      this.undoTimer = undefined;
      this.dismissUndo();
    }, UNDO_MS);
    this.changed();
  }

  private stopUndoTimer(): void {
    if (this.undoTimer !== undefined) this.clearTimer(this.undoTimer);
    this.undoTimer = undefined;
  }

  private fail(message: string): void {
    this.error = message;
    this.changed();
  }
}
