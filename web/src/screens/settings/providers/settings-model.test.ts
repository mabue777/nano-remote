import { describe, expect, it, vi } from 'vitest';

import { MemoryStorage } from '../../../../test/replica-doubles';
import type { HostRequester } from '../../../chat/providers/host-probe';
import { CUSTOM_PRESET, PRESETS } from '../../../chat/providers/presets';
import { HOST_UNAVAILABLE_MESSAGE, type FetchLike } from '../../../chat/providers/probe';
import { ProviderStore } from '../../../chat/providers/store';
import type { ClientState } from '../../../stream/client';
import {
  DISCOVERY_FAILED,
  EXPORT_FILENAME,
  kindLabel,
  NO_CANDIDATES,
  NO_HOST_DISCOVERY,
  NOT_AN_EXPORT,
  ProviderSettingsModel,
  readCandidate,
  routeLabel,
  type ProviderSettingsOptions,
} from './settings-model';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const OPENAI_MODELS = { data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] };

/** A fetch that answers by URL: a status and a JSON body, or a thrown network error. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown } | 'down'> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const answer = answers[url] ?? { status: 200, body: OPENAI_MODELS };
    if (answer === 'down') throw new TypeError('Failed to fetch');
    return { status: answer.status, json: async () => answer.body };
  };
  return { fetch, calls };
}

function fakeHost(state: ClientState, answer: (method: string, params?: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => answer(method, params));
  return { host: { state, request } as unknown as HostRequester, request };
}

let ids = 0;
function setup(options: Partial<ProviderSettingsOptions> = {}) {
  const storage = new MemoryStorage();
  const providers = new ProviderStore({ storage, now: () => NOW, randomId: () => `prv_${++ids}` });
  const { fetch, calls } = fakeFetch();
  const model = new ProviderSettingsModel({ providers, host: () => null, fetch, now: () => NOW + 5 * 60_000, ...options });
  return { model, providers, storage, calls };
}

const openai = PRESETS.find((p) => p.name === 'OpenAI')!;
const ollamaLocal = PRESETS.find((p) => p.name === 'Ollama (local)')!;

describe('labels', () => {
  it('names kinds and routes in plain words', () => {
    expect(kindLabel('openai-compatible')).toBe('OpenAI-compatible');
    expect(kindLabel('gemini')).toBe('Gemini');
    expect(routeLabel('direct')).toBe('direct');
    expect(routeLabel('host')).toBe('via your Mac');
  });
});

describe('the one field: live detection', () => {
  it('a known key prefix selects its preset and pre-fills the base URL; no URL typed', () => {
    const { model } = setup();
    model.openAdd();
    model.setPaste('sk-proj-abc123');
    expect(model.form).toMatchObject({ preset: openai, baseURL: 'https://api.openai.com/v1', apiKey: 'sk-proj-abc123' });
    expect(model.detectionText).toBe('OpenAI key · direct');
    expect(model.formName).toBe('OpenAI');
    expect(model.formRoute).toBe('direct');
    expect(model.formKind).toBe('openai-compatible');
    expect(model.keyAllowed).toBe(true);
  });

  it('a URL selects Custom with the kind from the host and the route from ADR 0006', () => {
    const { model } = setup();
    model.openAdd();
    model.setPaste('192.168.1.20:11434');
    expect(model.form).toMatchObject({ preset: CUSTOM_PRESET, baseURL: 'http://192.168.1.20:11434', apiKey: '' });
    expect(model.detectionText).toBe('Server URL · Ollama · via your Mac');
    expect(model.formName).toBe('192.168.1.20:11434');
    expect(model.keyAllowed).toBe(false);
  });

  it('an unknown key waits for a preset; tapping one keeps the key', () => {
    const { model } = setup();
    model.openAdd();
    model.setPaste('mystery-key-123');
    expect(model.detectionText).toBe('A key: pick its provider below.');
    expect(model.formBaseURL).toBeNull();
    expect(model.canTest).toBe(false);
    const mistral = PRESETS.find((p) => p.name === 'Mistral')!;
    model.choosePreset(mistral);
    expect(model.form).toMatchObject({ preset: mistral, baseURL: 'https://api.mistral.ai/v1', apiKey: 'mystery-key-123' });
    expect(model.detectionText).toBe('Key for Mistral');
    // Editing the paste keeps the chosen preset's URL.
    model.setPaste('mystery-key-456');
    expect(model.form).toMatchObject({ baseURL: 'https://api.mistral.ai/v1', apiKey: 'mystery-key-456' });
  });

  it('clearing the field clears the guess; Custom keeps a typed URL', () => {
    const { model } = setup();
    model.openAdd();
    model.setPaste('sk-ant-xyz');
    model.setPaste('  ');
    expect(model.form).toMatchObject({ preset: null, baseURL: '', apiKey: '', detection: { type: 'empty' } });
    expect(model.detectionText).toBe('');
    model.choosePreset(CUSTOM_PRESET);
    model.setBaseURL('https://llm.example.com/v1');
    model.choosePreset(CUSTOM_PRESET);
    expect(model.form?.baseURL).toBe('https://llm.example.com/v1');
    model.choosePreset(ollamaLocal);
    model.choosePreset(CUSTOM_PRESET);
    expect(model.form?.baseURL).toBe('');
  });

  it('does nothing without an open form', () => {
    const { model } = setup();
    model.setPaste('sk-proj-1');
    model.choosePreset(openai);
    model.setBaseURL('x');
    model.setApiKey('x');
    model.setName('x');
    expect(model.form).toBeNull();
    expect(model.detectionText).toBe('');
    expect(model.formName).toBe('');
    expect(model.formBaseURL).toBeNull();
    expect(model.formRoute).toBeNull();
    expect(model.formKind).toBeNull();
    expect(model.canTest).toBe(false);
    expect(model.canAdd).toBe(false);
    expect(model.canAddWithoutTesting).toBe(false);
    expect(model.save()).toBeNull();
  });
});

describe('test before add', () => {
  it('lists the models live, then enables Add; Add saves key, models and the first default', async () => {
    const { model, providers, calls } = setup();
    model.openAdd();
    model.setPaste('sk-proj-abc123');
    expect(model.canAdd).toBe(false);
    expect(model.canAddWithoutTesting).toBe(true);
    const pending = model.test();
    expect(model.form?.test).toEqual({ status: 'testing' });
    expect(model.canTest).toBe(false);
    expect(model.canAddWithoutTesting).toBe(false);
    await pending;
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer sk-proj-abc123' } });
    expect(model.form?.test).toMatchObject({ status: 'ok', models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] });
    expect(model.canAdd).toBe(true);
    expect(model.canAddWithoutTesting).toBe(false);

    const id = model.save();
    expect(model.form).toBeNull();
    expect(model.notice).toBe('Added OpenAI.');
    expect(providers.defaultProviderId).toBe(id);
    expect(providers.getKey(id!)).toBe('sk-proj-abc123');
    expect(model.rows).toEqual([
      {
        id,
        name: 'OpenAI',
        baseURL: 'https://api.openai.com/v1',
        kind: 'OpenAI-compatible',
        route: 'direct',
        key: 'key sk-pro…',
        models: '2 models',
        probed: 'probed 5 min ago',
        isDefault: true,
        source: 'phone',
        needsKey: false,
      },
    ]);
    model.dismissNotice();
    model.dismissNotice();
    expect(model.notice).toBeUndefined();
  });

  it('any change after a test makes it stale', async () => {
    const { model } = setup();
    model.openAdd();
    model.setPaste('sk-proj-abc123');
    await model.test();
    model.setApiKey('sk-proj-other');
    expect(model.form?.test).toEqual({ status: 'idle' });
    expect(model.canAdd).toBe(false);
    // The name is not part of the test.
    await model.test();
    model.setName('Work OpenAI');
    expect(model.canAdd).toBe(true);
  });

  it.each([
    [{ status: 401 }, 'wrong-key', 'OpenAI rejected the key. Check that you pasted the whole key.'],
    [{ status: 429 }, 'rate-limited', 'OpenAI is rate limiting requests. Wait a minute and try again.'],
    ['down', 'unreachable', 'OpenAI did not answer within 10 seconds. Check the address and that the server is running.'],
    [{ status: 404 }, 'not-found', 'OpenAI has no model list at this address. Check the base URL.'],
  ] as const)('a failed test (%s) gives one sentence and keeps Add off', async (answer, code, message) => {
    const { fetch } = fakeFetch({ 'https://api.openai.com/v1/models': answer });
    const { model } = setup({ fetch });
    model.openAdd();
    model.setPaste('sk-proj-abc123');
    await model.test();
    expect(model.form?.test).toEqual({ status: 'failed', code, message });
    expect(model.canAdd).toBe(false);
    expect(model.canAddWithoutTesting).toBe(true);
    expect(model.save()).toBeNull();
  });

  it('names a Custom server by its typed name, else its host', async () => {
    const { fetch } = fakeFetch({ 'https://llm.example.com:8443/v1/models': { status: 401 } });
    const { model } = setup({ fetch });
    model.openAdd();
    model.setPaste('https://llm.example.com:8443/v1');
    model.setApiKey('sk-wrong');
    await model.test();
    expect(model.form?.test).toMatchObject({ message: 'llm.example.com:8443 rejected the key. Check that you pasted the whole key.' });
    model.setName('Lab server');
    await model.test();
    expect(model.form?.test).toMatchObject({ message: 'Lab server rejected the key. Check that you pasted the whole key.' });
  });

  it('reachable but no models: saved anyway, with the hint', async () => {
    const { fetch } = fakeFetch({ 'https://api.openai.com/v1/models': { status: 200, body: { data: [] } } });
    const { model, providers } = setup({ fetch });
    model.openAdd();
    model.setPaste('sk-proj-abc123');
    await model.test();
    expect(model.form?.test).toEqual({ status: 'empty', message: 'OpenAI answered but lists no models. Check the key or the service status.' });
    expect(model.canAdd).toBe(true);
    const id = model.save()!;
    expect(providers.get(id)?.models.lastProbedAt).toBeNull();
  });

  it('"Add without testing" saves an offline server; Add alone does not', () => {
    const { model, providers } = setup();
    model.openAdd();
    model.setPaste('http://192.168.1.20:11434');
    expect(model.save()).toBeNull();
    const id = model.save({ withoutTesting: true })!;
    expect(providers.get(id)).toMatchObject({ baseURL: 'http://192.168.1.20:11434', kind: 'ollama', apiKeyFingerprint: null });
    expect(model.rows[0]).toMatchObject({ route: 'via your Mac', key: 'no key', models: 'no models yet', probed: 'never probed', needsKey: false });
  });

  it('a test of a host-routed server goes through the Mac, and says so when the Mac is away', async () => {
    const away = setup();
    away.model.openAdd();
    away.model.setPaste('http://192.168.1.20:11434');
    await away.model.test();
    expect(away.model.form?.test).toEqual({ status: 'failed', code: 'host-unavailable', message: HOST_UNAVAILABLE_MESSAGE });

    const { host, request } = fakeHost('ready', () => ({ models: [{ id: 'llama3.2:1b' }] }));
    const paired = setup({ host: () => host });
    paired.model.openAdd();
    paired.model.setPaste('http://192.168.1.20:11434');
    paired.model.setApiKey('ignored');
    await paired.model.test();
    expect(request).toHaveBeenCalledWith('provider/models', { baseURL: 'http://192.168.1.20:11434', kind: 'ollama' });
    expect(paired.model.form?.test).toMatchObject({ status: 'ok', models: [{ id: 'llama3.2:1b' }] });
    const id = paired.model.save()!;
    expect(paired.providers.get(id)?.apiKeyFingerprint).toBeNull(); // the key stays on the Mac (R2)
  });

  it('closing the form or a new change drops a test that is still running', async () => {
    let release: (() => void) | undefined;
    const fetch: FetchLike = (_url, init) =>
      new Promise((resolve, reject) => {
        release = () => resolve({ status: 200, json: async () => OPENAI_MODELS });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const { model } = setup({ fetch });
    model.openAdd();
    model.setPaste('sk-proj-abc123');
    const first = model.test();
    model.setApiKey('sk-proj-xyz');
    await first;
    expect(model.form?.test).toEqual({ status: 'idle' });
    const second = model.test();
    await model.test(); // already testing: ignored
    model.closeForm();
    release?.();
    await second;
    expect(model.form).toBeNull();
  });

  it('ignores Test without a valid address', async () => {
    const { model, calls } = setup();
    model.openAdd();
    model.setBaseURL('not a url');
    await model.test();
    expect(calls).toEqual([]);
    expect(model.form?.test).toEqual({ status: 'idle' });
  });
});

describe('save: dedupe and edit', () => {
  it('deduplicates by normalized base URL: the same server added twice updates the first', async () => {
    const { model, providers } = setup();
    model.openAdd();
    model.setPaste('sk-proj-first');
    await model.test();
    const first = model.save()!;
    model.openAdd();
    model.setPaste('HTTPS://API.OPENAI.COM/v1/');
    expect(model.duplicate?.name).toBe('OpenAI');
    model.setApiKey('sk-proj-second');
    await model.test();
    expect(model.save()).toBe(first);
    expect(model.notice).toBe('Updated OpenAI: it was already in your list.');
    expect(providers.list()).toHaveLength(1);
    expect(providers.getKey(first)).toBe('sk-proj-second');
  });

  it('edits name, URL and key; an empty key keeps the saved one; a taken URL is refused in one sentence', async () => {
    const { model, providers } = setup();
    const a = providers.add({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-proj-aaa' }).record;
    const b = providers.add({ baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk_bbb' }).record;
    model.openEdit('nope');
    expect(model.form).toBeNull();
    model.openEdit(a.id);
    expect(model.form).toMatchObject({ mode: 'edit', id: a.id, baseURL: 'https://api.openai.com/v1', name: 'OpenAI', preset: openai });
    expect(model.canAdd).toBe(true); // edits may be saved without a test
    expect(model.canAddWithoutTesting).toBe(false);
    expect(model.duplicate).toBeUndefined();
    model.setName('Work');
    expect(model.save()).toBe(a.id);
    expect(model.notice).toBe('Saved Work.');
    expect(providers.getKey(a.id)).toBe('sk-proj-aaa');

    model.openEdit(b.id);
    expect(model.form?.preset).toBe(PRESETS.find((p) => p.name === 'Groq'));
    model.setBaseURL('https://api.openai.com/v1');
    expect(model.save()).toBeNull();
    expect(model.form?.error).toBe('Another provider already uses this address. Edit that one instead.');
    model.setName('Groq 2'); // typing clears the error
    expect(model.form?.error).toBeUndefined();
    model.setBaseURL('https://api.groq.com/openai/v1');
    model.setApiKey('gsk_new');
    await model.test();
    model.save();
    expect(providers.getKey(b.id)).toBe('gsk_new');
    expect(providers.get(b.id)?.models.list.map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
  });

  it('opens a Custom form for a provider that is not a preset', () => {
    const { model, providers } = setup();
    const p = providers.add({ baseURL: 'https://llm.example.com/v1' }).record;
    model.openEdit(p.id);
    expect(model.form?.preset).toBe(CUSTOM_PRESET);
    model.closeForm();
    expect(model.form).toBeNull();
  });
});

describe('the list', () => {
  it('shows phone rows, the default marker, and the Mac-kept providers read-only with their model count', async () => {
    const { host, request } = fakeHost('ready', (method, params) => {
      if (method === 'provider/list') {
        return {
          providers: [
            { id: 'prv_studio', name: 'Studio vLLM', baseURL: 'http://studio.local:8000/v1/', kind: 'openai-compatible', hasKey: true },
            { id: 'prv_box', name: ' ', baseURL: 'http://box.local:11434', kind: 'weird', hasKey: false },
            { id: 'prv_same', name: 'Same', baseURL: 'https://api.openai.com/v1', kind: 'openai-compatible', hasKey: true },
            { id: '', baseURL: 'http://x.local' },
            'junk',
          ],
        };
      }
      if (params?.providerId === 'prv_studio') return { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
      if (params?.providerId === 'prv_box') return { models: [] };
      throw { code: 'provider_unavailable' };
    });
    const { model, providers } = setup({ host: () => host });
    const a = providers.add({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-proj-aaa', models: [{ id: 'm', displayName: 'm', capabilities: {}, source: 'unknown' }] }).record;
    const b = providers.add({ baseURL: 'https://api.groq.com/openai/v1' }).record;
    await model.loadHostProviders();
    expect(request).toHaveBeenCalledWith('provider/list');
    const rows = model.rows;
    expect(rows.map((r) => [r.name, r.source, r.isDefault])).toEqual([
      ['OpenAI', 'phone', true],
      ['Groq', 'phone', false],
      ['Studio vLLM', 'mac', false],
      ['box.local:11434', 'mac', false],
    ]);
    expect(rows[1]).toMatchObject({ models: 'no models yet', probed: 'never probed', needsKey: true, key: 'no key' });
    expect(rows[2]).toEqual({
      id: 'prv_studio',
      name: 'Studio vLLM',
      baseURL: 'http://studio.local:8000/v1',
      kind: 'OpenAI-compatible',
      route: 'via your Mac',
      key: 'key on your Mac',
      models: '3 models',
      probed: '',
      isDefault: false,
      source: 'mac',
      needsKey: false,
    });
    expect(rows[3]).toMatchObject({ kind: 'OpenAI-compatible', key: 'no key', models: 'no models yet' });
    expect(rows[0]?.models).toBe('1 model');
    model.setDefault(b.id);
    expect(model.rows.find((r) => r.id === a.id)?.isDefault).toBe(false);
  });

  it('says "models on your Mac" until a count arrives, and keeps the list when provider/list fails', async () => {
    let fail = false;
    const { host } = fakeHost('ready', (method) => {
      if (method === 'provider/list') {
        if (fail) throw { code: 'internal' };
        return { providers: [{ id: 'p', name: 'P', baseURL: 'http://p.local:1', kind: 'ollama', hasKey: false }] };
      }
      return { nope: true };
    });
    const { model } = setup({ host: () => host });
    await model.loadHostProviders();
    expect(model.rows[0]?.models).toBe('models on your Mac');
    fail = true;
    await model.loadHostProviders();
    expect(model.rows).toHaveLength(1);
  });

  it('without a host, or with a list that is not one, shows only this phone', async () => {
    const { model } = setup();
    await model.loadHostProviders();
    expect(model.empty).toBe(true);
    const { host } = fakeHost('ready', () => ({}));
    const other = setup({ host: () => host });
    await other.model.loadHostProviders();
    expect(other.model.rows).toEqual([]);
  });

  it('re-renders when the store changes, and stops after dispose', async () => {
    const { model, providers } = setup();
    const listener = vi.fn();
    model.subscribe(listener);
    providers.add({ baseURL: 'https://api.openai.com/v1' });
    expect(listener).toHaveBeenCalledTimes(1);
    model.dispose();
    providers.add({ baseURL: 'https://api.groq.com/openai/v1' });
    expect(listener).toHaveBeenCalledTimes(1);
    const { host } = fakeHost('ready', () => ({ providers: [{ id: 'p', name: 'P', baseURL: 'http://p.local:1', kind: 'ollama', hasKey: false }] }));
    const late = setup({ host: () => host });
    const pending = late.model.loadHostProviders();
    late.model.dispose();
    await pending;
    expect(late.model.rows).toEqual([]);
  });
});

describe('find local servers', () => {
  it('without a paired Mac explains it in one line', async () => {
    const { model } = setup();
    expect(model.discovery).toEqual({ status: 'idle' });
    await model.discover();
    expect(model.discovery).toEqual({ status: 'failed', message: NO_HOST_DISCOVERY });
  });

  it('asks the Mac; candidates become one-tap adds that test through the Mac', async () => {
    const { host, request } = fakeHost('ready', (method) => {
      if (method === 'provider/discover') {
        return {
          candidates: [
            { baseURL: 'http://127.0.0.1:11434', kind: 'ollama' },
            { baseURL: 'http://100.101.1.2:1234/v1', kind: 'openai-compatible' },
            { baseURL: 'ftp://x' },
          ],
        };
      }
      return { models: [{ id: 'llama3.2:1b' }] };
    });
    const { model, providers } = setup({ host: () => host });
    const pending = model.discover();
    expect(model.discovery).toEqual({ status: 'searching' });
    await model.discover(); // already searching: ignored
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
    const state = model.discovery;
    expect(state.status === 'done' && state.candidates).toEqual([
      { baseURL: 'http://127.0.0.1:11434', kind: 'ollama', name: 'Ollama on your Mac', added: false },
      { baseURL: 'http://100.101.1.2:1234/v1', kind: 'openai-compatible', name: 'OpenAI-compatible server at 100.101.1.2:1234', added: false },
    ]);
    if (state.status !== 'done') throw new Error('not done');
    await model.addCandidate(state.candidates[0]!);
    expect(request).toHaveBeenLastCalledWith('provider/models', { baseURL: 'http://127.0.0.1:11434', kind: 'ollama' });
    expect(model.form).toBeNull();
    expect(model.notice).toBe('Added Ollama on your Mac.');
    const record = providers.list()[0]!;
    expect(record).toMatchObject({ name: 'Ollama on your Mac', baseURL: 'http://127.0.0.1:11434', kind: 'ollama' });
    expect(model.rows[0]).toMatchObject({ route: 'via your Mac', models: '1 model' });
    const after = model.discovery;
    expect(after.status === 'done' && after.candidates.map((c) => c.added)).toEqual([true, false]);
  });

  it('a candidate that fails its test leaves the form open with the sentence', async () => {
    const { host } = fakeHost('ready', (method) => {
      if (method === 'provider/discover') return { candidates: [{ baseURL: 'http://127.0.0.1:1234/v1', kind: 'openai-compatible' }] };
      throw { code: 'provider_unavailable', data: { reason: 'unreachable' } };
    });
    const { model, providers } = setup({ host: () => host });
    await model.discover();
    const state = model.discovery;
    if (state.status !== 'done') throw new Error('not done');
    await model.addCandidate(state.candidates[0]!);
    expect(providers.list()).toEqual([]);
    expect(model.form?.test).toMatchObject({ status: 'failed', code: 'unreachable' });
    expect(model.canAddWithoutTesting).toBe(true);
  });

  it('nothing found, or the Mac failing, is one line each', async () => {
    const none = setup({ host: () => fakeHost('ready', () => ({ candidates: [] })).host });
    await none.model.discover();
    expect(none.model.discovery).toEqual({ status: 'failed', message: NO_CANDIDATES });
    const odd = setup({ host: () => fakeHost('ready', () => null).host });
    await odd.model.discover();
    expect(odd.model.discovery).toEqual({ status: 'failed', message: NO_CANDIDATES });
    const broken = setup({
      host: () =>
        fakeHost('ready', () => {
          throw { code: 'internal' };
        }).host,
    });
    await broken.model.discover();
    expect(broken.model.discovery).toEqual({ status: 'failed', message: DISCOVERY_FAILED });
    const gone = setup({ host: () => fakeHost('ready', () => ({ candidates: [] })).host });
    const pending = gone.model.discover();
    gone.model.dispose();
    await pending;
    expect(gone.model.discovery).toEqual({ status: 'searching' });
  });

  it('readCandidate names servers and derives a missing kind', () => {
    expect(readCandidate(null)).toBeNull();
    expect(readCandidate({ baseURL: 'http://localhost:11434' })).toMatchObject({ kind: 'ollama', name: 'Ollama on your Mac' });
    expect(readCandidate({ baseURL: 'http://[::1]:8080/v1', kind: 'openai-compatible' })).toMatchObject({ name: 'OpenAI-compatible server on your Mac' });
  });
});

describe('delete', () => {
  it('asks before deleting one provider, and before deleting all', () => {
    const { model, providers } = setup();
    const a = providers.add({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-proj-aaa' }).record;
    const b = providers.add({ baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk_b' }).record;
    model.askDelete('nope');
    expect(model.confirm).toBeNull();
    model.confirmDelete(); // nothing to confirm
    model.askDelete(a.id);
    expect(model.confirm).toEqual({ type: 'delete', id: a.id, name: 'OpenAI' });
    model.cancelConfirm();
    expect(providers.list()).toHaveLength(2);
    model.openEdit(a.id);
    model.askDelete(a.id);
    model.confirmDelete();
    expect(model.notice).toBe('Deleted OpenAI.');
    expect(model.form).toBeNull();
    expect(providers.getKey(a.id)).toBeNull();
    expect(providers.defaultProviderId).toBe(b.id);

    model.askDeleteAll();
    expect(model.confirm).toEqual({ type: 'delete-all' });
    model.confirmDelete();
    expect(providers.list()).toEqual([]);
    expect(model.notice).toBe('Deleted every provider on this phone.');
    model.askDeleteAll(); // nothing left
    expect(model.confirm).toBeNull();
  });
});

describe('export and import', () => {
  it('exports JSON without keys, fingerprints or cached models', () => {
    const { model, providers } = setup();
    providers.add({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-proj-secret', models: [{ id: 'm', displayName: 'm', capabilities: {}, source: 'unknown' }] });
    providers.add({ baseURL: 'http://192.168.1.20:11434', name: 'Mac Ollama' });
    const file = model.exportFile();
    expect(file.name).toBe(EXPORT_FILENAME);
    expect(file.type).toBe('application/json');
    expect(file.text).not.toContain('sk-proj');
    const data = JSON.parse(file.text);
    expect(data).toEqual({
      format: 'nano-remote/providers',
      v: 1,
      providers: [
        expect.objectContaining({ name: 'OpenAI', baseURL: 'https://api.openai.com/v1', kind: 'openai-compatible' }),
        expect.objectContaining({ name: 'Mac Ollama', baseURL: 'http://192.168.1.20:11434', kind: 'ollama' }),
      ],
    });
    for (const p of data.providers) {
      expect(Object.keys(p).sort()).toEqual(['baseURL', 'hiddenModels', 'id', 'kind', 'name', 'pinnedModels', 'refresh', 'supportsTools']);
    }
  });

  it('round trip: delete all, import, and each direct provider asks for its key; the key is checked first', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.groq.com/openai/v1/models': { status: 401 },
    });
    const { model, providers } = setup({ fetch });
    providers.add({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-proj-secret' });
    providers.add({ baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk_secret' });
    providers.add({ baseURL: 'http://192.168.1.20:11434', name: 'Mac Ollama' });
    const text = model.exportFile().text;
    model.askDeleteAll();
    model.confirmDelete();
    model.importText(text);
    expect(model.notice).toBe('Imported 3 providers. Enter the key where asked.');
    const rows = model.rows;
    expect(rows.map((r) => [r.name, r.needsKey, r.key])).toEqual([
      ['OpenAI', true, 'no key'],
      ['Groq', true, 'no key'],
      ['Mac Ollama', false, 'no key'],
    ]);

    const openaiId = rows[0]!.id;
    await model.submitKey(openaiId); // empty draft: nothing
    expect(calls).toHaveLength(0);
    model.setKeyDraft(openaiId, ' sk-proj-new ');
    const pending = model.submitKey(openaiId);
    expect(model.keyPrompt(openaiId).busy).toBe(true);
    await model.submitKey(openaiId); // busy: ignored
    await pending;
    expect(calls).toHaveLength(1);
    expect(providers.getKey(openaiId)).toBe('sk-proj-new');
    expect(model.rows[0]).toMatchObject({ needsKey: false, key: 'key sk-pro…', models: '2 models' });
    expect(model.keyPrompt(openaiId)).toEqual({ draft: '', busy: false });

    const groqId = rows[1]!.id;
    model.setKeyDraft(groqId, 'gsk_wrong');
    await model.submitKey(groqId);
    expect(model.keyPrompt(groqId)).toEqual({ draft: 'gsk_wrong', busy: false, error: 'Groq rejected the key. Check that you pasted the whole key.' });
    expect(providers.getKey(groqId)).toBeNull();
  });

  it('keeps a key whose check could not reach the provider, and says why', async () => {
    const { fetch } = fakeFetch({ 'https://api.openai.com/v1/models': 'down' });
    const { model, providers } = setup({ fetch });
    model.importText(JSON.stringify({ format: 'nano-remote/providers', v: 1, providers: [{ baseURL: 'https://api.openai.com/v1' }] }));
    expect(model.notice).toBe('Imported 1 provider. Enter the key where asked.');
    const id = providers.list()[0]!.id;
    model.setKeyDraft(id, 'sk-proj-x');
    await model.submitKey(id);
    expect(providers.getKey(id)).toBe('sk-proj-x');
    expect(model.keyPrompt(id).error).toMatch(/^OpenAI did not answer/);
  });

  it('a provider deleted while its key is checked stays deleted', async () => {
    let release: (() => void) | undefined;
    const fetch: FetchLike = () => new Promise((resolve) => (release = () => resolve({ status: 200, json: async () => OPENAI_MODELS })));
    const { model, providers } = setup({ fetch });
    const id = providers.add({ baseURL: 'https://api.openai.com/v1' }).record.id;
    model.setKeyDraft(id, 'sk-proj-x');
    const pending = model.submitKey(id);
    providers.remove(id);
    release?.();
    await pending;
    expect(providers.list()).toEqual([]);
  });

  it('refuses a file that is not an export, in one sentence', () => {
    const { model, providers } = setup();
    model.importText('{not json');
    expect(model.notice).toBe(NOT_AN_EXPORT);
    model.importText(JSON.stringify({ hello: 1 }));
    expect(model.notice).toBe(NOT_AN_EXPORT);
    model.importText(JSON.stringify({ format: 'nano-remote/providers', v: 1, providers: [] }));
    expect(model.notice).toBe('That file has no providers.');
    model.importText(JSON.stringify({ format: 'nano-remote/providers', v: 1, providers: [{ baseURL: 'http://10.0.0.5:8080/v1' }] }));
    expect(model.notice).toBe('Imported 1 provider.');
    expect(providers.list()).toHaveLength(1);
  });
});
