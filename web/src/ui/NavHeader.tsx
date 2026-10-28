// The centred top bar of a page below Home (docs/research/new-look-prototype.md item 8): a round back button
// (icon only; the link keeps its href for a long-press), the title centred on one line with one footnote line
// under it, and a round ⋯ button. Used by the session view and the lab's New look. Styles: .nav* and
// .round-button in styles/components.css.
import type { ComponentChildren } from 'preact';

import { Icon } from './Icon';

export interface NavHeaderProps {
  /** The page the back link goes to, for a long-press or a new tab. */
  href: string;
  /** Where back goes, e.g. "Sessions": the round button's accessible name. */
  backLabel: string;
  /** A plain tap: the app navigates itself. */
  onBack: () => void;
  title: string;
  /** The one footnote line under the title (the session's status). */
  children?: ComponentChildren;
  /** The ⋯ button's accessible name. */
  moreLabel: string;
  onMore: () => void;
}

export function NavHeader({ href, backLabel, onBack, title, children, moreLabel, onMore }: NavHeaderProps) {
  return (
    <header class="nav">
      <a
        class="round-button"
        href={href}
        aria-label={backLabel}
        onClick={(event) => {
          event.preventDefault();
          onBack();
        }}
      >
        <Icon name="back" size={22} />
      </a>
      <div class="nav-title">
        <h1 title={title}>{title}</h1>
        {children !== undefined && <p class="nav-footnote">{children}</p>}
      </div>
      <button type="button" class="round-button" aria-label={moreLabel} aria-haspopup="dialog" onClick={onMore}>
        <Icon name="more" size={22} />
      </button>
    </header>
  );
}
