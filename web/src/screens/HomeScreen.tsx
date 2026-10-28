import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Replica } from '../replica/replica';
import { defaultStorage } from '../replica/storage';
import type { StreamClient } from '../stream/client';
import { Icon } from '../ui/Icon';
import { useListMotion } from '../ui/motion/use-flip';
import { PullIndicator, usePullToRefresh } from '../ui/PullToRefresh';
import { usePress } from './chat/hooks';
import { backgroundTasksText, HomeModel, type AwayTracker, type Connection, type SessionRow } from './home-model';
import { RowSign } from './RowSign';
import { reducedMotion } from './session/motion-hooks';
import { emptyFilterText, STATUS_FILTERS, type StatusFilter } from './session-list';
import { NewSessionSheet } from './NewSessionSheet';
import { SessionActions } from './session-actions';
import { ActionsSheet, DeleteConfirmSheet, UndoToast } from './SessionActionsSheets';
import { useModel } from './use-model';

export interface HomeScreenProps {
  client: StreamClient;
  replica: Replica;
  /** "Finished while away" markers; absent means none are shown. */
  away?: AwayTracker;
  onOpenSession: (sessionId: string) => void;
  /** Which half of the "Sessions | Chats" switch shows; Sessions by default while a host is paired. */
  tab?: HomeTab;
  onTab?: (tab: HomeTab) => void;
  /** The Chats tab's content (chat/ChatsPanel). */
  chats?: ComponentChildren;
  /** The gear: Settings. */
  onSettings?: () => void;
  /** Archive and delete (one per stream client, so an archive in the session view shows its Undo here). */
  actions?: SessionActions;
}

export type HomeTab = 'sessions' | 'chats';

