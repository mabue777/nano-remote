// The new-session sheet: pick an agent (agent/list), a model (model/list), a working folder (recent
// projects from project/list, then browsing with fs/readDirectory), an optional title and an optional
// first message, then session/start (spec 4, 6). With a first message the host starts the first turn
// in the same round trip. A "Bypass approvals" switch (off by default, remembered per agent) starts the
// session with settings.approvalMode "never": the agent runs everything without asking (spec 5.1). It is
// offered only for an agent whose capabilities.approvalModes include "never" (pi has none), or for every
// agent when an older host sends no capabilities.
// Agents that reach many providers (pi) list hundreds of models, each with a `provider` (spec 4): the
// picker groups them by provider and offers a search field once the list is long.
// Effort: the chosen model's `efforts` (spec 4 model/list) are offered under the model, none when it lists
// none. The level preselected is this agent's last choice when the model offers it, else the model's
// `defaultEffort`; a model without `defaultEffort` (Claude) also offers "Auto", which sends no effort and
// leaves the level to the agent. The chosen level goes in settings.effort.
import type {
  Agent,
  DirEntry,
  FsReadDirectoryResult,
  ModelInfo,
  ModelListResult,
  ProjectEntry,
  ProjectListResult,
  AgentListResult,
  SessionStartParams,
  SessionStartResult,
} from '../generated/methods';
import { defaultStorage, type StorageLike } from '../replica/storage';
import { canBypass } from './capabilities';
import { errorText, Model } from './model';

/** localStorage key of the agent's last "Bypass approvals" choice. */
export const bypassKey = (agentId: string): string => `nano-remote/bypass/${agentId}`;

/** localStorage key of the agent's last effort choice ("" for Auto). */
export const effortKey = (agentId: string): string => `nano-remote/effort/${agentId}`;

/** An effort level as a short label: "xhigh" reads "XHigh", "medium" "Medium". */
export function effortLabel(level: string): string {
  if (level === 'xhigh') return 'XHigh';
  return level === '' ? level : `${level[0]!.toUpperCase()}${level.slice(1)}`;
}

/**
 * The level preselected for a model: the remembered one when the model offers it ("" for Auto when the
 * model has no default), else the model's default; undefined (Auto) when it has neither, or no efforts.
 */
export function pickEffort(model: ModelInfo | undefined, remembered: string | null | undefined): string | undefined {
  const efforts: readonly string[] = model?.efforts ?? [];
  if (efforts.length === 0) return undefined;
  if (remembered !== null && remembered !== undefined && efforts.includes(remembered)) return remembered;
  const fallback = model?.defaultEffort;
  if (remembered === '' && fallback === undefined) return undefined;
  return fallback !== undefined && efforts.includes(fallback) ? fallback : undefined;
}

export interface NewSessionClient {
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface NewSessionStarter {
  startSession(params: SessionStartParams): Promise<SessionStartResult>;
}

/** The parent of an absolute path ("/a/b" → "/a", "/a" → "/"), or undefined at the root. */
export function parentOf(path: string): string | undefined {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (trimmed === '/' || trimmed === '') return undefined;
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return undefined;
  return index === 0 ? '/' : trimmed.slice(0, index);
}

/** Folders first and only folders (a session runs in a folder), hidden ones last, by name. */
export function foldersOf(entries: DirEntry[]): DirEntry[] {
  return entries
    .filter((entry) => entry.kind === 'dir')
    .sort((a, b) => Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) || a.name.localeCompare(b.name));
}

/** The model picker shows a search field from this many models on. */
export const SEARCH_FROM = 12;

/** Models under one provider; `provider` is undefined for models that name none (one-provider agents). */
export interface ModelGroup {
  provider: string | undefined;
  models: ModelInfo[];
}

/**
 * Models grouped by provider: the ones without a provider first (as one unnamed group), then one group per
 * provider in alphabetical order; each group keeps the host's order. A filter keeps the models whose id,
 * name or provider contains it (any case); the model `keep` (the current choice) always stays listed.
 */
export function groupModels(models: readonly ModelInfo[], filter = '', keep?: string): ModelGroup[] {
  const needle = filter.trim().toLowerCase();
  const matches = (m: ModelInfo): boolean =>
    needle === '' || m.id === keep || [m.id, m.displayName, m.provider ?? ''].some((text) => text.toLowerCase().includes(needle));
  const groups = new Map<string | undefined, ModelInfo[]>();
  for (const model of models) {
    if (!matches(model)) continue;
    const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : undefined;
    const group = groups.get(provider);
    if (group === undefined) groups.set(provider, [model]);
    else group.push(model);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === undefined ? -1 : b === undefined ? 1 : a.localeCompare(b)))
    .map(([provider, list]) => ({ provider, models: list }));
}

