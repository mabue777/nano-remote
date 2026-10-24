// The interaction lab at /lab: a mini copy of the app (session list -> session -> sheets, plus the
// composer) on fake data, with a floating "Lab" button that opens one Now/Smooth switch per technique. Now
// is today's behaviour; Smooth is the proposal. Nothing here touches the host or the real screens; the
// router loads this file only for /lab. Motion values live in lab.css as custom properties. A "Look" switch at
// the top of the panel shows the same mini app in today's look (Now) or the redesign (New, NewLook.tsx and
// new-look.css, scoped under data-look="new"); it combines freely with every technique switch. Since look
// adoption step 1 the app's tokens are the New look's; now-look.css restores the earlier ones for Now.
import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { defaultStorage, type StorageLike } from '../replica/storage';
import { lockAxis, settleDuration, shouldComplete, VelocityTracker } from '../ui/motion/gesture';
import { hapticTick } from '../ui/motion/haptic';
import { SheetHeader } from '../ui/Sheet';
import { CrossFade, motionOf, reducedMotion, useDrag, useFlip } from './dom';
import { ACTIVITY, CHANGES, DIFF_LINES, SESSIONS, type LabSession as Session } from './fixtures';
import { drop, withLeaving, type Shown } from './flip';
import { LabSession } from './LabSession';
import { LabSheet } from './LabSheet';
import { ALL_HOSTS, hostsOf, loadLook, onHost, saveLook, type Look } from './look';
import { AddBody, NewList, SessionDetailsBody } from './NewLook';
import { allAt, loadSettings, saveSettings, TECHNIQUES, type LabSettings, type Mode, type TechniqueId } from './settings';
import { watchViewport } from './viewport';
import './lab.css';
import './new-look.css';
import './now-look.css';

type View = 'list' | 'session';
type SheetName = 'changes' | 'new' | 'details' | 'add' | null;

const keyOf = (s: Session) => s.id;
/** A back swipe starts this close to the left edge (px). */
const EDGE = 24;

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<void> } };

