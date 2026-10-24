// The session page, /s/:sessionId: the turn list, the pending-request banner, the approval and question
// cards (approvals/), the composer, and the item detail sheet (views/: command output, the turn's diff). All state and rules live in SessionModel and ApprovalsModel; this
// file renders them and owns only the DOM work (scrolling, the pull-down gesture, keeping the reading
// position when older turns are put in front).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Replica } from '../../replica/replica';
import { BackHeader } from '../../ui/BackHeader';
import { hapticTick } from '../../ui/motion/haptic';
import { Sheet } from '../../ui/Sheet';
import { PullIndicator, usePullToRefresh } from '../../ui/PullToRefresh';
import type { AgentsSource } from '../capabilities';
import { SessionActions } from '../session-actions';
import { ActionsSheet, DeleteConfirmSheet } from '../SessionActionsSheets';
import { useModel } from '../use-model';
import { ApprovalsModel } from './approvals/approvals-model';
import { InlineRequests, PinnedQuestions } from './approvals/RequestCards';
import type { AttachmentEntry } from './attachments/composer';
import { SessionModel, type AttachmentServices, type AttachmentView, type BackgroundTaskRow, type ItemRow, type SteerRow, type TurnRow } from './session-model';
import { SessionSettingsSheet } from './SessionSettingsSheet';
import { ChangesSheet } from './views/ChangesSheet';
import { ItemDetailSheet } from './views/ItemDetailSheet';

/** Within this many px of the bottom counts as "at the bottom" (auto-scroll stays on). */
const BOTTOM_SLACK = 48;

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
  /** Archive and delete from the header's "⋯" menu (shared with Home, which shows the archive's Undo). */
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
  const landed = useRef(false);
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
    // Landing here (a notification's link, or a tap on a waiting row): the first pending card comes into
    // view once, with its top edge showing when it is taller than the conversation. Blocking questions are
    // pinned above the composer already.
    if (!landed.current && model.loaded) {
      landed.current = true;
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
  const task = model.taskState;
  const pending = model.pending;
  const turns = model.turns;
  const steers = model.steerRows;
  const running = model.runningTurnId !== undefined;

  return (
    <main class="screen session-screen">
      <BackHeader href="/" label="Sessions" onBack={onBack}>
        <div class="topbar-end">
          <span class={`pill ${status.tone}`} aria-label="Session status" data-status={status.status}>
            {status.label}
          </span>
          <button type="button" class="ghost icon-button" aria-label="Session actions" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
            ⋯
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
            <span class="bypass-tag" title="Approvals bypassed: the agent runs everything without asking" aria-label="Approvals bypassed">
              Bypass
            </span>
          )}
        </h1>
        <p class={`task-state small ${task.tone}`} aria-label="Task state" data-tone={task.tone}>
          <span class="dot" aria-hidden="true" />
          {task.label}
        </p>
        <p class="muted small">
          {model.agentId ?? ''}
          {model.folder !== undefined && (
            <>
              {' · '}
              <code title={model.folder.path}>{model.folder.name}</code>
            </>
          )}
        </p>
        {model.canChangeSettings ? (
          <button
            type="button"
            class="muted small session-model session-model-button"
            aria-haspopup="dialog"
            title="Change model and effort"
            onClick={() => model.openSettings()}
          >
            <span aria-label="Model">{model.model ?? 'Default model'}</span>
            {model.effort !== undefined && ' · '}
            {model.effort !== undefined && <span aria-label="Effort">{model.effort} effort</span>}
            <span class="session-model-change" aria-hidden="true">
              Change
            </span>
          </button>
        ) : (
          (model.model !== undefined || model.effort !== undefined) && (
            <p class="muted small session-model">
              {model.model !== undefined && <span aria-label="Model">{model.model}</span>}
              {model.model !== undefined && model.effort !== undefined && ' · '}
              {model.effort !== undefined && <span aria-label="Effort">{model.effort} effort</span>}
            </p>
          )
        )}
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
      <BackgroundTasks rows={model.backgroundTasks} model={model} />
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
        <InlineRequests model={requests} />
      </section>

      {model.showJumpToLatest && (
        <button type="button" class="jump-pill" onClick={() => model.jumpToLatest()}>
          Jump to latest ↓
        </button>
      )}

      <PinnedQuestions model={requests} />
      <Composer model={model} running={running} />
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

