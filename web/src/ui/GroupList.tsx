// A grouped list on a grey fill (the new look's settings-style rows): a leading icon, a label, a grey value
// at the right, and a chevron on rows that open something. Used by the session's ⋯ details sheet and the
// lab's New look. Styles: .group-list and .group-row in styles/components.css.
import type { ComponentChildren } from 'preact';

import { Icon, type IconName } from './Icon';

export interface GroupRow {
  key: string;
  icon: IconName;
  label: string;
  /** Shown at the right, joined by " · "; a part's `label` names it for assistive tech. */
  value: readonly { text: string; label?: string }[];
  /** A tap; without one the row is plain text. */
  onClick?: () => void;
  /** The row opens another sheet: a chevron at the right. */
  opens?: boolean;
  /** A hover title for the control. */
  title?: string;
  tone?: 'error';
}

export function GroupList({ label, rows }: { label: string; rows: readonly GroupRow[] }) {
  return (
    <ul class="group-list" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key} data-row={row.key}>
          {row.onClick === undefined ? (
            <div class="group-row">
              <RowContent row={row} />
            </div>
          ) : (
            <button
              type="button"
              class={row.tone === 'error' ? 'group-row error' : 'group-row'}
              {...(row.title !== undefined ? { title: row.title } : {})}
              {...(row.opens === true ? { 'aria-haspopup': 'dialog' as const } : {})}
              onClick={row.onClick}
            >
              <RowContent row={row} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RowContent({ row }: { row: GroupRow }) {
  const parts: ComponentChildren[] = [];
  row.value.forEach((part, index) => {
    if (index > 0) parts.push(' · ');
    parts.push(
      part.label === undefined ? (
        part.text
      ) : (
        <span key={part.label} aria-label={part.label}>
          {part.text}
        </span>
      ),
    );
  });
  return (
    <>
      <Icon name={row.icon} size={18} />
      <span class="group-label">{row.label}</span>
      {parts.length > 0 && <span class="group-value">{parts}</span>}
      {row.opens === true && <Icon name="chevron-right" size={16} class="chevron" />}
    </>
  );
}
