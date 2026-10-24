import { describe, expect, it, vi } from 'vitest';

import type { ModelInfo } from '../../generated/methods';
import type { SettingsKey } from '../capabilities';
import { APPLIES_LATER, SessionSettingsModel, type SettingsReplica } from './settings-model';

const CODEX: ModelInfo[] = [
  { id: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex', default: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  { id: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini', default: false },
  { id: 'gpt-5.5-sol', displayName: 'GPT-5.5 Sol', default: false, efforts: ['low', 'high'], defaultEffort: 'high' },
];
// Claude lists levels without a default.
const CLAUDE: ModelInfo[] = [
  { id: 'opus', displayName: 'Opus', default: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', displayName: 'Sonnet', default: false, efforts: ['low', 'medium', 'high', 'max'] },
];

function replica(models: ModelInfo[] | Error = CODEX) {
  const calls: { sessionId: string; settings: Record<string, string> }[] = [];
  let fail: Error | undefined;
  let hold: Promise<void> | undefined;
  const fake: SettingsReplica & { calls: typeof calls; failWith(error: Error): void; holdWith(p: Promise<void>): void } = {
    calls,
    failWith: (error) => (fail = error),
    holdWith: (p) => (hold = p),
    models: vi.fn(async () => {
      if (models instanceof Error) throw models;
      return models;
    }),
    updateSettings: vi.fn(async (sessionId: string, settings: Record<string, string>) => {
      calls.push({ sessionId, settings });
      await hold;
      if (fail) throw fail;
      return {};
    }),
  };
  return fake;
}

function make(
  options: { current?: { model?: string; effort?: string }; keys?: SettingsKey[]; running?: boolean; models?: ModelInfo[] | Error } = {},
) {
  const fake = replica(options.models);
  let running = options.running ?? false;
  const model = new SessionSettingsModel({
    sessionId: 'ses_1',
    agentId: 'codex',
    current: options.current ?? {},
    keys: options.keys ?? ['model', 'effort'],
    running: () => running,
    replica: fake,
  });
  return { model, fake, setRunning: (on: boolean) => (running = on) };
}

describe('SessionSettingsModel', () => {
  it('preselects the session\'s model and effort; nothing to save until something differs', async () => {
    const { model, fake } = make({ current: { model: 'gpt-5.5-codex', effort: 'high' } });
    const seen = vi.fn();
    model.subscribe(seen);
    const loading = model.load();
    expect(model.modelsLoading).toBe(true);
    expect(model.canSave).toBe(false);
    await loading;
    expect(fake.models).toHaveBeenCalledWith('codex');
    expect([model.modelId, model.effort]).toEqual(['gpt-5.5-codex', 'high']);
    expect(model.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(model.effortAuto).toBe(false);
    expect(model.change).toEqual({});
    expect(model.canSave).toBe(false);
    expect(seen).toHaveBeenCalled();
  });

  it('a new model keeps the chosen level when it has it, else takes its default; a model without levels has none', async () => {
    const { model } = make({ current: { model: 'gpt-5.5-codex', effort: 'high' } });
    await model.load();
    model.selectModel('gpt-5.5-sol');
    expect([model.effort, model.change]).toEqual(['high', { model: 'gpt-5.5-sol' }]);
    model.selectEffort('low');
    expect(model.change).toEqual({ model: 'gpt-5.5-sol', effort: 'low' });
    model.selectModel('gpt-5.5-codex');
    expect([model.effort, model.change]).toEqual(['low', { effort: 'low' }]);
    model.selectModel('gpt-5.5-mini');
    expect([model.efforts, model.effort, model.change]).toEqual([[], undefined, { model: 'gpt-5.5-mini' }]);
    model.selectModel('nowhere');
    model.selectEffort('max');
    expect(model.modelId).toBe('gpt-5.5-mini');
    expect(model.effort).toBeUndefined();
  });

  it('a session without a model runs on the default; its default level is no change', async () => {
    const { model } = make({ current: {} });
    await model.load();
    expect([model.modelId, model.effort, model.change]).toEqual(['gpt-5.5-codex', 'medium', {}]);
    model.selectEffort('xhigh');
    expect(model.change).toEqual({ effort: 'xhigh' });
  });

  it('Auto only while the session names no level (a change cannot clear one)', async () => {
    const auto = make({ models: CLAUDE, current: { model: 'opus' } });
    await auto.model.load();
    expect([auto.model.effortAuto, auto.model.effort]).toEqual([true, undefined]);
    auto.model.selectEffort('max');
    expect(auto.model.change).toEqual({ effort: 'max' });
    auto.model.selectEffort(undefined);
    expect(auto.model.change).toEqual({});
    const set = make({ models: CLAUDE, current: { model: 'opus', effort: 'high' } });
    await set.model.load();
    expect([set.model.effortAuto, set.model.effort]).toEqual([false, 'high']);
    set.model.selectEffort(undefined);
    expect(set.model.effort).toBe('high');
    set.model.selectModel('sonnet');
    expect([set.model.effort, set.model.change]).toEqual(['high', { model: 'sonnet' }]);
  });

  it('a model the list no longer names stays listed as the current one', async () => {
    const { model } = make({ current: { model: 'openrouter/old-model' } });
    await model.load();
    expect(model.models[0]).toEqual({ id: 'openrouter/old-model', displayName: 'old-model · openrouter', default: false });
    expect([model.modelId, model.change]).toEqual(['openrouter/old-model', {}]);
  });

  it('offers only what the agent can change', async () => {
    const effortOnly = make({ current: { model: 'gpt-5.5-codex', effort: 'low' }, keys: ['effort'] });
    await effortOnly.model.load();
    expect([effortOnly.model.canChangeModel, effortOnly.model.canChangeEffort]).toEqual([false, true]);
    effortOnly.model.selectModel('gpt-5.5-mini');
    expect(effortOnly.model.modelId).toBe('gpt-5.5-codex');
    effortOnly.model.selectEffort('high');
    expect(effortOnly.model.change).toEqual({ effort: 'high' });
    const modelOnly = make({ current: { model: 'gpt-5.5-codex', effort: 'low' }, keys: ['model'] });
    await modelOnly.model.load();
    modelOnly.model.selectEffort('high');
    expect(modelOnly.model.effort).toBe('low');
    modelOnly.model.selectModel('gpt-5.5-sol');
    expect(modelOnly.model.change).toEqual({ model: 'gpt-5.5-sol' });
  });

  it('says "Applies after this turn" while a turn runs', () => {
    const { model, setRunning } = make({ running: true });
    expect(model.note).toBe(APPLIES_LATER);
    expect(APPLIES_LATER).toBe('Applies after this turn');
    setRunning(false);
    expect(model.note).toBeUndefined();
  });

  it('save sends the change once and resolves true; a refusal shows the host\'s words and resolves false', async () => {
    const { model, fake } = make({ current: { model: 'gpt-5.5-codex', effort: 'medium' } });
    await model.load();
    expect(await model.save()).toBe(false);
    expect(fake.calls).toEqual([]);
    model.selectModel('gpt-5.5-sol');
    let release!: () => void;
    fake.holdWith(new Promise<void>((resolve) => (release = resolve)));
    const saving = model.save();
    expect([model.saving, model.canSave]).toEqual([true, false]);
    release();
    expect(await saving).toBe(true);
    expect(fake.calls).toEqual([{ sessionId: 'ses_1', settings: { model: 'gpt-5.5-sol', effort: 'high' } }]);
    fake.failWith(new Error('Codex cannot change the model of an open session'));
    expect(await model.save()).toBe(false);
    expect(model.error).toBe('Could not change the settings: Codex cannot change the model of an open session');
    expect(model.saving).toBe(false);
  });

  it('a failed model list says so', async () => {
    const { model } = make({ models: new Error('agent codex is unavailable') });
    await model.load();
    expect(model.error).toBe('Could not load the models: agent codex is unavailable');
    expect([model.modelsLoading, model.models, model.canSave]).toEqual([false, [], false]);
  });

  it('groups and searches long lists like the New session sheet', async () => {
    const many: ModelInfo[] = Array.from({ length: 12 }, (_, i) => ({ id: `p${i % 2}/m${i}`, displayName: `m${i}`, default: i === 0, provider: `p${i % 2}` }));
    const { model } = make({ models: many, current: { model: 'p0/m0' } });
    await model.load();
    expect(model.modelSearch).toBe(true);
    expect(model.modelGroups.map((g) => g.provider)).toEqual(['p0', 'p1']);
    model.setModelFilter('m3');
    expect(model.modelGroups.flatMap((g) => g.models.map((m) => m.id))).toEqual(['p0/m0', 'p1/m3']);
    expect(model.model?.id).toBe('p0/m0');
  });
});
