import { describe, expect, it, vi } from 'vitest';

import { fakeFetch, fixture, MemoryStorage } from '../../../test/chat-doubles';
import { createChatEngine, type ChatEngine } from '../../chat/engine/chat';
import { HOST_UNAVAILABLE_MESSAGE } from '../../chat/engine/errors';
import type { HostLink } from '../../chat/engine/host';
import { ChatStore } from '../../chat/engine/history';
import type { ChatEvent, ChatOptions, ChatTurn } from '../../chat/engine/types';
import type { FetchLike } from '../../chat/providers/probe';
import { ProviderStore } from '../../chat/providers/store';
import type { ModelInfo } from '../../chat/providers/types';
import { ChatModel, COPIED_MS, MISSING_CHAT, MISSING_PROVIDER, NO_MODEL, routeLabel, usageLine, type Timers } from './chat-model';
import { REMOVED_PROVIDER } from './chats-list-model';
import { createChatServices, hasLocalChat, HostSlot } from './services';

const REASONER: ModelInfo = { id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { reasoning: true }, source: 'vendor' };
const PLAIN: ModelInfo = { id: 'fake-mini', displayName: 'fake-mini', capabilities: {}, source: 'unknown' };

/** An engine whose replies the test feeds event by event. */
function scriptedEngine() {
  const calls: { model: string; turns: readonly ChatTurn[]; options: ChatOptions | undefined; signal: AbortSignal | undefined }[] = [];
  let feed: ((event: ChatEvent | 'end') => void) | undefined;
  const engine: ChatEngine = {
    chat(_provider, model, turns, options, signal) {
      calls.push({ model, turns, options, signal });
      const queue: (ChatEvent | 'end')[] = [];
      let wake: (() => void) | undefined;
      feed = (event) => {
        queue.push(event);
        wake?.();
      };
      signal?.addEventListener('abort', () => feed?.({ type: 'done', status: 'aborted' }));
      return (async function* () {
        for (;;) {
          const next = queue.shift();
          if (next === undefined) {
            await new Promise<void>((resolve) => (wake = resolve));
            continue;
          }
          if (next === 'end') return;
          yield next;
          if (next.type === 'done' || next.type === 'error') return;
        }
      })();
    },
  };
  return { engine, calls, emit: (event: ChatEvent | 'end') => feed?.(event) };
}

