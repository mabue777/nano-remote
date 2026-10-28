// The item detail sheet, opened from any item in the turn list. It hosts the output view (command items)
// and the diff view of the item's turn, as tabs; a file change item shows its own diff. State lives in ItemDetailModel.
import { useEffect, useMemo } from 'preact/hooks';

import { Sheet, SheetHeader, useCloseOnEscape } from '../../../ui/Sheet';
import { useModel } from '../../use-model';
import { ItemDetailModel, type DetailReplica, type DetailTab } from './detail-model';
import { AgentChanges, ChangesView } from './DiffView';
import { OutputView } from './OutputView';

const TAB_LABEL: Record<DetailTab, string> = { output: 'Output', changes: 'Changes' };

export interface ItemDetailSheetProps {
  sessionId: string;
  itemId: string;
  replica: DetailReplica;
  /** False when the session's agent provides no diffs: no Changes view. */
  diffs?: boolean;
  onClose: () => void;
}

export function ItemDetailSheet({ sessionId, itemId, replica, diffs = true, onClose }: ItemDetailSheetProps) {
  const model = useModel(
    useMemo(
      () =>
        new ItemDetailModel({
          sessionId,
          itemId,
          replica,
          diffs,
          ...(typeof navigator !== 'undefined' && navigator.clipboard ? { clipboard: navigator.clipboard } : {}),
        }),
      [sessionId, itemId, replica, diffs],
    ),
  );
  useEffect(() => {
    model.start();
    return () => model.dispose();
  }, [model]);
  useCloseOnEscape(onClose);

  const tabs = model.tabs;
  return (
    <Sheet labelledBy="item-detail-title" class="detail-sheet" onClose={onClose}>
      <SheetHeader titleId="item-detail-title" title={model.title} subtitle={model.subtitle} actionLabel="Close" onAction={onClose} />
      {tabs.length > 1 && (
        <div class="tabs" role="tablist" aria-label="Views">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`detail-tab-${tab}`}
              aria-selected={model.tab === tab}
              aria-controls="detail-panel"
              class={`tab ${model.tab === tab ? 'selected' : ''}`}
              onClick={() => model.selectTab(tab)}
            >
              {TAB_LABEL[tab]}
            </button>
          ))}
        </div>
      )}
      <div id="detail-panel" role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? `detail-tab-${model.tab}` : undefined}>
        {model.tab === 'output' ? (
          <OutputView model={model} />
        ) : model.ownChanges.length > 0 ? (
          <AgentChanges files={model.ownChanges} />
        ) : (
          <ChangesView model={model.changes} />
        )}
      </div>
    </Sheet>
  );
}
