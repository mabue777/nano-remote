import { describe, expect, it, vi } from 'vitest';

import { exampleMessage } from '../../test/fixtures';
import { FakeTransport, rpcError, settle } from '../../test/replica-doubles';
import type { SessionStartParams } from '../generated/methods';
import { bypassKey, foldersOf, NewSessionModel, parentOf, startParams } from './new-session-model';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const AGENTS = exampleMessage('08').result.agents;
const PROJECTS = [
  { path: '/Users/me/old', name: 'old', lastUsedAt: 100, sessions: 1 },
  { path: '/Users/me/Desktop/phone-test', name: 'phone-test', lastUsedAt: 200, sessions: 3 },
];
const MODELS = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', default: true },
  { id: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini', default: false },
];

function setup(storage = memoryStorage()) {
  const client = new FakeTransport();
  const started: SessionStartParams[] = [];
  const starter = {
    startSession: vi.fn(async (params: SessionStartParams) => {
      started.push(params);
      const session = { ...exampleMessage('13').result.session, sessionId: 'ses_new' };
      return { session };
    }),
  };
  const model = new NewSessionModel(client, starter, storage);
  return { client, model, starter, started, storage };
}

function standardRules(client: FakeTransport) {
  client.rule('agent/list', () => ({ agents: AGENTS }));
  client.rule('project/list', () => ({ projects: PROJECTS }));
  client.rule('model/list', ({ agentId }) => (agentId === 'codex' ? { models: MODELS } : { models: [{ id: 'opus', displayName: 'Opus', default: false }] }));
}

describe('new session helpers', () => {
  it.each([
    ['/a/b', '/a'],
    ['/a/b/', '/a'],
    ['/a', '/'],
    ['/', undefined],
    ['', undefined],
    ['relative', undefined],
  ])('parentOf(%j)', (path, parent) => {
    expect(parentOf(path)).toBe(parent);
  });

  it('foldersOf keeps folders, visible ones first, by name', () => {
    const entries = [
      { name: 'b', kind: 'dir' as const, path: '/b' },
      { name: '.git', kind: 'dir' as const, path: '/.git' },
      { name: 'a.txt', kind: 'file' as const, path: '/a.txt' },
      { name: 'a', kind: 'dir' as const, path: '/a' },
    ];
    expect(foldersOf(entries).map((e) => e.name)).toEqual(['a', 'b', '.git']);
  });

  it('startParams leaves out empty title and message, and the model when it is the default', () => {
    const base = { agentId: 'codex', cwd: '/w', title: '  ', model: 'm1', defaultModel: 'm1', message: ' ' };
    expect(startParams(base)).toEqual({ agentId: 'codex', cwd: '/w' });
    expect(startParams({ ...base, title: ' Fix it ', model: 'm2', message: ' go ' })).toEqual({
      agentId: 'codex',
      cwd: '/w',
      title: 'Fix it',
      settings: { model: 'm2' },
      input: [{ type: 'text', text: 'go' }],
    });
    expect(startParams({ ...base, model: undefined })).toEqual({ agentId: 'codex', cwd: '/w' });
  });

  it('startParams with bypass carries approvalMode never, next to a chosen model', () => {
    const base = { agentId: 'codex', cwd: '/w', title: '', model: 'm1', defaultModel: 'm1', message: '' };
    expect(startParams({ ...base, bypass: true })).toEqual({ agentId: 'codex', cwd: '/w', settings: { approvalMode: 'never' } });
    expect(startParams({ ...base, model: 'm2', bypass: true }).settings).toEqual({ model: 'm2', approvalMode: 'never' });
    expect(startParams({ ...base, bypass: false })).toEqual({ agentId: 'codex', cwd: '/w' });
  });
});

