// The session page, /s/:sessionId: the turn list, the pending-request banner and the composer. All state
// and rules live in SessionModel; this file renders it and owns only the DOM work (scrolling, the
// pull-down gesture, keeping the reading position when older turns are put in front).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Replica } from '../../replica/replica';
import { useModel } from '../use-model';
import { SessionModel, type ItemRow, type SteerRow, type TurnRow } from './session-model';

/** How far (px) the list must be pulled down at the top before letting go loads older turns. */
const PULL_THRESHOLD = 70;
/** Within this many px of the bottom counts as "at the bottom" (auto-scroll stays on). */
const BOTTOM_SLACK = 48;

export interface SessionScreenProps {
  sessionId: string;
  replica: Replica;
  onBack: () => void;
}

export function SessionScreen({ sessionId, replica, onBack }: SessionScreenProps) {
  const model = useModel(useMemo(() => new SessionModel({ sessionId, replica }), [sessionId, replica]));
  useEffect(() => {
    model.start();
    return () => model.dispose();
  }, [model]);

  const scroller = useRef<HTMLElement>(null);
  const keep = useRef<{ height: number; top: number } | undefined>(undefined);
  const lastScrollRequest = useRef(-1);

  // After every render: keep the reading position when older turns were put in front, else follow the
  // bottom while the user has not scrolled away (and always after a send or the jump pill).
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (keep.current !== undefined && !model.loadingOlder) {
      element.scrollTop = keep.current.top + (element.scrollHeight - keep.current.height);
      keep.current = undefined;
      return;
    }
    if (model.atBottom || lastScrollRequest.current !== model.scrollRequest) {
      lastScrollRequest.current = model.scrollRequest;
      element.scrollTop = element.scrollHeight;
    }
  });

  const loadOlder = () => {
    const element = scroller.current;
    if (element !== null && model.hasOlder && !model.loadingOlder) keep.current = { height: element.scrollHeight, top: element.scrollTop };
    void model.loadOlder();
  };
  const pull = usePullDown(scroller, loadOlder);

  const status = model.status;
  const pending = model.pending;
  const turns = model.turns;
  const steers = model.steerRows;
  const running = model.runningTurnId !== undefined;

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
        <span class={`pill ${status.tone}`} aria-label="Session status" data-status={status.status}>
          {status.label}
        </span>
      </header>
      <div class="session-head">
        <h1 class="session-heading">{model.title}</h1>
        <p class="muted small">
          {model.agentId ?? ''}
          {model.folder !== undefined && (
            <>
              {' · '}
              <code title={model.folder.path}>{model.folder.name}</code>
            </>
          )}
        </p>
      </div>
      {model.needsDecision && (
        <div class="decision-banner" role="alert" aria-label="Needs your decision">
          <strong>Needs your decision</strong>
          <span class="counters">
            {pending.approvals > 0 && (
              <span class="badge" aria-label={`${pending.approvals} approval${pending.approvals === 1 ? '' : 's'} waiting`}>
                {pending.approvals} approval{pending.approvals === 1 ? '' : 's'}
              </span>
            )}
            {pending.inputs > 0 && (
              <span class="badge" aria-label={`${pending.inputs} question${pending.inputs === 1 ? '' : 's'} waiting`}>
                {pending.inputs} question{pending.inputs === 1 ? '' : 's'}
              </span>
            )}
          </span>
        </div>
      )}
      {model.openError !== undefined && (
        <p class="error" role="alert">
          {model.openError}
        </p>
      )}

      <section
        class="conversation"
        aria-label="Conversation"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget as HTMLElement;
          model.setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK);
        }}
        {...pull.handlers}
      >
        <div class="pull" style={{ height: `${pull.distance}px` }} aria-hidden={pull.distance === 0}>
          {pull.distance > 0 && <span>{pull.distance >= PULL_THRESHOLD ? 'Release to load earlier turns' : 'Pull for earlier turns'}</span>}
        </div>
        {model.hasOlder && (
          <div class="older">
            <button type="button" class="ghost small" onClick={loadOlder} disabled={model.loadingOlder}>
              {model.loadingOlder ? 'Loading…' : 'Load earlier turns'}
            </button>
          </div>
        )}
        {model.olderError !== undefined && (
          <p class="error" role="alert">
            {model.olderError}
          </p>
        )}
        {turns.length === 0 && steers.length === 0 ? (
          <p class="empty muted">{model.loaded ? 'No turns yet. Send a message to start.' : 'Loading…'}</p>
        ) : (
          <ol class="turns" aria-label="Turns">
            {turns.map((turn) => (
              <Turn key={turn.turnId} turn={turn} model={model} />
            ))}
          </ol>
        )}
        {steers.length > 0 && (
          <ul class="steers" aria-label="Steering messages">
            {steers.map((steer) => (
              <Steer key={steer.clientMessageId} steer={steer} model={model} />
            ))}
          </ul>
        )}
      </section>

      {model.showJumpToLatest && (
        <button type="button" class="jump-pill" onClick={() => model.jumpToLatest()}>
          Jump to latest ↓
        </button>
      )}

      <Composer model={model} running={running} />
    </main>
  );
}

