// The New look's pieces (docs/research/visual-gap-openai-2026-10.md, ranked items 1-9, 13, 14): the flat
// session list with host chips, the centred session header, flat tool rows, the "N previous messages" and
// "Worked for" lines, and the sheets' bodies. The quiet approval and question cards are the app's
// (screens/session/approvals/RequestCards.tsx) fed with the lab's fixtures; the floating composer is the
// app's too (ui/Composer.tsx).
// Styles: new-look.css, all under .lab[data-look='new']. The motion hooks (data-flip-key, data-shell-key,
// data-body, Shell, lab-reveal) are the same the Now look uses, so every technique switch works in both looks.
import type { RefObject } from 'preact';
import { useState } from 'preact/hooks';

import { GroupList, type GroupRow } from '../ui/GroupList';
import { NavHeader } from '../ui/NavHeader';
import { SheetHeader } from '../ui/Sheet';
import { APPROVAL, QUESTION, type LabSession as Session, type ToolRow } from './fixtures';
import type { Shown } from '../ui/motion/flip';
import { Icon } from '../ui/Icon';
import type { ApprovalRequestBody, Decision } from '../replica/types';
import { approvalAnswered, questionAnswered, type AnsweredText } from '../screens/session/approvals/answered';
import type { AnsweredRow, ApprovalCardState, QuestionCardState } from '../screens/session/approvals/approvals-model';
import { approvalCard } from '../screens/session/approvals/decisions';
import {
  answerOf,
  EMPTY_DRAFT,
  isAnswered,
  pickOther,
  questionTitle,
  questionView,
  setOther,
  toggleOption,
  type Question,
  type QuestionDraft,
} from '../screens/session/approvals/questions';
import { AnsweredLine, ApprovalCard, QuestionCard } from '../screens/session/approvals/RequestCards';
import { detailRows } from '../screens/session/session-details';
import { RowSign } from '../screens/RowSign';
import { indicatorOf, previousMessages } from './look';

export interface NewListProps {
  sessions: Shown<Session>[];
  hosts: string[];
  host: string;
  listRef: RefObject<HTMLUListElement>;
  smooth: boolean;
  onHost: (host: string) => void;
  onOpen: () => void;
  onNew: () => void;
  onSimulate: () => void;
  onDropped: (id: string) => void;
}

