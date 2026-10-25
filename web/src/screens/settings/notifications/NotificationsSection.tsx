// Settings, first section: Web Push. A switch that subscribes this phone, and a test button once it is on
// (web/src/pwa/push.ts). Moved here from Home; Home keeps only a one-line pointer while it is off.
import type { PushModel } from '../../../pwa/push';
import { Switch } from '../../../ui/Switch';
import { useModel } from '../../use-model';

export function NotificationsSection({ push }: { push: PushModel }) {
  useModel(push);
  const state = push.state;
  const test = push.test;
  const switchable = state.kind === 'off' || state.kind === 'on' || state.kind === 'error' || state.kind === 'subscribing';
  return (
    <section class="card notifications" aria-label="Notifications" data-state={state.kind}>
      <div class="notifications-line">
        <h2 id="notifications-title">Notifications</h2>
        {switchable && (
          <Switch
            checked={state.kind === 'on' || state.kind === 'subscribing'}
            labelledBy="notifications-title"
            disabled={state.kind === 'subscribing'}
            // turnOn asks for permission inside this tap: iOS allows it only from a user gesture.
            onChange={(on) => void (on ? push.turnOn() : push.turnOff())}
          />
        )}
      </div>
      {state.kind === 'unsupported' && <p class="muted small">This browser cannot show notifications from Nano Remote.</p>}
      {state.kind === 'needs-install' && (
        <p class="muted small">Install to the home screen from Safari to get notifications: tap Share, then Add to Home Screen, and open Nano Remote from there.</p>
      )}
      {state.kind === 'denied' && (
        <p class="muted small">
          Notifications are blocked for Nano Remote. To turn them back on, open Settings, then Notifications, then Nano Remote, and allow them (in a
          browser: the site settings for this page).
        </p>
      )}
      {state.kind === 'off' && <p class="muted small">Get a notification when an agent needs you or finishes while the app is closed.</p>}
      {state.kind === 'subscribing' && <p class="muted small">Turning on…</p>}
      {state.kind === 'error' && (
        <p class="error small" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'on' && (
        <div class="notifications-test">
          <button type="button" class="ghost" disabled={test.kind === 'sending'} onClick={() => void push.sendTest()}>
            {test.kind === 'sending' ? 'Sending…' : 'Send test notification'}
          </button>
          {test.kind === 'sent' && (
            <span class="muted small" role="status">
              Sent. It should arrive in a moment.
            </span>
          )}
          {test.kind === 'failed' && (
            <span class="error small" role="alert">
              {test.message}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
