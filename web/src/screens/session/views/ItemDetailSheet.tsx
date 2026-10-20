// The item detail sheet, opened from any item in the turn list. It hosts the output view (command items)
// and the diff view of the item's turn, as tabs. State lives in ItemDetailModel.
import { useEffect, useMemo } from 'preact/hooks';

import { useModel } from '../../use-model';
import { ItemDetailModel, type DetailReplica, type DetailTab } from './detail-model';
import { DiffView } from './DiffView';
import { OutputView } from './OutputView';

const TAB_LABEL: Record<DetailTab, string> = { output: 'Output', changes: 'Changes' };

export interface ItemDetailSheetProps {
  sessionId: string;
  itemId: string;
  replica: DetailReplica;
  onClose: () => void;
}

export function ItemDetailSheet({ sessionId, itemId, replica, onClose }: ItemDetailSheetProps) {
  const model = useModel(
    useMemo(
      () => new ItemDetailModel({ sessionId, itemId, replica, ...(typeof navigator !== 'undefined' && navigator.clipboard ? { clipboard: navigator.clipboard } : {}) }),
      [sessionId, itemId, replica],
    ),
  );
  useEffect(() => {
    model.start();
    return () => model.dispose();
  }, [model]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs = model.tabs;
  return (
    <div class="sheet-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section class="sheet detail-sheet" role="dialog" aria-modal="true" aria-labelledby="item-detail-title">
        <header class="sheet-head">
          <div class="detail-title">
            <h2 id="item-detail-title">{model.title}</h2>
            {model.subtitle !== '' && <p class="muted small detail-subtitle">{model.subtitle}</p>}
          </div>
          <button type="button" class="ghost" onClick={onClose}>
            Close
          </button>
        </header>
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
          {model.tab === 'output' ? <OutputView model={model} /> : <DiffView model={model} />}
        </div>
      </section>
    </div>
  );
}
