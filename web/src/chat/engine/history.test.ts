import { describe, expect, it } from 'vitest';

import { cut, fakeFetch, fixture, MemoryStorage } from '../../../test/chat-doubles';
import { createChatEngine, type ChatEngine } from './chat';
import { type Chat, CHATS_STORAGE_KEY, ChatStore, PERSIST_INTERVAL_MS, sendMessage, TITLE_LENGTH, titleFrom, UNTITLED } from './history';
import type { ChatEvent, ChatProvider } from './types';

const PROVIDER: ChatProvider = { id: 'p-1', name: 'Acme AI', baseURL: 'https://api.acme.example/v1', kind: 'openai-compatible' };

function setup(storage: MemoryStorage | null = new MemoryStorage()) {
  let clock = 1_000;
  let n = 0;
  const options = { storage, now: () => clock, randomId: () => `chat-${++n}` };
  const store = new ChatStore(options);
  return {
    store,
    storage,
    advance: (ms: number) => (clock += ms),
    reopen: () => new ChatStore(options),
    persisted: (): { v: 1; chats: Chat[] } => JSON.parse(storage?.getItem(CHATS_STORAGE_KEY) ?? 'null'),
  };
}

describe('ChatStore', () => {
  it('creates a chat, names it from the first user message only, and persists it', () => {
    const { store, advance, reopen } = setup();
    const chat = store.create('p-1', 'gpt-x');
    expect(chat).toEqual({ id: 'chat-1', title: UNTITLED, providerId: 'p-1', model: 'gpt-x', createdAt: 1000, updatedAt: 1000, messages: [] });
    advance(10);
    store.addUserMessage(chat.id, '  Why is   the sky\nblue? ');
    store.addUserMessage(chat.id, 'And the sea?');
    const reopened = reopen().get(chat.id);
    expect(reopened?.title).toBe('Why is the sky blue?');
    expect(reopened?.updatedAt).toBe(1010);
    expect(reopened?.messages).toEqual([
      { role: 'user', text: '  Why is   the sky\nblue? ', status: 'complete' },
      { role: 'user', text: 'And the sea?', status: 'complete' },
    ]);
  });

  it('streams events into the last assistant message: text, reasoning, merged usage, then done', () => {
    const { store, reopen } = setup();
    const { id } = store.create('p-1', 'm');
    store.addUserMessage(id, 'Hi');
    store.startReply(id);
    const events: ChatEvent[] = [
      { type: 'reasoning', text: 'The user ' },
      { type: 'reasoning', text: 'greets.' },
      { type: 'usage', inputTokens: 25 },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
      { type: 'usage', outputTokens: 15 },
      { type: 'done', status: 'completed' },
    ];
    for (const event of events) store.apply(id, event);
    const reply = { role: 'assistant', text: 'Hello there', reasoning: 'The user greets.', usage: { inputTokens: 25, outputTokens: 15 }, status: 'complete' };
    expect(store.get(id)?.messages[1]).toEqual(reply);
    expect(reopen().get(id)?.messages[1]).toEqual(reply);
  });

  it('marks an aborted reply stopped with its partial text, and a failed one with the sentence', () => {
    const { store } = setup();
    const { id } = store.create('p-1', 'm');
    store.startReply(id);
    store.apply(id, { type: 'text', text: 'Partial' });
    store.apply(id, { type: 'done', status: 'aborted' });
    store.startReply(id);
    store.apply(id, { type: 'error', reason: 'unauthorized', message: 'Acme AI rejected the key. Check the key in Settings.' });
    expect(store.get(id)?.messages).toEqual([
      { role: 'assistant', text: 'Partial', status: 'stopped' },
      { role: 'assistant', text: '', status: 'failed', error: 'Acme AI rejected the key. Check the key in Settings.' },
    ]);
  });

  it('ignores events when the last message is not a streaming reply', () => {
    const { store } = setup();
    const { id } = store.create('p-1', 'm');
    store.apply(id, { type: 'text', text: 'lost' });
    store.addUserMessage(id, 'Hi');
    store.apply(id, { type: 'text', text: 'lost' });
    store.startReply(id);
    store.apply(id, { type: 'done', status: 'completed' });
    store.apply(id, { type: 'text', text: 'late' });
    expect(store.get(id)?.messages.map((m) => m.text)).toEqual(['Hi', '']);
  });

  it('persists streamed text at most every 500 ms, and everything else at once', () => {
    const { store, advance, persisted } = setup();
    const { id } = store.create('p-1', 'm');
    store.startReply(id);
    const saved = () => persisted().chats[0]?.messages[0]?.text;
    store.apply(id, { type: 'text', text: 'a' });
    expect(saved()).toBe('');
    advance(PERSIST_INTERVAL_MS);
    store.apply(id, { type: 'text', text: 'b' });
    expect(saved()).toBe('ab');
    store.apply(id, { type: 'reasoning', text: 'r' });
    expect(persisted().chats[0]?.messages[0]?.reasoning).toBeUndefined();
    store.apply(id, { type: 'usage', outputTokens: 1 });
    expect(persisted().chats[0]?.messages[0]?.reasoning).toBe('r');
  });

  it('turns a reply that was streaming when the page died into a stopped one on load', () => {
    const { store, reopen } = setup();
    const { id } = store.create('p-1', 'm');
    store.startReply(id);
    expect(reopen().get(id)?.messages[0]?.status).toBe('stopped');
  });

  it('builds the turns to send: finished messages with text, plus an optional system prompt', () => {
    const { store } = setup();
    const { id } = store.create('p-1', 'm');
    store.addUserMessage(id, 'one');
    store.startReply(id);
    store.apply(id, { type: 'text', text: 'two' });
    store.apply(id, { type: 'done', status: 'aborted' });
    store.startReply(id);
    store.apply(id, { type: 'done', status: 'aborted' }); // stopped before any text
    store.startReply(id);
    store.apply(id, { type: 'text', text: 'half' });
    store.apply(id, { type: 'error', reason: 'upstream', message: 'x' });
    store.addUserMessage(id, 'three');
    store.startReply(id);
    expect(store.turns(id, 'Be brief.')).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
    expect(store.turns(id, '')[0]).toEqual({ role: 'user', content: 'one' });
  });

  it('lists the most recently updated first, switches models, removes, and notifies subscribers', () => {
    const { store, advance } = setup();
    const a = store.create('p-1', 'm');
    advance(1);
    const b = store.create('p-1', 'm');
    advance(1);
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.setModel(a.id, 'p-2', 'other');
    expect(store.list().map((c) => c.id)).toEqual([a.id, b.id]);
    expect(store.get(a.id)).toMatchObject({ providerId: 'p-2', model: 'other' });
    store.remove(b.id);
    store.remove('nope');
    expect(store.list().map((c) => c.id)).toEqual([a.id]);
    expect(calls).toBe(2);
    off();
    store.remove(a.id);
    expect(calls).toBe(2);
    expect(store.get(a.id)).toBeUndefined();
    expect(() => store.addUserMessage(a.id, 'x')).toThrow('no chat chat-1');
  });

  it('hands out copies', () => {
    const { store } = setup();
    const { id } = store.create('p-1', 'm');
    store.startReply(id);
    store.apply(id, { type: 'usage', inputTokens: 1 });
    const copy = store.get(id)!;
    copy.messages[0]!.usage!.inputTokens = 99;
    copy.messages.push({ role: 'user', text: 'x', status: 'complete' });
    expect(store.get(id)?.messages).toEqual([{ role: 'assistant', text: '', usage: { inputTokens: 1 }, status: 'streaming' }]);
  });

  it('works without storage, survives a full storage, and ignores corrupt or foreign data', () => {
    const memoryOnly = setup(null).store;
    expect(memoryOnly.create('p', 'm').id).toBe('chat-1');
    expect(memoryOnly.list()).toHaveLength(1);

    const { store, storage } = setup();
    storage!.failWrites = true;
    const { id } = store.create('p', 'm');
    expect(store.get(id)).toBeDefined();

    for (const raw of ['{', '{"v":2,"chats":[]}', '{"v":1}', 'null']) {
      const s = new MemoryStorage();
      s.setItem(CHATS_STORAGE_KEY, raw);
      expect(new ChatStore({ storage: s }).list()).toEqual([]);
    }
    const mixed = new MemoryStorage();
    const good: Chat = { id: 'c', title: 't', providerId: 'p', model: 'm', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', text: 'x', status: 'complete' }] };
    const bad = [null, 'x', { ...good, id: 7 }, { ...good, messages: [{ role: 'tool', text: 'x', status: 'complete' }] }, { ...good, messages: [null] }];
    mixed.setItem(CHATS_STORAGE_KEY, JSON.stringify({ v: 1, chats: [good, ...bad] }));
    expect(new ChatStore({ storage: mixed }).list()).toEqual([good]);
  });

  it('uses random UUIDs and the clock by default', () => {
    const chat = new ChatStore({ storage: null }).create('p', 'm');
    expect(chat.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(chat.createdAt - Date.now())).toBeLessThan(5_000);
  });
});

describe('titleFrom', () => {
  it('collapses whitespace, cuts long text at a word with an ellipsis, and falls back for blank text', () => {
    expect(titleFrom('   ')).toBe(UNTITLED);
    expect(titleFrom('a'.repeat(TITLE_LENGTH))).toBe('a'.repeat(TITLE_LENGTH));
    const words = 'Please explain how the Rayleigh scattering of sunlight makes the daytime sky look blue';
    const title = titleFrom(words);
    expect(title.length).toBeLessThanOrEqual(TITLE_LENGTH);
    expect(title).toBe('Please explain how the Rayleigh scattering of sunlight…');
    expect(titleFrom('x'.repeat(100))).toBe(`${'x'.repeat(TITLE_LENGTH - 1)}…`);
  });
});

describe('sendMessage', () => {
  function engineFor(...replies: Parameters<typeof fakeFetch>) {
    const replay = fakeFetch(...replies);
    return { replay, engine: createChatEngine({ fetch: replay.fetch, keyFor: () => 'k', host: () => null, timing: { retryBaseMs: 1 } }) };
  }

  it('sends the history and streams the reply into the chat', async () => {
    const { store } = setup();
    const { replay, engine } = engineFor({ body: fixture('openai-reasoning.sse') });
    const { id } = store.create(PROVIDER.id, 'gpt-oss:120b');
    await sendMessage(engine, store, id, PROVIDER, 'Say hi in three words.', { system: 'Be brief.', thinking: true });
    expect(replay.calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Say hi in three words.' },
    ]);
    expect(replay.calls[0]?.body.model).toBe('gpt-oss:120b');
    expect(store.get(id)).toMatchObject({
      title: 'Say hi in three words.',
      messages: [
        { role: 'user', status: 'complete' },
        {
          role: 'assistant',
          text: 'Hey there, friend!',
          reasoning: 'We need to respond with three-word greeting.',
          usage: { inputTokens: 73, outputTokens: 24 },
          status: 'complete',
        },
      ],
    });
  });

  it('keeps the partial text with status stopped when the user stops', async () => {
    const { store } = setup();
    const { engine } = engineFor({ body: cut(fixture('openai-reasoning.sse'), 7, 'sse'), stall: true });
    const { id } = store.create(PROVIDER.id, 'm');
    const controller = new AbortController();
    store.subscribe(() => {
      if (store.get(id)?.messages.at(-1)?.text === 'Hey there') controller.abort();
    });
    await sendMessage(engine, store, id, PROVIDER, 'hi', {}, controller.signal);
    expect(store.get(id)?.messages.at(-1)).toEqual({ role: 'assistant', text: 'Hey there', reasoning: 'We need to respond with three-word greeting.', status: 'stopped' });
  });

  it('records a failure as the reply with the one sentence', async () => {
    const { store } = setup();
    const { engine } = engineFor({ status: 401 });
    const { id } = store.create(PROVIDER.id, 'm');
    await sendMessage(engine, store, id, PROVIDER, 'hi');
    expect(store.get(id)?.messages.at(-1)).toMatchObject({ status: 'failed', error: 'Acme AI rejected the key. Check the key in Settings.' });
  });

  it('closes the reply when an engine stream ends without done, or throws', async () => {
    const { store } = setup();
    const { id } = store.create(PROVIDER.id, 'm');
    const silent: ChatEngine = {
      async *chat() {
        yield { type: 'text', text: 'x' } as ChatEvent;
      },
    };
    await sendMessage(silent, store, id, PROVIDER, 'hi');
    expect(store.get(id)?.messages.at(-1)).toMatchObject({ text: 'x', status: 'complete' });
    await sendMessage(silent, store, id, PROVIDER, 'hi', {}, AbortSignal.abort());
    expect(store.get(id)?.messages.at(-1)).toMatchObject({ status: 'stopped' });
    const broken: ChatEngine = {
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('bug');
      },
    };
    await sendMessage(broken, store, id, PROVIDER, 'hi');
    expect(store.get(id)?.messages.at(-1)).toMatchObject({ status: 'failed', error: 'Acme AI reported an error while answering. Try again.' });
  });
});
