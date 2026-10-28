// The text file viewer, /s/<id>/file?path=<path>[&line=<n>] (docs/plan/file-viewer.md item P3): a page pushed
// over its session. The file name is the title, its folder the grey line under it. The text is SF Mono 13/18
// with a line-number gutter pinned at the left while long lines scroll sideways; wrap is a choice per kind
// (file-model.ts). The search button opens a find bar under the header; ⋯ opens a sheet with Wrap lines,
// Raw/Rendered for markdown, Copy all and Copy path. A file the host calls binary shows a card with its kind,
// size and Share. Rules and state live in FileViewerModel; this file renders, scrolls and measures.
//
// Windowing: the page scrolls the window (so the edge swipe and the status-bar tap work as on other pages);
// only the blocks of lines near the viewport are in the DOM, with spacers above and below whose heights come
// from each block's measured height, or an estimate before it was shown (file-model.ts visibleBlocks).
// Styles: files.css.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { StorageLike } from '../../../replica/storage';
import { GroupList, type GroupRow } from '../../../ui/GroupList';
import { Icon } from '../../../ui/Icon';
import { NavHeader } from '../../../ui/NavHeader';
import { Sheet, SheetHeader } from '../../../ui/Sheet';
import { prefersReducedMotion } from '../../../ui/motion/motion';
import { Markdown } from '../../chat/MarkdownView';
import { parseMarkdown } from '../../chat/markdown';
import { useModel } from '../../use-model';
import {
  BLOCK_LINES,
  blockCount,
  blockOf,
  estimateBlockHeight,
  fileName,
  fileUrl,
  FileViewerModel,
  folderOf,
  formatBytes,
  lineSegments,
  visibleBlocks,
  type FileInfo,
  type FileReader,
  type Match,
} from './file-model';
import './files.css';

/** --type-code's line height. */
const LINE_HEIGHT = 18;
/** How long a jumped-to line stays tinted (its fade is in files.css). */
const FLASH_MS = 1600;

export interface FileViewerProps {
  sessionId: string;
  path: string;
  line?: number;
  reader: FileReader;
  storage: StorageLike | null;
  /** The session folder's name, the grey line for a file at its top (it may arrive later: `subscribe`). */
  sessionFolder?: SessionFolder;
  onBack: () => void;
}

/** The session folder's name as the app knows it so far; the Replica's session list fits. */
export interface SessionFolder {
  name(): string | undefined;
  subscribe(listener: () => void): () => void;
}

function useFolderName(source: SessionFolder | undefined): string | undefined {
  const [name, setName] = useState(() => source?.name());
  useEffect(() => {
    if (source === undefined) return;
    setName(source.name());
    return source.subscribe(() => setName(source.name()));
  }, [source]);
  return name;
}

export function FileViewer({ sessionId, path, line, reader, storage, sessionFolder, onBack }: FileViewerProps) {
  const folderName = useFolderName(sessionFolder);
  const model = useMemo(
    () => new FileViewerModel({ sessionId, path, ...(line !== undefined ? { line } : {}), reader, storage }),
    // A new file is a new page (PageStack keys pages by path); the reader and storage never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, path, line],
  );
  useModel(model);
  useEffect(() => {
    void model.load();
    return () => model.dispose();
  }, [model]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  // Escape closes the top layer: the menu, then the find bar, then the page.
  const layers = useRef({ menuOpen, findOpen: model.findOpen });
  layers.current = { menuOpen, findOpen: model.findOpen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (layers.current.menuOpen) setMenuOpen(false);
      else if (layers.current.findOpen) model.closeFind();
      else onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model, onBack]);

  const state = model.state;
  const info = state.state === 'text' || state.state === 'binary' ? state.info : undefined;
  const shownPath = info?.path ?? model.path;
  const folder = folderOf(shownPath);
  const copy = async (text: string, done: string) => {
    setMenuOpen(false);
    try {
      await navigator.clipboard.writeText(text);
      setToast(done);
    } catch {
      setToast("Couldn't copy");
    }
  };

  const findButton =
    state.state === 'text' ? (
      <button
        type="button"
        class="round-button"
        aria-label="Find in file"
        aria-pressed={model.findOpen}
        onClick={() => (model.findOpen ? model.closeFind() : model.openFind())}
      >
        <Icon name="search" size={20} />
      </button>
    ) : undefined;

  return (
    <main class={`screen file-viewer${model.wrap ? ' wrapped' : ''}`} data-kind={model.kind}>
      <div class="file-top">
        <NavHeader
          href={`/s/${encodeURIComponent(sessionId)}`}
          backLabel="Session"
          onBack={onBack}
          title={fileName(shownPath)}
          moreLabel="File actions"
          onMore={() => setMenuOpen(true)}
          actions={findButton}
        >
          <span class="file-folder">{folder === '' ? (folderName ?? 'Session folder') : folder}</span>
        </NavHeader>
        {model.findOpen && state.state === 'text' && <FindBar model={model} />}
      </div>
      {state.state === 'loading' && <p class="file-status muted">Loading…</p>}
      {state.state === 'error' && (
        <div class="file-status" role="alert">
          <p class="error">{state.message}</p>
          {!state.missing && (
            <button type="button" onClick={() => void model.load()}>
              Try again
            </button>
          )}
        </div>
      )}
      {state.state === 'binary' && <BinaryCard sessionId={sessionId} info={state.info} kindLabel={state.kindLabel} />}
      {state.state === 'text' && (model.rendered ? <RenderedMarkdown text={model.loadedText} /> : <TextLines model={model} />)}
      {state.state === 'text' && <MoreFooter model={model} info={state.info} />}
      {menuOpen && (
        <FileMenu
          model={model}
          name={fileName(shownPath)}
          path={shownPath}
          text={state.state === 'text'}
          onCopyAll={() => void copy(model.loadedText, model.hasMore ? 'Copied the part shown' : 'Copied')}
          onCopyPath={() => void copy(shownPath, 'Path copied')}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {toast !== null && (
        <p class="toast file-toast" role="status">
          {toast}
        </p>
      )}
    </main>
  );
}

// ---- the text -----------------------------------------------------------------------------------------

function RenderedMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <article class="file-markdown" aria-label="Rendered markdown">
      <Markdown blocks={blocks} />
    </article>
  );
}