export function Lab({ storage = defaultStorage() }: { storage?: StorageLike | null }) {
  const [settings, setSettings] = useState<LabSettings>(() => loadSettings(storage));
  const [look, setLook] = useState<Look>(() => loadLook(storage));
  const [host, setHost] = useState(ALL_HOSTS);
  const [task, setTask] = useState('Running');
  const onStatus = useCallback((next: string) => setTask(next), []);
  const [reduced] = useState(reducedMotion);
  const [view, setView] = useState<View>('list');
  const [sheet, setSheet] = useState<SheetName>(null);
  const [panel, setPanel] = useState(false);
  const [replay, setReplay] = useState(0);
  const [sessions, setSessions] = useState<Shown<Session>[]>(() => SESSIONS.map((item) => ({ item, leaving: false })));
  const [peek, setPeek] = useState(false);
  const [sliding, setSliding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const listPage = useRef<HTMLDivElement>(null);
  const sessionPage = useRef<HTMLDivElement>(null);

  const set = (next: LabSettings) => {
    setSettings(next);
    saveSettings(storage, next);
  };
  const choose = (id: TechniqueId, mode: Mode) => set({ ...settings, [id]: mode });
  const chooseLook = (next: Look) => {
    setLook(next);
    saveLook(storage, next);
  };

  const pageSmooth = settings.page === 'smooth';
  const animatePages = pageSmooth && !reduced;
  const keyboardSmooth = settings.keyboard === 'smooth';
  const staged = pageSmooth || keyboardSmooth;

  // 1. Press feedback: iOS Safari shows :active only when a touchstart listener exists on the page.
  useEffect(() => {
    if (settings.press !== 'smooth') return;
    const noop = () => undefined;
    document.addEventListener('touchstart', noop, { passive: true });
    return () => document.removeEventListener('touchstart', noop);
  }, [settings.press]);

  // 7. Keyboard: the stage takes the visible area above the keyboard and stays in it while iOS scrolls.
  useEffect(() => {
    const el = stage.current;
    if (!keyboardSmooth || el === null) return;
    return watchViewport(window, (box) => {
      el.style.setProperty('--lab-vvh', `${box.height}px`);
      el.style.setProperty('--lab-vvtop', `${box.offsetTop}px`);
    });
  }, [keyboardSmooth, staged]);

  // 2. Page push and pop.
  const rendered = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    rendered.current?.();
    rendered.current = null;
  }, [view]);
  const enterFallback = useRef(false);
  useLayoutEffect(() => {
    if (view !== 'session' || !enterFallback.current || sessionPage.current === null) return;
    enterFallback.current = false;
    const m = motionOf(root.current);
    const a = sessionPage.current.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: m.relaxed, easing: m.enter });
    listPage.current?.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-30%)' }], { duration: m.relaxed, easing: m.enter });
    a.onfinish = () => setSliding(false);
  }, [view]);

  const slideBack = (from: number, velocity: number) => {
    const page = sessionPage.current;
    const width = page?.offsetWidth ?? window.innerWidth;
    if (page === null || reduced) {
      setView('list');
      return;
    }
    setSliding(true);
    const m = motionOf(root.current);
    const duration = settleDuration(width - from, velocity, 150, m.relaxed);
    const easing = velocity > 0.3 ? 'cubic-bezier(0.2, 0.6, 0.35, 1)' : m.standard;
    const a = page.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${width}px)` }], { duration, easing, fill: 'forwards' });
    listPage.current?.animate([{ transform: `translateX(${-0.3 * width * (1 - from / width)}px)` }, { transform: 'translateX(0)' }], { duration, easing });
    a.onfinish = () => {
      setView('list');
      setSliding(false);
      setPeek(false);
    };
  };

  const navigate = (next: View) => {
    if (next === view) return;
    if (!animatePages) {
      setView(next);
      return;
    }
    const doc = document as ViewTransitionDocument;
    if (typeof doc.startViewTransition === 'function') {
      const html = document.documentElement;
      html.dataset.labNav = next === 'session' ? 'push' : 'pop';
      const transition = doc.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            rendered.current = resolve;
            setView(next);
          }),
      );
      void transition.finished.finally(() => delete html.dataset.labNav);
      return;
    }
    // No View Transitions (Safari before 18): slide with the Web Animations API.
    if (next === 'session') {
      enterFallback.current = true;
      setSliding(true);
      setView('session');
    } else slideBack(0, 0);
  };

  // Edge swipe back: the session page follows the finger, the list shows underneath.
  const swipe = useRef({ x: 0, y: 0, dx: 0, phase: 'ignore' as 'pending' | 'drag' | 'ignore' });
  const tracker = useRef(new VelocityTracker());
  useDrag(sessionPage, pageSmooth && view === 'session', {
    start(x, y, _target, time) {
      if (x > EDGE || sheet !== null) return false;
      swipe.current = { x, y, dx: 0, phase: 'pending' };
      tracker.current.reset();
      tracker.current.add(time, x);
      return true;
    },
    move(x, y, time) {
      const state = swipe.current;
      if (state.phase === 'ignore') return false;
      if (state.phase === 'pending') {
        const axis = lockAxis(x - state.x, y - state.y);
        if (axis === undefined) return false;
        if (axis === 'y') {
          state.phase = 'ignore';
          return false;
        }
        state.phase = 'drag';
        setPeek(true);
      }
      const page = sessionPage.current!;
      const width = page.offsetWidth || 1;
      const dx = Math.max(0, x - state.x);
      state.dx = dx;
      page.style.transform = `translateX(${dx}px)`;
      if (listPage.current !== null) listPage.current.style.transform = `translateX(${-0.3 * width * (1 - dx / width)}px)`;
      tracker.current.add(time, x);
      return true;
    },
    end(cancelled) {
      const state = swipe.current;
      const dragged = state.phase === 'drag';
      state.phase = 'ignore';
      if (!dragged) return;
      const page = sessionPage.current!;
      const width = page.offsetWidth || 1;
      const velocity = cancelled ? 0 : tracker.current.velocity();
      page.style.transform = '';
      if (listPage.current !== null) listPage.current.style.transform = '';
      if (!cancelled && shouldComplete(state.dx, velocity, width, { distanceRatio: 0.4, flickVelocity: 0.35 })) {
        slideBack(state.dx, velocity);
        return;
      }
      if (reduced) {
        setPeek(false);
        return;
      }
      const m = motionOf(root.current);
      const duration = settleDuration(state.dx, -velocity, 150, m.relaxed);
      page.animate([{ transform: `translateX(${state.dx}px)` }, { transform: 'translateX(0)' }], { duration, easing: m.standard });
      const a = listPage.current?.animate([{ transform: `translateX(${-0.3 * width * (1 - state.dx / width)}px)` }, { transform: `translateX(${-0.3 * width}px)` }], { duration, easing: m.standard });
      if (a === undefined) setPeek(false);
      else a.onfinish = () => setPeek(false);
    },
  });

  // 8. List changes.
  const listRef = useRef<HTMLUListElement>(null);
  const listSmooth = settings.list === 'smooth' && !reduced;
  const flipList = useFlip(listRef, listSmooth);
  const step = useRef(0);
  const simulate = () => {
    const current = sessions.filter((s) => !s.leaving).map((s) => s.item);
    const next = ACTIVITY[step.current % ACTIVITY.length]!(current);
    step.current += 1;
    flipList(() => setSessions((prev) => (listSmooth ? withLeaving(prev, next, keyOf) : next.map((item) => ({ item, leaving: false })))));
  };
  const dropRow = (id: string) => flipList(() => setSessions((prev) => drop(prev, id, keyOf)));

  const haptic = () => {
    if (settings.haptic === 'smooth') hapticTick(document);
  };

  const sheetSmooth = settings.sheet === 'smooth';
  const listVisible = view === 'list' || (pageSmooth && (peek || sliding));
  const listNode =
    look === 'new' ? (
      <NewList
        sessions={onHost(sessions, host, (s) => s.item.host)}
        hosts={hostsOf(SESSIONS)}
        host={host}
        listRef={listRef}
        smooth={listSmooth}
        onHost={(next) => flipList(() => setHost(next))}
        onOpen={() => navigate('session')}
        onNew={() => setSheet('new')}
        onSimulate={simulate}
        onDropped={dropRow}
      />
    ) : (
      <LabList
        sessions={sessions}
        listRef={listRef}
        smooth={listSmooth}
        onOpen={() => navigate('session')}
        onNew={() => setSheet('new')}
        onSimulate={simulate}
        onDropped={dropRow}
      />
    );
  const sessionNode = (
    <LabSession
      key={`${replay}-${settings.stream}`}
      settings={settings}
      look={look}
      reduced={reduced}
      onBack={() => navigate('list')}
      onOpenChanges={() => setSheet('changes')}
      onOpenDetails={() => setSheet('details')}
      onOpenAdd={() => setSheet('add')}
      onHaptic={haptic}
      onStatus={onStatus}
    />
  );

  return (
    <div class="lab" ref={root} data-look={look} {...Object.fromEntries(TECHNIQUES.map((t) => [`data-${t.id}`, settings[t.id]]))}>
      {staged ? (
        <div class={`lab-stage${keyboardSmooth ? ' lab-keyboard' : ''}`} ref={stage}>
          {(pageSmooth || view === 'list') && (
            <div class="lab-page lab-list-page" ref={listPage} hidden={!listVisible} data-under={view === 'session' ? 'true' : undefined}>
              {listNode}
            </div>
          )}
          {view === 'session' && (
            <div class="lab-page lab-session-page" ref={sessionPage}>
              {sessionNode}
            </div>
          )}
        </div>
      ) : view === 'list' ? (
        listNode
      ) : (
        sessionNode
      )}

      {sheet === 'changes' && (
        <LabSheet smooth={sheetSmooth} reduced={reduced} labelledBy="lab-changes-title" class="lab-changes-sheet" onClosed={() => setSheet(null)}>
          {(close) => <ChangesBody onClose={close} />}
        </LabSheet>
      )}
      {sheet === 'new' && (
        <LabSheet smooth={sheetSmooth} reduced={reduced} labelledBy="lab-new-title" onClosed={() => setSheet(null)}>
          {(close) => <NewSessionBody onClose={close} />}
        </LabSheet>
      )}
      {sheet === 'details' && (
        <LabSheet smooth={sheetSmooth} reduced={reduced} labelledBy="lab-details-title" onClosed={() => setSheet(null)}>
          {(close) => <SessionDetailsBody status={task} onChanges={() => setSheet('changes')} onClose={close} />}
        </LabSheet>
      )}
      {sheet === 'add' && (
        <LabSheet smooth={sheetSmooth} reduced={reduced} labelledBy="lab-add-title" onClosed={() => setSheet(null)}>
          {(close) => <AddBody onClose={close} />}
        </LabSheet>
      )}

      <button type="button" class="lab-fab" aria-haspopup="dialog" onClick={() => setPanel(true)}>
        Lab
      </button>
      {panel && (
        <LabPanel
          settings={settings}
          look={look}
          reduced={reduced}
          onLook={chooseLook}
          onChoose={choose}
          onAll={(mode) => set(allAt(mode))}
          onReplay={() => {
            setReplay((n) => n + 1);
            setPanel(false);
          }}
          onClose={() => setPanel(false)}
        />
      )}
    </div>
  );
}

interface LabListProps {
  sessions: Shown<Session>[];
  listRef: RefObject<HTMLUListElement>;
  smooth: boolean;
  onOpen: () => void;
  onNew: () => void;
  onSimulate: () => void;
  onDropped: (id: string) => void;
}

function LabList({ sessions, listRef, smooth, onOpen, onNew, onSimulate, onDropped }: LabListProps) {
  return (
    <main class="screen home lab-home">
      <header class="topbar">
        <h1>Nano Remote</h1>
        <span class="muted small">Interaction lab</span>
      </header>
      <section class="sessions" aria-labelledby="lab-sessions-title">
        <div class="section-head">
          <h2 id="lab-sessions-title">Sessions</h2>
          <div class="actions">
            <button type="button" class="ghost small" onClick={onSimulate}>
              Simulate activity
            </button>
            <button type="button" class="primary small" onClick={onNew}>
              New session
            </button>
          </div>
        </div>
        <ul class="session-list" aria-label="Sessions" ref={listRef}>
          {sessions.map(({ item, leaving }) => (
            <li
              key={item.id}
              class={`swipe-row${leaving ? ' lab-leaving' : ''}`}
              data-flip-key={leaving ? undefined : item.id}
              aria-hidden={leaving ? 'true' : undefined}
              onAnimationEnd={(event) => leaving && event.target === event.currentTarget && onDropped(item.id)}
            >
              <a
                class="session"
                href="/lab"
                onClick={(event) => {
                  event.preventDefault();
                  if (!leaving) onOpen();
                }}
              >
                <div class="session-top">
                  <span class="session-title">{item.title}</span>
                  {item.pending > 0 && (
                    <span class="badge" aria-label={`${item.pending} waiting for you`}>
                      {item.pending}
                    </span>
                  )}
                </div>
                <div class="session-meta small">
                  <CrossFade value={`${item.tone}|${item.status}`} smooth={smooth} render={(v) => <span class={`status ${v.split('|')[0]}`}>{v.split('|')[1]}</span>} />
                  <span class="muted">
                    {item.agent} · {item.folder} · {item.updated}
                  </span>
                </div>
                <p class="preview muted small">{item.preview}</p>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function ChangesBody({ onClose }: { onClose: () => void }) {
  return (
    <>
      <SheetHeader titleId="lab-changes-title" title="Changes" subtitle="3 files changed" actionLabel="Close" onAction={onClose} />
      <ul class="diff-files" aria-label="Changed files">
        {CHANGES.map((f) => (
          <li key={f.path}>
            <button type="button" class="diff-file-row">
              <span class={`file-kind ${f.kind === 'Added' ? 'added' : 'modified'}`}>{f.kind}</span>
              <code class="diff-path">{f.path}</code>
              <span class="diff-counts small">
                <span class="plus">+{f.added}</span> <span class="minus">−{f.removed}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <pre class="diff lab-diff" aria-label="Diff of src/parser.ts">
        {DIFF_LINES.map((line, i) => (
          <span key={i} class={`diff-line ${line.tone}`}>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </>
  );
}

function NewSessionBody({ onClose }: { onClose: () => void }) {
  const [agent, setAgent] = useState('Codex');
  return (
    <>
      <SheetHeader titleId="lab-new-title" title="New session" actionLabel="Cancel" onAction={onClose} />
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <fieldset class="field">
          <legend>Agent</legend>
          <div class="choices">
            {['Codex', 'Claude Code'].map((name) => (
              <button key={name} type="button" class={`choice${agent === name ? ' selected' : ''}`} aria-pressed={agent === name} onClick={() => setAgent(name)}>
                {name}
              </button>
            ))}
          </div>
        </fieldset>
        <label class="field">
          <span>Folder</span>
          <input value="~/code/nano-remote" readOnly />
        </label>
        <label class="field">
          <span>First message</span>
          <textarea rows={3} placeholder="What should the agent do?" />
        </label>
        <button type="submit" class="primary">
          Start session
        </button>
      </form>
    </>
  );
}

interface LabPanelProps {
  settings: LabSettings;
  look: Look;
  reduced: boolean;
  onLook: (look: Look) => void;
  onChoose: (id: TechniqueId, mode: Mode) => void;
  onAll: (mode: Mode) => void;
  onReplay: () => void;
  onClose: () => void;
}

/** The switches. Always plain (no motion), so the panel itself never colours the comparison. */
function LabPanel({ settings, look, reduced, onLook, onChoose, onAll, onReplay, onClose }: LabPanelProps) {
  return (
    <div class="sheet-backdrop lab-panel-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section class="sheet lab-panel" role="dialog" aria-modal="true" aria-labelledby="lab-panel-title">
        <SheetHeader titleId="lab-panel-title" title="Lab" subtitle="Now is today's app; Smooth is the proposal." actionLabel="Done" onAction={onClose} />
        {reduced && (
          <p class="small lab-note" role="note">
            Reduce Motion is on, so Smooth shows no animations. Turn it off in Settings › Accessibility › Motion to compare.
          </p>
        )}
        <div class="lab-technique lab-look" role="group" aria-label="Look">
          <div class="lab-technique-text">
            <strong>Look</strong>
            <span class="muted small">Now is today's design; New is the redesign. Works with every switch below.</span>
          </div>
          <div class="segmented lab-mode">
            {(['now', 'new'] as const).map((value) => (
              <button key={value} type="button" class={look === value ? 'selected' : undefined} aria-pressed={look === value} onClick={() => onLook(value)}>
                {value === 'now' ? 'Now' : 'New'}
              </button>
            ))}
          </div>
        </div>
        <div class="actions lab-panel-all">
          <button type="button" class="small" onClick={() => onAll('now')}>
            All Now
          </button>
          <button type="button" class="small" onClick={() => onAll('smooth')}>
            All Smooth
          </button>
          <button type="button" class="small ghost" onClick={onReplay}>
            Replay stream
          </button>
        </div>
        <ol class="lab-techniques">
          {TECHNIQUES.map((t, i) => (
            <li key={t.id} class="lab-technique" role="group" aria-label={t.name}>
              <div class="lab-technique-text">
                <strong>
                  {i + 1}. {t.name}
                </strong>
                <span class="muted small">{t.tryIt}</span>
              </div>
              <div class="segmented lab-mode">
                {(['now', 'smooth'] as const).map((mode) => (
                  <button key={mode} type="button" class={settings[t.id] === mode ? 'selected' : undefined} aria-pressed={settings[t.id] === mode} onClick={() => onChoose(t.id, mode)}>
                    {mode === 'now' ? 'Now' : 'Smooth'}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