/**
 * A model id as a short label for the session row and header. Ids of the form `provider/model` (pi, spec
 * 4) read "model · provider"; any other id is shown as is.
 */
export function modelLabel(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return modelId;
  return `${modelId.slice(slash + 1)} · ${modelId.slice(0, slash)}`;
}

/**
 * session/start params from the form; empty title and message are left out. The model goes in
 * settings.model when it is not the agent's default, or always with `pinModel` (a model with a provider:
 * the session then records which one it runs on).
 */
export function startParams(form: {
  agentId: string;
  cwd: string;
  title: string;
  model: string | undefined;
  defaultModel: string | undefined;
  message: string;
  bypass?: boolean;
  pinModel?: boolean;
  effort?: string;
}): SessionStartParams {
  const params: SessionStartParams = { agentId: form.agentId, cwd: form.cwd };
  const title = form.title.trim();
  if (title !== '') params.title = title;
  if (form.model !== undefined && (form.model !== form.defaultModel || form.pinModel === true)) params.settings = { model: form.model };
  if (form.bypass === true) params.settings = { ...params.settings, approvalMode: 'never' };
  if (form.effort !== undefined && form.effort !== '') params.settings = { ...params.settings, effort: form.effort };
  const message = form.message.trim();
  if (message !== '') params.input = [{ type: 'text', text: message }];
  return params;
}

export interface Browser {
  path: string;
  parent: string | undefined;
  folders: DirEntry[];
  loading: boolean;
  error?: string;
}

export class NewSessionModel extends Model {
  agents: Agent[] = [];
  agentId: string | undefined;
  models: ModelInfo[] = [];
  modelId: string | undefined;
  modelsLoading = false;
  /** The model search text (shown from SEARCH_FROM models on). */
  modelFilter = '';
  /** The chosen effort level; undefined is Auto (the agent decides). */
  effort: string | undefined;
  projects: ProjectEntry[] = [];
  cwd: string | undefined;
  browser: Browser | undefined;
  title = '';
  message = '';
  /** "Bypass approvals (full access)": off unless this agent's last session had it on. */
  bypass = false;
  loading = false;
  submitting = false;
  error: string | undefined;
  private modelRequest = 0;
  private browseRequest = 0;

  constructor(
    private readonly client: NewSessionClient,
    private readonly starter: NewSessionStarter,
    private readonly storage: Pick<StorageLike, 'getItem' | 'setItem'> | null = defaultStorage(),
  ) {
    super();
  }

  get agent(): Agent | undefined {
    return this.agents.find((agent) => agent.id === this.agentId);
  }

  /** The models to offer, grouped by provider and narrowed by the search text. */
  get modelGroups(): ModelGroup[] {
    return groupModels(this.models, this.modelFilter, this.modelId);
  }

  get model(): ModelInfo | undefined {
    return this.models.find((m) => m.id === this.modelId);
  }

  /** True when the list is long enough to need the search field. */
  get modelSearch(): boolean {
    return this.models.length >= SEARCH_FROM;
  }

  /** The levels the chosen model offers; empty: no effort picker. */
  get efforts(): readonly string[] {
    return this.model?.efforts ?? [];
  }

  /** "Auto" is offered: the model has levels but names no default (the agent picks it). */
  get effortAuto(): boolean {
    return this.efforts.length > 0 && this.model?.defaultEffort === undefined;
  }

  /** The "Bypass approvals" switch is shown: the chosen agent honours approvalMode "never". */
  get bypassOffered(): boolean {
    return canBypass(this.agent);
  }

  get canSubmit(): boolean {
    return !this.submitting && this.agent?.status === 'ready' && this.cwd !== undefined;
  }

