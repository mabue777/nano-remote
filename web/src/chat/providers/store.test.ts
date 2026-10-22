import { describe, expect, it, vi } from 'vitest';

import type { StorageLike } from '../../replica/storage';
import {
  clampRefresh,
  defaultName,
  fingerprint,
  PROVIDER_KEYS_STORAGE_KEY,
  PROVIDERS_STORAGE_KEY,
  ProviderStore,
} from './store';
import type { ModelInfo } from './types';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function setup(storage: StorageLike | null = new MemoryStorage()) {
  let n = 0;
  let clock = 1_000;
  const store = new ProviderStore({ storage, randomId: () => `id-${++n}`, now: () => clock });
  return { store, storage, tick: (ms: number) => (clock += ms) };
}

const model = (id: string): ModelInfo => ({ id, displayName: id, capabilities: {}, source: 'unknown' });

const OPENAI = 'https://api.openai.com/v1';
const OLLAMA_LAN = 'http://192.168.1.20:11434';

describe('helpers', () => {
  it('clamps the auto refresh interval to 30 s .. 1 day', () => {
    expect(clampRefresh({ mode: 'manual' })).toEqual({ mode: 'manual' });
    expect(clampRefresh({ mode: 'auto', intervalSeconds: 5 })).toEqual({ mode: 'auto', intervalSeconds: 30 });
    expect(clampRefresh({ mode: 'auto', intervalSeconds: 10 ** 9 })).toEqual({ mode: 'auto', intervalSeconds: 86_400 });
    expect(clampRefresh({ mode: 'auto', intervalSeconds: 600.4 })).toEqual({ mode: 'auto', intervalSeconds: 600 });
    expect(clampRefresh({ mode: 'auto', intervalSeconds: Number.NaN })).toEqual({ mode: 'auto', intervalSeconds: 30 });
  });

  it('fingerprints a key by its first 6 characters', () => {
    expect(fingerprint('sk-proj-abcdef')).toBe('sk-pro');
  });

  it('names a provider after its preset or its host', () => {
    expect(defaultName(OPENAI)).toBe('OpenAI');
    expect(defaultName('http://mac.local:11434')).toBe('mac.local:11434');
  });
});

describe('add', () => {
  it('creates a record exactly as section 1, with the key kept apart', () => {
    const { store, storage } = setup();
    const { record, created } = store.add({ baseURL: 'https://API.openai.com/v1/', apiKey: 'sk-proj-secret', models: [model('gpt-5')] });
    expect(created).toBe(true);
    expect(record).toEqual({
      id: 'id-1',
      name: 'OpenAI',
      baseURL: OPENAI,
      kind: 'openai-compatible',
      apiKeyFingerprint: 'sk-pro',
      models: { list: [model('gpt-5')], lastProbedAt: 1_000 },
      hiddenModels: [],
      pinnedModels: [],
      supportsTools: 'unknown',
      refresh: { mode: 'manual' },
    });
    expect(store.getKey('id-1')).toBe('sk-proj-secret');
    const mem = storage as MemoryStorage;
    expect(mem.getItem(PROVIDERS_STORAGE_KEY)).not.toContain('sk-proj-secret');
    expect(JSON.parse(mem.getItem(PROVIDER_KEYS_STORAGE_KEY) ?? '')).toEqual({ v: 1, keys: { 'id-1': 'sk-proj-secret' } });
  });

  it('makes the first provider the default for new chats', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI });
    store.add({ baseURL: 'https://api.anthropic.com' });
    expect(store.defaultProviderId).toBe('id-1');
    store.setDefault('id-2');
    expect(store.defaultProviderId).toBe('id-2');
    expect(() => store.setDefault('nope')).toThrow(/no provider/);
  });

  it('deduplicates by normalized base URL and updates in place', () => {
    const { store, tick } = setup();
    store.add({ baseURL: OPENAI, apiKey: 'sk-proj-one' });
    tick(500);
    const again = store.add({
      baseURL: 'api.openai.com/v1/',
      name: '  Work  ',
      apiKey: 'sk-proj-two',
      models: [model('o9')],
      supportsTools: 'yes',
      refresh: { mode: 'auto', intervalSeconds: 1 },
    });
    expect(again.created).toBe(false);
    expect(again.record).toMatchObject({
      id: 'id-1',
      name: 'Work',
      supportsTools: 'yes',
      refresh: { mode: 'auto', intervalSeconds: 30 },
      models: { list: [model('o9')], lastProbedAt: 1_500 },
    });
    expect(store.list()).toHaveLength(1);
    expect(store.getKey('id-1')).toBe('sk-proj-two');
  });

  it('derives kind and route from the URL', () => {
    const { store } = setup();
    expect(store.add({ baseURL: 'https://api.anthropic.com' }).record.kind).toBe('anthropic');
    expect(store.add({ baseURL: OLLAMA_LAN }).record.kind).toBe('ollama');
    expect(store.routeOf('id-1')).toBe('direct');
    expect(store.routeOf('id-2')).toBe('host');
  });

  it('refuses a key for a provider routed through the host (R2) and an invalid URL', () => {
    const { store } = setup();
    expect(() => store.add({ baseURL: OLLAMA_LAN, apiKey: 'k' })).toThrow(/runs through your Mac/);
    expect(store.list()).toEqual([]);
    expect(() => store.add({ baseURL: 'ftp://x' })).toThrow(/not a base URL/);
    expect(store.add({ baseURL: OLLAMA_LAN, apiKey: null }).record.apiKeyFingerprint).toBeNull();
  });
});

