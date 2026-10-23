// The bottom sheet: a dimmed backdrop with a panel that slides up from the bottom edge. A tap on the backdrop
// closes it; a tap inside the panel does not. Used by the new-session sheet, the item detail and Changes
// sheets, the chat's model picker and the delete confirmation in Settings > Providers. Styles: .sheet-* in
// styles/components.css.
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

export interface SheetProps {
  /** id of the heading that names the dialog. */
  labelledBy: string;
  /** Extra class on the panel, for a sheet with its own layout (e.g. `detail-sheet`). */
  class?: string;
  onClose: () => void;
  children?: ComponentChildren;
}

export function Sheet({ labelledBy, class: extra, onClose, children }: SheetProps) {
  return (
    <div class="sheet-backdrop" onClick={(event) => isBackdropTap(event) && onClose()}>
      <section class={extra === undefined ? 'sheet' : `sheet ${extra}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  );
}

/** True for a tap on the backdrop itself; a tap inside the panel reaches the backdrop only by bubbling. */
export function isBackdropTap(event: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  return event.target === event.currentTarget;
}

export interface SheetHeaderProps {
  /** id of the heading; pass the same to the Sheet's `labelledBy`. */
  titleId: string;
  title: ComponentChildren;
  /** A line under the title; with a subtitle (even an empty one) the title and line are grouped. */
  subtitle?: string;
  /** The button at the right: Cancel, Close or Done. */
  actionLabel: string;
  onAction: () => void;
}

/** The title row of a sheet: the heading at the left, one ghost button at the right. */
export function SheetHeader({ titleId, title, subtitle, actionLabel, onAction }: SheetHeaderProps) {
  return (
    <header class="sheet-head">
      {subtitle === undefined ? (
        <h2 id={titleId}>{title}</h2>
      ) : (
        <div class="detail-title">
          <h2 id={titleId}>{title}</h2>
          {subtitle !== '' && <p class="muted small detail-subtitle">{subtitle}</p>}
        </div>
      )}
      <button type="button" class="ghost" onClick={onAction}>
        {actionLabel}
      </button>
    </header>
  );
}

/** Escape closes the sheet (hardware keyboards). */
export function useCloseOnEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}
