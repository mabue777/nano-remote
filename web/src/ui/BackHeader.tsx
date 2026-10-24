// The top bar of a page below Home: a back chevron and where it goes at the left, optional content at the right (the
// session's status pill, the chat's model button). Styles: .topbar and .back in styles/components.css.
import type { ComponentChildren } from 'preact';

import { Icon } from './Icon';

export interface BackHeaderProps {
  /** The page the link goes to, for a long-press or a new tab. */
  href: string;
  /** Where it goes, e.g. "Sessions". */
  label: string;
  /** A plain tap: the app navigates itself. */
  onBack: () => void;
  /** The right side of the bar. */
  children?: ComponentChildren;
}

export function BackHeader({ href, label, onBack, children }: BackHeaderProps) {
  return (
    <header class="topbar">
      <a
        class="back"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onBack();
        }}
      >
        <Icon name="back" size={22} />
        {label}
      </a>
      {children}
    </header>
  );
}
