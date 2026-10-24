import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { PushModel } from '../pwa/push';
import type { Replica } from '../replica/replica';
import type { StreamClient } from '../stream/client';
import { Icon } from '../ui/Icon';
import { PullIndicator, usePullToRefresh } from '../ui/PullToRefresh';
import { Switch } from '../ui/Switch';
import { usePress } from './chat/hooks';
import { backgroundTasksText, HomeModel, type AwayTracker, type Connection, type HostView, type SessionRow } from './home-model';
import { NewSessionSheet } from './NewSessionSheet';
import { SessionActions } from './session-actions';
import { ActionsSheet, DeleteConfirmSheet, UndoToast } from './SessionActionsSheets';
import { useModel } from './use-model';

export interface HomeScreenProps {
  client: StreamClient;
  replica: Replica;
  /** The Notifications card; absent where the app has no service worker (the dev server). */
  notifications?: PushModel;
  /** "Finished while away" markers; absent means none are shown. */
  away?: AwayTracker;
  onOpenSession: (sessionId: string) => void;
  /** Which half of the "Sessions | Chats" switch shows; Sessions by default while a host is paired. */
  tab?: HomeTab;
  onTab?: (tab: HomeTab) => void;
  /** The Chats tab's content (chat/ChatsPanel). */
  chats?: ComponentChildren;
  /** The gear: Settings > Providers. */
  onSettings?: () => void;
  /** Archive and delete (one per stream client, so an archive in the session view shows its Undo here). */
  actions?: SessionActions;
}

export type HomeTab = 'sessions' | 'chats';

