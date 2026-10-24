// The lab's session page: the real session page's layout and classes (header, transcript, composer) over
// fake data. A scripted first turn (user message, three tool rows, a streamed answer, then an approval
// card); each sent message starts a turn with a short streamed reply, the first of them ending in a question.
// Every technique switch changes only how these things move, never what they show. The Look switch (Now / New)
// changes how they look: New renders the pieces in NewLook.tsx in the same places, with the same motion hooks.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { BackHeader } from '../ui/BackHeader';
import { distanceFromBottom, BOTTOM_SLACK, Follower } from './autoscroll';
import { CrossFade, motionOf, Shell, useFlip } from './dom';
import { chunksOf, FakeStream } from './fake-stream';
import { ANSWER, APPROVAL, QUESTION, REPLY, TOOL_ROWS, USER_MESSAGE, type ToolRow } from './fixtures';
import { workedFor, type Look } from './look';
import { ChangesRow, NewApprovalCard, NewComposer, NewQuestionCard, NewSessionHeader, NewToolRow, PreviousToggle, WorkedFor, type ApprovalChoice } from './NewLook';
import { Icon } from './icons';
import { FrameLoop, FreshSegments, StreamPacer, type Segment } from './pacer';
import type { LabSettings } from './settings';

export interface LabSessionProps {
  settings: LabSettings;
  look: Look;
  reduced: boolean;
  onBack: () => void;
  onOpenChanges: () => void;
  /** New look: the header's ⋯ button. */
  onOpenDetails: () => void;
  /** New look: the composer's + button. */
  onOpenAdd: () => void;
  onHaptic: () => void;
  /** The session's state changed (the New look's details sheet shows it). */
  onStatus?: (task: string) => void;
}

interface LabTurn {
  id: string;
  user: string;
  /** Sent from the composer and not acknowledged yet (the real app dims it). */
  sending: boolean;
  /** Sent from the composer in this visit: gets the entrance. */
  sent: boolean;
  tools: readonly ToolRow[];
  answer: string;
  seed: number;
  thinkMs: number;
  done: boolean;
  changes: boolean;
  approval: 'none' | 'pending' | 'approved' | 'declined';
  /** The agent's question at the end of the turn: none, waiting, or the answer given. */
  question: 'none' | 'pending' | { answer: string };
  /** Stop was tapped while the turn ran (New look's composer). */
  stopped: boolean;
  startedAt: number;
  endedAt: number | null;
}

const FIRST_TURN: LabTurn = {
  id: 't1',
  user: USER_MESSAGE,
  sending: false,
  sent: false,
  tools: TOOL_ROWS,
  answer: ANSWER,
  seed: 7,
  thinkMs: 1200,
  done: false,
  changes: false,
  approval: 'none',
  question: 'none',
  stopped: false,
  startedAt: 0,
  endedAt: null,
};

/** The scripted first turn started a while before you opened the session ("Worked for 3m …"). */
const FIRST_TURN_AGE_MS = 3 * 60_000;

/** `/lab?speed=8` plays the fake stream eight times faster (the Playwright smoke uses it). */
const SPEED = Math.max(1, Number(new URLSearchParams(window.location.search).get('speed')) || 1);

const timers = { setTimeout: (cb: () => void, ms: number) => window.setTimeout(cb, ms / SPEED), clearTimeout: (h: unknown) => window.clearTimeout(h as number) };

