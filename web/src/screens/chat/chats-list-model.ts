// The Chats tab of Home (local-chat.md ruling R4): the chats on this phone, newest first, each with its
// title, model, provider and a relative time; a row revealed by a swipe or a long-press offers Delete;
// "New chat" opens a chat on the default provider and its default model. Empty states: no providers (a
// link to Settings > Providers) and no chats yet.
import type { ChatStore } from '../../chat/engine/history';
import type { ProviderStore } from '../../chat/providers/store';
import { formatAgo } from '../home-model';
import { Model } from '../model';

/** Where the empty state's link goes; the provider settings screen lives there. */
export const PROVIDER_SETTINGS_PATH = '/settings/providers';

export const REMOVED_PROVIDER = 'Removed provider';

export interface ChatRow {
  chatId: string;
  title: string;
  /** The model's display name, or "No model" when none is chosen yet. */
  model: string;
  provider: string;
  /** "just now", "5 min ago", … */
  updated: string;
  /** Delete is showing (after a swipe or a long-press). */
  revealed: boolean;
}

export type ChatsEmpty = 'no-providers' | 'no-chats' | null;

export interface ChatsListOptions {
  chats: ChatStore;
  providers: ProviderStore;
  now?: () => number;
}

/**
 * The model a new chat on a provider starts with: the model of the newest chat on it that is still in the
 * picker, else the first pinned model, else the first in the picker; '' when the provider lists none.
 */
export function defaultModelFor(chats: ChatStore, providers: ProviderStore, providerId: string): string {
  const visible = providers.visibleModels(providerId).map((m) => m.id);
  const recent = chats.list().find((c) => c.providerId === providerId && visible.includes(c.model));
  if (recent !== undefined) return recent.model;
  const pinned = providers.get(providerId)?.pinnedModels.find((id) => visible.includes(id));
  return pinned ?? visible[0] ?? '';
}

export class ChatsListModel extends Model {
  private readonly chats: ChatStore;
  private readonly providers: ProviderStore;
  private readonly now: () => number;
  private readonly unsubscribe: (() => void)[];
  private revealedId: string | undefined;

  constructor(options: ChatsListOptions) {
    super();
    this.chats = options.chats;
    this.providers = options.providers;
    this.now = options.now ?? Date.now;
    this.unsubscribe = [this.chats.subscribe(() => this.changed()), this.providers.subscribe(() => this.changed())];
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  get rows(): ChatRow[] {
    const now = this.now();
    return this.chats.list().map((chat) => {
      const provider = this.providers.get(chat.providerId);
      const model = provider?.models.list.find((m) => m.id === chat.model)?.displayName ?? chat.model;
      return {
        chatId: chat.id,
        title: chat.title,
        model: model === '' ? 'No model' : model,
        provider: provider?.name ?? REMOVED_PROVIDER,
        updated: formatAgo(Math.floor(chat.updatedAt / 1000), now),
        revealed: chat.id === this.revealedId,
      };
    });
  }

  get hasProviders(): boolean {
    return this.providers.list().length > 0;
  }

  /** Which empty state to show: no providers wins over no chats; null when there are chats. */
  get empty(): ChatsEmpty {
    if (!this.hasProviders) return 'no-providers';
    return this.chats.list().length === 0 ? 'no-chats' : null;
  }

  get canCreate(): boolean {
    return this.defaultProviderId() !== undefined;
  }

  /** Shows Delete on one row (a swipe or a long-press); any other row's Delete hides. */
  reveal(chatId: string): void {
    if (this.revealedId === chatId) return;
    this.revealedId = chatId;
    this.changed();
  }

  conceal(): void {
    if (this.revealedId === undefined) return;
    this.revealedId = undefined;
    this.changed();
  }

  remove(chatId: string): void {
    if (this.revealedId === chatId) this.revealedId = undefined;
    this.chats.remove(chatId);
  }

  /** Creates a chat on the default provider and its default model; the new chat's id, or null without providers. */
  newChat(): string | null {
    const providerId = this.defaultProviderId();
    if (providerId === undefined) return null;
    return this.chats.create(providerId, defaultModelFor(this.chats, this.providers, providerId)).id;
  }

  private defaultProviderId(): string | undefined {
    return this.providers.defaultProviderId ?? this.providers.list()[0]?.id;
  }
}
