import { describe, expect, it, vi } from 'vitest';

import { MemoryStorage } from '../../../test/chat-doubles';
import { ChatStore } from '../../chat/engine/history';
import { PROVIDERS_STORAGE_KEY, ProviderStore } from '../../chat/providers/store';
import type { ModelInfo } from '../../chat/providers/types';
import { ChatsListModel, defaultModelFor, REMOVED_PROVIDER } from './chats-list-model';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

function model(id: string, displayName = id): ModelInfo {
  return { id, displayName, capabilities: {}, source: 'unknown' };
}

function setup(storage = new MemoryStorage()) {
  let clock = NOW;
  let ids = 0;
  const now = () => clock;
  const providers = new ProviderStore({ storage, now, randomId: () => `p${++ids}` });
  const chats = new ChatStore({ storage, now, randomId: () => `c${++ids}` });
  const list = new ChatsListModel({ chats, providers, now });
  return { storage, providers, chats, list, tick: (ms: number) => (clock += ms) };
}

describe('ChatsListModel', () => {
  it('shows the no-providers state first, then no chats, then rows', () => {
    const { providers, list } = setup();
    expect(list.empty).toBe('no-providers');
    expect(list.hasProviders).toBe(false);
    expect(list.canCreate).toBe(false);
    expect(list.newChat()).toBeNull();
    providers.add({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-abc', models: [model('gpt-5')] });
    expect(list.empty).toBe('no-chats');
    expect(list.canCreate).toBe(true);
    list.newChat();
    expect(list.empty).toBeNull();
  });

  it('lists chats newest first with title, model name, provider and relative time', () => {
    const { providers, chats, list, tick } = setup();
    const openai = providers.add({ baseURL: 'https://api.openai.com/v1', models: [model('gpt-5', 'GPT-5')] }).record;
    const first = chats.create(openai.id, 'gpt-5');
    chats.addUserMessage(first.id, 'How do tides work?');
    tick(10 * 60_000);
    const second = chats.create(openai.id, 'unlisted-model');
    tick(60_000);
    const third = chats.create('gone', '');
    tick(5_000);
    expect(list.rows).toEqual([
      { chatId: third.id, title: 'New chat', model: 'No model', provider: REMOVED_PROVIDER, updated: 'just now', revealed: false },
      { chatId: second.id, title: 'New chat', model: 'unlisted-model', provider: 'OpenAI', updated: '1 min ago', revealed: false },
      { chatId: first.id, title: 'How do tides work?', model: 'GPT-5', provider: 'OpenAI', updated: '11 min ago', revealed: false },
    ]);
  });

  it('reveals Delete on one row at a time and deletes', () => {
    const { providers, chats, list } = setup();
    const p = providers.add({ baseURL: 'https://api.openai.com/v1' }).record;
    const a = chats.create(p.id, 'm');
    const b = chats.create(p.id, 'm');
    const seen = vi.fn();
    list.subscribe(seen);
    list.reveal(a.id);
    list.reveal(a.id); // no change
    expect(seen).toHaveBeenCalledTimes(1);
    expect(list.rows.find((r) => r.chatId === a.id)?.revealed).toBe(true);
    list.reveal(b.id);
    expect(list.rows.filter((r) => r.revealed).map((r) => r.chatId)).toEqual([b.id]);
    list.conceal();
    list.conceal(); // no change
    expect(list.rows.some((r) => r.revealed)).toBe(false);
    list.reveal(a.id);
    list.remove(a.id);
    expect(list.rows.map((r) => r.chatId)).toEqual([b.id]);
    list.remove(b.id); // not revealed
    expect(list.empty).toBe('no-chats');
  });

  it('re-renders on store changes until disposed', () => {
    const { providers, list } = setup();
    const seen = vi.fn();
    list.subscribe(seen);
    providers.add({ baseURL: 'https://api.openai.com/v1' });
    expect(seen).toHaveBeenCalledTimes(1);
    list.dispose();
    providers.add({ baseURL: 'https://api.mistral.ai/v1' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('starts a new chat on the default provider and its default model', () => {
    const { providers, list, chats } = setup();
    providers.add({ baseURL: 'https://api.openai.com/v1', models: [model('gpt-5'), model('gpt-5-mini')] });
    const mistral = providers.add({ baseURL: 'https://api.mistral.ai/v1', models: [model('mistral-large')] }).record;
    providers.setDefault(mistral.id);
    const id = list.newChat();
    expect(chats.get(id!)).toMatchObject({ providerId: mistral.id, model: 'mistral-large' });
  });

  it('falls back to the first provider when none is marked default', () => {
    const storage = new MemoryStorage();
    const seeded = setup(storage);
    const p = seeded.providers.add({ baseURL: 'https://api.openai.com/v1', models: [model('gpt-5')] }).record;
    const raw = JSON.parse(storage.getItem(PROVIDERS_STORAGE_KEY)!) as { defaultProviderId: string | null };
    raw.defaultProviderId = null;
    storage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(raw));
    const { list, chats } = setup(storage);
    expect(chats.get(list.newChat()!)?.providerId).toBe(p.id);
  });
});

describe('defaultModelFor', () => {
  it('prefers the newest chat model still listed, then a pinned model, then the first one', () => {
    const { providers, chats, tick } = setup();
    const p = providers.add({ baseURL: 'https://api.openai.com/v1', models: [model('a'), model('b'), model('c')] }).record;
    expect(defaultModelFor(chats, providers, p.id)).toBe('a');
    providers.pinModel(p.id, 'zzz-unlisted-hidden');
    providers.hideModel(p.id, 'zzz-unlisted-hidden');
    providers.pinModel(p.id, 'c');
    expect(defaultModelFor(chats, providers, p.id)).toBe('c');
    chats.create(p.id, 'b');
    tick(1000);
    chats.create(p.id, 'gone-model');
    expect(defaultModelFor(chats, providers, p.id)).toBe('b');
    const empty = providers.add({ baseURL: 'https://api.mistral.ai/v1' }).record;
    expect(defaultModelFor(chats, providers, empty.id)).toBe('');
  });
});