function Turn({ turn, model }: { turn: TurnRow; model: SessionModel }) {
  return (
    <li class={`turn ${turn.status}`} data-turn-status={turn.status}>
      {turn.items.map((item) => (
        <Item key={item.itemId} item={item} model={model} />
      ))}
      {turn.label !== '' && <p class={`turn-state small ${turn.tone}`}>{turn.label}</p>}
      {turn.error !== undefined && (
        <p class="error small" role="alert">
          {turn.error}
        </p>
      )}
      {turn.send?.failure !== undefined && (
        <div class="send-failure" role="alert">
          <span class="small">{turn.send.failure}</span>
          <div class="actions">
            {turn.send.busy && (
              <button type="button" class="small primary" onClick={() => model.steerInstead(turn.send!.clientMessageId)}>
                Steer instead
              </button>
            )}
            <button type="button" class="small" onClick={() => model.retry(turn.send!.clientMessageId)}>
              Retry
            </button>
            <button type="button" class="small ghost" onClick={() => model.discard(turn.send!.clientMessageId)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function Item({ item, model }: { item: ItemRow; model: SessionModel }) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="msg user" data-item={item.kind}>
          <p>{item.text}</p>
          {item.attachments > 0 && <p class="muted small">{item.attachments} attachment{item.attachments === 1 ? '' : 's'}</p>}
        </div>
      );
    case 'agent':
      return (
        <div class="msg agent" data-item={item.kind} data-streaming={item.streaming ? 'true' : 'false'}>
          <p>{item.text}</p>
        </div>
      );
    case 'reasoning':
      return (
        <div class="item reasoning" data-item={item.kind}>
          <button type="button" class="link reasoning-toggle" aria-expanded={item.expanded} onClick={() => model.toggleReasoning(item.itemId)}>
            {item.expanded ? '▾' : '▸'} Thinking{item.summary !== '' ? `: ${item.summary.split('\n')[0]}` : ''}
          </button>
          {item.expanded && <p class="muted small reasoning-text">{item.text !== '' ? item.text : item.summary}</p>}
        </div>
      );
    case 'command':
      return (
        <div class="item command" data-item={item.kind}>
          <div class="item-line">
            <span class={`state small ${item.tone}`}>{item.state}</span>
            <code class="summary">{item.summary}</code>
          </div>
          {item.output !== '' && (
            <details>
              <summary class="small muted">Output</summary>
              <pre>{item.output}</pre>
            </details>
          )}
        </div>
      );
    case 'fileChange':
      return (
        <div class="item file-change" data-item={item.kind}>
          <span class={`state small ${item.tone}`}>{item.state === 'Done' ? 'Changed' : item.state}</span>
          <ul class="paths" aria-label="Changed files">
            {item.files.map((file) => (
              <li key={file.path}>
                <span class={`kind ${file.kind}`}>{file.kind === 'add' ? '+' : file.kind === 'delete' ? '−' : '~'}</span> <code>{file.path}</code>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'tool':
      return (
        <div class="item tool" data-item={item.kind}>
          <div class="item-line">
            <span class={`state small ${item.tone}`}>{item.state}</span>
            <code class="summary">{item.summary}</code>
          </div>
          {item.error !== undefined && <p class="error small">{item.error}</p>}
        </div>
      );
    case 'plan':
      return (
        <div class="item plan" data-item={item.kind}>
          <p class="small">{item.text}</p>
        </div>
      );
    case 'other':
      return (
        <div class="item other muted small" data-item={item.kind}>
          {item.label}
        </div>
      );
  }
}

function Steer({ steer, model }: { steer: SteerRow; model: SessionModel }) {
  return (
    <li class={`msg user steer ${steer.state}`} data-steer-state={steer.state}>
      <p>{steer.text}</p>
      <p class="muted small">{steer.label}</p>
      {steer.state === 'failed' && (
        <div class="send-failure" role="alert">
          <span class="small">{steer.error}</span>
          <div class="actions">
            <button type="button" class="small" onClick={() => model.retrySteer(steer.clientMessageId)}>
              Retry
            </button>
            <button type="button" class="small ghost" onClick={() => model.discardSteer(steer.clientMessageId)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function Composer({ model, running }: { model: SessionModel; running: boolean }) {
  const steering = model.mode === 'steer';
  return (
    <footer class="composer">
      {model.usage !== undefined && (
        <p class="usage muted small" aria-label="Usage">
          {model.usage}
        </p>
      )}
      {model.interruptError !== undefined && (
        <p class="error small" role="alert">
          {model.interruptError}
        </p>
      )}
      {model.closed && <p class="muted small">This session is closed.</p>}
      <form
        class="composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          model.send();
        }}
      >
        <textarea
          aria-label="Message"
          rows={Math.min(6, Math.max(1, model.draft.split('\n').length))}
          placeholder={steering ? 'Add to the running turn…' : 'Message the agent…'}
          value={model.draft}
          disabled={model.closed}
          onInput={(event) => model.setDraft((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              model.send();
            }
          }}
        />
        <div class="composer-actions">
          {running && (
            <button type="button" class="stop" onClick={() => void model.interrupt()} disabled={!model.canInterrupt} aria-label="Interrupt">
              {model.interrupting ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button type="submit" class="primary" disabled={!model.canSend}>
            {steering ? 'Steer' : 'Send'}
          </button>
        </div>
      </form>
    </footer>
  );
}

/** Pull down while the list is at its top to load older turns (touch screens). */
function usePullDown(scroller: { current: HTMLElement | null }, onPull: () => void) {
  const [distance, setDistance] = useState(0);
  const start = useRef<number | undefined>(undefined);
  return {
    distance,
    handlers: {
      onTouchStart: (event: TouchEvent) => {
        start.current = (scroller.current?.scrollTop ?? 0) <= 0 ? event.touches[0]?.clientY : undefined;
      },
      onTouchMove: (event: TouchEvent) => {
        if (start.current === undefined) return;
        const dy = (event.touches[0]?.clientY ?? start.current) - start.current;
        setDistance(dy > 0 ? Math.min(dy * 0.5, PULL_THRESHOLD * 1.5) : 0);
      },
      onTouchEnd: () => {
        if (start.current !== undefined && distance >= PULL_THRESHOLD) onPull();
        start.current = undefined;
        setDistance(0);
      },
    },
  };
}
