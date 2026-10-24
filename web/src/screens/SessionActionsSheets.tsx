// The pieces of archive and delete (session-actions.ts) that Home and the session view share: the actions
// sheet (a long-press on a row, the session view's "⋯" button), the delete confirmation and the Undo toast.
// Styles: .actions-sheet, .confirm-sheet and .undo-toast in HomeScreen.css.
import { Sheet, useCloseOnEscape } from '../ui/Sheet';
import type { SessionActions } from './session-actions';
import { useModel } from './use-model';

export interface ActionsSheetProps {
  title: string;
  /** An archived session offers Unarchive instead of Archive. */
  archived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** Archive (or Unarchive) and Delete for one session, with Cancel. */
export function ActionsSheet({ title, archived, onArchive, onUnarchive, onDelete, onClose }: ActionsSheetProps) {
  useCloseOnEscape(onClose);
  return (
    <Sheet labelledBy="session-actions-title" class="actions-sheet" onClose={onClose}>
      <h2 id="session-actions-title">{title}</h2>
      <div class="sheet-actions">
        {archived ? (
          <button type="button" class="ghost" onClick={onUnarchive}>
            Unarchive
          </button>
        ) : (
          <button type="button" class="ghost" onClick={onArchive}>
            Archive
          </button>
        )}
        <button type="button" class="danger" onClick={onDelete}>
          Delete…
        </button>
        <button type="button" class="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/**
 * The confirmation of a pending delete (or of archiving a working session), while there is one;
 * `onDeleted` after it went through.
 */
export function DeleteConfirmSheet({ actions, onDeleted }: { actions: SessionActions; onDeleted?: () => void }) {
  useModel(actions);
  const confirm = actions.confirm;
  if (confirm === undefined) return null;
  const cancel = () => actions.cancelConfirm();
  return (
    <Sheet labelledBy="delete-confirm-title" class="confirm-sheet" onClose={cancel}>
      <h2 id="delete-confirm-title">{confirm.title}</h2>
      <p class="muted small">{confirm.message}</p>
      <div class="actions">
        <button type="button" class="small ghost" onClick={cancel} disabled={actions.deleting}>
          Cancel
        </button>
        <button
          type="button"
          class="small danger"
          disabled={actions.deleting}
          onClick={() =>
            void actions.confirmDelete().then((done) => {
              if (done) onDeleted?.();
            })
          }
        >
          {actions.deleting ? 'Deleting…' : confirm.confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

/** "Archived <title>  Undo" for a few seconds after an archive. */
export function UndoToast({ actions }: { actions: SessionActions }) {
  useModel(actions);
  const undo = actions.undo;
  if (undo === undefined) return null;
  return (
    <div class="undo-toast" role="status">
      <span class="undo-text">{undo.text}</span>
      <button type="button" class="link" onClick={() => void actions.undoArchive()}>
        Undo
      </button>
    </div>
  );
}
