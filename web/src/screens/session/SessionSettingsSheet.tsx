// The session's settings sheet: the New session sheet's model picker and effort control for an open
// session, opened from the header's model line. State lives in SessionSettingsModel (settings-model.ts).
import { useEffect, useMemo } from 'preact/hooks';

import { Sheet, SheetHeader, useCloseOnEscape } from '../../ui/Sheet';
import { ModelEffortFields } from '../ModelEffortFields';
import { useModel } from '../use-model';
import type { SessionSettingsModel } from './settings-model';

export interface SessionSettingsSheetProps {
  /** Makes the sheet's model once (SessionModel.settingsSheet). */
  create: () => SessionSettingsModel;
  onClose: () => void;
}

export function SessionSettingsSheet({ create, onClose }: SessionSettingsSheetProps) {
  // One model per open sheet: it starts from the session's settings as they were when it opened.
  const model = useModel(useMemo(create, []));
  useEffect(() => {
    void model.load();
  }, [model]);
  useCloseOnEscape(onClose);
  const note = model.note;
  return (
    <Sheet labelledBy="session-settings-title" onClose={onClose}>
      <SheetHeader titleId="session-settings-title" title="Model and effort" actionLabel="Cancel" onAction={onClose} />
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          void model.save().then((saved) => saved && onClose());
        }}
      >
        <ModelEffortFields picker={model} idPrefix="session-settings" showModel={model.canChangeModel} showEffort={model.canChangeEffort} />
        {!model.modelsLoading && model.models.length > 0 && model.efforts.length === 0 && model.canChangeEffort && (
          <p class="small muted">This model has no effort setting.</p>
        )}
        {note !== undefined && (
          <p class="small session-settings-note" role="note">
            {note}
          </p>
        )}
        {model.error !== undefined && (
          <p class="error" role="alert">
            {model.error}
          </p>
        )}
        <button class="primary" type="submit" disabled={!model.canSave}>
          {model.saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Sheet>
  );
}