export function HomeScreen({ client, replica, away, onOpenSession, tab = 'sessions', onTab, chats, onSettings, actions: shared }: HomeScreenProps) {
  const model = useModel(
    useMemo(() => new HomeModel({ client, replica, storage: defaultStorage(), ...(away !== undefined ? { away } : {}) }), [client, replica, away]),
  );
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
  const smooth = !reducedMotion();

  return (
    <main class={`screen home${actions.undo !== undefined ? ' with-toast' : ''}`} {...(tab === 'sessions' ? pull.handlers : {})}>
      <header class="topbar home-bar">
        {chats !== undefined ? <HomeTabs tab={tab} onTab={onTab} /> : <span />}
        {onSettings !== undefined && <SettingsGear onClick={onSettings} />}
      </header>
      {tab === 'chats' ? (
        chats
      ) : (
        <>
          <div class="titlebar">
            <h1 class="large-title">Sessions</h1>
            <button type="button" class="round-button ink" aria-label="New session" onClick={() => setCreating(true)}>
              <Icon name="plus" />
            </button>
          </div>
          <FilterChips filter={model.filter} onFilter={(filter) => model.setFilter(filter)} />
          <ConnectionLine connection={model.connection} onRetry={() => model.retryNow()} />
          <PullIndicator distance={pull.distance} pullLabel="Pull to refresh" releaseLabel="Release to refresh" />
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
          <SessionList model={model} actions={actions} smooth={smooth} onOpen={onOpenSession} />
          {model.hasMore && (
            <div ref={sentinel} class="more">
              <button type="button" class="ghost" onClick={() => void model.loadMore()} disabled={model.loadingMore}>
                {model.loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
          {model.archivedCount > 0 && <ArchivedSection model={model} actions={actions} smooth={smooth} onOpen={onOpenSession} />}
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

const rowKey = (row: SessionRow) => row.sessionId;

/**
 * The flat list under the chips (list changes, technique 8): rows that move slide to their new place, new
 * ones fade and grow in, removed ones fade out and the rest close the gap. The empty lines: no sessions at
 * all, or none under the chosen chip.
 */
function SessionList({ model, actions, smooth, onOpen }: { model: HomeModel; actions: SessionActions; smooth: boolean; onOpen: (sessionId: string) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  const list = useListMotion(model.rows, rowKey, listRef, smooth);
  if (model.sessions.length === 0 && list.shown.length === 0) {
    return <p class="empty muted">{model.connection.kind === 'connected' ? 'No sessions yet. Start one to drive an agent from here.' : 'Sessions appear once the host is connected.'}</p>;
  }
  return (
    <>
      <ul class="session-list" aria-label="Sessions" ref={listRef}>
        {list.shown.map(({ item, leaving }) => (
          <SessionItem key={item.sessionId} row={item} model={model} actions={actions} archived={false} leaving={leaving} smooth={smooth} onOpen={onOpen} onDropped={list.dropped} />
        ))}
      </ul>
      {model.filter !== 'all' && model.rows.length === 0 && <p class="empty muted">{emptyFilterText(model.filter)}</p>}
    </>
  );
}

/** All · Running · Needs you · Finished: grey chips, the chosen one ink; no counts (a status is a dot and a word). */
function FilterChips({ filter, onFilter }: { filter: StatusFilter; onFilter: (filter: StatusFilter) => void }) {
  return (
    <div class="chips" role="group" aria-label="Show">
      {STATUS_FILTERS.map(({ value, label }) => (
        <button key={value} type="button" class="chip" aria-pressed={filter === value} onClick={() => onFilter(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The "Sessions | Chats" switch at the top of Home. */
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

/**
 * The connection, at the top of the list: a line with the dot, the word and "Retry now" while the Mac is not
 * reachable; read out only while connected (nothing to see when all is well).
 */
function ConnectionLine({ connection, onRetry }: { connection: Connection; onRetry: () => void }) {
  const quiet = connection.kind === 'connected';
  return (
    <div class={`connection ${connection.kind}${quiet ? ' visually-hidden' : ''}`} role="status" aria-live="polite" data-state={connection.kind}>
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

/** "Archived (3)": a plain row, collapsed at first; open, its rows and "Delete all archived". */
function ArchivedSection({ model, actions, smooth, onOpen }: { model: HomeModel; actions: SessionActions; smooth: boolean; onOpen: (sessionId: string) => void }) {
  const open = model.archivedOpen;
  return (
    <section class="archived" aria-labelledby="archived-title">
      <h2 id="archived-title" class="archived-head">
        <button type="button" class="archived-toggle" aria-expanded={open} aria-controls="archived-list" onClick={() => model.toggleArchived()}>
          <span>Archived ({model.archivedCount})</span>
          <Icon name="chevron-right" size={18} class={open ? 'chevron open' : 'chevron'} />
        </button>
      </h2>
      {open && <ArchivedList model={model} actions={actions} smooth={smooth} onOpen={onOpen} />}
    </section>
  );
}

function ArchivedList({ model, actions, smooth, onOpen }: { model: HomeModel; actions: SessionActions; smooth: boolean; onOpen: (sessionId: string) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  const list = useListMotion(model.archived, rowKey, listRef, smooth);
  return (
    <div id="archived-list">
      <ul class="session-list" aria-label="Archived sessions" ref={listRef}>
        {list.shown.map(({ item, leaving }) => (
          <SessionItem key={item.sessionId} row={item} model={model} actions={actions} archived={true} leaving={leaving} smooth={smooth} onOpen={onOpen} onDropped={list.dropped} />
        ))}
      </ul>
      <div class="archived-foot">
        <button type="button" class="small danger" onClick={() => actions.askDeleteArchived()}>
          Delete all archived
        </button>
      </div>
    </div>
  );
}

interface SessionItemProps {
  row: SessionRow;
  model: HomeModel;
  actions: SessionActions;
  archived: boolean;
  /** It left the list and fades out at its old place (not interactive). */
  leaving: boolean;
  smooth: boolean;
  onOpen: (sessionId: string) => void;
  onDropped: (sessionId: string) => void;
}

/**
 * A flat row: the title on one line, one grey meta line (agent · folder · time, "Finished while away", the
 * background-task mark, and the model once the phone knows it from an opened session) and one sign at the end. A swipe to the left shows Archive and Delete under it, a
 * long-press opens the actions sheet.
 */
function SessionItem({ row, model, actions, archived, leaving, smooth, onOpen, onDropped }: SessionItemProps) {
  const { consumed, ...handlers } = usePress({ onLongPress: () => model.openMenu(row.sessionId), onSwipeLeft: () => model.reveal(row.sessionId) });
  const revealed = !leaving && model.revealedId === row.sessionId;
  return (
    <li
      class={`swipe-row${revealed ? ' revealed' : ''}${leaving ? ' list-leaving' : ''}`}
      data-session-id={row.sessionId}
      data-flip-key={leaving ? undefined : row.sessionId}
      aria-hidden={leaving ? 'true' : undefined}
      onAnimationEnd={(event) => leaving && event.target === event.currentTarget && onDropped(row.sessionId)}
    >
      <a
        class={`session${row.finishedWhileAway ? ' away' : ''}`}
        data-tone={row.tone}
        href={`/s/${encodeURIComponent(row.sessionId)}`}
        tabIndex={leaving ? -1 : undefined}
        {...(leaving ? {} : handlers)}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (leaving || consumed()) return;
          if (revealed) {
            model.conceal();
            return;
          }
          onOpen(row.sessionId);
        }}
      >
        <span class="session-text">
          <span class="session-title">{row.title}</span>
          <span class="session-meta">
            {row.finishedWhileAway && <span class="away-mark">Finished while away · </span>}
            {row.backgroundTasks > 0 && (
              <span class="tasks-mark" data-count={row.backgroundTasks}>
                {backgroundTasksText(row.backgroundTasks)} ·{' '}
              </span>
            )}
            <span class="meta">
              {row.agentName} ·{' '}
              {row.model !== undefined && (
                <>
                  <span aria-label="Model">{row.model}</span> ·{' '}
                </>
              )}
              {row.folder} · {row.updated}
            </span>
          </span>
        </span>
        <RowSign sign={row.sign} smooth={smooth} />
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

/** The gear in the top bar: Settings. */
export function SettingsGear({ onClick }: { onClick: () => void }) {
  return (
    <a
      class="gear"
      href="/settings"
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
