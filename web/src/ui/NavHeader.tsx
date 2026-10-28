// The centred top bar of a page below Home (docs/research/new-look-prototype.md item 8): a round back button
// (icon only; the link keeps its href for a long-press), the title centred on one line with one footnote line
// under it, and a round ⋯ button, optionally with more round buttons before it (`actions`; the file viewer's
// find button). Used by the session view, the file viewer and the lab's New look. Styles: .nav* and
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
  /** Round buttons before ⋯ (the left column widens to match, so the title stays centred). */
  actions?: ComponentChildren;
}

export function NavHeader({ href, backLabel, onBack, title, children, moreLabel, onMore, actions }: NavHeaderProps) {
  const more = (
    <button type="button" class="round-button" aria-label={moreLabel} aria-haspopup="dialog" onClick={onMore}>
      <Icon name="more" size={22} />
    </button>
  );
  return (
    <header class={actions === undefined ? 'nav' : 'nav nav-wide'}>
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
      {actions === undefined ? (
        more
      ) : (
        <div class="nav-actions">
          {actions}
          {more}
        </div>
      )}
    </header>
  );
}
