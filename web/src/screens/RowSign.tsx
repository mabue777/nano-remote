// The one sign at the end of a session row (look step 6, rules in session-list.ts): the accent spinner while
// it runs, the needs-you dot and word in the warn tone, "!" in the error tone on a failure, nothing when it
// finished (its word is still read out). Shared by Home and the lab's New look. Styles: .row-sign in
// HomeScreen.css.
import { CrossFade } from '../ui/CrossFade';
import { Icon } from '../ui/Icon';
import type { RowSign as Sign } from './session-list';

/** The sign, its word cross-fading when it changes (`smooth`; off with Reduce Motion). */
export function RowSign({ sign, smooth }: { sign: Sign; smooth: boolean }) {
  return (
    <span class="row-sign" data-sign={sign.kind}>
      <CrossFade value={`${sign.kind}|${sign.label}`} smooth={smooth} render={(value) => <SignBody value={value} />} />
    </span>
  );
}

function SignBody({ value }: { value: string }) {
  const [kind, label] = value.split('|') as [Sign['kind'], string];
  switch (kind) {
    case 'spinner':
      return (
        <span class="row-sign-icon busy" role="img" aria-label={label}>
          <Icon name="spinner" size={18} class="spin" />
        </span>
      );
    case 'needs':
      return (
        <span class="row-sign-word attention">
          <span class="dot" aria-hidden="true" />
          {label}
        </span>
      );
    case 'failed':
      return (
        <span class="row-sign-icon error" role="img" aria-label={label}>
          <Icon name="alert" size={18} />
        </span>
      );
    case 'none':
      return <span class="visually-hidden">{label}</span>;
  }
}