interface Viewport {
  top: number;
  bottom: number;
}

/** The lines, windowed: only the blocks near the viewport are rendered. */
function TextLines({ model }: { model: FileViewerModel }) {
  const lines = model.lines;
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, bottom: typeof window === 'undefined' ? 900 : window.innerHeight });
  const [columns, setColumns] = useState(40);
  const [, setMeasured] = useState(0);
  const heights = useRef(new Map<number, number>());
  const layoutKey = `${model.wrap}:${columns}`;
  const keyRef = useRef(layoutKey);
  if (keyRef.current !== layoutKey) {
    keyRef.current = layoutKey;
    heights.current.clear();
  }
  const [flash, setFlash] = useState<{ line: number; token: number } | null>(null);
  const handled = useRef(0);

  // Where the viewport is, in the lines' own coordinates; on scroll and resize, once per frame.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = body.current;
      if (el === null) return;
      const top = el.getBoundingClientRect().top;
      setViewport((old) => {
        const next = { top: -top, bottom: window.innerHeight - top };
        return Math.abs(old.top - next.top) < 1 && Math.abs(old.bottom - next.bottom) < 1 ? old : next;
      });
      const width = scroller.current?.clientWidth ?? 0;
      const char = charWidth(el);
      setColumns(Math.max(10, Math.floor((width - gutterWidth(lines.length, char) - 2 * 20) / char)));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [lines.length, model.wrap]);

  const count = blockCount(lines.length);
  const layout = { wrap: model.wrap, columns, lineHeight: LINE_HEIGHT };
  const blockHeights: number[] = [];
  for (let b = 0; b < count; b += 1) blockHeights.push(heights.current.get(b) ?? estimateBlockHeight(lines, b, layout));
  const overscan = Math.max(600, viewport.bottom - viewport.top);
  const target = model.scrollTarget;
  // A scroll target outside the rendered blocks: render around it first, then scroll there exactly.
  let window_ = visibleBlocks(blockHeights, viewport.top, viewport.bottom, overscan);
  if (target !== undefined && target.token !== handled.current) {
    const block = blockOf(target.line);
    if (block < window_.first || block > window_.last) {
      const y = blockHeights.slice(0, block).reduce((a, b) => a + b, 0);
      window_ = visibleBlocks(blockHeights, y, y + (viewport.bottom - viewport.top), overscan);
    }
  }

  // Measure what was rendered; a changed height re-renders with the true spacers.
  useLayoutEffect(() => {
    const el = body.current;
    if (el === null) return;
    let changed = false;
    for (const child of el.querySelectorAll<HTMLElement>('[data-block]')) {
      const b = Number(child.dataset.block);
      const h = child.offsetHeight;
      if (h > 0 && Math.abs((heights.current.get(b) ?? -1) - h) > 0.5) {
        heights.current.set(b, h);
        changed = true;
      }
    }
    if (changed) setMeasured((n) => n + 1);
  });

  // Scroll to a line jump or the current match once it is rendered.
  useLayoutEffect(() => {
    if (target === undefined || target.token === handled.current) return;
    const current = model.matches[model.current];
    const hit: Match | undefined = !target.flash && current?.line === target.line ? current : undefined;
    const row = body.current?.querySelector<HTMLElement>(`[data-line="${target.line}"]`);
    if (row === null || row === undefined) return;
    handled.current = target.token;
    const reduced = prefersReducedMotion(window);
    const rect = row.getBoundingClientRect();
    const header = document.querySelector('.file-viewer .file-top')?.getBoundingClientRect().bottom ?? 0;
    const visible = rect.top >= header + LINE_HEIGHT && rect.bottom <= window.innerHeight - LINE_HEIGHT * 2;
    if (!visible || target.flash) {
      const room = window.innerHeight - header;
      window.scrollTo({ top: window.scrollY + rect.top - header - room / 3, behavior: reduced || target.flash ? 'auto' : 'smooth' });
    }
    const box = scroller.current;
    if (hit !== undefined && box !== null && !model.wrap) {
      const char = charWidth(row);
      const gutter = gutterWidth(lines.length, char);
      const left = gutter + hit.start * char;
      const right = gutter + hit.end * char;
      if (left - gutter < box.scrollLeft || right > box.scrollLeft + box.clientWidth - 20) box.scrollLeft = Math.max(0, left - gutter - box.clientWidth / 3);
    }
    if (target.flash) setFlash({ line: target.line, token: target.token });
  });

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash((f) => (f?.token === flash.token ? null : f)), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  // The longest line in characters (a tab counts as four), so sideways scrolling keeps one width.
  const longest = useMemo(() => lines.reduce((max, l) => Math.max(max, l.length + (l.split('\t').length - 1) * 3), 0), [lines]);
  if (lines.length === 0) return <p class="file-status muted">This file is empty.</p>;

  const digits = String(lines.length).length;
  const byLine = new Map<number, { start: number; end: number; current: boolean }[]>();
  if (model.findOpen) model.matches.forEach((m, i) => {
    if (blockOf(m.line) < window_.first || blockOf(m.line) > window_.last) return;
    const list = byLine.get(m.line) ?? [];
    list.push({ start: m.start, end: m.end, current: i === model.current });
    byLine.set(m.line, list);
  });

  const blocks = [];
  for (let b = window_.first; b <= window_.last; b += 1) {
    const rows = [];
    const end = Math.min(lines.length, (b + 1) * BLOCK_LINES);
    for (let i = b * BLOCK_LINES; i < end; i += 1) {
      rows.push(
        <div key={i} class={flash?.line === i ? 'file-line flash' : 'file-line'} data-line={i}>
          <span class="file-gutter" aria-hidden="true">
            {i + 1}
          </span>
          <span class="file-code">
            {lineSegments(lines[i]!, byLine.get(i) ?? []).map((segment, k) =>
              segment.mark === undefined ? (
                segment.text
              ) : (
                <mark key={k} class={segment.mark === 'current' ? 'find-hit current' : 'find-hit'}>
                  {segment.text}
                </mark>
              ),
            )}
            {'\n'}
          </span>
        </div>,
      );
    }
    blocks.push(
      <div key={b} data-block={b}>
        {rows}
      </div>,
    );
  }

  return (
    <div ref={scroller} class="file-text" style={{ '--gutter-digits': String(digits) }}>
      <div ref={body} class="file-lines" role="document" aria-label="File text" style={model.wrap ? undefined : { minWidth: `calc(var(--gutter) + ${longest}ch + var(--page-x))` }}>
        <div class="file-spacer" style={{ height: `${window_.before}px` }} />
        {blocks}
        <div class="file-spacer" style={{ height: `${window_.after}px` }} />
      </div>
    </div>
  );
}

