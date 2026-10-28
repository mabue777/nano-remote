// The chat page, /c/:chatId: header with the model picker and the thinking switch, the message list
// (reasoning as the session view's flat thinking row, replies as markdown), and the shared floating composer
// (ui/Composer.tsx) with Stop while a reply streams; a sent message rises out of it. A reply streams in
// paced, its newest words fading in on the last block; a grey "Thinking" holds its place before the first
// words, and the view follows it while you are at the bottom (the session view's motion-hooks.tsx). State and rules live in ChatModel; this file renders and scrolls.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import { BackHeader } from '../../ui/BackHeader';
import { Composer } from '../../ui/Composer';
import { Icon } from '../../ui/Icon';
import { Sheet, SheetHeader } from '../../ui/Sheet';
import { Switch } from '../../ui/Switch';
import { ChatModel, type MessageRow } from './chat-model';
import { useModel } from '../use-model';
import { usePress } from './hooks';
import { parseMarkdown, withoutFreshTail, type Block, type Inline } from './markdown';
import { SettingsPath } from './ChatsPanel';
import type { ChatServices } from './services';
import { collapse, reducedMotion, useAutoScroll, useFlip, usePacedText, type Flip } from '../session/motion-hooks';
import { FlatRow, FreshText, JumpPill, Thinking } from '../session/TranscriptRows';
import type { Segment } from '../../ui/motion/pacer';

export interface ChatScreenProps {
  chatId: string;
  services: ChatServices;
  onBack: () => void;
  /** Label of the back link: where it goes. */
  backLabel: string;
  /** Settings > Providers, linked from the empty model picker. */
  onSettings?: () => void;
}

export function ChatScreen({ chatId, services, onBack, backLabel, onSettings }: ChatScreenProps) {
  const model = useModel(
    useMemo(
      () =>
        new ChatModel({
          chatId,
          chats: services.chats,
          providers: services.providers,
          engine: services.engine,
          host: () => services.host.current,
          fetch: (url, init) => window.fetch(url, init),
          clipboard: typeof navigator !== 'undefined' && navigator.clipboard !== undefined ? navigator.clipboard : null,
        }),
      [chatId, services],
    ),
  );
  useEffect(() => () => model.dispose(), [model]);

  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const lastScrollRequest = useRef(-1);
  const scroll = useAutoScroll(scroller, content);
  const flip = useFlip(scroller, !reducedMotion(), scroll.layout);
  // The history is on the phone: land at its end at once; after that new content glides into view.
  useLayoutEffect(() => scroll.snap(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (lastScrollRequest.current !== model.scrollRequest) {
      if (lastScrollRequest.current !== -1) scroll.jump();
      lastScrollRequest.current = model.scrollRequest;
    }
  });

  const rows = model.rows;
  const notice = model.notice;
  // Sending (technique 6): the message rises out of the composer, the field clears in the same frame, and the
  // older messages glide up as the view pins to the new bottom.
  const send = () => flip(() => void model.send(), { enter: false, rise: '.chat-message.user', beforePlay: () => scroll.pin() });

  return (
    <main class="screen session-screen chat-screen">
      <BackHeader href="/chats" label={backLabel} onBack={onBack}>
        <button type="button" class="model-button small" onClick={() => model.openPicker()} aria-haspopup="dialog" aria-label={`Model: ${model.modelLabel}`} disabled={!model.found}>
          <span class="model-name">{model.modelLabel}</span>
          <Icon name="chevron-down" size={16} />
        </button>
      </BackHeader>
      <div class="session-head chat-head">
        <h1 class="session-heading">{model.title}</h1>
        <div class="chat-sub">
          <p class="session-meta-line small" aria-label="Provider">
            {model.providerName}
            {model.routeLabel !== undefined && ` · ${model.routeLabel}`}
          </p>
          {model.thinkingAvailable && (
            <div class="thinking-row">
              <span id="thinking-label" class="small">
                Thinking
              </span>
              <Switch checked={model.thinking} labelledBy="thinking-label" onChange={() => model.toggleThinking()} />
            </div>
          )}
        </div>
      </div>

      <section
        class="conversation"
        aria-label="Conversation"
        ref={scroller}
        {...scroll.handlers}
      >
        <div ref={content} class="conversation-content">
          {rows.length === 0 ? (
            <p class="empty muted">{model.found ? 'Send a message to start.' : ''}</p>
          ) : (
            <ol class="turns chat-messages" aria-label="Messages">
              {rows.map((row) => (
                <Message key={row.index} row={row} model={model} flip={flip} scroller={scroller} />
              ))}
            </ol>
          )}
        </div>
      </section>

      <JumpPill shown={scroll.pill} onJump={() => scroll.jump()} />

      {(model.copied !== undefined || model.copyError !== undefined) && (
        <p class={`toast small${model.copyError !== undefined ? ' error' : ''}`} role="status">
          {model.copyError ?? 'Copied'}
        </p>
      )}

      <Composer
        draft={model.draft}
        placeholder={`Message ${model.modelId === '' ? 'the model' : model.modelLabel}…`}
        onDraft={(text) => model.setDraft(text)}
        canSend={model.canSend}
        onSend={send}
        running={model.streaming}
        stop={{ onStop: () => model.stop() }}
        disabled={!model.found}
        above={notice !== undefined && <p class="muted small chat-notice">{notice}</p>}
      />
      {model.pickerOpen && <ModelPicker model={model} onSettings={onSettings} />}
    </main>
  );
}

