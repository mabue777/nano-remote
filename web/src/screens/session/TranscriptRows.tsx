// The transcript's pieces in the new look (docs/research/new-look-prototype.md, item 4), shared by the session
// view and local chat: the flat one-line row that opens its content under it, "N previous messages", the
// "Worked for" hairline, the shimmering "Thinking", the paced answer text and the jump-to-latest pill.
// Wording and rules: transcript.ts; motion: motion-hooks.tsx. Styles: transcript.css.
import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';

import { Icon } from '../../ui/Icon';
import type { Segment } from '../../ui/motion/pacer';
import { fileHref, linkifyPaths } from './files/file-link';
import { usePacedText } from './motion-hooks';
import { previousMessages, type RowLine } from './transcript';

export interface FlatRowProps {
  line: RowLine;
  /** The item's id: the row's FLIP key and its open part's `data-body`. */
  rowKey: string;
  /** `data-item` (the item kind), for tests and styles. */
  kind?: string;
  /** Whether the row has something to open. */
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  /** The verb shimmers like "Thinking" (a thinking row that is the only thing streaming). */
  shimmer?: boolean;
  /** The open part, shown under the row. */
  children?: ComponentChildren;
  /** When the target is a single file path, tapping it opens the file viewer. */
  targetHref?: string;
  onTargetClick?: () => void;
}

/** One line: a leading icon, the verb phrase in secondary text, a tag, a chevron; a tap opens the content under it. */
export function FlatRow({ line, rowKey, kind, expandable, open, onToggle, shimmer = false, children, targetHref, onTargetClick }: FlatRowProps) {
  const linked = line.target !== '' && onTargetClick !== undefined && targetHref !== undefined;
  const target =
    line.target !== '' ? (
      linked ? (
        <>
          {' '}
          <a
            class="row-target file-link"
            href={targetHref}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTargetClick();
            }}
          >
            {line.target}
          </a>
        </>
      ) : (
        <>
          {' '}
          <span class="row-target">{line.target}</span>
        </>
      )
    ) : null;
  const content = (
    <>
      <Icon name={line.icon} size={18} class={line.busy ? 'row-icon spin' : 'row-icon'} />
      <span class="row-text">
        {shimmer ? <span class="shimmer">{line.verb}</span> : line.verb}
        {target}
      </span>
      {line.tag !== undefined && <span class={`row-tag ${line.tag.tone}`}>{line.tag.text}</span>}
      {expandable && <Icon name="chevron-right" size={16} class={open ? 'chevron open' : 'chevron'} />}
    </>
  );
  return (
    <div class="row" data-item={kind} data-item-id={rowKey} data-flip-key={rowKey}>
      {expandable && linked ? (
        // A link may not sit inside a button: the toggle covers the line from behind, the path link sits above it.
        <div class="row-line linked">
          <button type="button" class="row-hit" aria-expanded={open} aria-label={`${line.verb} ${line.target}`} onClick={onToggle} />
          {content}
        </div>
      ) : expandable ? (
        <button type="button" class="row-line" aria-expanded={open} onClick={onToggle}>
          {content}
        </button>
      ) : (
        <div class="row-line">{content}</div>
      )}
      {expandable && open && (
        <div class="row-body reveal" data-body={rowKey}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A finished turn's work, folded behind one line. */
export function PreviousToggle({ count, open, flipKey, onToggle }: { count: number; open: boolean; flipKey: string; onToggle: () => void }) {
  return (
    <button type="button" class="previous-toggle" aria-expanded={open} data-flip-key={flipKey} onClick={onToggle}>
      {previousMessages(count)}
      <Icon name="chevron-down" size={16} class={open ? 'chevron open' : 'chevron'} />
    </button>
  );
}

/** "Worked for 3m 12s" with a hairline to the right. */
export function WorkedFor({ label, flipKey }: { label: string; flipKey: string }) {
  return (
    <p class="worked-for" data-flip-key={flipKey}>
      <span>{label}</span>
    </p>
  );
}

/** The grey "Thinking" with the slow shimmer, holding the answer's place before its first words. */
export function Thinking({ flipKey }: { flipKey?: string }) {
  return (
    <p class="thinking" role="status" data-flip-key={flipKey}>
      Thinking
    </p>
  );
}

/** Text revealed at the stream's pace, the newest pieces fading in. */
export function FreshText({ settled, fresh }: { settled: string; fresh: Segment[] }) {
  return (
    <>
      {settled}
      {fresh.map((piece) => (
        <span key={piece.start} class="fresh">
          {piece.text}
        </span>
      ))}
    </>
  );
}

/** An agent message: the Replica's text, paced while it streams. Paths become links when the message is settled. */
export function AgentMessage({
  itemId,
  text,
  streaming,
  sessionId,
  onOpenFile,
}: {
  itemId: string;
  text: string;
  streaming: boolean;
  sessionId?: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const view = usePacedText(text, streaming);
  const linkify = sessionId !== undefined && onOpenFile !== undefined && !streaming;
  return (
    <div class="item-row" data-item-id={itemId} data-flip-key={itemId}>
      <div class="msg agent" data-item="agent" data-streaming={streaming ? 'true' : 'false'}>
        <p>
          {linkify ? (
            <LinkifiedText text={text} sessionId={sessionId} onOpenFile={onOpenFile} />
          ) : (
            <FreshText settled={view.settled} fresh={view.fresh} />
          )}
        </p>
      </div>
    </div>
  );
}

function LinkifiedText({
  text,
  sessionId,
  onOpenFile,
}: {
  text: string;
  sessionId: string;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const segments = useMemo(() => linkifyPaths(text), [text]);
  return (
    <>
      {segments.map((segment, i) =>
        segment.path !== undefined ? (
          <a
            key={i}
            class="file-link"
            href={fileHref(sessionId!, segment.path, segment.line)}
            onClick={(event) => {
              event.preventDefault();
              onOpenFile(segment.path!, segment.line);
            }}
          >
            {segment.text}
          </a>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** "Jump to latest": fades and rises in while the reader is away from the bottom; a tap glides back down. */
export function JumpPill({ shown, onJump }: { shown: boolean; onJump: () => void }) {
  return (
    <button type="button" class={`jump-latest${shown ? ' shown' : ''}`} aria-hidden={!shown} tabIndex={shown ? 0 : -1} aria-label="Jump to latest" onClick={onJump}>
      <Icon name="arrow-down" size={18} />
    </button>
  );
}
