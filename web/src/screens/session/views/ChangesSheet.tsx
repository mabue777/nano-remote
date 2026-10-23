// The Changes view of one turn as a sheet, opened from the turn's "N files changed" line in the session
// view. State lives in ChangesModel.
import { useEffect, useMemo } from 'preact/hooks';

import { useModel } from '../../use-model';
import { ChangesModel, type ChangesReplica } from './changes-model';
import { ChangesView } from './DiffView';

export interface ChangesSheetProps {
  sessionId: string;
  turnId: string;
  replica: ChangesReplica;
  onClose: () => void;
}

export function ChangesSheet({ sessionId, turnId, replica, onClose }: ChangesSheetProps) {
  const model = useModel(useMemo(() => new ChangesModel({ sessionId, turnId, replica }), [sessionId, turnId, replica]));
  useEffect(() => {
    model.start();
    return () => model.dispose();
  }, [model]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="sheet-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section class="sheet detail-sheet" role="dialog" aria-modal="true" aria-labelledby="changes-title">
        <header class="sheet-head">
          <div class="detail-title">
            <h2 id="changes-title">Changes</h2>
            {model.summary !== '' && <p class="muted small detail-subtitle">{model.summary}</p>}
          </div>
          <button type="button" class="ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div id="detail-panel">
          <ChangesView model={model} summary={false} />
        </div>
      </section>
    </div>
  );
}