export function LabSession({ settings, look, reduced, onBack, onOpenChanges, onOpenDetails, onOpenAdd, onHaptic, onStatus }: LabSessionProps) {
  const [turns, setTurns] = useState<LabTurn[]>(() => [{ ...FIRST_TURN, startedAt: Date.now() - FIRST_TURN_AGE_MS }]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const newLook = look === 'new';
  const [draft, setDraft] = useState('');
  const conv = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);

  const scrollSmooth = settings.scroll === 'smooth';
  const sendSmooth = settings.send === 'smooth' && !reduced;
  const expandSmooth = settings.expand === 'smooth' && !reduced;
  const keyboardSmooth = settings.keyboard === 'smooth';

  const flipExpand = useFlip(conv, expandSmooth);
  const flipSend = useFlip(conv, sendSmooth);

  // Auto-scroll. Now: today's rule (snap to the bottom on new content while within 48 px of it; the pill
  // appears at once). Smooth: Follower eases toward the bottom each frame and lets go on the first touch.
  const atBottom = useRef(true);
  const [awayNow, setAwayNow] = useState(false);
  const follower = useMemo(() => new Follower(), []);
  const [pill, setPill] = useState(false);
  const loop = useMemo(
    () =>
      new FrameLoop(
        () => {
          const el = conv.current;
          if (el === null) return;
          const next = follower.step(el);
          if (next !== undefined) el.scrollTop = next;
        },
        () => conv.current !== null && follower.following && distanceFromBottom(conv.current) > 0.5,
        (cb) => window.requestAnimationFrame(cb),
        (h) => window.cancelAnimationFrame(h),
      ),
    [follower],
  );
  useEffect(() => () => loop.stop(), [loop]);
  const pin = () => {
    const el = conv.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  };
  const updatePill = () => {
    const el = conv.current;
    if (el !== null) setPill(!follower.following && distanceFromBottom(el) > BOTTOM_SLACK);
  };

  useEffect(() => {
    const el = conv.current;
    const inner = content.current;
    if (el === null || inner === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const following = scrollSmooth ? follower.following : atBottom.current;
      // The visible area changed (the keyboard opened or closed): keep the latest message in view.
      if (keyboardSmooth && following && entries.some((e) => e.target === el)) pin();
      if (!entries.some((e) => e.target === inner)) return;
      if (scrollSmooth) loop.start();
      else if (atBottom.current) pin();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [scrollSmooth, keyboardSmooth, follower, loop]);

  const running = turns.some((t) => !t.done);
  const asking = turns.some((t) => t.question === 'pending');
  const status = running
    ? { label: 'Working', tone: 'busy' }
    : turns.some((t) => t.approval === 'pending')
      ? { label: 'Needs approval', tone: 'attention' }
      : asking
        ? { label: 'Needs your input', tone: 'attention' }
        : { label: 'Finished', tone: 'ok' };
  const task = status.tone === 'busy' ? 'Running' : status.label === 'Needs approval' ? 'Waiting for your approval' : asking ? 'Needs your input' : 'Finished';
  useEffect(() => onStatus?.(task), [task, onStatus]);

  const patch = (id: string, change: Partial<LabTurn>) => setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));

  // A turn ends: t1 asks for approval and shows its changes, the first sent turn asks a question, unless
  // Stop cut it short.
  const finished = (turn: LabTurn) => {
    flipExpand(() =>
      setTurns((list) =>
        list.map((t) => {
          if (t.id !== turn.id) return t;
          const asks = !t.stopped;
          return {
            ...t,
            done: true,
            endedAt: Date.now(),
            changes: t.id === 't1' && asks,
            approval: t.id === 't1' && asks ? 'pending' : 'none',
            question: t.id === 'sent-1' && asks ? 'pending' : 'none',
          };
        }),
      ),
    );
  };

  const answer = (turn: LabTurn, choice: ApprovalChoice) => {
    const approved = choice === 'accept' || choice === 'session';
    if (approved) onHaptic();
    flipExpand(() => patch(turn.id, { approval: approved ? 'approved' : 'declined' }));
  };

  const reply = (turn: LabTurn, text: string) => {
    onHaptic();
    flipExpand(() => patch(turn.id, { question: { answer: text } }));
  };

  const stop = () => setTurns((list) => list.map((t) => (t.done ? t : { ...t, stopped: true })));

  // New look: a finished turn's work folds behind "N previous messages"; these turns are unfolded.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggleWork = (id: string) => flipExpand(() => setUnfolded((set) => (set.has(id) ? new Set([...set].filter((k) => k !== id)) : new Set([...set, id]))));

  const toggleTool = (key: string) => {
    const remove = () => setExpanded((set) => new Set([...set].filter((k) => k !== key)));
    if (!expanded.has(key)) {
      flipExpand(() => setExpanded((set) => new Set([...set, key])));
      return;
    }
    const body = expandSmooth ? conv.current?.querySelector<HTMLElement>(`[data-body="${key}"]`) : null;
    if (body === null || body === undefined) {
      remove();
      return;
    }
    const m = motionOf(body);
    const fade = body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: m.fast, easing: m.standard, fill: 'forwards' });
    fade.onfinish = () => flipExpand(remove);
  };

  const sendCount = useRef(0);
  const pinAfterRender = useRef(false);
  useLayoutEffect(() => {
    if (!pinAfterRender.current) return;
    pinAfterRender.current = false;
    pin();
  });
  const send = () => {
    const text = draft.trim();
    if (text === '') return;
    onHaptic();
    sendCount.current += 1;
    const turn: LabTurn = {
      id: `sent-${sendCount.current}`,
      user: text,
      sending: true,
      sent: true,
      tools: [],
      answer: REPLY,
      seed: 11 + sendCount.current,
      thinkMs: 1400,
      done: false,
      changes: false,
      approval: 'none',
      question: 'none',
      stopped: false,
      startedAt: Date.now(),
      endedAt: null,
    };
    const apply = () => {
      setTurns((list) => [...list, turn]);
      setDraft('');
    };
    if (sendSmooth) {
      // One frame: the bubble enters, the composer clears, older content glides up instead of jumping.
      flipSend(apply, {
        enter: false,
        beforePlay: () => {
          follower.jump();
          pin();
        },
      });
    } else {
      atBottom.current = true;
      follower.jump();
      pinAfterRender.current = true;
      apply();
    }
    window.setTimeout(() => patch(turn.id, { sending: false }), 500);
  };

  const pinOnFocus = () => keyboardSmooth && window.setTimeout(() => (scrollSmooth ? follower.following : atBottom.current) && pin(), 350);

  return (
    <main class="screen session-screen lab-session">
      {newLook ? (
        <NewSessionHeader title="Fix the failing parser test" subtitle="Mac mini · nano-remote" onBack={onBack} onMore={onOpenDetails} />
      ) : (
        <>
          <BackHeader href="/lab" label="Sessions" onBack={onBack}>
            <div class="topbar-end">
              <span class={`pill ${status.tone}`} aria-label="Session status">
                <CrossFade value={status.label} smooth={settings.list === 'smooth' && !reduced} render={(v) => v} />
              </span>
            </div>
          </BackHeader>
          <div class="session-head">
            <h1 class="session-heading">Fix the failing parser test</h1>
            <p class={`task-state small ${status.tone}`} aria-label="Task state">
              <span class="dot" aria-hidden="true" />
              <CrossFade value={task} smooth={settings.list === 'smooth' && !reduced} render={(v) => v} />
            </p>
            <p class="muted small">
              Codex · <code>nano-remote</code>
            </p>
          </div>
        </>
      )}

      <section
        class="conversation"
        aria-label="Conversation"
        ref={conv}
        onScroll={(event) => {
          const el = event.currentTarget as HTMLElement;
          if (scrollSmooth) {
            follower.onScroll(el);
            updatePill();
          } else {
            atBottom.current = distanceFromBottom(el) <= BOTTOM_SLACK;
            setAwayNow(!atBottom.current);
          }
        }}
        onTouchStart={() => scrollSmooth && follower.hold()}
        onTouchEnd={() => {
          if (!scrollSmooth || conv.current === null) return;
          follower.release(conv.current);
          updatePill();
          loop.start();
        }}
      >
        <div ref={content}>
          <ol class="turns" aria-label="Turns">
            {turns.map((turn) => (
              <Turn
                key={turn.id}
                turn={turn}
                settings={settings}
                newLook={newLook}
                reduced={reduced}
                expanded={expanded}
                unfolded={unfolded.has(turn.id)}
                onToggle={toggleTool}
                onToggleWork={() => toggleWork(turn.id)}
                onDone={() => finished(turn)}
                onAnswer={(choice) => answer(turn, choice)}
                onReply={(text) => reply(turn, text)}
                onOpenChanges={onOpenChanges}
              />
            ))}
          </ol>
        </div>
      </section>

      {scrollSmooth ? (
        <button
          type="button"
          class={`jump-pill lab-jump${pill ? ' shown' : ''}`}
          aria-hidden={!pill}
          tabIndex={pill ? 0 : -1}
          onClick={() => {
            follower.jump();
            setPill(false);
            loop.start();
          }}
        >
          {newLook ? <Icon name="arrow-down" size={18} /> : 'Jump to latest ↓'}
          {newLook && <span class="lab-nl-sr">Jump to latest</span>}
        </button>
      ) : (
        awayNow && (
          <button
            type="button"
            class="jump-pill"
            onClick={() => {
              atBottom.current = true;
              setAwayNow(false);
              pin();
            }}
          >
            {newLook ? <Icon name="arrow-down" size={18} /> : 'Jump to latest ↓'}
            {newLook && <span class="lab-nl-sr">Jump to latest</span>}
          </button>
        )
      )}

      {newLook ? (
        <NewComposer draft={draft} running={running} onDraft={setDraft} onSend={send} onStop={stop} onAdd={onOpenAdd} onFocus={pinOnFocus} />
      ) : (
      <footer class="composer">
        <form
          class="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            aria-label="Message"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="Message the agent…"
            value={draft}
            onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
            onFocus={pinOnFocus}
          />
          <div class="composer-actions">
            <button type="submit" class="primary" disabled={draft.trim() === ''}>
              Send
            </button>
          </div>
        </form>
      </footer>
      )}
    </main>
  );
}

