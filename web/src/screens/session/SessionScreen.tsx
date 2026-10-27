// The session page, /s/:sessionId: the turn list, the approval and question cards and the lines they leave
// once answered (approvals/), the shared floating composer (ui/Composer.tsx), and the item detail sheet (views/:
// command output, the turn's diff). All state and rules live in SessionModel and ApprovalsModel; this file
// renders them and owns only the DOM work (auto-scroll, the pull-down gesture, keeping the reading position
// when older turns are put in front, the expand and collapse motion, and a sent message rising out of the
// composer). The transcript is the new look's (Transcript.tsx): flat one-line rows that
// open under themselves, "Thinking", the paced answer, "Worked for" and the "N previous messages" fold.
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Replica } from '../../replica/replica';
import { BackHeader } from '../../ui/BackHeader';
import { Composer } from '../../ui/Composer';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { PullIndicator, usePullToRefresh } from '../../ui/PullToRefresh';
import type { AgentsSource } from '../capabilities';
import { SessionActions } from '../session-actions';
import { ActionsSheet, DeleteConfirmSheet } from '../SessionActionsSheets';
import { useModel } from '../use-model';
import { placeByTurn, placeInTurn } from './approvals/answered';
import { ApprovalsModel, type AnsweredRow } from './approvals/approvals-model';
import { AnsweredLines, InlineRequests, PinnedQuestions } from './approvals/RequestCards';
import type { AttachmentEntry } from './attachments/composer';
import { collapse, reducedMotion, useAutoScroll, useFlip, type Flip } from './motion-hooks';
import { SessionModel, type AttachmentServices, type AttachmentView, type BackgroundTaskRow, type ItemRow, type SteerRow, type TurnRow } from './session-model';
import { SessionSettingsSheet } from './SessionSettingsSheet';
import { AgentMessage, FlatRow, JumpPill, PreviousToggle, Thinking, WorkedFor } from './TranscriptRows';
import { layoutTurn, rowLine } from './transcript';
import { cleanOutput } from './views/ansi';
import { ChangesSheet } from './views/ChangesSheet';
import { ItemDetailSheet } from './views/ItemDetailSheet';

/** The rows a send adds: the user message of a new turn, or a steer. */
const SENT_ROWS = '.item-row.user, .steer';

/** A command's open row shows at most this many of its last output lines; Full output has the rest. */
const OUTPUT_LINES = 60;

export interface SessionScreenProps {
  sessionId: string;
  replica: Replica;
  onBack: () => void;
  /** This device's clientId: its own answers leave no "answered on" notice. */
  clientId?: string;
  /** Display name of another device (device/list), for "answered on <device>". */
  deviceName?: (clientId: string) => Promise<string | undefined>;
  /** Told when the session is shown, so its "Finished while away" marker goes (home-model AwayTracker). */
  onOpened?: (sessionId: string) => void;
  /** The host's agents with their capabilities (the stream client's initialize result). */
  agents?: AgentsSource;
  /** Photo and file uploads for the composer (spec 8.1); without them there is no attach button. */
  attachments?: AttachmentServices;
  /** Archive and delete from the header's More menu (shared with Home, which shows the archive's Undo). */
  actions?: SessionActions;
}

