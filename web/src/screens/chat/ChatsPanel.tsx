// The Chats tab: the list of local chats, "New chat", and the empty states. Rendered by Home (paired, on
// its Chats tab) and by ChatsHome (no host paired). Rules live in ChatsListModel.
import { useEffect, useMemo } from 'preact/hooks';

import { ChatsListModel, PROVIDER_SETTINGS_PATH, type ChatRow } from './chats-list-model';
import { useLiveModel, usePress } from './hooks';
import type { ChatServices } from './services';

export interface ChatsPanelProps {
  services: ChatServices;
  onOpenChat: (chatId: string) => void;
  /** In-app navigation to a path (the Settings > Providers link). */
  onNavigate: (path: string) => void;
}

export function ChatsPanel({ services, onOpenChat, onNavigate }: ChatsPanelProps) {
  const model = useLiveModel(useMemo(() => new ChatsListModel({ chats: services.chats, providers: services.providers }), [services]));
  useEffect(() => () => model.dispose(), [model]);
  const rows = model.rows;
  const empty = model.empty;
  const create = () => {
    const chatId = model.newChat();
    if (chatId !== null) onOpenChat(chatId);
  };

  return (
    <section class="chats" aria-labelledby="chats-title">
      <div class="section-head">
        <h2 id="chats-title">Chats</h2>
        <div class="actions">
          <button type="button" class="primary small" onClick={create} disabled={!model.canCreate}>
            New chat
          </button>
        </div>
      </div>
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
            Settings › Providers
          </a>
        </p>
      )}
      {empty === 'no-chats' && <p class="empty muted">No chats yet. Start one with New chat.</p>}
      {rows.length > 0 && (
        <ul class="session-list chat-list" aria-label="Chats">
          {rows.map((row) => (
            <ChatItem key={row.chatId} row={row} model={model} onOpen={onOpenChat} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatItem({ row, model, onOpen }: { row: ChatRow; model: ChatsListModel; onOpen: (chatId: string) => void }) {
  const press = usePress({ onLongPress: () => model.reveal(row.chatId), onSwipeLeft: () => model.reveal(row.chatId) });
  const { consumed, ...handlers } = press;
  return (
    <li class={`chat-row${row.revealed ? ' revealed' : ''}`} data-chat-id={row.chatId}>
      <a
        class="session chat"
        href={`/c/${encodeURIComponent(row.chatId)}`}
        {...handlers}
        onClick={(event) => {
          event.preventDefault();
          if (consumed()) return;
          if (row.revealed) {
            model.conceal();
            return;
          }
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          onOpen(row.chatId);
        }}
      >
        <div class="session-top">
          <span class="session-title">{row.title}</span>
        </div>
        <div class="session-meta small">
          <span class="muted">
            {row.model} · {row.provider} · {row.updated}
          </span>
        </div>
      </a>
      {row.revealed && (
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
