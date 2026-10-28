// The session's Permissions sheet, opened from the ⋯ details sheet's Permissions row: the agent's approval
// modes in plain words with the current one checked; a tap switches (with the haptic tick), full access
// after a one-tap confirmation in the New session sheet's words. "Applies from the next turn" when the host
// says so. State lives in PermissionsModel (permissions-model.ts).
import { useMemo } from 'preact/hooks';

import { Icon } from '../../ui/Icon';
import { hapticTick } from '../../ui/motion/haptic';
import { Sheet, SheetHeader, useCloseOnEscape } from '../../ui/Sheet';
import { useModel } from '../use-model';
import { BYPASS_WARNING, type PermissionsModel } from './permissions-model';

export interface PermissionsSheetProps {
  /** Makes the sheet's model once (SessionModel.permissionsSheet). */
  create: () => PermissionsModel;
  onClose: () => void;
}

export function PermissionsSheet({ create, onClose }: PermissionsSheetProps) {
  // One model per open sheet: it starts from the session's mode as it was when it opened.
  const model = useModel(useMemo(create, []));
  useCloseOnEscape(model.confirming ? () => model.cancelConfirm() : onClose);
  const note = model.note;
  return (
    <>
      <Sheet labelledBy="permissions-title" class="permissions-sheet" onClose={onClose}>
        <SheetHeader titleId="permissions-title" title="Permissions" actionLabel="Done" onAction={onClose} />
        <ul class="group-list permission-modes" role="radiogroup" aria-label="Approval mode">
          {model.rows.map((row) => (
            <li key={row.mode} data-mode={row.mode}>
              <button
                type="button"
                role="radio"
                aria-checked={row.current}
                class={`group-row permission-mode${row.danger ? ' bypass' : ''}${row.current ? ' current' : ''}`}
                disabled={model.saving}
                onClick={() => {
                  if (row.current) return;
                  hapticTick(); // inside the tap, where iOS allows it
                  void model.choose(row.mode);
                }}
              >
                <span class="permission-words">
                  <span class="permission-title">{row.title}</span>
                  {row.detail !== '' && <span class="permission-detail">{row.detail}</span>}
                </span>
                {row.current && <Icon name="check" size={18} class="permission-check" />}
              </button>
            </li>
          ))}
        </ul>
        {note !== undefined && (
          <p class="small muted permissions-note" role="note">
            {note}
          </p>
        )}
        {model.error !== undefined && (
          <p class="error permissions-error" role="alert">
            {model.error}
          </p>
        )}
      </Sheet>
      {model.confirming && (
        <Sheet labelledBy="bypass-confirm-title" class="confirm-sheet" onClose={() => model.cancelConfirm()}>
          <h2 id="bypass-confirm-title">Bypass approvals?</h2>
          <p class="muted small">{BYPASS_WARNING}</p>
          <div class="actions">
            <button type="button" class="small ghost" onClick={() => model.cancelConfirm()}>
              Cancel
            </button>
            <button
              type="button"
              class="small danger"
              onClick={() => {
                hapticTick();
                void model.confirmBypass();
              }}
            >
              Allow full access
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
