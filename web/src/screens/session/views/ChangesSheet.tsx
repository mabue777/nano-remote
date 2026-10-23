// The Changes view of one turn as a sheet, opened from the turn's "N files changed" line in the session
// view. State lives in ChangesModel.
import { useEffect, useMemo } from 'preact/hooks';

import { Sheet, SheetHeader, useCloseOnEscape } from '../../../ui/Sheet';
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
  useCloseOnEscape(onClose);
  return (
    <Sheet labelledBy="changes-title" class="detail-sheet" onClose={onClose}>
      <SheetHeader titleId="changes-title" title="Changes" subtitle={model.summary} actionLabel="Close" onAction={onClose} />
      <div id="detail-panel">
        <ChangesView model={model} summary={false} />
      </div>
    </Sheet>
  );
}
