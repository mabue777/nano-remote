// Home without a paired host: local chat works on its own (ADR 0006: direct providers need no Mac), so
// the page shows the Chats tab with an inline "Pair your Mac" link instead of sending the user to pairing.
import { SettingsGear } from '../HomeScreen';
import { ChatsPanel } from './ChatsPanel';
import { PROVIDER_SETTINGS_PATH } from './chats-list-model';
import type { ChatServices } from './services';

export interface ChatsHomeProps {
  services: ChatServices;
  onOpenChat: (chatId: string) => void;
  onNavigate: (path: string) => void;
}

export function ChatsHome({ services, onOpenChat, onNavigate }: ChatsHomeProps) {
  return (
    <main class="screen home">
      <header class="topbar">
        <h1>Nano Remote</h1>
        <SettingsGear onClick={() => onNavigate(PROVIDER_SETTINGS_PATH)} />
      </header>
      <p class="pair-hint muted small">
        Sessions with your coding agents need your Mac.{' '}
        <a
          href="/pair"
          onClick={(event) => {
            event.preventDefault();
            onNavigate('/pair');
          }}
        >
          Pair your Mac
        </a>
      </p>
      <ChatsPanel services={services} onOpenChat={onOpenChat} onNavigate={onNavigate} />
    </main>
  );
}