/** The width of one character of the code font, measured once per page. */
let measuredChar = 0;
function charWidth(near: HTMLElement): number {
  if (measuredChar > 0) return measuredChar;
  const probe = document.createElement('span');
  probe.className = 'file-probe';
  probe.textContent = '0'.repeat(100);
  near.appendChild(probe);
  measuredChar = probe.getBoundingClientRect().width / 100 || 7.8;
  probe.remove();
  return measuredChar;
}

/** The gutter's width: the page margin, the digits and the gap after them (files.css --gutter). */
function gutterWidth(lineCount: number, char: number): number {
  return 20 + String(lineCount).length * char + 12;
}

// ---- find ---------------------------------------------------------------------------------------------

function FindBar({ model }: { model: FileViewerModel }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div class="find-bar" role="search">
      <div class="find-field">
        <Icon name="search" size={16} />
        <input
          ref={field}
          type="search"
          enterKeyHint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          aria-label="Find in file"
          placeholder="Find"
          value={model.query}
          onInput={(event) => model.setQuery((event.currentTarget as HTMLInputElement).value, firstVisibleLine())}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (event.shiftKey) model.previous();
            else model.next();
          }}
        />
        <span class="find-count" aria-live="polite">
          {model.findCount}
        </span>
      </div>
      <button
        type="button"
        class={`find-case${model.matchCase ? ' on' : ''}`}
        aria-label="Match case"
        aria-pressed={model.matchCase}
        onClick={() => model.setMatchCase(!model.matchCase)}
      >
        Aa
      </button>
      <button type="button" class="find-step" aria-label="Previous match" disabled={model.matches.length === 0} onClick={() => model.previous()}>
        <Icon name="chevron-up" size={20} />
      </button>
      <button type="button" class="find-step" aria-label="Next match" disabled={model.matches.length === 0} onClick={() => model.next()}>
        <Icon name="chevron-down" size={20} />
      </button>
      <button type="button" class="link find-done" onClick={() => model.closeFind()}>
        Done
      </button>
    </div>
  );
}

