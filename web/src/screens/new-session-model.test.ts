import { describe, expect, it, vi } from 'vitest';

import { exampleMessage } from '../../test/fixtures';
import { FakeTransport, rpcError, settle } from '../../test/replica-doubles';
import type { SessionStartParams } from '../generated/methods';
import {
  acceptEditsKey,
  bypassKey,
  effortKey,
  effortLabel,
  foldersOf,
  groupModels,
  modelLabel,
  NewSessionModel,
  parentOf,
  pickEffort,
  SEARCH_FROM,
  startParams,
} from './new-session-model';

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

  it('offers Bypass for codex and claude, whose capabilities honour never, and not for pi', async () => {
    const pi = { id: 'pi', name: 'Pi', status: 'ready', capabilities: { steer: true, diff: false, approvalModes: [] } };
    const { client, model, started } = setup(memoryStorage({ [bypassKey('pi')]: '1' }));
    standardRules(client);
    client.rule('agent/list', () => ({ agents: [...AGENTS, pi] }));
    await model.load();
    expect(model.agentId).toBe('codex');
    expect(model.bypassOffered).toBe(true);
    await model.selectAgent('claude');
    expect(model.bypassOffered).toBe(true);
    await model.selectAgent('pi');
    expect(model.bypassOffered).toBe(false);
    // A "1" remembered from before capabilities existed never reaches session/start for pi.
    await model.submit();
    expect(started[0]).not.toHaveProperty('settings.approvalMode');
  });

  it('pi with approval modes: Accept edits and Bypass are offered, exclude each other, and reach session/start', async () => {
    const pi = { id: 'pi', name: 'Pi', status: 'ready', capabilities: { steer: true, diff: true, approvalModes: ['ask', 'acceptEdits', 'never'] } };
    const storage = memoryStorage({});
    const { client, model, started } = setup(storage);
    standardRules(client);
    client.rule('agent/list', () => ({ agents: [...AGENTS, pi] }));
    await model.load();
    // Codex lists no acceptEdits: no switch.
    expect(model.acceptEditsOffered).toBe(false);
    await model.selectAgent('pi');
    expect([model.acceptEditsOffered, model.bypassOffered]).toEqual([true, true]);
    model.setAcceptEdits(true);
    model.setBypass(true);
    expect([model.acceptEdits, model.bypass]).toEqual([false, true]);
    model.setAcceptEdits(true);
    expect([model.acceptEdits, model.bypass]).toEqual([true, false]);
    await model.submit();
    expect(started[0]).toMatchObject({ agentId: 'pi', settings: { approvalMode: 'acceptEdits' } });
    // Remembered per agent.
    expect(storage.getItem(acceptEditsKey('pi'))).toBe('1');
    expect(storage.getItem(bypassKey('pi'))).toBe('0');
  });

  it('offers Bypass for every agent when an older host sends no capabilities', async () => {
    const { client, model, started } = setup(memoryStorage({ [bypassKey('pi')]: '1' }));
    standardRules(client);
    client.rule('agent/list', () => ({
      agents: [...AGENTS.map(({ capabilities: _c, ...agent }: { capabilities?: unknown }) => agent), { id: 'pi', name: 'Pi', status: 'ready' }],
    }));
    await model.load();
    expect(model.bypassOffered).toBe(true);
    await model.selectAgent('pi');
    expect(model.bypassOffered).toBe(true);
    await model.submit();
    expect(started[0]).toMatchObject({ agentId: 'pi', settings: { approvalMode: 'never' } });
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

// Pi (Phase 5b): listed by agent/list when the host finds the program; model/list gives provider/model ids
// with `provider` set (spec 4, example 54).
const PI = { id: 'pi', name: 'Pi', status: 'ready' as const };
const PI_MODELS = [
  ...exampleMessage('54').result.models,
  { id: 'openrouter/qwen/qwen3.5-coder', displayName: 'Qwen 3.5 Coder', default: false, provider: 'openrouter' },
  { id: 'google/gemini-3-pro', displayName: 'Gemini 3 Pro', default: false, provider: 'google' },
];

function piRules(client: FakeTransport, models: unknown[] = PI_MODELS) {
  client.rule('agent/list', () => ({ agents: [...AGENTS, PI] }));
  client.rule('project/list', () => ({ projects: PROJECTS }));
  client.rule('model/list', ({ agentId }) => (agentId === 'pi' ? { models } : { models: MODELS }));
}

describe('Pi in the new session sheet', () => {
  it('groupModels: unnamed group first, then providers by name, host order kept inside a group', () => {
    const groups = groupModels([...MODELS, ...PI_MODELS]);
    expect(groups.map((g) => g.provider)).toEqual([undefined, 'google', 'llamacpp', 'openrouter']);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    expect(groups[3]!.models.map((m) => m.id)).toEqual(['openrouter/~deepseek/deepseek-v4-flash-latest', 'openrouter/qwen/qwen3.5-coder']);
    expect(groupModels(MODELS)).toEqual([{ provider: undefined, models: MODELS }]); // Codex and Claude: as before
    expect(groupModels([{ id: 'x', displayName: 'X', default: false, provider: '' }])[0]!.provider).toBeUndefined();
    expect(groupModels([])).toEqual([]);
  });

  it('groupModels filters by id, name or provider in any case, and keeps the current choice', () => {
    const ids = (filter: string, keep?: string) => groupModels(PI_MODELS, filter, keep).flatMap((g) => g.models.map((m) => m.id));
    expect(ids('  QWEN ')).toEqual(['openrouter/qwen/qwen3.5-coder']);
    expect(ids('DeepSeek V4')).toEqual(['openrouter/~deepseek/deepseek-v4-flash-latest']);
    expect(ids('llamacpp')).toEqual(['llamacpp/bonsai-27b']);
    expect(ids('qwen', 'llamacpp/bonsai-27b')).toEqual(['llamacpp/bonsai-27b', 'openrouter/qwen/qwen3.5-coder']);
    expect(ids('nothing matches')).toEqual([]);
    expect(ids('')).toHaveLength(PI_MODELS.length);
  });

  it('modelLabel reads provider/model ids as "model · provider" and leaves other ids alone', () => {
    expect(modelLabel('llamacpp/bonsai-27b')).toBe('bonsai-27b · llamacpp');
    expect(modelLabel('openrouter/deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash · openrouter');
    expect(modelLabel('gpt-5.5')).toBe('gpt-5.5');
    expect(modelLabel('/leading')).toBe('/leading');
    expect(modelLabel('trailing/')).toBe('trailing/');
  });

  it('startParams with pinModel sends the model even when it is the default', () => {
    const base = { agentId: 'pi', cwd: '/w', title: '', model: 'llamacpp/bonsai-27b', defaultModel: 'llamacpp/bonsai-27b', message: '' };
    expect(startParams(base)).toEqual({ agentId: 'pi', cwd: '/w' });
    expect(startParams({ ...base, pinModel: true })).toEqual({ agentId: 'pi', cwd: '/w', settings: { model: 'llamacpp/bonsai-27b' } });
  });

  it('no pi on the host: no Pi option', async () => {
    const { client, model } = setup();
    standardRules(client);
    await model.load();
    expect(model.agents.some((a) => a.id === 'pi')).toBe(false);
  });

  it('Pi is listed when the host lists it; choosing it loads its models grouped by provider', async () => {
    const { client, model } = setup();
    piRules(client);
    await model.load();
    expect(model.agents.map((a) => a.name)).toContain('Pi');
    expect(model.modelGroups).toEqual([{ provider: undefined, models: MODELS }]);
    await model.selectAgent('pi');
    expect(model.agentId).toBe('pi');
    expect(model.modelId).toBe('llamacpp/bonsai-27b'); // the default
    expect(model.model?.provider).toBe('llamacpp');
    expect(model.modelGroups.map((g) => g.provider)).toEqual(['google', 'llamacpp', 'openrouter']);
    expect(model.modelSearch).toBe(false); // four models: no search field
  });

  it('a long model list gets a search field; the filter narrows the groups and resets with the agent', async () => {
    const many = Array.from({ length: SEARCH_FROM }, (_, i) => ({
      id: `${i % 2 === 0 ? 'xai' : 'ollama'}/model-${i}`,
      displayName: `Model ${i}`,
      default: i === 0,
      provider: i % 2 === 0 ? 'xai' : 'ollama',
    }));
    const { client, model } = setup();
    piRules(client, many);
    await model.load();
    await model.selectAgent('pi');
    expect(model.modelSearch).toBe(true);
    const seen: string[] = [];
    model.subscribe(() => seen.push(model.modelFilter));
    model.setModelFilter('ollama');
    expect(seen).toEqual(['ollama']);
    // the current choice (xai/model-0) stays listed next to the matches
    expect(model.modelGroups.map((g) => [g.provider, g.models.length])).toEqual([
      ['ollama', SEARCH_FROM / 2],
      ['xai', 1],
    ]);
    await model.selectAgent('codex');
    expect(model.modelFilter).toBe('');
    expect(model.modelSearch).toBe(false);
  });

  it('picking a Pi model starts the session on it: settings.model carries provider/model, even the default', async () => {
    const { client, model, started } = setup();
    piRules(client);
    await model.load();
    await model.selectAgent('pi');
    expect(await model.submit()).toBe('ses_new');
    expect(started[0]).toEqual({ agentId: 'pi', cwd: '/Users/me/Desktop/phone-test', settings: { model: 'llamacpp/bonsai-27b' } });
    model.selectModel('openrouter/qwen/qwen3.5-coder');
    model.setMessage('Fix the test');
    expect(await model.submit()).toBe('ses_new');
    expect(started[1]).toEqual({
      agentId: 'pi',
      cwd: '/Users/me/Desktop/phone-test',
      settings: { model: 'openrouter/qwen/qwen3.5-coder' },
      input: [{ type: 'text', text: 'Fix the test' }],
    });
  });
});

describe('Effort in the new session sheet', () => {
  const EFFORT_MODELS = [
    { id: 'gpt-6-sol', displayName: 'GPT-6 Sol', default: true, efforts: ['low', 'medium', 'high', 'xhigh'] as [string, ...string[]], defaultEffort: 'medium' },
    { id: 'gpt-6-mini', displayName: 'GPT-6 mini', default: false },
    { id: 'gpt-6-luna', displayName: 'GPT-6 Luna', default: false, efforts: ['none', 'high'] as [string, ...string[]], defaultEffort: 'high' },
  ];
  const CLAUDE_MODELS = [{ id: 'opus', displayName: 'Opus', default: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as [string, ...string[]] }];

  function effortRules(client: FakeTransport) {
    client.rule('agent/list', () => ({ agents: AGENTS }));
    client.rule('project/list', () => ({ projects: PROJECTS }));
    client.rule('model/list', ({ agentId }) => ({ models: agentId === 'codex' ? EFFORT_MODELS : CLAUDE_MODELS }));
  }

  it('effortLabel and pickEffort', () => {
    expect(effortLabel('xhigh')).toBe('XHigh');
    expect(effortLabel('medium')).toBe('Medium');
    expect(effortLabel('')).toBe('');
    const [sol, mini, luna] = EFFORT_MODELS;
    expect(pickEffort(sol, null)).toBe('medium');
    expect(pickEffort(sol, 'xhigh')).toBe('xhigh');
    expect(pickEffort(sol, 'max')).toBe('medium');
    expect(pickEffort(sol, '')).toBe('medium');
    expect(pickEffort(mini, 'high')).toBeUndefined();
    expect(pickEffort(luna, undefined)).toBe('high');
    expect(pickEffort(undefined, 'high')).toBeUndefined();
    expect(pickEffort(CLAUDE_MODELS[0], null)).toBeUndefined();
    expect(pickEffort(CLAUDE_MODELS[0], '')).toBeUndefined();
    expect(pickEffort(CLAUDE_MODELS[0], 'max')).toBe('max');
    expect(pickEffort({ ...sol!, defaultEffort: 'turbo' }, null)).toBeUndefined();
  });

  it('startParams carries a chosen effort and leaves out Auto', () => {
    const base = { agentId: 'codex', cwd: '/w', title: '', model: 'm', defaultModel: 'm', message: '' };
    expect(startParams({ ...base, effort: 'high' })).toEqual({ agentId: 'codex', cwd: '/w', settings: { effort: 'high' } });
    expect(startParams({ ...base, effort: '' })).toEqual({ agentId: 'codex', cwd: '/w' });
    expect(startParams({ ...base, model: 'x', bypass: true, effort: 'low' }).settings).toEqual({ model: 'x', approvalMode: 'never', effort: 'low' });
  });

  it('shows the model default preselected, sends the choice and remembers it per agent', async () => {
    const { client, model, started, storage } = setup();
    effortRules(client);
    await model.load();
    expect(model.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(model.effortAuto).toBe(false);
    expect(model.effort).toBe('medium');
    model.selectEffort('xhigh');
    expect(storage.data.get(effortKey('codex'))).toBe('xhigh');
    await model.submit();
    expect(started[0]).toEqual({ agentId: 'codex', cwd: '/Users/me/Desktop/phone-test', settings: { effort: 'xhigh' } });

    const again = setup(memoryStorage(Object.fromEntries(storage.data)));
    effortRules(again.client);
    await again.model.load();
    expect(again.model.effort).toBe('xhigh');
    // A model without that level gets its own default; one without levels hides the picker.
    again.model.selectModel('gpt-6-luna');
    expect(again.model.effort).toBe('high');
    again.model.selectModel('gpt-6-mini');
    expect(again.model.efforts).toEqual([]);
    expect(again.model.effort).toBeUndefined();
    await again.model.submit();
    expect(again.started[0]).toEqual({ agentId: 'codex', cwd: '/Users/me/Desktop/phone-test', settings: { model: 'gpt-6-mini' } });
  });

  it('ignores levels the model does not offer, and Auto where the model has a default', async () => {
    const { client, model, storage } = setup();
    effortRules(client);
    await model.load();
    model.selectEffort('max');
    model.selectEffort(undefined);
    expect(model.effort).toBe('medium');
    expect(storage.data.has(effortKey('codex'))).toBe(false);
  });

  it('a model without a default offers Auto, preselected, which sends no effort; Auto is remembered too', async () => {
    const { client, model, started, storage } = setup();
    effortRules(client);
    await model.load();
    await model.selectAgent('claude');
    expect(model.effortAuto).toBe(true);
    expect(model.effort).toBeUndefined();
    model.selectEffort('max');
    expect(model.effort).toBe('max');
    model.selectEffort(undefined);
    expect(storage.data.get(effortKey('claude'))).toBe('');
    expect(model.effort).toBeUndefined();
    await model.submit();
    expect(started[0]).toEqual({ agentId: 'claude', cwd: '/Users/me/Desktop/phone-test' });
  });

  it('storage that throws neither loses the choice for this sheet nor breaks the picker', async () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    const client = new FakeTransport();
    effortRules(client);
    const model = new NewSessionModel(client, { startSession: vi.fn() }, broken);
    await model.load();
    expect(model.effort).toBe('medium');
    model.selectEffort('low');
    expect(model.effort).toBe('low');
  });
});