describe('NewSessionModel', () => {
  it('loads agents and projects, picks the first ready agent, its default model and the latest project', async () => {
    const { client, model } = setup();
    standardRules(client);
    await model.load();
    expect(model.agents.map((a) => a.id)).toEqual(['codex', 'claude', 'kimi']);
    expect(model.agentId).toBe('codex');
    expect(model.models).toEqual(MODELS);
    expect(model.modelId).toBe('gpt-5.5');
    expect(model.modelsLoading).toBe(false);
    expect(model.projects[0]!.path).toBe('/Users/me/Desktop/phone-test');
    expect(model.cwd).toBe('/Users/me/Desktop/phone-test');
    expect(model.canSubmit).toBe(true);
  });

  it('unavailable agents cannot be picked; switching agent reloads models', async () => {
    const { client, model } = setup();
    standardRules(client);
    await model.load();
    await model.selectAgent('kimi');
    expect(model.agentId).toBe('codex');
    await model.selectAgent('nope');
    expect(model.agentId).toBe('codex');
    await model.selectAgent('claude');
    expect(model.agentId).toBe('claude');
    expect(model.modelId).toBe('opus'); // no default: the first
    model.selectModel('gpt-5.5'); // not this agent's
    expect(model.modelId).toBe('opus');
  });

  it('a model list that fails (not_supported) leaves no picker; a stale answer is dropped', async () => {
    const { client, model } = setup();
    client.rule('agent/list', () => ({ agents: AGENTS }));
    client.rule('project/list', () => ({ projects: [] }));
    const loaded = model.load();
    await settle();
    const first = client.last('model/list');
    const second = model.selectAgent('claude');
    first.resolve({ models: MODELS }); // codex's late answer
    client.last('model/list').reject(rpcError('not_supported'));
    await loaded;
    await second;
    expect(model.agentId).toBe('claude');
    expect(model.models).toEqual([]);
    expect(model.modelId).toBeUndefined();
    expect(model.modelsLoading).toBe(false);
    // the late codex failure is dropped too
    const third = model.selectAgent('codex');
    const late = client.last('model/list');
    const fourth = model.selectAgent('claude');
    late.reject(rpcError('internal'));
    client.last('model/list').resolve({ models: [{ id: 'opus', displayName: 'Opus', default: true }] });
    await third;
    await fourth;
    expect(model.modelId).toBe('opus');
  });

  it('agent/list failure shows an error; project/list failure just means no recent folders', async () => {
    const { client, model } = setup();
    client.rule('agent/list', () => {
      throw rpcError('internal');
    });
    client.rule('project/list', () => {
      throw rpcError('method_not_found');
    });
    await model.load();
    expect(model.error).toBe('Could not load agents: internal');
    expect(model.loading).toBe(false);
    client.rule('agent/list', () => ({ agents: [{ id: 'kimi', name: 'Kimi', status: 'unavailable' }] }));
    await model.load();
    expect(model.error).toBeUndefined();
    expect(model.projects).toEqual([]);
    expect(model.cwd).toBeUndefined();
    expect(model.agentId).toBeUndefined();
    expect(model.canSubmit).toBe(false);
  });

  it('browses folders from the latest project, up to the parent, and chooses one', async () => {
    const { client, model } = setup();
    standardRules(client);
    client.rule('fs/readDirectory', ({ path }) => ({
      entries: [
        { name: 'src', kind: 'dir', path: `${path === '/' ? '' : path}/src` },
        { name: 'README.md', kind: 'file', path: `${path}/README.md` },
      ],
    }));
    await model.load();
    await model.browse();
    expect(model.browser).toMatchObject({ path: '/Users/me/Desktop/phone-test', parent: '/Users/me/Desktop', loading: false });
    expect(model.browser!.folders.map((f) => f.name)).toEqual(['src']);
    await model.browse(model.browser!.folders[0]!.path);
    expect(model.browser!.path).toBe('/Users/me/Desktop/phone-test/src');
    model.chooseFolder();
    expect(model.cwd).toBe('/Users/me/Desktop/phone-test/src');
    expect(model.browser).toBeUndefined();
    model.chooseFolder(); // nothing open: no change
    expect(model.cwd).toBe('/Users/me/Desktop/phone-test/src');
    model.chooseFolder('/Users/me/old');
    expect(model.cwd).toBe('/Users/me/old');
  });

  it('a folder that cannot be read shows the error; a late answer after closing is dropped', async () => {
    const { client, model } = setup();
    client.rule('fs/readDirectory', () => {
      throw rpcError('not_found');
    });
    await model.browse('/gone');
    expect(model.browser).toMatchObject({ path: '/gone', parent: '/', error: 'not_found', loading: false });
    client.unrule('fs/readDirectory');
    const pending = model.browse('/');
    model.closeBrowser();
    client.last('fs/readDirectory').resolve({ entries: [] });
    await pending;
    expect(model.browser).toBeUndefined();
    const failing = model.browse('/');
    model.closeBrowser();
    client.last('fs/readDirectory').reject(rpcError('internal'));
    await failing;
    expect(model.browser).toBeUndefined();
  });

  it('browse with nothing chosen and no projects starts at the root', async () => {
    const { client, model } = setup();
    client.rule('fs/readDirectory', () => ({ entries: [] }));
    await model.browse();
    expect(model.browser).toMatchObject({ path: '/', parent: undefined });
  });

  it('submit sends session/start with the form and resolves the new id; title and first input optional', async () => {
    const { client, model, started } = setup();
    standardRules(client);
    await model.load();
    expect(await model.submit()).toBe('ses_new');
    expect(started[0]).toEqual({ agentId: 'codex', cwd: '/Users/me/Desktop/phone-test' });
    model.setTitle('Hello file');
    model.setMessage('Create hello.txt');
    model.selectModel('gpt-5.5-mini');
    const pending = model.submit();
    expect(model.submitting).toBe(true);
    expect(model.canSubmit).toBe(false);
    expect(await model.submit()).toBeUndefined(); // double tap
    expect(await pending).toBe('ses_new');
    expect(started[1]).toEqual({
      agentId: 'codex',
      cwd: '/Users/me/Desktop/phone-test',
      title: 'Hello file',
      settings: { model: 'gpt-5.5-mini' },
      input: [{ type: 'text', text: 'Create hello.txt' }],
    });
    expect(model.submitting).toBe(false);
  });

  it('the bypass switch is off by default, sets approvalMode never, and is remembered per agent', async () => {
    const { client, model, started, storage } = setup();
    standardRules(client);
    await model.load();
    expect(model.bypass).toBe(false);
    model.setBypass(true);
    expect(storage.data.get(bypassKey('codex'))).toBe('1');
    await model.submit();
    expect(started[0]).toEqual({ agentId: 'codex', cwd: '/Users/me/Desktop/phone-test', settings: { approvalMode: 'never' } });

    // A new sheet remembers the choice for this agent only.
    const again = setup(memoryStorage(Object.fromEntries(storage.data)));
    standardRules(again.client);
    await again.model.load();
    expect(again.model.bypass).toBe(true);
    const fresh = setup(memoryStorage({ [bypassKey('claude')]: '1' }));
    standardRules(fresh.client);
    await fresh.model.load();
    expect(fresh.model.bypass).toBe(false);

    again.model.setBypass(false);
    await again.model.submit();
    expect(again.started[0]).toEqual({ agentId: 'codex', cwd: '/Users/me/Desktop/phone-test' });
  });

  it('a failed session/start shows the error and allows another try', async () => {
    const { client, model, starter } = setup();
    standardRules(client);
    await model.load();
    starter.startSession.mockRejectedValueOnce(rpcError('agent_unavailable'));
    expect(await model.submit()).toBeUndefined();
    expect(model.error).toBe('Could not start the session: agent_unavailable');
    expect(model.canSubmit).toBe(true);
  });
});