export function SessionScreen({ sessionId, replica, onBack, clientId, deviceName, onOpened, agents, attachments, actions: shared }: SessionScreenProps) {
  const own = useMemo(() => (shared === undefined ? new SessionActions({ replica }) : undefined), [shared, replica]);
  useEffect(() => () => own?.dispose(), [own]);
  const actions = useModel((shared ?? own)!);
  const [menuOpen, setMenuOpen] = useState(false);
  const model = useModel(
    useMemo(
      () =>
        new SessionModel({
          sessionId,
          replica,
          ...(agents !== undefined ? { agents } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
        }),
      [sessionId, replica, agents, attachments],
    ),
  );
  const requests = useModel(
    useMemo(
      () => new ApprovalsModel({ sessionId, replica, ...(clientId !== undefined ? { clientId } : {}), ...(deviceName !== undefined ? { deviceName } : {}) }),
      [sessionId, replica, clientId, deviceName],
    ),
  );
  useEffect(() => {
    model.start();
    return () => model.dispose();
  }, [model]);
  useEffect(() => () => requests.dispose(), [requests]);
  useEffect(() => onOpened?.(sessionId), [sessionId, onOpened]);
  // While the background-task strip shows, elapsed times count up and ended tasks leave on time.
  const tasksShown = model.backgroundTasks.length > 0;
  useEffect(() => {
    if (!tasksShown) return undefined;
    const timer = setInterval(() => model.tick(), 1000);
    return () => clearInterval(timer);
  }, [model, tasksShown]);

  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const landed = useRef(false);
  const keep = useRef<{ height: number; top: number } | undefined>(undefined);
  const lastScrollRequest = useRef(-1);
  // Auto-scroll: eases to new content while the reader is at the bottom, lets go at the first touch.
  const scroll = useAutoScroll(scroller, content, (following) => model.setAtBottom(following));
  const flip = useFlip(scroller, !reducedMotion());

  // A turn that ends folds its work behind "N previous messages": measure the rows before that renders, so
  // the rest slides into place instead of jumping.
  useLayoutEffect(() => {
    let folded = model.foldedTurns;
    return model.subscribe(() => {
      const next = model.foldedTurns;
      if (next === folded) return;
      folded = next;
      flip.prepare();
    });
  }, [model, flip]);

  // A card that is answered turns into its one-line answered state where it was: measure before that
  // renders, so the card's grey shell shrinks to the line and what follows slides up.
  useLayoutEffect(() => {
    let answered = requests.answered.length;
    return requests.subscribe(() => {
      const next = requests.answered.length;
      if (next === answered) return;
      answered = next;
      flip.prepare();
    });
  }, [requests, flip]);

  // After every render: keep the reading position when older turns were put in front; follow the bottom
  // again after a send or the jump pill.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (keep.current !== undefined && !model.loadingOlder) {
      element.scrollTop = keep.current.top + (element.scrollHeight - keep.current.height);
      keep.current = undefined;
      return;
    }
    if (lastScrollRequest.current !== model.scrollRequest) {
      if (lastScrollRequest.current !== -1) scroll.jump();
      lastScrollRequest.current = model.scrollRequest;
    }
    // Landing here (a notification's link, or a tap on a waiting row): at the bottom, and the first pending
    // card comes into view once, with its top edge showing when it is taller than the conversation. Blocking
    // questions are pinned above the composer already.
    if (!landed.current && model.loaded) {
      landed.current = true;
      scroll.snap();
      const card = element.querySelector<HTMLElement>('.request-card');
      if (card !== null && typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ block: card.offsetHeight > element.clientHeight ? 'start' : 'end' });
      }
    }
  });

  const loadOlder = () => {
    const element = scroller.current;
    if (element !== null && model.hasOlder && !model.loadingOlder) keep.current = { height: element.scrollHeight, top: element.scrollTop };
    void model.loadOlder();
  };
  const pull = usePullToRefresh(() => (scroller.current?.scrollTop ?? 0) <= 0, loadOlder);

  const status = model.status;
  const turns = model.turns;
  const answered = placeByTurn(requests.answered, new Set(turns.map((t) => t.turnId)));
  const steers = model.steerRows;
  const running = model.runningTurnId !== undefined;
  // Sending (technique 6): the message rises out of the composer, the field clears in the same frame, and the
  // older rows glide up as the view pins to the new bottom.
  const send = () => flip(() => model.send(), { enter: false, rise: SENT_ROWS, beforePlay: () => scroll.pin() });

  return (
    <main class="screen session-screen">
      <BackHeader href="/" label="Sessions" onBack={onBack}>
        <div class="topbar-end">
          <span class={`status-word ${status.tone}`} aria-label="Session status" data-status={status.status}>
            <span class="dot" aria-hidden="true" />
            {status.label}
          </span>
          <button type="button" class="ghost icon-button" aria-label="Session actions" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
            <Icon name="more" size={22} />
          </button>
        </div>
      </BackHeader>
      {actions.error !== undefined && (
        <p class="error session-actions-error" role="alert">
          {actions.error}
        </p>
      )}
      <div class="session-head">
        <h1 class="session-heading">
          {model.title}
          {model.bypass && (
            <span class="pill session-tag" title="Approvals bypassed: the agent runs everything without asking" aria-label="Approvals bypassed">
              Full access
            </span>
          )}
        </h1>
        {/* One footnote line: agent · folder · model · effort, then Change (a control) where the agent allows it. */}
        <p class="session-meta-line small">
          {model.agentId ?? ''}
          {model.folder !== undefined && (
            <>
              {' · '}
              <span class="session-folder" title={model.folder.path}>
                {model.folder.name}
              </span>
            </>
          )}
          {model.canChangeSettings ? (
            <>
              {' · '}
              <button type="button" class="session-model session-model-button" aria-haspopup="dialog" title="Change model and effort" onClick={() => model.openSettings()}>
                <span aria-label="Model">{model.model ?? 'Default model'}</span>
                {model.effort !== undefined && ' · '}
                {model.effort !== undefined && <span aria-label="Effort">{model.effort} effort</span>}
                <span aria-hidden="true">
                  {' · '}
                  <span class="session-model-change">Change</span>
                </span>
              </button>
            </>
          ) : (
            (model.model !== undefined || model.effort !== undefined) && (
              <span class="session-model">
                {' · '}
                {model.model !== undefined && <span aria-label="Model">{model.model}</span>}
                {model.model !== undefined && model.effort !== undefined && ' · '}
                {model.effort !== undefined && <span aria-label="Effort">{model.effort} effort</span>}
              </span>
            )
          )}
        </p>
      </div>
      <BackgroundTasks rows={model.backgroundTasks} model={model} flip={flip} scroller={scroller} />
      {model.openError !== undefined && (
        <p class="error" role="alert">
          {model.openError}
        </p>
      )}

      <section
        class="conversation"
        aria-label="Conversation"
        ref={scroller}
        onScroll={scroll.handlers.onScroll}
        onTouchStart={(event) => {
          scroll.handlers.onTouchStart();
          pull.handlers.onTouchStart(event);
        }}
        onTouchMove={pull.handlers.onTouchMove}
        onTouchEnd={() => {
          pull.handlers.onTouchEnd();
          scroll.handlers.onTouchEnd();
        }}
        onTouchCancel={scroll.handlers.onTouchCancel}
      >
        <div ref={content} class="conversation-content">
        <PullIndicator distance={pull.distance} pullLabel="Pull for earlier turns" releaseLabel="Release to load earlier turns" />
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
              <Turn key={turn.turnId} turn={turn} model={model} flip={flip} scroller={scroller} answered={answered.byTurn.get(turn.turnId) ?? NO_ROWS} />
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
        <InlineRequests model={requests} answered={answered.orphans} />
        </div>
      </section>

      <JumpPill shown={scroll.pill} onJump={() => model.jumpToLatest()} />

      <SessionComposer model={model} running={running} onSend={send} above={<PinnedQuestions model={requests} />} />
      {model.detailItemId !== undefined && (
        <ItemDetailSheet sessionId={sessionId} itemId={model.detailItemId} replica={replica} diffs={model.diffs} onClose={() => model.closeItem()} />
      )}
      {model.changesTurnId !== undefined && (
        <ChangesSheet sessionId={sessionId} turnId={model.changesTurnId} replica={replica} onClose={() => model.closeChanges()} />
      )}
      {model.settingsOpen && <SessionSettingsSheet create={() => model.settingsSheet()} onClose={() => model.closeSettings()} />}
      <StopConfirm model={model} />
      {menuOpen && (
        <ActionsSheet
          title={model.title}
          archived={replica.archivedSessions.some((s) => s.sessionId === sessionId)}
          onClose={() => setMenuOpen(false)}
          onArchive={() => {
            setMenuOpen(false);
            if (actions.askArchive(sessionId)) onBack();
          }}
          onUnarchive={() => {
            setMenuOpen(false);
            void actions.unarchive(sessionId);
          }}
          onDelete={() => {
            setMenuOpen(false);
            actions.askDelete(sessionId);
          }}
        />
      )}
      <DeleteConfirmSheet actions={actions} onDeleted={onBack} />
    </main>
  );
}

