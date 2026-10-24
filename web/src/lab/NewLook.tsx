// The New look's pieces (docs/research/visual-gap-openai-2026-10.md, ranked items 1-9, 13, 14): the flat
// session list with host chips, the centred session header, flat tool rows, the "N previous messages" and
// "Worked for" lines, the quiet approval and question cards, the floating composer and the sheets' bodies.
// Styles: new-look.css, all under .lab[data-look='new']. The motion hooks (data-flip-key, data-shell-key,
// data-body, Shell, lab-reveal) are the same the Now look uses, so every technique switch works in both looks.
import type { RefObject } from 'preact';
import { useState } from 'preact/hooks';

import { SheetHeader } from '../ui/Sheet';
import { CrossFade, Shell } from './dom';
import { APPROVAL, QUESTION, type LabSession as Session, type ToolRow } from './fixtures';
import type { Shown } from './flip';
import { Icon } from './icons';
import { indicatorOf, previousMessages, type Indicator } from './look';

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

/** Item 6: a flat list on the page, host chips under the large title, one trailing indicator per row. */
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
          const indicator = indicatorOf(item);
          return (
            <li
              key={item.id}
              class={leaving ? 'lab-leaving' : undefined}
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
                <CrossFade value={`${indicator.kind}|${indicator.label}`} smooth={smooth} render={(v) => <RowIndicator value={v} />} />
              </a>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function RowIndicator({ value }: { value: string }) {
  const [kind, label] = value.split('|') as [Indicator['kind'], string];
  if (kind === 'pill') return <span class="lab-nl-pill">{label}</span>;
  if (kind === 'spinner') return <Icon name="spinner" class="lab-nl-spin lab-nl-indicator busy" />;
  if (kind === 'question') return <Icon name="question" class="lab-nl-indicator attention" />;
  if (kind === 'alert') return <Icon name="alert" class="lab-nl-indicator error" />;
  return <span class="lab-nl-indicator-none" />;
}

/** Item 8: round back button, centred 17 px title with a grey subtitle, round more button. */
export function NewSessionHeader({ title, subtitle, onBack, onMore }: { title: string; subtitle: string; onBack: () => void; onMore: () => void }) {
  return (
    <header class="lab-nl-nav">
      <a
        class="lab-nl-round"
        href="/lab"
        aria-label="Back to sessions"
        onClick={(event) => {
          event.preventDefault();
          onBack();
        }}
      >
        <Icon name="back" />
      </a>
      <div class="lab-nl-nav-title">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <button type="button" class="lab-nl-round" aria-label="Session details" onClick={onMore}>
        <Icon name="more" />
      </button>
    </header>
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

/**
 * Item 5: a grey card, icon and bold title, the command in an inner box, one primary pill (Accept) and one
 * secondary pill (Decline); Accept for session and Cancel sit behind More. Answered, it keeps its place with
 * a check.
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
  const [more, setMore] = useState(false);
  const shellClass = shelled ? ' lab-shelled' : '';
  if (state !== 'pending') {
    const approved = state === 'approved';
    return (
      <section class={`lab-nl-card answered${shellClass}`} data-flip-key={flipKey} data-shell-key={flipKey} aria-label="Approval answered">
        {shelled && <Shell />}
        <div class={`lab-nl-card-head${animate ? ' lab-reveal' : ''}`}>
          <Icon name={approved ? 'check' : 'x'} size={18} />
          <span class="lab-nl-card-title">{APPROVAL.title}</span>
          <span class={`lab-nl-answer ${approved ? 'ok' : 'muted'}`}>
            {approved ? 'Approved' : 'Declined'}
            {approved && <Icon name="check-circle" size={18} />}
          </span>
        </div>
      </section>
    );
  }
  return (
    <section class={`lab-nl-card${shellClass}`} role="group" aria-label={`Approval: ${APPROVAL.title}`} data-flip-key={flipKey} data-shell-key={flipKey}>
      {shelled && <Shell />}
      <div class="lab-nl-card-head">
        <Icon name="terminal" size={18} />
        <h2 class="lab-nl-card-title">{APPROVAL.title}</h2>
      </div>
      <div class="lab-nl-inner">
        <code class="lab-nl-command">{APPROVAL.command}</code>
        <span class="lab-nl-inner-meta">
          in {APPROVAL.cwd} · {APPROVAL.reason}
        </span>
      </div>
      <div class="lab-nl-card-actions">
        <button type="button" class="lab-nl-pill-button primary" onClick={() => onAnswer('accept')}>
          Accept
        </button>
        <button type="button" class="lab-nl-pill-button" onClick={() => onAnswer('decline')}>
          Decline
        </button>
        <button type="button" class="lab-nl-text-button lab-nl-more" aria-expanded={more} onClick={() => setMore(!more)}>
          More
        </button>
      </div>
      {more && (
        <div class={`lab-nl-more-menu${animate ? ' lab-reveal' : ''}`} role="group" aria-label="More choices">
          <button type="button" class="lab-nl-menu-row" onClick={() => onAnswer('session')}>
            Accept for this session
          </button>
          <button type="button" class="lab-nl-menu-row danger" onClick={() => onAnswer('cancel')}>
            Cancel the turn
          </button>
        </div>
      )}
    </section>
  );
}

/** Item 13: the question card, shaped like the approval card: options as rows in one inner box, one Send pill. */
export function NewQuestionCard({ flipKey, answer, shelled, animate, onAnswer }: { flipKey: string; answer: string | null; shelled: boolean; animate: boolean; onAnswer: (answer: string) => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const shellClass = shelled ? ' lab-shelled' : '';
  if (answer !== null) {
    return (
      <section class={`lab-nl-card answered${shellClass}`} data-flip-key={flipKey} data-shell-key={flipKey} aria-label="Question answered">
        {shelled && <Shell />}
        <div class={`lab-nl-card-head${animate ? ' lab-reveal' : ''}`}>
          <Icon name="check" size={18} />
          <span class="lab-nl-card-title">{QUESTION.title}</span>
          <span class="lab-nl-answer muted">{answer}</span>
        </div>
      </section>
    );
  }
  const picked = choice === 'other' ? other.trim() : choice;
  return (
    <section class={`lab-nl-card${shellClass}`} role="group" aria-label={`Question: ${QUESTION.title}`} data-flip-key={flipKey} data-shell-key={flipKey}>
      {shelled && <Shell />}
      <div class="lab-nl-card-head">
        <Icon name="question" size={18} />
        <h2 class="lab-nl-card-title">{QUESTION.title}</h2>
      </div>
      <div class="lab-nl-inner lab-nl-options" role="radiogroup" aria-label="Answers">
        {[...QUESTION.options, { label: 'other', description: '' }].map((option) => {
          const selected = choice === option.label;
          return (
            <label key={option.label} class={`lab-nl-option${selected ? ' selected' : ''}`}>
              <input type="radio" name="lab-question" checked={selected} onChange={() => setChoice(option.label)} />
              <span class="lab-nl-radio" aria-hidden="true">
                {selected && <Icon name="check" size={14} />}
              </span>
              {option.label === 'other' ? (
                <input
                  class="lab-nl-other"
                  aria-label="Other answer"
                  placeholder="Other…"
                  value={other}
                  onFocus={() => setChoice('other')}
                  onInput={(event) => setOther((event.currentTarget as HTMLInputElement).value)}
                />
              ) : (
                <span class="lab-nl-option-text">
                  <span>{option.label}</span>
                  <span class="lab-nl-inner-meta">{option.description}</span>
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div class="lab-nl-card-actions">
        <button type="button" class="lab-nl-pill-button primary" disabled={picked === null || picked === ''} onClick={() => picked && onAnswer(picked)}>
          Send answer
        </button>
      </div>
    </section>
  );
}

export interface NewComposerProps {
  draft: string;
  running: boolean;
  onDraft: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  onAdd: () => void;
  onFocus: () => void;
}

/** Item 3: a floating card with a round + and one round trailing button: Send (arrow) or, while running, Stop. */
export function NewComposer({ draft, running, onDraft, onSend, onStop, onAdd, onFocus }: NewComposerProps) {
  const empty = draft.trim() === '';
  return (
    <footer class="composer lab-nl-composer-bar">
      {running && !empty && <p class="lab-nl-composer-hint">Steers the running turn</p>}
      <form
        class="lab-nl-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <button type="button" class="lab-nl-round lab-nl-add" aria-label="Add files" onClick={onAdd}>
          <Icon name="plus" />
        </button>
        <textarea
          aria-label="Message"
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          placeholder="Message the agent"
          value={draft}
          onInput={(event) => onDraft((event.currentTarget as HTMLTextAreaElement).value)}
          onFocus={onFocus}
        />
        {running && empty ? (
          <button type="button" class="lab-nl-send stop" aria-label="Stop" onClick={onStop}>
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button type="submit" class="lab-nl-send" aria-label="Send" disabled={empty}>
            <Icon name="send" size={18} />
          </button>
        )}
      </form>
    </footer>
  );
}

/** The session's ⋯ sheet: what the old header carried (status, agent and model, folder) plus Changes. */
export function SessionDetailsBody({ status, onChanges, onClose }: { status: string; onChanges: () => void; onClose: () => void }) {
  return (
    <>
      <SheetHeader titleId="lab-details-title" title="Fix the failing parser test" subtitle="Mac mini · nano-remote" actionLabel="Done" onAction={onClose} />
      <ul class="lab-nl-group" aria-label="Session details">
        <li class="lab-nl-group-row">
          <Icon name={status === 'Running' ? 'spinner' : status === 'Finished' ? 'check' : 'question'} size={18} />
          <span>Status</span>
          <span class="lab-nl-value">{status}</span>
        </li>
        <li class="lab-nl-group-row">
          <Icon name="terminal" size={18} />
          <span>Agent</span>
          <span class="lab-nl-value">Codex</span>
        </li>
        <li class="lab-nl-group-row">
          <Icon name="gear" size={18} />
          <span>Model</span>
          <span class="lab-nl-value">gpt-5.5 · High</span>
        </li>
        <li class="lab-nl-group-row">
          <Icon name="folder" size={18} />
          <span>Folder</span>
          <span class="lab-nl-value">~/code/nano-remote</span>
        </li>
        <li>
          <button type="button" class="lab-nl-group-row" onClick={onChanges}>
            <Icon name="file-diff" size={18} />
            <span>Changes</span>
            <span class="lab-nl-value">3 files</span>
            <Icon name="chevron-right" size={16} class="lab-nl-chevron" />
          </button>
        </li>
      </ul>
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
