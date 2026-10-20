// The session page, /s/:sessionId. This step only opens the session in the Replica and shows its
// header; the conversation view (turns, items, approvals, the composer) is a later ticket.
import { useEffect } from 'preact/hooks';

import type { Replica } from '../replica/replica';
import { statusOf } from './home-model';
import { useModel } from './use-model';

export interface SessionScreenProps {
  sessionId: string;
  replica: Replica;
  onBack: () => void;
}

export function SessionScreen({ sessionId, replica, onBack }: SessionScreenProps) {
  useModel(replica);
  useEffect(() => {
    void replica.open(sessionId).catch(() => undefined);
    return () => {
      void replica.close().catch(() => undefined);
    };
  }, [replica, sessionId]);
  const view = replica.session(sessionId);
  const summary = view?.session ?? replica.sessions.find((s) => s.sessionId === sessionId);
  return (
    <main class="screen session-screen">
      <header class="topbar">
        <a
          class="back"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            onBack();
          }}
        >
          ‹ Sessions
        </a>
      </header>
      <h1 class="session-heading">{summary?.title || 'Session'}</h1>
      {summary !== undefined ? (
        <p class="muted">
          {statusOf({ ...summary, status: view?.loaded ? view.status : summary.status }).label} · <code>{summary.cwd}</code>
        </p>
      ) : (
        <p class="muted">Loading…</p>
      )}
      <p class="muted small">The conversation view arrives in the next step.</p>
    </main>
  );
}
