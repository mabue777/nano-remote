// The bottom sheet: a dim layer with a panel that slides up from the bottom edge on a spring. A tap on the dim
// layer closes it; a tap inside the panel does not. A drag down follows the finger while the content is at its
// top; a flick or a pull past 30% closes it, a shorter one springs back. Closing slides the panel out, on
// every close path (motion/sheet-motion.ts). With reduced motion nothing animates by itself. Used by the
// new-session sheet, the item detail and Changes sheets, the session settings and actions sheets, the
// delete and Stop confirmations, the chat's model picker and the delete confirmation in Settings > Providers.
// Styles: .sheet-* in styles/components.css.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

import { useDrag } from './motion/drag';
import { SheetMotion } from './motion/sheet-motion';

export interface SheetProps {
  /** id of the heading that names the dialog. */
  labelledBy: string;
  /** Extra class on the panel, for a sheet with its own layout (e.g. `detail-sheet`). */
  class?: string;
  /** The sheet asks to close (dim-layer tap, a drag down); the owner removes it, and it slides out. */
  onClose: () => void;
  children?: ComponentChildren;
}

export function Sheet({ labelledBy, class: extra, onClose, children }: SheetProps) {
  const backdrop = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const motion = useRef<SheetMotion | null>(null);
  motion.current ??= new SheetMotion(() => close.current());
  const sheet = motion.current;
  useLayoutEffect(() => {
    if (backdrop.current !== null && scrim.current !== null && panel.current !== null) {
      sheet.open({ backdrop: backdrop.current, scrim: scrim.current, panel: panel.current });
    }
    return () => sheet.close();
  }, [sheet]);
  useDrag(panel, true, sheet);
  return (
    <div ref={backdrop} class="sheet-backdrop layered" onClick={(event) => isBackdropTap(event) && onClose()}>
      <div ref={scrim} class="sheet-scrim" aria-hidden="true" onClick={() => onClose()} />
      <section ref={panel} class={extra === undefined ? 'sheet' : `sheet ${extra}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div class="sheet-grabber" aria-hidden="true" />
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