/** The strip of background tasks: one flat row each (title, elapsed time, status); a tap shows the activity. */
function BackgroundTasks({ rows, model, flip, scroller }: { rows: BackgroundTaskRow[]; model: SessionModel; flip: Flip; scroller: { current: HTMLElement | null } }) {
  if (rows.length === 0) return null;
  const running = rows.filter((row) => row.status === 'running').length;
  const toggle = (row: BackgroundTaskRow) => {
    if (!row.expanded) flip(() => model.toggleTask(row.id));
    else collapse(scroller.current?.parentElement ?? null, `task/${row.id}`, flip, () => model.toggleTask(row.id), !reducedMotion());
  };
  return (
    <section class="bg-tasks" aria-labelledby="bg-tasks-title">
      <h2 id="bg-tasks-title" class="bg-tasks-title small">
        Background tasks{running > 0 ? ` · ${running} running` : ''}
      </h2>
      <ul class="bg-task-list">
        {rows.map((row) => (
          <li key={row.id} class="bg-task" data-status={row.status}>
            <button type="button" class="bg-task-row row-line" aria-expanded={row.expanded} onClick={() => toggle(row)}>
              <Icon name={TASK_ICON[row.status]} size={18} class={row.status === 'running' ? 'row-icon spin' : 'row-icon'} />
              <span class="bg-task-title row-text">{row.title}</span>
              <span class="bg-task-time small">{row.elapsed}</span>
              <span class={`row-tag ${row.tone}`}>{row.state}</span>
              <Icon name="chevron-right" size={16} class={row.expanded ? 'chevron open' : 'chevron'} />
            </button>
            {row.expanded && (
              <p class="bg-task-activity row-body reveal" data-body={`task/${row.id}`}>
                {row.activity ?? 'No activity reported yet.'}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TASK_ICON = { running: 'spinner', finished: 'check', cancelled: 'x', failed: 'alert', ended: 'x' } as const;

/** Stop while background tasks run: stopping the turn cancels them too, so it asks first. */
function StopConfirm({ model }: { model: SessionModel }) {
  const question = model.stopQuestion;
  if (question === undefined) return null;
  return (
    <Sheet labelledBy="stop-confirm-title" onClose={() => model.cancelStop()}>
      <h2 id="stop-confirm-title">Stop the turn?</h2>
      <p class="muted small">{question}</p>
      <div class="actions">
        <button type="button" class="small ghost" onClick={() => model.cancelStop()}>
          Keep running
        </button>
        <button type="button" class="small danger" onClick={() => model.confirmStop()}>
          Stop anyway
        </button>
      </div>
    </Sheet>
  );
}

interface TurnProps {
  turn: TurnRow;
  model: SessionModel;
  flip: Flip;
  scroller: { current: HTMLElement | null };
  /** The turn's answered approvals and questions, each placed after its item. */
  answered: readonly AnsweredRow[];
}

const NO_ROWS: readonly AnsweredRow[] = [];

function Turn({ turn, model, flip, scroller, answered }: TurnProps) {
  const layout = layoutTurn(turn.items, turn.final);
  const foldable = turn.final && layout.work.length > 0;
  const visible = [...layout.lead, ...(!foldable || turn.unfolded ? layout.work : []), ...(layout.answer !== undefined ? [layout.answer] : [])];
  const lines = placeInTurn(answered, new Set(visible.map((item) => item.itemId)));
  const shown = (item: ItemRow) => (
    <Fragment key={item.itemId}>
      <ItemView item={item} model={model} flip={flip} scroller={scroller} />
      <AnsweredLines rows={lines.after.get(item.itemId) ?? NO_ROWS} />
    </Fragment>
  );
  return (
    <li class={`turn ${turn.status}`} data-turn-status={turn.status}>
      {layout.lead.map(shown)}
      {foldable && <PreviousToggle count={layout.work.length} open={turn.unfolded} flipKey={`${turn.turnId}/previous`} onToggle={() => flip(() => model.toggleFold(turn.turnId))} />}
      {(!foldable || turn.unfolded) && layout.work.map(shown)}
      {turn.workedFor !== undefined && <WorkedFor label={turn.workedFor} flipKey={`${turn.turnId}/worked`} />}
      {layout.answer !== undefined && shown(layout.answer)}
      <AnsweredLines rows={lines.end} />
      {turn.thinking && <Thinking flipKey={`${turn.turnId}/thinking`} />}
      {turn.changes !== undefined && (
        <button type="button" class="link small turn-changes" data-flip-key={`${turn.turnId}/changes`} onClick={() => model.openChanges(turn.turnId)}>
          {turn.changes}
          <Icon name="chevron-right" size={16} />
        </button>
      )}
      {turn.label !== '' && (
        <p class={`turn-state small ${turn.tone}${turn.queued === true ? ' queued' : ''}`} data-flip-key={`${turn.turnId}/state`} {...(turn.queued === true ? { role: 'status' } : {})}>
          {turn.label}
        </p>
      )}
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
                {model.steerable ? 'Steer instead' : 'Send when it ends'}
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

/** The last `max` lines of a command's output, without terminal codes. */
function outputTail(output: string, max = OUTPUT_LINES): string {
  const lines = cleanOutput(output).replace(/\n+$/, '').split('\n');
  return lines.length > max ? lines.slice(-max).join('\n') : lines.join('\n');
}

/** One item of a turn: a message, or a flat row that opens its content under it. */
function ItemView({ item, model, flip, scroller }: { item: ItemRow; model: SessionModel; flip: Flip; scroller: { current: HTMLElement | null } }) {
  if (item.kind === 'user') {
    return (
      <div class="item-row user" data-item-id={item.itemId} data-flip-key={item.itemId}>
        <div class="msg user" data-item="user">
          <SentAttachments images={item.images} files={item.files} />
          {item.text !== '' && <p>{item.text}</p>}
        </div>
      </div>
    );
  }
  if (item.kind === 'agent') return <AgentMessage itemId={item.itemId} text={item.text} streaming={item.streaming} />;
  const open = item.kind === 'other' ? false : item.expanded;
  const toggle = () => {
    if (!open) flip(() => model.toggleItem(item.itemId));
    else collapse(scroller.current, item.itemId, flip, () => model.toggleItem(item.itemId), !reducedMotion());
  };
  const detail = model.hasDetail(item.kind) ? (label: string) => (
    <button type="button" class="link small row-more" onClick={() => model.openItem(item.itemId)}>
      {label}
      <Icon name="chevron-right" size={16} />
    </button>
  ) : () => null;
  const line = rowLine(item);
  switch (item.kind) {
    case 'command':
      return (
        <FlatRow line={line} rowKey={item.itemId} kind="command" expandable open={open} onToggle={toggle}>
          {item.meta !== '' && <p class="row-meta">{item.meta}</p>}
          {item.output !== '' ? <pre class="row-output">{outputTail(item.output)}</pre> : <p class="row-meta">{item.tone === 'busy' ? 'No output yet.' : 'No output.'}</p>}
          {detail('Full output')}
        </FlatRow>
      );
    case 'fileChange':
      return (
        <FlatRow line={line} rowKey={item.itemId} kind="fileChange" expandable open={open} onToggle={toggle}>
          <ul class="paths" aria-label="Changed files">
            {item.files.map((file) => (
              <li key={file.path}>
                <span class={`kind ${file.kind}`}>{file.kind === 'add' ? '+' : file.kind === 'delete' ? '−' : '~'}</span> <code>{file.path}</code>
              </li>
            ))}
          </ul>
          {detail('Show changes')}
        </FlatRow>
      );
    case 'tool':
      return (
        <FlatRow line={line} rowKey={item.itemId} kind="tool" expandable={item.error !== undefined || model.diffs} open={open} onToggle={toggle}>
          {item.error !== undefined && <p class="error small">{item.error}</p>}
          {detail('Details')}
        </FlatRow>
      );
    case 'reasoning': {
      const text = item.text !== '' ? item.text : item.summary;
      return (
        <FlatRow line={line} rowKey={item.itemId} kind="reasoning" expandable={text !== ''} open={open} onToggle={toggle} shimmer={item.streaming}>
          <p class="reasoning-text">{text}</p>
        </FlatRow>
      );
    }
    case 'plan':
      return (
        <FlatRow line={line} rowKey={item.itemId} kind="plan" expandable={item.text !== ''} open={open} onToggle={toggle}>
          <p class="plan-text">{item.text}</p>
          {detail('Details')}
        </FlatRow>
      );
    case 'other':
      return <FlatRow line={line} rowKey={item.itemId} kind="other" expandable={false} open={false} onToggle={toggle} />;
  }
}

function Steer({ steer, model }: { steer: SteerRow; model: SessionModel }) {
  return (
    <li class={`msg user steer ${steer.state}`} data-steer-state={steer.state} data-flip-key={`steer/${steer.clientMessageId}`}>
      <SentAttachments images={steer.images} files={steer.files} />
      {steer.text !== '' && <p>{steer.text}</p>}
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

/** A sent message's images (thumbnails that open the full image) and files (chips that download them). */
function SentAttachments({ images, files }: { images: AttachmentView[]; files: AttachmentView[] }) {
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div class="sent-attachments">
      {images.length > 0 && (
        <ul class="thumbs" aria-label="Attached images">
          {images.map((image, index) => (
            <li key={`${image.url}-${index}`}>
              <a href={image.url} target="_blank" rel="noopener">
                <img src={image.url} alt={`Attached image ${index + 1}`} loading="lazy" decoding="async" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul class="file-chips" aria-label="Attached files">
          {files.map((file, index) => (
            <li key={`${file.url}-${index}`}>
              <a class="file-chip" href={file.url} download={file.name} title={file.mediaType}>
                <span class="file-icon" aria-hidden="true">
                  ▤
                </span>
                <span class="file-name">{file.name}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The picked photos and files above the message field: thumbnail or name, progress, error, remove. */
function AttachTray({ model }: { model: SessionModel }) {
  const entries = model.attachments?.entries ?? [];
  const notice = model.attachments?.notice;
  if (entries.length === 0 && notice === undefined) return null;
  return (
    <div class="attach-tray">
      {notice !== undefined && (
        <p class="error small" role="alert">
          {notice}
        </p>
      )}
      {entries.length > 0 && (
        <ul class="tray" aria-label="Attachments to send">
          {entries.map((entry) => (
            <TrayEntry key={entry.id} entry={entry} model={model} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TrayEntry({ entry, model }: { entry: AttachmentEntry; model: SessionModel }) {
  const label = entry.state === 'preparing' ? 'Preparing…' : entry.state === 'uploading' ? `Uploading ${Math.round(entry.progress * 100)}%` : entry.state === 'ready' ? 'Ready' : 'Failed';
  return (
    <li class={`tray-entry ${entry.kind} ${entry.state}`} data-state={entry.state} aria-label={`${entry.name}: ${label}`}>
      {entry.kind === 'image' && entry.previewUrl !== undefined ? (
        <img class="tray-thumb" src={entry.previewUrl} alt={entry.name} />
      ) : (
        <span class="tray-file">
          <span class="file-icon" aria-hidden="true">
            ▤
          </span>
          <span class="file-name">{entry.name}</span>
        </span>
      )}
      {(entry.state === 'preparing' || entry.state === 'uploading') && (
        <progress class="tray-progress" max={1} value={entry.state === 'preparing' ? undefined : entry.progress} aria-label={label} />
      )}
      <button type="button" class="tray-remove" aria-label={`Remove ${entry.name}`} onClick={() => model.removeAttachment(entry.id)}>
        ×
      </button>
      {entry.state === 'failed' && (
        <div class="tray-error" role="alert">
          <span class="small">{entry.error}</span>
          <button type="button" class="small" onClick={() => model.retryAttachment(entry.id)}>
            Retry
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * The shared floating composer (ui/Composer.tsx) with the session's rules: Send, Steer or Queue, Stop (asking
 * first while background tasks run), the attachments, and the notes above the card. A send rises out of it
 * (Sending): the field clears in the same frame and the older rows glide up.
 */
function SessionComposer({ model, running, onSend, above }: { model: SessionModel; running: boolean; onSend: () => void; above: ComponentChildren }) {
  const steering = model.mode === 'steer';
  const queueing = model.mode === 'queue';
  const rules = model.attachRules;
  const hint = model.runHint;
  const typing = model.draft.trim() !== '' || (model.attachments?.entries.length ?? 0) > 0;
  return (
    <Composer
      draft={model.draft}
      placeholder={steering ? 'Steer the turn…' : queueing ? 'Message for after this turn…' : 'Message the agent…'}
      onDraft={(text) => model.setDraft(text)}
      canSend={model.canSend}
      onSend={onSend}
      sendLabel={steering ? 'Steer' : queueing ? 'Queue' : 'Send'}
      running={running}
      sendsWhileRunning
      {...(hint !== undefined ? { runHint: hint } : {})}
      attachments={model.attachments?.entries.length ?? 0}
      stop={{ onStop: () => model.requestStop(), disabled: !model.canInterrupt, busy: model.interrupting }}
      {...(rules !== undefined ? { attach: { accept: model.attachAccept, onPick: (files: File[]) => model.attach(files) } } : {})}
      disabled={model.closed}
      tray={<AttachTray model={model} />}
      above={
        <>
          {above}
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
          {/* While you type into the run, the hint above the field says the same thing. */}
          {model.composerNote !== undefined && !typing && (
            <p class="muted small composer-note" role="note">
              {model.composerNote}
            </p>
          )}
          {model.attachmentsNote !== undefined && (
            <p class="muted small attach-note" role="status">
              {model.attachmentsNote}
            </p>
          )}
        </>
      }
    />
  );
}
