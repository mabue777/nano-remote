import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Replica } from '../replica/replica';
import type { StreamClient } from '../stream/client';
import { HomeModel, type Connection, type HostView, type SessionRow } from './home-model';
import { NewSessionSheet } from './NewSessionSheet';
import { useModel } from './use-model';

/** How far (px) the list must be pulled down before letting go refreshes it. */
const PULL_THRESHOLD = 70;

export interface HomeScreenProps {
  client: StreamClient;
  replica: Replica;
  onOpenSession: (sessionId: string) => void;
}

export function HomeScreen({ client, replica, onOpenSession }: HomeScreenProps) {
  const model = useModel(useMemo(() => new HomeModel({ client, replica }), [client, replica]));
  useEffect(() => () => model.dispose(), [model]);
  const [creating, setCreating] = useState(false);
  const pull = usePullToRefresh(() => void model.refresh());
  const sentinel = useInfiniteScroll(() => void model.loadMore(), model.hasMore);
  const sessions = model.sessions;

  return (
    <main class="screen home" {...pull.handlers}>
      <header class="topbar">
        <h1>Nano Remote</h1>
        <ConnectionBadge connection={model.connection} onRetry={() => model.retryNow()} />
      </header>
      <div class="pull" style={{ height: `${pull.distance}px` }} aria-hidden={pull.distance === 0}>
        {pull.distance > 0 && <span>{pull.distance >= PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}</span>}
      </div>
      <HostCard host={model.host} />
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
        {sessions.length === 0 ? (
          <p class="empty muted">{model.connection.kind === 'connected' ? 'No sessions yet. Start one to drive an agent from here.' : 'Sessions appear once the host is connected.'}</p>
        ) : (
          <ul class="session-list" aria-label="Sessions">
            {sessions.map((row) => (
              <SessionItem key={row.sessionId} row={row} onOpen={onOpenSession} />
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

function SessionItem({ row, onOpen }: { row: SessionRow; onOpen: (sessionId: string) => void }) {
  return (
    <li>
      <a
        class="session"
        href={`/s/${encodeURIComponent(row.sessionId)}`}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
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
          <span class="muted">
            {row.agentName} · {row.folder} · {row.updated}
          </span>
        </div>
        {row.preview !== '' && <p class="preview muted small">{row.preview}</p>}
      </a>
    </li>
  );
}

/** Pull down at the top of the page to refresh (touch screens). */
function usePullToRefresh(onRefresh: () => void) {
  const [distance, setDistance] = useState(0);
  const start = useRef<number | undefined>(undefined);
  return {
    distance,
    handlers: {
      onTouchStart: (event: TouchEvent) => {
        start.current = window.scrollY <= 0 ? event.touches[0]?.clientY : undefined;
      },
      onTouchMove: (event: TouchEvent) => {
        if (start.current === undefined) return;
        const dy = (event.touches[0]?.clientY ?? start.current) - start.current;
        setDistance(dy > 0 ? Math.min(dy * 0.5, PULL_THRESHOLD * 1.5) : 0);
      },
      onTouchEnd: () => {
        if (start.current !== undefined && distance >= PULL_THRESHOLD) onRefresh();
        start.current = undefined;
        setDistance(0);
      },
    },
  };
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