function Message({ row, model, flip, scroller }: { row: MessageRow; model: ChatModel; flip: Flip; scroller: { current: HTMLElement | null } }) {
  const press = usePress({ onLongPress: () => void model.copy(row.index) });
  const { consumed: _consumed, ...handlers } = press;
  const reasoning = row.reasoning;
  const key = `reasoning/${row.index}`;
  // Thinking while the reasoning is the only thing streaming; it folds once the answer starts.
  const thinking = row.streaming && row.text === '';
  const toggle = () => {
    if (reasoning?.expanded !== true) flip(() => model.toggleReasoning(row.index));
    else collapse(scroller.current, key, flip, () => model.toggleReasoning(row.index), !reducedMotion());
  };
  return (
    <li class={`turn chat-message ${row.role}`} data-role={row.role} data-streaming={row.streaming ? 'true' : 'false'} data-flip-key={`message/${row.index}`}>
      {reasoning !== undefined && (
        <FlatRow
          line={{ icon: 'lightbulb', verb: thinking ? 'Thinking' : 'Thought', target: '', busy: false }}
          rowKey={key}
          kind="reasoning"
          expandable
          open={reasoning.expanded}
          onToggle={toggle}
          shimmer={thinking}
        >
          <p class="reasoning-text">{reasoning.text}</p>
        </FlatRow>
      )}
      {row.role === 'user' ? (
        <div class="msg user" data-item="user" {...handlers}>
          <p>{row.text}</p>
        </div>
      ) : row.text !== '' ? (
        <div class="msg agent" data-item="agent" {...handlers}>
          <Reply text={row.text} blocks={row.blocks} streaming={row.streaming} />
        </div>
      ) : (
        thinking && reasoning === undefined && <Thinking />
      )}
      {row.label !== '' && <p class="turn-state small muted">{row.label}</p>}
      {row.error !== undefined && (
        <p class="error small" role="alert">
          {row.error}
        </p>
      )}
      {row.usage !== undefined && (
        <p class="usage muted small" aria-label="Token usage">
          {row.usage}
        </p>
      )}
    </li>
  );
}

/** A reply as markdown, paced while it streams; the newest words fade in on the last block only. */
function Reply({ text, blocks, streaming }: { text: string; blocks: Block[]; streaming: boolean }) {
  const view = usePacedText(text, streaming);
  if (view.fresh.length === 0 && view.settled === text) return <Markdown blocks={blocks} />;
  const fresh = view.fresh.map((piece) => piece.text).join('');
  const shown = parseMarkdown(view.settled + fresh);
  const cut = withoutFreshTail(shown, fresh);
  return cut === null ? <Markdown blocks={shown} /> : <Markdown blocks={cut} tail={view.fresh} />;
}

function ModelPicker({ model, onSettings }: { model: ChatModel; onSettings: (() => void) | undefined }) {
  const groups = model.pickerGroups;
  return (
    <Sheet labelledBy="model-picker-title" class="model-picker" onClose={() => model.closePicker()}>
      <SheetHeader titleId="model-picker-title" title="Model" actionLabel="Done" onAction={() => model.closePicker()} />
      {groups.length === 0 && (
        <p class="muted">
          No providers yet.{' '}
          <a
            class="settings-link"
            href="/settings/providers"
            onClick={(event) => {
              event.preventDefault();
              model.closePicker();
              onSettings?.();
            }}
          >
            Add one in <SettingsPath />
          </a>
        </p>
      )}
      {groups.map((group) => (
        <section key={group.providerId} class="picker-group" aria-label={group.name}>
          <div class="picker-head">
            <div>
              <h3>{group.name}</h3>
              <p class="muted small">{group.route}</p>
            </div>
            <button type="button" class="ghost small" onClick={() => void model.refreshModels(group.providerId)} disabled={group.refreshing} aria-label={`Refresh models of ${group.name}`}>
              {group.refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {group.error !== undefined && (
            <p class="error small" role="alert">
              {group.error}
            </p>
          )}
          {group.models.length === 0 ? (
            <p class="muted small">No models cached. Refresh to load them.</p>
          ) : (
            <ul class="picker-models">
              {group.models.map((m) => (
                <li key={m.id}>
                  <button type="button" class={`choice${m.selected ? ' selected' : ''}`} aria-pressed={m.selected} onClick={() => model.selectModel(group.providerId, m.id)}>
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </Sheet>
  );
}

/** `tail`: the newest pieces, appended to the last block's text so they fade in (see withoutFreshTail). */
function Markdown({ blocks, tail }: { blocks: Block[]; tail?: Segment[] }) {
  return (
    <div class="markdown">
      {blocks.map((block, i) => {
        const end = tail !== undefined && i === blocks.length - 1 ? <FreshText settled="" fresh={tail} /> : null;
        switch (block.kind) {
          case 'p':
            return (
              <p key={i}>
                {inlines(block.inlines)}
                {end}
              </p>
            );
          case 'h':
            return block.level === 1 ? (
              <h3 key={i}>
                {inlines(block.inlines)}
                {end}
              </h3>
            ) : (
              <h4 key={i}>
                {inlines(block.inlines)}
                {end}
              </h4>
            );
          case 'code':
            return (
              <pre key={i} class="code-block" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case 'ul':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    {inlines(item)}
                    {j === block.items.length - 1 && end}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={block.start}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    {inlines(item)}
                    {j === block.items.length - 1 && end}
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i}>
                {inlines(block.inlines)}
                {end}
              </blockquote>
            );
        }
      })}
    </div>
  );
}

function inlines(parts: Inline[]): ComponentChildren {
  return parts.map((part, i) => {
    switch (part.kind) {
      case 'text':
        return part.text;
      case 'code':
        return <code key={i}>{part.text}</code>;
      case 'strong':
        return <strong key={i}>{part.text}</strong>;
      case 'em':
        return <em key={i}>{part.text}</em>;
      case 'link':
        return (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        );
    }
  });
}