interface TurnProps {
  turn: LabTurn;
  settings: LabSettings;
  newLook: boolean;
  reduced: boolean;
  expanded: ReadonlySet<string>;
  /** New look: the finished turn's work is shown, not folded. */
  unfolded: boolean;
  onToggle: (key: string) => void;
  onToggleWork: () => void;
  onDone: () => void;
  onAnswer: (choice: ApprovalChoice) => void;
  onReply: (answer: string) => void;
  onOpenChanges: () => void;
}

function Turn({ turn, settings, newLook, reduced, expanded, unfolded, onToggle, onToggleWork, onDone, onAnswer, onReply, onOpenChanges }: TurnProps) {
  const sendSmooth = settings.send === 'smooth' && !reduced;
  const expandSmooth = settings.expand === 'smooth' && !reduced;
  const shelled = settings.expand === 'smooth';
  const folded = newLook && turn.done && turn.tools.length > 0 && !unfolded;
  const tools = folded
    ? null
    : turn.tools.map((tool) => {
        const key = `${turn.id}/${tool.id}`;
        const open = expanded.has(key);
        if (newLook) return <NewToolRow key={tool.id} tool={tool} flipKey={key} open={open} reveal={expandSmooth} onToggle={() => onToggle(key)} />;
        return (
          <div key={tool.id} class={`item command lab-tool${shelled ? ' lab-shelled' : ''}`} data-flip-key={key} data-shell-key={key}>
            {shelled && <Shell />}
            <button type="button" class="lab-tool-toggle" aria-expanded={open} onClick={() => onToggle(key)}>
              <span class="item-line">
                <span class={`state small ${tool.tone}`}>{tool.state}</span>
                <code class="summary">{tool.summary}</code>
                <span class="lab-chevron muted" aria-hidden="true">
                  {open ? '▾' : '›'}
                </span>
              </span>
            </button>
            {open && (
              <pre class={expandSmooth ? 'lab-reveal' : undefined} data-body={key}>
                {tool.output}
              </pre>
            )}
          </div>
        );
      });
  const question = turn.question === 'none' ? null : turn.question === 'pending' ? null : turn.question.answer;
  return (
    <li class={`turn ${turn.done ? 'completed' : 'running'}${turn.sending && !sendSmooth ? ' sending' : ''}`}>
      <div class={`item-row user${turn.sent && sendSmooth ? ' lab-enter' : ''}`} data-flip-key={`${turn.id}/user`}>
        <div class="msg user">
          <p>{turn.user}</p>
        </div>
      </div>
      {newLook && turn.done && turn.tools.length > 0 && <PreviousToggle count={turn.tools.length} open={unfolded} flipKey={`${turn.id}/previous`} onToggle={onToggleWork} />}
      {tools}
      {newLook && turn.done && turn.endedAt !== null && <WorkedFor label={workedFor(turn.endedAt - turn.startedAt, turn.stopped ? 'Stopped after' : undefined)} flipKey={`${turn.id}/worked`} />}
      <StreamingAnswer turn={turn} newLook={newLook} smooth={settings.stream === 'smooth'} reduced={reduced} onDone={onDone} />
      {turn.changes &&
        (newLook ? (
          <ChangesRow reveal={expandSmooth} flipKey={`${turn.id}/changes`} onOpen={onOpenChanges} />
        ) : (
          <button type="button" class={`link small turn-changes${expandSmooth ? ' lab-reveal' : ''}`} data-flip-key={`${turn.id}/changes`} onClick={onOpenChanges}>
            3 files changed ›
          </button>
        ))}
      {turn.approval !== 'none' &&
        (newLook ? (
          <NewApprovalCard key="approval" flipKey={`${turn.id}/approval`} state={turn.approval} shelled={shelled} animate={expandSmooth} onAnswer={onAnswer} />
        ) : (
          <ApprovalCard key="approval" turnId={turn.id} state={turn.approval} shelled={shelled} animate={expandSmooth} onAnswer={(ok) => onAnswer(ok ? 'accept' : 'decline')} />
        ))}
      {turn.question !== 'none' &&
        (newLook ? (
          <NewQuestionCard key="question" flipKey={`${turn.id}/question`} answer={question} shelled={shelled} animate={expandSmooth} onAnswer={onReply} />
        ) : (
          <QuestionCard key="question" turnId={turn.id} answer={question} shelled={shelled} animate={expandSmooth} onAnswer={onReply} />
        ))}
    </li>
  );
}