describe('reads', () => {
  it('returns copies that do not alias the store', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI, models: [model('a')] });
    const copy = store.get('id-1');
    copy?.models.list.push(model('b'));
    copy?.hiddenModels.push('a');
    store.list()[0]?.pinnedModels.push('z');
    expect(store.get('id-1')?.models.list).toEqual([model('a')]);
    expect(store.get('id-1')?.hiddenModels).toEqual([]);
    expect(store.get('id-1')?.pinnedModels).toEqual([]);
    expect(store.get('missing')).toBeUndefined();
  });

  it('finds a record by any spelling of its base URL', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI });
    expect(store.findByBaseURL('HTTPS://api.openai.com:443/v1/')?.id).toBe('id-1');
    expect(store.findByBaseURL('https://api.x.ai/v1')).toBeUndefined();
  });
});

describe('update', () => {
  it('renames and changes settings', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI });
    const updated = store.update('id-1', { name: 'Mine', supportsTools: 'no', refresh: { mode: 'auto', intervalSeconds: 100 } });
    expect(updated).toMatchObject({ name: 'Mine', supportsTools: 'no', refresh: { mode: 'auto', intervalSeconds: 100 } });
    expect(store.update('id-1', { name: '   ' }).name).toBe('Mine');
  });

  it('re-derives the kind on a new URL, clears the cache, and drops the key when the route becomes host', () => {
    const { store } = setup();
    store.add({ baseURL: 'https://ollama.com', apiKey: 'ollama-key', models: [model('m')] });
    const same = store.update('id-1', { baseURL: 'https://OLLAMA.com/' });
    expect(same.models.list).toEqual([model('m')]);
    const moved = store.update('id-1', { baseURL: OLLAMA_LAN });
    expect(moved).toMatchObject({ baseURL: OLLAMA_LAN, kind: 'ollama', apiKeyFingerprint: null, models: { list: [], lastProbedAt: null } });
    expect(store.getKey('id-1')).toBeNull();
    const cloud = store.update('id-1', { baseURL: 'https://api.anthropic.com' });
    expect(cloud.kind).toBe('anthropic');
  });

  it('refuses a URL that another record uses, an invalid URL, or an unknown id', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI });
    store.add({ baseURL: 'https://api.x.ai/v1' });
    expect(() => store.update('id-2', { baseURL: 'api.openai.com/v1' })).toThrow(/already uses/);
    expect(() => store.update('id-2', { baseURL: '' })).toThrow(/not a base URL/);
    expect(() => store.update('nope', {})).toThrow(/no provider/);
  });
});

describe('keys', () => {
  it('sets, replaces and deletes the key of a direct provider', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI });
    expect(store.needsKey('id-1')).toBe(true);
    store.setKey('id-1', 'sk-proj-123456789');
    expect(store.get('id-1')?.apiKeyFingerprint).toBe('sk-pro');
    expect(store.needsKey('id-1')).toBe(false);
    store.setKey('id-1', '');
    expect(store.getKey('id-1')).toBeNull();
    store.setKey('id-1', 'x');
    store.setKey('id-1', null);
    expect(store.get('id-1')?.apiKeyFingerprint).toBeNull();
  });

  it('never keeps a key for a host-routed provider and never asks for one', () => {
    const { store } = setup();
    store.add({ baseURL: OLLAMA_LAN });
    expect(() => store.setKey('id-1', 'k')).toThrow(/runs through your Mac/);
    expect(store.needsKey('id-1')).toBe(false);
  });
});

