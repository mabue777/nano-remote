// The session's ⋯ sheet: the title with "host · folder", then what the old header carried (status, agent,
// model and effort, folder, permissions), the last turn's Changes, and Archive or Unarchive and Delete. Rows
// and wording are session-details.ts; the delete confirmation stays SessionActionsSheets' DeleteConfirmSheet.
import { GroupList, type GroupRow } from '../../ui/GroupList';
import { Sheet, SheetHeader, useCloseOnEscape } from '../../ui/Sheet';
import type { DetailAction, DetailRow } from './session-details';

export interface SessionDetailsSheetProps {
  title: string;
  subtitle: string;
  rows: readonly DetailRow[];
  onAction: (action: DetailAction) => void;
  onClose: () => void;
}

const ACTIONS: ReadonlySet<DetailAction> = new Set(['archive', 'unarchive', 'delete']);

export function SessionDetailsSheet({ title, subtitle, rows, onAction, onClose }: SessionDetailsSheetProps) {
  useCloseOnEscape(onClose);
  const groupRow = (row: DetailRow): GroupRow => ({
    key: row.key,
    icon: row.icon,
    label: row.label,
    value: row.value,
    ...(row.action !== undefined ? { onClick: () => onAction(row.action!), opens: !ACTIONS.has(row.action) } : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.tone !== undefined ? { tone: row.tone } : {}),
  });
  const details = rows.filter((row) => row.action === undefined || !ACTIONS.has(row.action)).map(groupRow);
  const actions = rows.filter((row) => row.action !== undefined && ACTIONS.has(row.action)).map(groupRow);
  return (
    <Sheet labelledBy="session-details-title" class="details-sheet" onClose={onClose}>
      <SheetHeader titleId="session-details-title" title={title} subtitle={subtitle} actionLabel="Done" onAction={onClose} />
      <GroupList label="Session details" rows={details} />
      <GroupList label="Session actions" rows={actions} />
    </Sheet>
  );
}
