// The chat page, /c/:chatId: header with the model picker and the thinking switch, the message list
// (reasoning in the session view's thinking block, replies as markdown), and the session view's composer
// with Stop while a reply streams. State and rules live in ChatModel; this file renders and scrolls.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import { BackHeader } from '../../ui/BackHeader';
import { Sheet, SheetHeader } from '../../ui/Sheet';
import { Switch } from '../../ui/Switch';
import { ChatModel, type MessageRow } from './chat-model';
import { useLiveModel, usePress } from './hooks';
import type { Block, Inline } from './markdown';
import type { ChatServices } from './services';

/** Within this many px of the bottom counts as "at the bottom" (auto-scroll stays on). */
const BOTTOM_SLACK = 48;

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
  const model = useLiveModel(
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
  const atBottom = useRef(true);
  const lastScrollRequest = useRef(-1);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (atBottom.current || lastScrollRequest.current !== model.scrollRequest) {
      lastScrollRequest.current = model.scrollRequest;
      element.scrollTop = element.scrollHeight;
    }
  });

  const rows = model.rows;
  const notice = model.notice;

  return (
    <main class="screen session-screen chat-screen">
      <BackHeader href="/chats" label={backLabel} onBack={onBack}>
        <button type="button" class="model-button small" onClick={() => model.openPicker()} aria-haspopup="dialog" aria-label={`Model: ${model.modelLabel}`} disabled={!model.found}>
          <span class="model-name">{model.modelLabel}</span> ▾
        </button>
      </BackHeader>
      <div class="session-head chat-head">
        <h1 class="session-heading">{model.title}</h1>
        <div class="chat-sub">
          <p class="muted small" aria-label="Provider">
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
        onScroll={(event) => {
          const element = event.currentTarget as HTMLElement;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
        }}
      >
        {rows.length === 0 ? (
          <p class="empty muted">{model.found ? 'Send a message to start.' : ''}</p>
        ) : (
          <ol class="turns chat-messages" aria-label="Messages">
            {rows.map((row) => (
              <Message key={row.index} row={row} model={model} />
            ))}
          </ol>
        )}
      </section>

      {(model.copied !== undefined || model.copyError !== undefined) && (
        <p class={`toast small${model.copyError !== undefined ? ' error' : ''}`} role="status">
          {model.copyError ?? 'Copied'}
        </p>
      )}

      <footer class="composer">
        {notice !== undefined && <p class="muted small chat-notice">{notice}</p>}
        <form
          class="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void model.send();
          }}
        >
          <textarea
            aria-label="Message"
            rows={Math.min(6, Math.max(1, model.draft.split('\n').length))}
            placeholder={`Message ${model.modelId === '' ? 'the model' : model.modelLabel}…`}
            value={model.draft}
            disabled={!model.found}
            onInput={(event) => model.setDraft((event.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void model.send();
              }
            }}
          />
          <div class="composer-actions">
            {model.streaming ? (
              <button type="button" class="stop" onClick={() => model.stop()}>
                Stop
              </button>
            ) : (
              <button type="submit" class="primary" disabled={!model.canSend}>
                Send
              </button>
            )}
          </div>
        </form>
      </footer>
      {model.pickerOpen && <ModelPicker model={model} onSettings={onSettings} />}
    </main>
  );
}

function Message({ row, model }: { row: MessageRow; model: ChatModel }) {
  const press = usePress({ onLongPress: () => void model.copy(row.index) });
  const { consumed: _consumed, ...handlers } = press;
  return (
    <li class={`turn chat-message ${row.role}`} data-role={row.role} data-streaming={row.streaming ? 'true' : 'false'}>
      {row.reasoning !== undefined && (
        <div class="item reasoning" data-item="reasoning">
          <button type="button" class="link reasoning-toggle" aria-expanded={row.reasoning.expanded} onClick={() => model.toggleReasoning(row.index)}>
            {row.reasoning.expanded ? '▾' : '▸'} Thinking
          </button>
          {row.reasoning.expanded && <p class="muted small reasoning-text">{row.reasoning.text}</p>}
        </div>
      )}
      {(row.text !== '' || row.role === 'user' || (row.streaming && row.reasoning === undefined)) && (
        <div class={`msg ${row.role === 'user' ? 'user' : 'agent'}`} data-item={row.role === 'user' ? 'user' : 'agent'} {...handlers}>
          {row.role === 'user' ? <p>{row.text}</p> : <Markdown blocks={row.blocks} />}
          {row.streaming && row.text === '' && <p class="muted small">…</p>}
        </div>
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
            Add one in Settings › Providers
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

function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <div class="markdown">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'p':
            return <p key={i}>{inlines(block.inlines)}</p>;
          case 'h':
            return block.level === 1 ? <h3 key={i}>{inlines(block.inlines)}</h3> : <h4 key={i}>{inlines(block.inlines)}</h4>;
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
                  <li key={j}>{inlines(item)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={block.start}>
                {block.items.map((item, j) => (
                  <li key={j}>{inlines(item)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={i}>{inlines(block.inlines)}</blockquote>;
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
