// The Chats tab: the large "Chats" title with the round ink + (New chat), the flat list of local chats, and
// the empty states. Rendered by Home (paired, on its Chats tab) and by ChatsHome (no host paired). Rules live
// in ChatsListModel. List changes (a new chat, a delete, a reorder) move through FLIP like Home's sessions
// (ui/motion/use-flip.ts useListMotion); the rows' swipes are horizontal touches, FLIP only animates after.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';

import { Icon } from '../../ui/Icon';
import { useListMotion } from '../../ui/motion/use-flip';
import { reducedMotion } from '../session/motion-hooks';

import { ChatsListModel, PROVIDER_SETTINGS_PATH, type ChatRow } from './chats-list-model';
import { useModel } from '../use-model';
import { usePress } from './hooks';
import type { ChatServices } from './services';

export interface ChatsPanelProps {
  services: ChatServices;
  onOpenChat: (chatId: string) => void;
  /** In-app navigation to a path (the Settings > Providers link). */
  onNavigate: (path: string) => void;
  /** A line under the title (ChatsHome: "Pair your Mac"). */
  note?: ComponentChildren;
}

const chatKey = (row: ChatRow) => row.chatId;

export function ChatsPanel({ services, onOpenChat, onNavigate, note }: ChatsPanelProps) {
  const model = useModel(useMemo(() => new ChatsListModel({ chats: services.chats, providers: services.providers }), [services]));
  useEffect(() => () => model.dispose(), [model]);
  const rows = model.rows;
  const empty = model.empty;
  const smooth = !reducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  const list = useListMotion(rows, chatKey, listRef, smooth);
  const create = () => {
    const chatId = model.newChat();
    if (chatId !== null) onOpenChat(chatId);
  };

  return (
    <section class="chats" aria-labelledby="chats-title">
      <div class="titlebar">
        <h1 id="chats-title" class="large-title">
          Chats
        </h1>
        <button type="button" class="round-button ink" aria-label="New chat" onClick={create} disabled={!model.canCreate}>
          <Icon name="plus" />
        </button>
      </div>
      {note}
      {empty === 'no-providers' && (
        <p class="empty muted">
          Add a model provider to start chatting.{' '}
          <a
            class="settings-link"
            href={PROVIDER_SETTINGS_PATH}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(PROVIDER_SETTINGS_PATH);
            }}
          >
            <SettingsPath />
          </a>
        </p>
      )}
      {empty === 'no-chats' && <p class="empty muted">No chats yet. Start one with New chat.</p>}
      {list.shown.length > 0 && (
        <ul class="session-list chat-list" aria-label="Chats" ref={listRef}>
          {list.shown.map(({ item, leaving }) => (
            <ChatItem key={item.chatId} row={item} model={model} leaving={leaving} onOpen={onOpenChat} onDropped={list.dropped} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ChatItemProps {
  row: ChatRow;
  model: ChatsListModel;
  /** It left the list and fades out at its old place (not interactive). */
  leaving: boolean;
  onOpen: (chatId: string) => void;
  onDropped: (chatId: string) => void;
}

function ChatItem({ row, model, leaving, onOpen, onDropped }: ChatItemProps) {
  const press = usePress({ onLongPress: () => model.reveal(row.chatId), onSwipeLeft: () => model.reveal(row.chatId) });
  const { consumed, ...handlers } = press;
  const revealed = !leaving && row.revealed;
  return (
    <li
      class={`swipe-row chat-row${revealed ? ' revealed' : ''}${leaving ? ' list-leaving' : ''}`}
      data-chat-id={row.chatId}
      data-flip-key={leaving ? undefined : row.chatId}
      aria-hidden={leaving ? 'true' : undefined}
      onAnimationEnd={(event) => leaving && event.target === event.currentTarget && onDropped(row.chatId)}
    >
      <a
        class="session chat"
        href={`/c/${encodeURIComponent(row.chatId)}`}
        tabIndex={leaving ? -1 : undefined}
        {...(leaving ? {} : handlers)}
        onClick={(event) => {
          event.preventDefault();
          if (leaving || consumed()) return;
          if (revealed) {
            model.conceal();
            return;
          }
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          onOpen(row.chatId);
        }}
      >
        <span class="session-text">
          <span class="session-title">{row.title}</span>
          <span class="session-meta">
            {row.model} · {row.provider} · {row.updated}
          </span>
        </span>
      </a>
      {revealed && (
        <div class="row-actions">
          <button type="button" class="small danger" onClick={() => model.remove(row.chatId)} aria-label={`Delete ${row.title}`}>
            Delete
          </button>
          <button type="button" class="small ghost" onClick={() => model.conceal()}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

/** "Settings > Providers" in a link: a chevron between the two names (read as "Settings Providers"). */
export function SettingsPath() {
  return (
    <>
      Settings <Icon name="chevron-right" size={14} class="path-chevron" /> Providers
    </>
  );
}