function manualTimers(): Timers & { fire: () => void; pending: number } {
  const jobs = new Map<number, () => void>();
  let next = 0;
  return {
    set: (callback) => {
      jobs.set(++next, callback);
      return next;
    },
    clear: (handle) => void jobs.delete(handle as number),
    fire: () => {
      const all = [...jobs.values()];
      jobs.clear();
      for (const job of all) job();
    },
    get pending() {
      return jobs.size;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { engine?: ChatEngine; fetch?: FetchLike; host?: HostLink | null; clipboard?: { writeText(t: string): Promise<void> } | null } = {}) {
  const storage = new MemoryStorage();
  let ids = 0;
  const providers = new ProviderStore({ storage, randomId: () => `p${++ids}` });
  const chats = new ChatStore({ storage, randomId: () => `c${++ids}` });
  const direct = providers.add({ baseURL: 'https://api.fake-provider.test/v1', name: 'Fake Cloud', apiKey: 'sk-fake', models: [REASONER, PLAIN] }).record;
  const scripted = scriptedEngine();
  const timers = manualTimers();
  const chat = chats.create(direct.id, REASONER.id);
  const make = (chatId = chat.id) =>
    new ChatModel({
      chatId,
      chats,
      providers,
      engine: options.engine ?? scripted.engine,
      host: () => options.host ?? null,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      clipboard: options.clipboard === undefined ? null : options.clipboard,
      timers,
    });
  return { storage, providers, chats, direct, chat, scripted, timers, model: make(), make };
}

describe('ChatModel: header and notices', () => {
  it('shows the title, provider, route and model name', () => {
    const { model, chats, chat } = setup();
    expect(model.found).toBe(true);
    expect(model.title).toBe('New chat');
    expect(model.providerName).toBe('Fake Cloud');
    expect(model.routeLabel).toBe('direct');
    expect(model.modelId).toBe('fake-reasoner');
    expect(model.modelLabel).toBe('Fake Reasoner');
    expect(model.notice).toBeUndefined();
    chats.setModel(chat.id, chat.providerId, 'unlisted');
    expect(model.modelLabel).toBe('unlisted');
    chats.setModel(chat.id, chat.providerId, '');
    expect(model.modelLabel).toBe('Pick a model');
    expect(model.notice).toBe(NO_MODEL);
  });

  it('says so when the chat or its provider is gone', () => {
    const { make, providers, direct, model } = setup();
    const missing = make('nope');
    expect(missing.found).toBe(false);
    expect(missing.title).toBe('Chat');
    expect(missing.notice).toBe(MISSING_CHAT);
    expect(missing.rows).toEqual([]);
    expect(missing.modelId).toBe('');
    missing.selectModel(direct.id, 'x'); // ignored
    providers.remove(direct.id);
    expect(model.notice).toBe(MISSING_PROVIDER);
    expect(model.providerName).toBe(REMOVED_PROVIDER);
    expect(model.routeLabel).toBeUndefined();
    expect(model.thinkingAvailable).toBe(false);
    model.setDraft('hi');
    expect(model.canSend).toBe(false);
  });

  it('labels routes per ADR 0006 and formats usage', () => {
    expect(routeLabel('https://api.openai.com/v1')).toBe('direct');
    expect(routeLabel('http://192.168.1.20:11434')).toBe('via your Mac');
    expect(usageLine(undefined)).toBeUndefined();
    expect(usageLine({})).toBeUndefined();
    expect(usageLine({ inputTokens: 12, outputTokens: 40 })).toBe('12 in · 40 out tokens');
    expect(usageLine({ outputTokens: 3 })).toBe('3 out tokens');
  });
});

describe('ChatModel: sending and streaming', () => {
  it('streams a reply with reasoning that folds once the answer starts, and the usage line', async () => {
    const { model, scripted } = setup();
    model.setDraft('  Say hi  ');
    expect(model.canSend).toBe(true);
    const done = model.send();
    expect(model.streaming).toBe(true);
    expect(model.draft).toBe('');
    expect(model.canSend).toBe(false);
    expect(model.scrollRequest).toBe(1);
    expect(scripted.calls[0]).toMatchObject({ model: 'fake-reasoner', options: { thinking: true } });
    expect(scripted.calls[0]!.turns).toEqual([{ role: 'user', content: 'Say hi' }]);

    scripted.emit({ type: 'reasoning', text: 'The user wants' });
    await flush();
    expect(model.rows[1]).toMatchObject({ role: 'assistant', streaming: true, reasoning: { text: 'The user wants', expanded: true } });
    scripted.emit({ type: 'text', text: 'Hey **there**' });
    await flush();
    expect(model.rows[1]!.reasoning!.expanded).toBe(false);
    expect(model.rows[1]!.blocks).toEqual([
      { kind: 'p', inlines: [{ kind: 'text', text: 'Hey ' }, { kind: 'strong', text: 'there' }] },
    ]);
    scripted.emit({ type: 'usage', inputTokens: 5, outputTokens: 7 });
    scripted.emit({ type: 'done', status: 'completed' });
    await done;
    expect(model.streaming).toBe(false);
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]).toMatchObject({ role: 'user', text: 'Say hi', blocks: [], label: '' });
    expect(model.rows[1]).toMatchObject({ text: 'Hey **there**', streaming: false, label: '', usage: '5 in · 7 out tokens' });
    expect(model.title).toBe('Say hi');
  });

  it('Stop keeps the partial text and marks the reply stopped', async () => {
    const { model, scripted } = setup();
    model.setDraft('Count slowly');
    const done = model.send();
    scripted.emit({ type: 'text', text: 'One, two' });
    await flush();
    model.stop();
    await done;
    expect(model.streaming).toBe(false);
    expect(model.rows[1]).toMatchObject({ text: 'One, two', label: 'Stopped', streaming: false });
    expect(scripted.calls[0]!.signal?.aborted).toBe(true);
    model.stop(); // nothing running
  });

  it('shows the failure sentence and does not send twice or when empty', async () => {
    const { model, scripted } = setup();
    void model.send(); // empty draft
    expect(scripted.calls).toHaveLength(0);
    model.setDraft('Hi');
    const done = model.send();
    model.setDraft('again');
    await model.send(); // busy: ignored
    scripted.emit({ type: 'error', reason: 'unauthorized', message: 'Fake Cloud rejected the key. Check the key in Settings.' });
    await done;
    expect(scripted.calls).toHaveLength(1);
    expect(model.rows[1]).toMatchObject({ error: 'Fake Cloud rejected the key. Check the key in Settings.', label: '' });
  });

  it('sends no thinking option for a model without reasoning, and the switch toggles', async () => {
    const { model, scripted, chats, chat, direct } = setup();
    expect(model.thinkingAvailable).toBe(true);
    expect(model.thinking).toBe(true);
    model.toggleThinking();
    expect(model.thinking).toBe(false);
    model.setDraft('a');
    const first = model.send();
    expect(scripted.calls[0]!.options).toEqual({ thinking: false });
    scripted.emit({ type: 'done', status: 'completed' });
    await first;
    chats.setModel(chat.id, direct.id, PLAIN.id);
    expect(model.thinkingAvailable).toBe(false);
    model.setDraft('b');
    const second = model.send();
    expect(scripted.calls[1]!.options).toEqual({});
    scripted.emit('end');
    await second;
    expect(model.rows[3]!.streaming).toBe(false);
  });

  it('toggles a reasoning block by tap, and ignores rows without one', async () => {
    const { model, scripted } = setup();
    model.setDraft('x');
    const done = model.send();
    scripted.emit({ type: 'reasoning', text: 'think' });
    scripted.emit({ type: 'text', text: 'answer' });
    scripted.emit({ type: 'done', status: 'completed' });
    await done;
    expect(model.rows[1]!.reasoning!.expanded).toBe(false);
    model.toggleReasoning(1);
    expect(model.rows[1]!.reasoning!.expanded).toBe(true);
    model.toggleReasoning(1);
    expect(model.rows[1]!.reasoning!.expanded).toBe(false);
    const seen = vi.fn();
    model.subscribe(seen);
    model.toggleReasoning(0);
    model.toggleReasoning(9);
    expect(seen).not.toHaveBeenCalled();
  });

  it('dispose stops a running reply and stops listening', async () => {
    const { model, scripted, chats, chat } = setup();
    model.setDraft('x');
    const done = model.send();
    scripted.emit({ type: 'text', text: 'partial' });
    await flush();
    const seen = vi.fn();
    model.subscribe(seen);
    model.dispose();
    await done;
    expect(chats.get(chat.id)!.messages[1]).toMatchObject({ text: 'partial', status: 'stopped' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('works end to end with the real engine on a recorded SSE stream', async () => {
    const { fetch } = fakeFetch({ body: fixture('openai-reasoning.sse'), headers: { 'content-type': 'text/event-stream' }, chunkBytes: 64 });
    const engine = createChatEngine({ fetch, keyFor: () => 'sk-fake', host: () => null });
    const { model } = setup({ engine });
    model.setDraft('Say hi in three words.');
    await model.send();
    const reply = model.rows[1]!;
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.reasoning?.text.length).toBeGreaterThan(0);
    expect(reply.usage).toMatch(/in · \d+ out tokens/);
  });

  it('a host-routed provider without the Mac ends in the one sentence', async () => {
    const engine = createChatEngine({ fetch: fakeFetch().fetch, keyFor: () => null, host: () => null });
    const { model, providers, chats, chat } = setup({ engine });
    const ollama = providers.add({ baseURL: 'http://192.168.1.20:11434', models: [PLAIN] }).record;
    chats.setModel(chat.id, ollama.id, PLAIN.id);
    expect(model.routeLabel).toBe('via your Mac');
    model.setDraft('hi');
    await model.send();
    expect(model.rows[1]!.error).toBe(HOST_UNAVAILABLE_MESSAGE);
  });
});

describe('ChatModel: copy', () => {
  it('copies a message and shows Copied for a moment', async () => {
    const writeText = vi.fn(async () => undefined);
    const { model, chats, chat, timers } = setup({ clipboard: { writeText } });
    chats.addUserMessage(chat.id, 'copy me');
    await model.copy(0);
    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(model.copied).toBe(0);
    expect(model.copyError).toBeUndefined();
    await model.copy(0); // a second copy restarts the timer
    expect(timers.pending).toBe(1);
    timers.fire();
    expect(model.copied).toBeUndefined();
    await model.copy(5); // no such message
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(COPIED_MS).toBeGreaterThan(0);
  });

  it('explains when the browser refuses or has no clipboard', async () => {
    const refused = setup({ clipboard: { writeText: async () => Promise.reject(new Error('denied')) } });
    refused.chats.addUserMessage(refused.chat.id, 'x');
    await refused.model.copy(0);
    expect(refused.model.copied).toBeUndefined();
    expect(refused.model.copyError).toMatch(/did not allow copying/);
    refused.timers.fire();
    expect(refused.model.copyError).toBeUndefined();
    const none = setup();
    none.chats.addUserMessage(none.chat.id, 'x');
    await none.model.copy(0);
    expect(none.model.copyError).toMatch(/did not allow copying/);
  });
});

describe('ChatModel: model picker', () => {
  it('groups every provider with its visible models, the current provider first', () => {
    const { model, providers, direct } = setup();
    const other = providers.add({ baseURL: 'http://192.168.1.20:11434', name: 'Mac Ollama', models: [PLAIN] }).record;
    providers.hideModel(direct.id, PLAIN.id);
    expect(model.pickerOpen).toBe(false);
    model.openPicker();
    expect(model.pickerOpen).toBe(true);
    expect(model.pickerGroups).toEqual([
      { providerId: direct.id, name: 'Fake Cloud', route: 'direct', models: [{ id: 'fake-reasoner', label: 'Fake Reasoner', selected: true }], refreshing: false },
      { providerId: other.id, name: 'Mac Ollama', route: 'via your Mac', models: [{ id: 'fake-mini', label: 'fake-mini', selected: false }], refreshing: false },
    ]);
    model.selectModel(other.id, PLAIN.id);
    expect(model.pickerOpen).toBe(false);
    expect(model.pickerGroups[0]!.providerId).toBe(other.id);
    expect(model.providerName).toBe('Mac Ollama');
    model.selectModel('unknown', 'x'); // ignored
    expect(model.modelId).toBe(PLAIN.id);
    model.openPicker();
    model.closePicker();
    expect(model.pickerOpen).toBe(false);
  });

  it('refreshes a direct provider through the probe and caches the list', async () => {
    const fetch = vi.fn<FetchLike>(async () => ({ status: 200, json: async () => ({ data: [{ id: 'new-model' }] }) }));
    const { model, providers, direct } = setup({ fetch });
    const running = model.refreshModels(direct.id);
    expect(model.pickerGroups[0]!.refreshing).toBe(true);
    void model.refreshModels(direct.id); // already running
    await running;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.fake-provider.test/v1/models');
    expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer sk-fake');
    expect(providers.visibleModels(direct.id).map((m) => m.id)).toEqual(['new-model']);
    expect(model.pickerGroups[0]).toMatchObject({ refreshing: false });
    expect(model.pickerGroups[0]!.error).toBeUndefined();
    await model.refreshModels('unknown'); // ignored
  });

  it('shows the probe sentence when a refresh fails, and a line without fetch', async () => {
    const fetch: FetchLike = async () => ({ status: 401, json: async () => ({}) });
    const failing = setup({ fetch });
    await failing.model.refreshModels(failing.direct.id);
    expect(failing.model.pickerGroups[0]!.error).toBe('Fake Cloud rejected the key. Check that you pasted the whole key.');
    expect(failing.providers.visibleModels(failing.direct.id)).toHaveLength(2); // cache kept
    const bare = setup();
    await bare.model.refreshModels(bare.direct.id);
    expect(bare.model.pickerGroups[0]!.error).toMatch(/cannot be asked for its models/);
  });

  it('refreshes a host-routed provider through provider/models on the Mac', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      models: [{ id: 'llama3.2:3b', displayName: 'Llama 3.2' }, { id: 'qwen3:4b' }, { id: '' }, { nope: 1 }],
    }));
    const host = { state: 'ready', request, onNotification: () => () => undefined, on: () => () => undefined } as unknown as HostLink;
    const { model, providers } = setup({ host });
    const ollama = providers.add({ baseURL: 'http://192.168.1.20:11434' }).record;
    await model.refreshModels(ollama.id);
    expect(request).toHaveBeenCalledWith('provider/models', { baseURL: 'http://192.168.1.20:11434', kind: 'ollama' });
    expect(providers.visibleModels(ollama.id).map((m) => [m.id, m.displayName])).toEqual([
      ['llama3.2:3b', 'Llama 3.2'],
      ['qwen3:4b', 'qwen3:4b'],
    ]);
  });

  it('maps the Mac being away and the relay errors to one sentence', async () => {
    const away = setup({ host: null });
    const p = away.providers.add({ baseURL: 'http://192.168.1.20:11434', name: 'Mac Ollama' }).record;
    await away.model.refreshModels(p.id);
    expect(away.model.pickerGroups.find((g) => g.providerId === p.id)?.error).toBe(HOST_UNAVAILABLE_MESSAGE);

    const cases: [unknown, string][] = [
      [{ code: 'connection_lost' }, HOST_UNAVAILABLE_MESSAGE],
      [{ code: 'provider_unavailable', data: { reason: 'unreachable' } }, 'Mac Ollama is not reachable. Check the address and that the server is running.'],
      [{ code: 'internal' }, 'Mac Ollama could not list its models. Try again.'],
      [null, 'Mac Ollama answered but lists no models. Check the server.'],
    ];
    for (const [error, sentence] of cases) {
      const request = vi.fn(async () => {
        if (error === null) return {};
        throw error;
      });
      const host = { state: 'ready', request } as unknown as HostLink;
      const s = setup({ host });
      const gemini = s.providers.add({ baseURL: 'http://gemini-box.local:8080', name: 'Mac Ollama' }).record;
      await s.model.refreshModels(gemini.id);
      expect(s.model.pickerGroups.find((g) => g.providerId === gemini.id)?.error).toBe(sentence);
    }
  });

  it('omits the kind for a gemini provider on the host route, and drops a list for a removed provider', async () => {
    let release: (() => void) | undefined;
    const request = vi.fn(async (_m: string, _p?: Record<string, unknown>) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { models: [{ id: 'g' }] };
    });
    const host = { state: 'ready', request } as unknown as HostLink;
    const { model, providers } = setup({ host });
    const p = providers.add({ baseURL: 'http://10.0.0.2:8080' }).record;
    // A record whose kind is gemini (as an import of an odd record could leave it).
    (providers as unknown as { records: { id: string; kind: string }[] }).records.find((r) => r.id === p.id)!.kind = 'gemini';
    const running = model.refreshModels(p.id);
    await flush();
    providers.remove(p.id);
    release!();
    await running;
    expect(request.mock.calls[0]![1]).toEqual({ baseURL: 'http://10.0.0.2:8080' });
    expect(providers.get(p.id)).toBeUndefined();
  });
});

describe('chat services', () => {
  it('build the stores and an engine that reads the host slot at each chat', async () => {
    const storage = new MemoryStorage();
    const services = createChatServices({ storage, fetch: fakeFetch().fetch });
    expect(hasLocalChat(services)).toBe(false);
    const p = services.providers.add({ baseURL: 'http://192.168.1.20:11434' }).record;
    expect(hasLocalChat(services)).toBe(true);
    const events: ChatEvent[] = [];
    for await (const e of services.engine.chat(p, 'm', [{ role: 'user', content: 'hi' }])) events.push(e);
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'host_unavailable' })]);
    const link = { state: 'connecting' } as unknown as HostLink;
    services.host.set(link);
    expect(services.host.current).toBe(link);
    services.host.set(null);
    expect(new HostSlot().current).toBeNull();
    const withoutFetch = createChatServices({ storage: null });
    withoutFetch.chats.create('p', 'm');
    expect(hasLocalChat(withoutFetch)).toBe(true);
  });
});