/** Today's question card (real classes .request-card.question, .question-field, .option). */
function QuestionCard({ turnId, answer, shelled, animate, onAnswer }: { turnId: string; answer: string | null; shelled: boolean; animate: boolean; onAnswer: (answer: string) => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  const key = `${turnId}/question`;
  if (answer !== null) {
    return (
      <section class={`request-card lab-answered${shelled ? ' lab-shelled' : ''}`} data-flip-key={key} data-shell-key={key} aria-label="Question answered">
        {shelled && <Shell />}
        <p class={`small${animate ? ' lab-reveal' : ''}`}>
          <strong>✓ Answered</strong> {answer}
        </p>
      </section>
    );
  }
  return (
    <section class={`request-card question${shelled ? ' lab-shelled' : ''}`} role="group" aria-label={`Question: ${QUESTION.title}`} data-flip-key={key} data-shell-key={key}>
      {shelled && <Shell />}
      <fieldset class="question-field">
        <legend>
          <span class="question-text">{QUESTION.title}</span>
        </legend>
        <ul class="question-options">
          {QUESTION.options.map((option) => (
            <li key={option.label}>
              <label class={`option${choice === option.label ? ' selected' : ''}`}>
                <input type="radio" name="lab-question-now" checked={choice === option.label} onChange={() => setChoice(option.label)} />
                <span>
                  <span class="option-label">{option.label}</span>
                  <span class="option-description small muted">{option.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div class="actions">
        <button type="button" class="primary" disabled={choice === null} onClick={() => choice !== null && onAnswer(choice)}>
          Send answer
        </button>
      </div>
    </section>
  );
}

function ApprovalCard({
  turnId,
  state,
  shelled,
  animate,
  onAnswer,
}: {
  turnId: string;
  state: 'pending' | 'approved' | 'declined';
  shelled: boolean;
  animate: boolean;
  onAnswer: (approved: boolean) => void;
}) {
  const key = `${turnId}/approval`;
  if (state !== 'pending') {
    return (
      <section class={`request-card lab-answered${shelled ? ' lab-shelled' : ''}`} data-flip-key={key} data-shell-key={key} aria-label="Approval answered">
        {shelled && <Shell />}
        <p class={`small${animate ? ' lab-reveal' : ''}`}>
          <strong>{state === 'approved' ? '✓ Approved' : '✕ Declined'}</strong> <code>{APPROVAL.command}</code>
        </p>
      </section>
    );
  }
  return (
    <section class={`request-card approval${shelled ? ' lab-shelled' : ''}`} role="group" aria-label={`Approval: ${APPROVAL.title}`} data-flip-key={key} data-shell-key={key}>
      {shelled && <Shell />}
      <h2 class="request-title">{APPROVAL.title}</h2>
      <pre class="request-command">{APPROVAL.command}</pre>
      <p class="muted small request-cwd">
        in <code>{APPROVAL.cwd}</code>
      </p>
      <p class="small">{APPROVAL.reason}</p>
      <div class="actions">
        <button type="button" class="primary" onClick={() => onAnswer(true)}>
          Accept
        </button>
        <button type="button" onClick={() => onAnswer(false)}>
          Decline
        </button>
      </div>
    </section>
  );
}

/**
 * The answer as it streams. Now: each chunk is shown the moment it arrives, under a "Working…" line.
 * Smooth: chunks go through the pacer and fade in; until the first words arrive a shimmering "Thinking"
 * holds the answer's place.
 */
function StreamingAnswer({ turn, newLook, smooth, reduced, onDone }: { turn: LabTurn; newLook: boolean; smooth: boolean; reduced: boolean; onDone: () => void }) {
  const [text, setText] = useState(turn.done ? turn.answer : '');
  const [view, setView] = useState<{ settled: string; fresh: Segment[] }>({ settled: turn.done ? turn.answer : '', fresh: [] });
  const [finished, setFinished] = useState(turn.done);
  const done = useRef(onDone);
  done.current = onDone;
  /** Ends the stream where it is (Stop); set while the stream runs. */
  const cut = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (turn.done || turn.sending) return;
    const pacer = new StreamPacer();
    const segments = new FreshSegments();
    let streamDone = false;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      setFinished(true);
      done.current();
    };
    const loop = new FrameLoop(
      (dt) => {
        pacer.tick(dt);
        segments.update(pacer.text, performance.now());
        setView({ settled: segments.settled, fresh: [...segments.fresh] });
        if (streamDone && pacer.backlog === 0) end();
      },
      () => pacer.backlog > 0 || segments.fresh.length > 0,
      (cb) => window.requestAnimationFrame(cb),
      (h) => window.cancelAnimationFrame(h),
    );
    const stream = new FakeStream(
      chunksOf(turn.answer, turn.seed),
      (chunk) => {
        if (!smooth) {
          setText((t) => t + chunk);
          return;
        }
        pacer.push(chunk);
        if (reduced) pacer.flush();
        loop.start();
      },
      () => {
        streamDone = true;
        if (!smooth || pacer.backlog === 0) end();
      },
      timers,
    );
    const think = window.setTimeout(() => stream.start(), turn.thinkMs / SPEED);
    cut.current = () => {
      window.clearTimeout(think);
      stream.stop();
      loop.stop();
      pacer.flush();
      setView({ settled: pacer.text, fresh: [] });
      end();
    };
    return () => {
      cut.current = null;
      window.clearTimeout(think);
      stream.stop();
      loop.stop();
    };
    // a turn streams once; switching the technique mid-stream takes effect on the next replay
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn.sending]);

  useEffect(() => {
    if (turn.stopped) cut.current?.();
  }, [turn.stopped]);

  if (!smooth) {
    return (
      <>
        {text !== '' && (
          <div class="msg agent" data-flip-key={`${turn.id}/answer`}>
            <p>{text}</p>
          </div>
        )}
        {!finished &&
          (newLook ? (
            <p class="turn-state small lab-nl-thinking" data-flip-key={`${turn.id}/state`}>
              Thinking
            </p>
          ) : (
            <p class="turn-state small busy" data-flip-key={`${turn.id}/state`}>
              Working…
            </p>
          ))}
      </>
    );
  }
  const empty = view.settled === '' && view.fresh.length === 0;
  if (empty && finished) return null; // stopped before the first words
  if (empty && !finished) {
    return (
      <p class="turn-state small lab-thinking" data-flip-key={`${turn.id}/answer`}>
        Thinking
      </p>
    );
  }
  return (
    <div class="msg agent" data-flip-key={`${turn.id}/answer`}>
      <p>
        {view.settled}
        {view.fresh.map((s) => (
          <span key={s.start} class="lab-fresh">
            {s.text}
          </span>
        ))}
      </p>
    </div>
  );
}