/** The first line whose row is below the header, so a new search starts where the reader is. */
function firstVisibleLine(): number {
  const header = document.querySelector('.file-viewer .file-top')?.getBoundingClientRect().bottom ?? 0;
  for (const row of document.querySelectorAll<HTMLElement>('.file-viewer [data-line]')) {
    if (row.getBoundingClientRect().bottom > header) return Number(row.dataset.line);
  }
  return 0;
}

// ---- the rest of the page -----------------------------------------------------------------------------

function MoreFooter({ model, info }: { model: FileViewerModel; info: FileInfo }) {
  if (!model.hasMore) return null;
  return (
    <div class="file-more">
      <p class="file-more-line">
        Showing {formatBytes(model.loadedBytes)} of {formatBytes(info.size)}
      </p>
      <button type="button" disabled={model.loadingMore} onClick={() => void model.more()}>
        {model.loadingMore ? 'Loading…' : 'Show more'}
      </button>
      {model.moreError !== undefined && (
        <p class="error" role="alert">
          {model.moreError}
        </p>
      )}
    </div>
  );
}

function BinaryCard({ sessionId, info, kindLabel }: { sessionId: string; info: FileInfo; kindLabel: string }) {
  const url = fileUrl(sessionId, info.path);
  const name = fileName(info.path);
  const [shareError, setShareError] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = async () => {
    setShareError(false);
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      const file = new File([await response.blob()], name, { type: info.mediaType });
      if (navigator.canShare?.({ files: [file] }) === false) throw new Error('cannot share files');
      await navigator.share({ files: [file], title: name });
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') setShareError(true);
    }
  };
  return (
    <section class="file-card" aria-label="File">
      <Icon name={info.mediaType.startsWith('image/') ? 'image' : 'file'} size={40} />
      <h2 class="file-card-kind">{kindLabel}</h2>
      <p class="file-card-meta">
        {formatBytes(info.size)} · Modified {new Date(info.mtimeMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
      </p>
      <div class="file-card-actions">
        {canShare && (
          <button type="button" class="primary" onClick={() => void share()}>
            <Icon name="share" size={18} /> Share
          </button>
        )}
        <a class={canShare ? 'file-download' : 'file-download primary'} href={url} download={name}>
          Download
        </a>
      </div>
      {shareError && (
        <p class="error" role="alert">
          Couldn't share this file. Try Download.
        </p>
      )}
    </section>
  );
}

interface FileMenuProps {
  model: FileViewerModel;
  name: string;
  path: string;
  /** A text file (Wrap, Copy all, Raw/Rendered apply). */
  text: boolean;
  onCopyAll: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}

function FileMenu({ model, name, path, text, onCopyAll, onCopyPath, onClose }: FileMenuProps) {
  const rows: GroupRow[] = [];
  if (text) {
    rows.push({
      key: 'wrap',
      icon: 'wrap',
      label: 'Wrap lines',
      value: [{ text: model.wrap ? 'On' : 'Off' }],
      onClick: () => {
        model.setWrap(!model.wrap);
        onClose();
      },
    });
    if (model.canRender) {
      rows.push({
        key: 'rendered',
        icon: 'file',
        label: 'Markdown',
        value: [{ text: model.rendered ? 'Rendered' : 'Raw' }],
        title: model.rendered ? 'Show the raw text' : 'Show it rendered',
        onClick: () => {
          model.setRendered(!model.rendered);
          onClose();
        },
      });
    }
    rows.push({ key: 'copy-all', icon: 'copy', label: model.hasMore ? 'Copy the part shown' : 'Copy all', value: [], onClick: onCopyAll });
  }
  rows.push({ key: 'copy-path', icon: 'copy', label: 'Copy path', value: [{ text: path }], onClick: onCopyPath });
  return (
    <Sheet labelledBy="file-menu-title" class="file-menu" onClose={onClose}>
      <SheetHeader titleId="file-menu-title" title={name} actionLabel="Done" onAction={onClose} />
      <GroupList label="File actions" rows={rows} />
    </Sheet>
  );
}