export function HomeScreen({ client, replica, notifications, away, onOpenSession, tab = 'sessions', onTab, chats, onSettings, actions: shared }: HomeScreenProps) {
  const model = useModel(useMemo(() => new HomeModel({ client, replica, ...(away !== undefined ? { away } : {}) }), [client, replica, away]));
  useEffect(() => () => model.dispose(), [model]);
  const own = useMemo(() => (shared === undefined ? new SessionActions({ replica }) : undefined), [shared, replica]);
  useEffect(() => () => own?.dispose(), [own]);
  const actions = useModel((shared ?? own)!);
  const menu = model.menuRow;
  const [creating, setCreating] = useState(false);
  const pull = usePullToRefresh(
    () => window.scrollY <= 0,
    () => void model.refresh(),
  );
  const sentinel = useInfiniteScroll(() => void model.loadMore(), model.hasMore);
  const sessions = model.sessions;

  return (
    <main class={`screen home${actions.undo !== undefined ? ' with-toast' : ''}`} {...(tab === 'sessions' ? pull.handlers : {})}>
      <header class="topbar">
        <h1>Nano Remote</h1>
        <div class="topbar-end">
          <ConnectionBadge connection={model.connection} onRetry={() => model.retryNow()} />
          {onSettings !== undefined && <SettingsGear onClick={onSettings} />}
        </div>
      </header>
      {chats !== undefined && <HomeTabs tab={tab} onTab={onTab} />}
      {tab === 'chats' ? (
        chats
      ) : (
        <>
          <PullIndicator distance={pull.distance} pullLabel="Pull to refresh" releaseLabel="Release to refresh" />
          <HostCard host={model.host} />
          {notifications !== undefined && <NotificationsCard push={notifications} />}
          <section class="sessions" aria-labelledby="sessions-title">
            <div class="section-head">
              <h2 id="sessions-title">Sessions</h2>
              <div class="actions">
                <button type="button" class="ghost" onClick={() => void model.refresh()} disabled={model.refreshing} aria-label="Refresh sessions">
                  {model.refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
                <button type="button" class="primary small" onClick={() => setCreating(true)}>
                  New session
                </button>
              </div>
            </div>
            {model.error !== undefined && (
              <p class="error" role="alert">
                {model.error}
              </p>
            )}
            {actions.error !== undefined && (
              <p class="error" role="alert">
                {actions.error}
              </p>
            )}
            {sessions.length === 0 ? (
              <p class="empty muted">{model.connection.kind === 'connected' ? 'No sessions yet. Start one to drive an agent from here.' : 'Sessions appear once the host is connected.'}</p>
            ) : (
              <ul class="session-list" aria-label="Sessions">
                {sessions.map((row) => (
                  <SessionItem key={row.sessionId} row={row} model={model} actions={actions} archived={false} onOpen={onOpenSession} />
                ))}
              </ul>
            )}
            {model.hasMore && (
              <div ref={sentinel} class="more">
                <button type="button" class="ghost" onClick={() => void model.loadMore()} disabled={model.loadingMore}>
                  {model.loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </section>
          {model.archivedCount > 0 && <ArchivedSection model={model} actions={actions} onOpen={onOpenSession} />}
        </>
      )}
      {menu !== undefined && (
        <ActionsSheet
          title={menu.title}
          archived={model.archived.some((row) => row.sessionId === menu.sessionId)}
          onClose={() => model.closeMenu()}
          onArchive={() => {
            model.closeMenu();
            actions.askArchive(menu.sessionId);
          }}
          onUnarchive={() => {
            model.closeMenu();
            void actions.unarchive(menu.sessionId);
          }}
          onDelete={() => {
            model.closeMenu();
            actions.askDelete(menu.sessionId);
          }}
        />
      )}
      <DeleteConfirmSheet actions={actions} />
      <UndoToast actions={actions} />
      {creating && (
        <NewSessionSheet
          client={client}
          replica={replica}
          onClose={() => setCreating(false)}
          onStarted={(sessionId) => {
            setCreating(false);
            onOpenSession(sessionId);
          }}
        />
      )}
    </main>
  );
}

/** The segmented "Sessions | Chats" switch at the top of Home. */
function HomeTabs({ tab, onTab }: { tab: HomeTab; onTab: ((tab: HomeTab) => void) | undefined }) {
  const options: [HomeTab, string][] = [
    ['sessions', 'Sessions'],
    ['chats', 'Chats'],
  ];
  return (
    <div class="segmented" role="tablist" aria-label="Home">
      {options.map(([value, label]) => (
        <button key={value} type="button" role="tab" aria-selected={tab === value} class={tab === value ? 'selected' : ''} onClick={() => onTab?.(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ConnectionBadge({ connection, onRetry }: { connection: Connection; onRetry: () => void }) {
  return (
    <div class={`connection ${connection.kind}`} role="status" aria-live="polite" data-state={connection.kind}>
      <span class="dot" aria-hidden="true" />
      <span class="label">{connection.label}</span>
      {connection.kind === 'offline' && (
        <button type="button" class="link" onClick={onRetry}>
          Retry now
        </button>
      )}
    </div>
  );
}

function HostCard({ host }: { host: HostView | undefined }) {
  if (host === undefined) {
    return (
      <section class="card host" aria-label="Host">
        <p class="muted">Waiting for the host…</p>
      </section>
    );
  }
  return (
    <section class="card host" aria-label="Host">
      <div class="host-line">
        <h2 class="host-name">{host.name}</h2>
        <span class="muted small">
          {host.uptime !== undefined ? `up ${host.uptime}` : `v${host.version}`}
          {host.sessionsActive !== undefined && host.sessionsActive > 0 ? ` · ${host.sessionsActive} active` : ''}
        </span>
      </div>
      <ul class="agents" aria-label="Agents">
        {host.agents.map((agent) => (
          <li key={agent.id} class={`agent ${agent.tone}`} title={agent.detail}>
            <span class="dot" aria-hidden="true" />
            <span class="agent-name">{agent.name}</span>
            <span class="agent-status muted small">{agent.status === 'ready' ? 'ready' : agent.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Web Push: a switch that subscribes this phone, and a test button once it is on (web/src/pwa/push.ts). */
function NotificationsCard({ push }: { push: PushModel }) {
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

/** "Archived (3)": collapsed at first; open, its rows and "Delete all archived". */
function ArchivedSection({ model, actions, onOpen }: { model: HomeModel; actions: SessionActions; onOpen: (sessionId: string) => void }) {
  const open = model.archivedOpen;
  return (
    <section class="archived" aria-labelledby="archived-title">
      <h2 id="archived-title" class="archived-head">
        <button type="button" class="archived-toggle" aria-expanded={open} aria-controls="archived-list" onClick={() => model.toggleArchived()}>
          <span>Archived</span>
          <span class="count muted">{model.archivedCount}</span>
          <Icon name="chevron-right" size={18} class={open ? 'chevron open' : 'chevron'} />
        </button>
      </h2>
      {open && (
        <div id="archived-list">
          <ul class="session-list" aria-label="Archived sessions">
            {model.archived.map((row) => (
              <SessionItem key={row.sessionId} row={row} model={model} actions={actions} archived={true} onOpen={onOpen} />
            ))}
          </ul>
          <div class="archived-foot">
            <button type="button" class="small danger" onClick={() => actions.askDeleteArchived()}>
              Delete all archived
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface SessionItemProps {
  row: SessionRow;
  model: HomeModel;
  actions: SessionActions;
  archived: boolean;
  onOpen: (sessionId: string) => void;
}

/** A session row; a swipe to the left shows Archive and Delete under it, a long-press opens the actions sheet. */
function SessionItem({ row, model, actions, archived, onOpen }: SessionItemProps) {
  const { consumed, ...handlers } = usePress({ onLongPress: () => model.openMenu(row.sessionId), onSwipeLeft: () => model.reveal(row.sessionId) });
  const revealed = model.revealedId === row.sessionId;
  return (
    <li class={`swipe-row${revealed ? ' revealed' : ''}`} data-session-id={row.sessionId}>
      <a
        class={`session${row.finishedWhileAway ? ' away' : ''}`}
        data-tone={row.tone}
        href={`/s/${encodeURIComponent(row.sessionId)}`}
        {...handlers}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (consumed()) return;
          if (revealed) {
            model.conceal();
            return;
          }
          onOpen(row.sessionId);
        }}
      >
        <div class="session-top">
          <span class="session-title">{row.title}</span>
          {row.pending > 0 && (
            <span class="badge" aria-label={`${row.pending} waiting for you`}>
              {row.pending}
            </span>
          )}
        </div>
        <div class="session-meta small">
          <span class={`status ${row.tone}`}>{row.statusLabel}</span>
          {row.finishedWhileAway && <span class="away-mark">Finished while away</span>}
          {row.backgroundTasks > 0 && (
            <span class="tasks-mark" data-count={row.backgroundTasks}>
              {backgroundTasksText(row.backgroundTasks)}
            </span>
          )}
          <span class="muted">
            {row.agentName} · {row.folder} · {row.updated}
          </span>
        </div>
        {row.model !== undefined && (
          <p class="muted small session-model" aria-label="Model">
            {row.model}
          </p>
        )}
        {row.preview !== '' && <p class="preview muted small">{row.preview}</p>}
      </a>
      {revealed && (
        <div class="row-actions">
          {archived ? (
            <button
              type="button"
              class="small ghost"
              aria-label={`Unarchive ${row.title}`}
              onClick={() => {
                model.conceal();
                void actions.unarchive(row.sessionId);
              }}
            >
              Unarchive
            </button>
          ) : (
            <button
              type="button"
              class="small ghost"
              aria-label={`Archive ${row.title}`}
              onClick={() => {
                model.conceal();
                actions.askArchive(row.sessionId);
              }}
            >
              Archive
            </button>
          )}
          <button
            type="button"
            class="small danger"
            aria-label={`Delete ${row.title}`}
            onClick={() => {
              model.conceal();
              actions.askDelete(row.sessionId);
            }}
          >
            Delete
          </button>
          <button type="button" class="small ghost" onClick={() => model.conceal()}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

/** Calls onMore when the element scrolls into view (the bottom of the list). */
function useInfiniteScroll(onMore: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onMore);
  callback.current = onMore;
  useEffect(() => {
    const element = ref.current;
    if (!active || element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback.current();
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return ref;
}

/** The gear in the top bar: Settings > Providers. */
export function SettingsGear({ onClick }: { onClick: () => void }) {
  return (
    <a
      class="gear"
      href="/settings/providers"
      aria-label="Settings"
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
    >
      <Icon name="gear" size={22} />
    </a>
  );
}