describe('remove', () => {
  it('removes a record with its key and moves the default', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI, apiKey: 'sk-proj-1' });
    store.add({ baseURL: 'https://api.x.ai/v1' });
    store.remove('id-1');
    expect(store.getKey('id-1')).toBeNull();
    expect(store.defaultProviderId).toBe('id-2');
    store.remove('id-1');
    store.remove('id-2');
    expect(store.defaultProviderId).toBeNull();
  });

  it('keeps the default when another record goes', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI });
    store.add({ baseURL: 'https://api.x.ai/v1' });
    store.remove('id-2');
    expect(store.defaultProviderId).toBe('id-1');
  });

  it('removeAll clears records, keys and the default', () => {
    const { store, storage } = setup();
    store.add({ baseURL: OPENAI, apiKey: 'sk-proj-1' });
    store.removeAll();
    expect(store.list()).toEqual([]);
    expect(store.defaultProviderId).toBeNull();
    expect(JSON.parse((storage as MemoryStorage).getItem(PROVIDER_KEYS_STORAGE_KEY) ?? '')).toEqual({ v: 1, keys: {} });
  });
});

describe('models cache, hidden and pinned', () => {
  it('caches a probe with lastProbedAt', () => {
    const { store, tick } = setup();
    store.add({ baseURL: OPENAI });
    tick(42);
    store.setModels('id-1', [model('a'), model('b')]);
    expect(store.get('id-1')?.models).toEqual({ list: [model('a'), model('b')], lastProbedAt: 1_042 });
  });

  it('hides failed ids and pins ids the list does not return', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI, models: [model('a'), model('b')] });
    store.hideModel('id-1', 'a');
    store.hideModel('id-1', 'a');
    store.pinModel('id-1', 'custom-ft');
    store.pinModel('id-1', 'b');
    store.pinModel('id-1', 'secret');
    store.hideModel('id-1', 'secret');
    expect(store.get('id-1')?.hiddenModels).toEqual(['a', 'secret']);
    expect(store.visibleModels('id-1').map((m) => m.id)).toEqual(['b', 'custom-ft']);
    store.unhideModel('id-1', 'a');
    store.unpinModel('id-1', 'custom-ft');
    expect(store.visibleModels('id-1').map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('export and import', () => {
  it('exports records without keys, fingerprints or cached models', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI, apiKey: 'sk-proj-secret', models: [model('gpt-5')] });
    store.pinModel('id-1', 'ft-1');
    const data = store.export();
    expect(data).toEqual({
      format: 'nano-remote/providers',
      v: 1,
      providers: [
        {
          id: 'id-1',
          name: 'OpenAI',
          baseURL: OPENAI,
          kind: 'openai-compatible',
          hiddenModels: [],
          pinnedModels: ['ft-1'],
          supportsTools: 'unknown',
          refresh: { mode: 'manual' },
        },
      ],
    });
    expect(JSON.stringify(data)).not.toMatch(/sk-pro/);
  });

  it('export, delete all, import: providers return without keys and ask for them', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI, apiKey: 'sk-proj-secret' });
    store.add({ baseURL: OLLAMA_LAN });
    const data = JSON.parse(JSON.stringify(store.export())) as unknown;
    store.removeAll();
    expect(store.import(data)).toEqual({ added: 2, updated: 0, skipped: 0 });
    const [openai, ollama] = store.list();
    expect(openai).toMatchObject({ id: 'id-3', baseURL: OPENAI, apiKeyFingerprint: null });
    expect(ollama).toMatchObject({ id: 'id-4', baseURL: OLLAMA_LAN, kind: 'ollama' });
    expect(store.needsKey('id-3')).toBe(true);
    expect(store.needsKey('id-4')).toBe(false);
    expect(store.defaultProviderId).toBe('id-3');
  });

  it('merges by normalized base URL, keeping id, key and cache', () => {
    const { store } = setup();
    store.add({ baseURL: OPENAI, apiKey: 'sk-proj-1', models: [model('a')] });
    store.hideModel('id-1', 'x');
    const result = store.import({
      format: 'nano-remote/providers',
      v: 1,
      providers: [
        {
          id: 'foreign',
          name: 'Renamed',
          baseURL: 'HTTPS://api.openai.com/v1/',
          kind: 'anthropic',
          hiddenModels: ['y', 7],
          pinnedModels: ['p'],
          supportsTools: 'yes',
          refresh: { mode: 'auto', intervalSeconds: 999_999 },
        },
        { baseURL: 'https://api.anthropic.com', kind: 'openai-compatible', supportsTools: 'maybe', refresh: { mode: 'auto' } },
        { name: 'no url' },
        { baseURL: 'gopher://x' },
        'junk',
      ],
    });
    expect(result).toEqual({ added: 1, updated: 1, skipped: 3 });
    expect(store.get('id-1')).toMatchObject({
      name: 'Renamed',
      kind: 'openai-compatible',
      apiKeyFingerprint: 'sk-pro',
      models: { list: [model('a')] },
      hiddenModels: ['x', 'y'],
      pinnedModels: ['p'],
      supportsTools: 'yes',
      refresh: { mode: 'auto', intervalSeconds: 86_400 },
    });
    expect(store.getKey('id-1')).toBe('sk-proj-1');
    expect(store.get('id-2')).toMatchObject({
      name: 'Anthropic',
      kind: 'anthropic',
      supportsTools: 'unknown',
      refresh: { mode: 'manual' },
      hiddenModels: [],
    });
  });

  it('throws for something that is not an export', () => {
    const { store } = setup();
    expect(() => store.import(null)).toThrow(/not a Nano Remote providers export/);
    expect(() => store.import({ format: 'nano-remote/providers', v: 2, providers: [] })).toThrow();
    expect(() => store.import({ v: 1, providers: [] })).toThrow();
  });
});