/** The strip of background tasks: one row each (title, elapsed time, status); a tap shows the activity. */
function BackgroundTasks({ rows, model }: { rows: BackgroundTaskRow[]; model: SessionModel }) {
  if (rows.length === 0) return null;
  const running = rows.filter((row) => row.status === 'running').length;
  return (
    <section class="bg-tasks" aria-labelledby="bg-tasks-title">
      <h2 id="bg-tasks-title" class="bg-tasks-title small">
        Background tasks{running > 0 ? ` · ${running} running` : ''}
      </h2>
      <ul class="bg-task-list">
        {rows.map((row) => (
          <li key={row.id} class="bg-task" data-status={row.status}>
            <button type="button" class="bg-task-row" aria-expanded={row.expanded} onClick={() => model.toggleTask(row.id)}>
              <span class="bg-task-title">{row.title}</span>
              <span class="bg-task-time small muted">{row.elapsed}</span>
              <span class={`state small ${row.tone}`}>{row.state}</span>
            </button>
            {row.expanded && <p class="bg-task-activity small muted">{row.activity ?? 'No activity reported yet.'}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

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

function Turn({ turn, model }: { turn: TurnRow; model: SessionModel }) {
  return (
    <li class={`turn ${turn.status}`} data-turn-status={turn.status}>
      {turn.items.map((item) => (
        <OpenableItem key={item.itemId} item={item} model={model} />
      ))}
      {turn.changes !== undefined && (
        <button type="button" class="link small turn-changes" onClick={() => model.openChanges(turn.turnId)}>
          {turn.changes} ›
        </button>
      )}
      {turn.label !== '' && (
        <p class={`turn-state small ${turn.tone}${turn.queued === true ? ' queued' : ''}`} {...(turn.queued === true ? { role: 'status' } : {})}>
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

/** What a short label of an item says, for the button that opens its detail sheet. */
const ITEM_NAME: Record<ItemRow['kind'], string> = {
  user: 'message',
  agent: 'agent message',
  reasoning: 'thinking',
  command: 'command',
  fileChange: 'file change',
  tool: 'tool call',
  plan: 'plan',
  other: 'activity',
};

/**
 * An item of the turn list that opens the detail sheet: a tap anywhere on it that does not hit one of its
 * own controls, or its details button (keyboard and screen readers).
 */
function OpenableItem({ item, model }: { item: ItemRow; model: SessionModel }) {
  if (!model.hasDetail(item.kind)) {
    return (
      <div class={`item-row ${item.kind === 'user' ? 'user' : ''}`} data-item-id={item.itemId}>
        <Item item={item} model={model} />
      </div>
    );
  }
  return (
    <div
      class={`item-row ${item.kind === 'user' ? 'user' : ''}`}
      data-item-id={item.itemId}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, a, summary, input, textarea, select') !== null) return;
        if (window.getSelection()?.isCollapsed === false) return; // selecting text, not opening
        model.openItem(item.itemId);
      }}
    >
      <Item item={item} model={model} />
      <button type="button" class="link small open-detail" aria-label={`Details of ${ITEM_NAME[item.kind]}`} onClick={() => model.openItem(item.itemId)}>
        {item.kind === 'command' ? 'Output ›' : 'Details ›'}
      </button>
    </div>
  );
}

function Item({ item, model }: { item: ItemRow; model: SessionModel }) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="msg user" data-item={item.kind}>
          <SentAttachments images={item.images} files={item.files} />
          {item.text !== '' && <p>{item.text}</p>}
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

function Composer({ model, running }: { model: SessionModel; running: boolean }) {
  const steering = model.mode === 'steer';
  const queueing = model.mode === 'queue';
  const picker = useRef<HTMLInputElement>(null);
  const rules = model.attachRules;
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
      {model.composerNote !== undefined && (
        <p class="muted small composer-note" role="note">
          {model.composerNote}
        </p>
      )}
      <AttachTray model={model} />
      {model.attachmentsNote !== undefined && (
        <p class="muted small attach-note" role="status">
          {model.attachmentsNote}
        </p>
      )}
      <form
        class="composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (model.canSend) hapticTick(); // Send, Steer or Queue; inside the tap, where iOS allows it
          model.send();
        }}
      >
        {rules !== undefined && (
          <>
            <button type="button" class="attach-button" aria-label="Attach photos or files" title="Attach photos or files" onClick={() => picker.current?.click()}>
              +
            </button>
            <input
              ref={picker}
              class="attach-input"
              type="file"
              multiple
              accept={model.attachAccept === '' ? undefined : model.attachAccept}
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                model.attach([...(input.files ?? [])]);
                input.value = ''; // the same file can be picked again
              }}
            />
          </>
        )}
        <textarea
          aria-label="Message"
          rows={Math.min(6, Math.max(1, model.draft.split('\n').length))}
          placeholder={steering ? 'Steer the turn…' : queueing ? 'Message for after this turn…' : 'Message the agent…'}
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
            <button type="button" class="stop" onClick={() => model.requestStop()} disabled={!model.canInterrupt} aria-label="Interrupt">
              {model.interrupting ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button type="submit" class="primary" disabled={!model.canSend}>
            {steering ? 'Steer' : queueing ? 'Queue' : 'Send'}
          </button>
        </div>
      </form>
    </footer>
  );
}