  /** Agents and recent projects; picks the first ready agent and the most recent project. */
  async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.changed();
    try {
      const [agents, projects] = await Promise.all([
        this.client.request<AgentListResult>('agent/list'),
        this.client.request<ProjectListResult>('project/list').catch(() => ({ projects: [] as ProjectEntry[] })),
      ]);
      this.agents = agents.agents;
      this.projects = [...projects.projects].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      if (this.cwd === undefined && this.projects[0] !== undefined) this.cwd = this.projects[0].path;
      const ready = this.agents.find((agent) => agent.status === 'ready');
      this.loading = false;
      this.changed();
      if (ready !== undefined) await this.selectAgent(ready.id);
    } catch (error) {
      this.loading = false;
      this.error = `Could not load agents: ${errorText(error)}`;
      this.changed();
    }
  }

  async selectAgent(agentId: string): Promise<void> {
    const agent = this.agents.find((a) => a.id === agentId);
    if (agent === undefined || agent.status !== 'ready') return;
    this.agentId = agentId;
    this.bypass = this.readBypass(agentId);
    this.models = [];
    this.modelId = undefined;
    this.effort = undefined;
    this.modelFilter = '';
    this.modelsLoading = true;
    const request = ++this.modelRequest;
    this.changed();
    try {
      const result = await this.client.request<ModelListResult>('model/list', { agentId });
      if (request !== this.modelRequest) return;
      this.models = result.models;
      this.modelId = (result.models.find((m) => m.default) ?? result.models[0])?.id;
      this.effort = pickEffort(this.model, this.readEffort(agentId));
    } catch {
      // the agent cannot list models (not_supported): no picker, the agent's default is used
      if (request !== this.modelRequest) return;
    }
    this.modelsLoading = false;
    this.changed();
  }

  selectModel(modelId: string): void {
    if (!this.models.some((m) => m.id === modelId)) return;
    this.modelId = modelId;
    this.effort = pickEffort(this.model, this.agentId === undefined ? undefined : this.readEffort(this.agentId));
    this.changed();
  }

  /** Chooses a level the model offers, or Auto (undefined, only when offered); remembered for the agent. */
  selectEffort(level: string | undefined): void {
    if (level === undefined ? !this.effortAuto : !this.efforts.includes(level)) return;
    this.effort = level;
    if (this.agentId !== undefined) {
      try {
        this.storage?.setItem(effortKey(this.agentId), level ?? '');
      } catch {
        // storage full or disabled: the choice still holds for this sheet
      }
    }
    this.changed();
  }

  private readEffort(agentId: string): string | null {
    try {
      return this.storage?.getItem(effortKey(agentId)) ?? null;
    } catch {
      return null;
    }
  }

  setModelFilter(filter: string): void {
    this.modelFilter = filter;
    this.changed();
  }

  /** Opens the folder browser at a path: the chosen folder, else the most recent project. */
  async browse(path?: string): Promise<void> {
    const target = path ?? this.cwd ?? this.projects[0]?.path ?? '/';
    const request = ++this.browseRequest;
    this.browser = { path: target, parent: parentOf(target), folders: this.browser?.path === target ? this.browser.folders : [], loading: true };
    this.changed();
    try {
      const result = await this.client.request<FsReadDirectoryResult>('fs/readDirectory', { path: target });
      if (request !== this.browseRequest) return;
      this.browser = { path: target, parent: parentOf(target), folders: foldersOf(result.entries), loading: false };
    } catch (error) {
      if (request !== this.browseRequest) return;
      this.browser = { path: target, parent: parentOf(target), folders: [], loading: false, error: errorText(error) };
    }
    this.changed();
  }

  /** Uses the folder being browsed (or a given one) as the working folder and closes the browser. */
  chooseFolder(path?: string): void {
    const chosen = path ?? this.browser?.path;
    if (chosen === undefined) return;
    this.cwd = chosen;
    this.browser = undefined;
    this.browseRequest += 1;
    this.changed();
  }

  closeBrowser(): void {
    this.browser = undefined;
    this.browseRequest += 1;
    this.changed();
  }

  setBypass(on: boolean): void {
    this.bypass = on;
    if (this.agentId !== undefined) {
      try {
        this.storage?.setItem(bypassKey(this.agentId), on ? '1' : '0');
      } catch {
        // storage full or disabled: the choice still holds for this sheet
      }
    }
    this.changed();
  }

  private readBypass(agentId: string): boolean {
    try {
      return this.storage?.getItem(bypassKey(agentId)) === '1';
    } catch {
      return false;
    }
  }

  setTitle(title: string): void {
    this.title = title;
    this.changed();
  }

  setMessage(message: string): void {
    this.message = message;
    this.changed();
  }

  /** session/start; resolves the new session's id, or undefined on failure (error is set). */
  async submit(): Promise<string | undefined> {
    if (!this.canSubmit) return undefined;
    this.submitting = true;
    this.error = undefined;
    this.changed();
    const defaultModel = (this.models.find((m) => m.default) ?? this.models[0])?.id;
    try {
      const result = await this.starter.startSession(
        startParams({
          agentId: this.agentId!,
          cwd: this.cwd!,
          title: this.title,
          model: this.modelId,
          defaultModel,
          message: this.message,
          bypass: this.bypass && this.bypassOffered,
          pinModel: typeof this.model?.provider === 'string',
          effort: this.efforts.length > 0 ? this.effort : undefined,
        }),
      );
      return result.session.sessionId;
    } catch (error) {
      this.error = `Could not start the session: ${errorText(error)}`;
      return undefined;
    } finally {
      this.submitting = false;
      this.changed();
    }
  }
}