describe('persistence', () => {
  it('survives a reload', () => {
    const storage = new MemoryStorage();
    const first = setup(storage).store;
    first.add({ baseURL: OPENAI, apiKey: 'sk-proj-1', models: [model('a')] });
    first.add({ baseURL: OLLAMA_LAN });
    first.setDefault('id-2');
    const second = new ProviderStore({ storage });
    expect(second.list()).toEqual(first.list());
    expect(second.getKey('id-1')).toBe('sk-proj-1');
    expect(second.defaultProviderId).toBe('id-2');
  });

  it('starts empty on missing, corrupt or other-version data and drops malformed records', () => {
    const storage = new MemoryStorage();
    expect(new ProviderStore({ storage }).list()).toEqual([]);
    storage.setItem(PROVIDERS_STORAGE_KEY, '{nope');
    storage.setItem(PROVIDER_KEYS_STORAGE_KEY, '{nope');
    expect(new ProviderStore({ storage }).list()).toEqual([]);
    storage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify({ v: 2, providers: [] }));
    storage.setItem(PROVIDER_KEYS_STORAGE_KEY, JSON.stringify({ v: 1, keys: null }));
    expect(new ProviderStore({ storage }).list()).toEqual([]);

    const good = setup(new MemoryStorage());
    good.store.add({ baseURL: OPENAI });
    const record = good.store.get('id-1');
    storage.setItem(
      PROVIDERS_STORAGE_KEY,
      JSON.stringify({ v: 1, providers: [record, { id: 'bad' }, null, { ...record, id: 'x', models: null }], defaultProviderId: 'gone' }),
    );
    storage.setItem(PROVIDER_KEYS_STORAGE_KEY, JSON.stringify({ v: 1, keys: { 'id-1': 'sk-proj-1', other: 5 } }));
    const loaded = new ProviderStore({ storage });
    expect(loaded.list().map((r) => r.id)).toEqual(['id-1']);
    expect(loaded.defaultProviderId).toBe('id-1');
    expect(loaded.getKey('id-1')).toBe('sk-proj-1');
    expect(loaded.getKey('other')).toBeNull();

    storage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify({ v: 1, providers: [], defaultProviderId: 7 }));
    expect(new ProviderStore({ storage }).defaultProviderId).toBeNull();
  });

  it('keeps working in memory without storage or when writes fail', () => {
    const none = setup(null).store;
    none.add({ baseURL: OPENAI });
    expect(none.list()).toHaveLength(1);

    const storage = new MemoryStorage();
    storage.failWrites = true;
    const failing = setup(storage).store;
    failing.add({ baseURL: OPENAI });
    expect(failing.list()).toHaveLength(1);
    expect(storage.data.size).toBe(0);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(new ProviderStore({ storage: throwing }).list()).toEqual([]);
  });

  it('uses the injected keys and a random UUID by default', () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore({ storage, recordsKey: 'r', keysKey: 'k' });
    const { record } = store.add({ baseURL: OPENAI, apiKey: 'sk-proj-1' });
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.models.lastProbedAt).toBeNull();
    expect([...storage.data.keys()].sort()).toEqual(['k', 'r']);
  });
});

describe('subscribe', () => {
  it('notifies after every change until unsubscribed', () => {
    const { store } = setup();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.add({ baseURL: OPENAI });
    store.setModels('id-1', []);
    off();
    store.remove('id-1');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