/** Item 6: a flat list on the page, host chips under the large title, one trailing sign per row (the app's RowSign). */
export function NewList({ sessions, hosts, host, listRef, smooth, onHost, onOpen, onNew, onSimulate, onDropped }: NewListProps) {
  return (
    <main class="screen lab-nl-home">
      <header class="lab-nl-titlebar">
        <h1 class="lab-nl-large-title">Sessions</h1>
        <button type="button" class="lab-nl-round lab-nl-round-primary" aria-label="New session" onClick={onNew}>
          <Icon name="plus" />
        </button>
      </header>
      <div class="lab-nl-chips" role="group" aria-label="Hosts">
        {hosts.map((name) => (
          <button key={name} type="button" class="lab-nl-chip" aria-pressed={host === name} onClick={() => onHost(name)}>
            {name !== 'All' && <span class="lab-nl-online" aria-hidden="true" />}
            {name}
          </button>
        ))}
      </div>
      <div class="lab-nl-list-head">
        <h2 class="lab-nl-section">Recent</h2>
        <button type="button" class="lab-nl-text-button" onClick={onSimulate}>
          Simulate activity
        </button>
      </div>
      <ul class="lab-nl-list" aria-label="Sessions" ref={listRef}>
        {sessions.map(({ item, leaving }) => {
          return (
            <li
              key={item.id}
              class={leaving ? 'list-leaving' : undefined}
              data-flip-key={leaving ? undefined : item.id}
              aria-hidden={leaving ? 'true' : undefined}
              onAnimationEnd={(event) => leaving && event.target === event.currentTarget && onDropped(item.id)}
            >
              <a
                class="lab-nl-row"
                href="/lab"
                onClick={(event) => {
                  event.preventDefault();
                  if (!leaving) onOpen();
                }}
              >
                <span class="lab-nl-row-text">
                  <span class="lab-nl-row-title">{item.title}</span>
                  <span class="lab-nl-row-meta">
                    {item.host} · {item.folder} · {item.updated}
                  </span>
                </span>
                <RowSign sign={indicatorOf(item)} smooth={smooth} />
              </a>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

/** Item 8: the app's centred bar (ui/NavHeader.tsx): round back button, centred 17 px title with a grey line, round more button. */
export function NewSessionHeader({ title, subtitle, onBack, onMore }: { title: string; subtitle: string; onBack: () => void; onMore: () => void }) {
  return (
    <NavHeader href="/lab" backLabel="Back to sessions" onBack={onBack} title={title} moreLabel="Session details" onMore={onMore}>
      {subtitle}
    </NavHeader>
  );
}

/** Item 4: one line, a leading icon, a verb phrase in secondary grey, a chevron; the output opens below. */
export function NewToolRow({ tool, flipKey, open, reveal, onToggle }: { tool: ToolRow; flipKey: string; open: boolean; reveal: boolean; onToggle: () => void }) {
  return (
    <div class="lab-nl-tool" data-flip-key={flipKey}>
      <button type="button" class="lab-nl-tool-row" aria-expanded={open} onClick={onToggle}>
        <Icon name={tool.verb === 'Edited' ? 'file-diff' : 'terminal'} size={18} />
        <span class="lab-nl-tool-text">
          {tool.verb} <span class="lab-nl-tool-target">{tool.summary}</span>
        </span>
        {tool.tone === 'error' && <span class="lab-nl-tool-failed">{tool.state}</span>}
        <Icon name="chevron-right" size={16} class={`lab-nl-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <pre class={`lab-nl-output${reveal ? ' lab-reveal' : ''}`} data-body={flipKey}>
          {tool.output}
        </pre>
      )}
    </div>
  );
}

/** Item 4: the finished turn's work, folded behind one line. */
export function PreviousToggle({ count, open, flipKey, onToggle }: { count: number; open: boolean; flipKey: string; onToggle: () => void }) {
  return (
    <button type="button" class="lab-nl-previous" aria-expanded={open} data-flip-key={flipKey} onClick={onToggle}>
      {previousMessages(count)}
      <Icon name="chevron-down" size={16} class={`lab-nl-chevron${open ? ' open' : ''}`} />
    </button>
  );
}

export function WorkedFor({ label, flipKey }: { label: string; flipKey: string }) {
  return (
    <p class="lab-nl-worked" data-flip-key={flipKey}>
      <span>{label}</span>
    </p>
  );
}

export function ChangesRow({ reveal, flipKey, onOpen }: { reveal: boolean; flipKey: string; onOpen: () => void }) {
  return (
    <button type="button" class={`lab-nl-changes${reveal ? ' lab-reveal' : ''}`} data-flip-key={flipKey} onClick={onOpen}>
      <Icon name="file-diff" size={18} />
      <span class="lab-nl-changes-text">3 files changed</span>
      <span class="lab-nl-counts">
        <span class="plus">+19</span> <span class="minus">−1</span>
      </span>
      <Icon name="chevron-right" size={16} class="lab-nl-chevron" />
    </button>
  );
}

export type ApprovalChoice = 'accept' | 'session' | 'decline' | 'cancel';

const CHOICE: Readonly<Record<Decision, ApprovalChoice>> = { accept: 'accept', acceptForSession: 'session', decline: 'decline', cancel: 'cancel' };

/** The fixture approval as the app's card sees it: every decision offered. */
const APPROVAL_CARD: ApprovalCardState = {
  ...approvalCard({
    requestId: 'lab-approval',
    kind: 'command',
    sessionId: 'lab',
    turnId: 't1',
    itemId: 'lab-approval',
    createdAt: 0,
    command: APPROVAL.command,
    cwd: APPROVAL.cwd,
    reason: APPROVAL.reason,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  } as ApprovalRequestBody),
  title: APPROVAL.title,
};

/** The fixture question: one pick from two branches, or your own words ("Other…"). */
const LAB_QUESTION: Question = { id: 'branch', header: '', question: QUESTION.title, options: QUESTION.options, isOther: true, isSecret: false };

function answeredRow(kind: 'approval' | 'question', title: string, text: AnsweredText): AnsweredRow {
  return { requestId: `lab-${kind}`, kind, requestKind: kind === 'approval' ? 'command' : 'input', turnId: '', itemId: '', title, ...text };
}

/**
 * Item 5: the app's approval card (screens/session/approvals/RequestCards.tsx) with the fixture: a grey
 * card, icon and bold title, the command in an inner box, Accept and Decline; Accept for this session and
 * Cancel the turn sit behind More. Answered, it keeps its place as one line with a check.
 */
export function NewApprovalCard({
  flipKey,
  state,
  shelled,
  animate,
  onAnswer,
}: {
  flipKey: string;
  state: 'pending' | 'approved' | 'declined';
  shelled: boolean;
  animate: boolean;
  onAnswer: (choice: ApprovalChoice) => void;
}) {
  if (state !== 'pending') {
    const row = answeredRow('approval', APPROVAL.title, approvalAnswered({ by: 'me' }, state === 'approved' ? 'accept' : 'decline'));
    return <AnsweredLine row={row} flipKey={flipKey} shelled={shelled} reveal={animate} />;
  }
  // The lab plays its own haptic tick (behind its switch), so the card's stays off.
  return <ApprovalCard card={APPROVAL_CARD} flipKey={flipKey} shelled={shelled} reveal={animate} haptic={NO_HAPTIC} onDecide={(decision) => onAnswer(CHOICE[decision])} />;
}

const NO_HAPTIC = () => undefined;

/** Item 13: the app's question card with the fixture; answered, it keeps its place with a check and the answer. */
export function NewQuestionCard({ flipKey, answer, shelled, animate, onAnswer }: { flipKey: string; answer: string | null; shelled: boolean; animate: boolean; onAnswer: (answer: string) => void }) {
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_DRAFT);
  if (answer !== null) {
    return <AnsweredLine row={answeredRow('question', QUESTION.title, questionAnswered({ by: 'me' }, answer))} flipKey={flipKey} shelled={shelled} reveal={animate} />;
  }
  const card: QuestionCardState = {
    requestId: 'lab-question',
    title: questionTitle([LAB_QUESTION]),
    blocking: false,
    questions: [questionView(LAB_QUESTION, draft)],
    canSubmit: isAnswered(LAB_QUESTION, draft),
    sending: false,
  };
  return (
    <QuestionCard
      card={card}
      flipKey={flipKey}
      shelled={shelled}
      reveal={animate}
      onToggle={(_, label) => setDraft(toggleOption(LAB_QUESTION, draft, label))}
      onOther={() => setDraft(pickOther(LAB_QUESTION, draft))}
      onText={(_, text) => setDraft(setOther(LAB_QUESTION, draft, text))}
      onSubmit={() => onAnswer(answerOf(LAB_QUESTION, draft).join(', '))}
    />
  );
}

/** The session's ⋯ sheet: the app's rows (session-details.ts) with the fixture's values; the lab has no archive or delete. */
export function SessionDetailsBody({ status, onChanges, onClose }: { status: string; onChanges: () => void; onClose: () => void }) {
  const tone = status === 'Running' ? 'busy' : status === 'Finished' ? 'ok' : 'attention';
  const rows = detailRows({
    status,
    statusTone: tone,
    agent: 'Codex',
    model: 'gpt-5.5',
    effort: 'High',
    canChangeSettings: false,
    folder: '~/code/nano-remote',
    fullAccess: false,
    changes: '3 files',
    archived: false,
  }).flatMap((row): GroupRow[] => {
    if (row.action !== undefined && row.action !== 'changes') return [];
    return [{ key: row.key, icon: row.icon, label: row.label, value: row.value, ...(row.action === 'changes' ? { onClick: onChanges, opens: true } : {}) }];
  });
  return (
    <>
      <SheetHeader titleId="lab-details-title" title="Fix the failing parser test" subtitle="Mac mini · nano-remote" actionLabel="Done" onAction={onClose} />
      <GroupList label="Session details" rows={rows} />
    </>
  );
}

/** The composer's + sheet. The lab has nothing to attach; each row just closes it. */
export function AddBody({ onClose }: { onClose: () => void }) {
  const rows = [
    { icon: 'image', label: 'Photo' },
    { icon: 'file', label: 'File' },
    { icon: 'folder', label: 'Folder from the Mac' },
  ] as const;
  return (
    <>
      <SheetHeader titleId="lab-add-title" title="Add to message" actionLabel="Cancel" onAction={onClose} />
      <ul class="lab-nl-group" aria-label="Add">
        {rows.map((row) => (
          <li key={row.label}>
            <button type="button" class="lab-nl-group-row" onClick={onClose}>
              <Icon name={row.icon} size={18} />
              <span>{row.label}</span>
              <Icon name="chevron-right" size={16} class="lab-nl-chevron" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
