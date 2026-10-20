// The new-session sheet: pick an agent (agent/list), a model (model/list), a working folder (recent
// projects from project/list, then browsing with fs/readDirectory), an optional title and an optional
// first message, then session/start (spec 4, 6). With a first message the host starts the first turn
// in the same round trip.
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
import { errorText, Model } from './model';

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

/** session/start params from the form; empty title and message are left out. */
export function startParams(form: {
  agentId: string;
  cwd: string;
  title: string;
  model: string | undefined;
  defaultModel: string | undefined;
  message: string;
}): SessionStartParams {
  const params: SessionStartParams = { agentId: form.agentId, cwd: form.cwd };
  const title = form.title.trim();
  if (title !== '') params.title = title;
  if (form.model !== undefined && form.model !== form.defaultModel) params.settings = { model: form.model };
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
  projects: ProjectEntry[] = [];
  cwd: string | undefined;
  browser: Browser | undefined;
  title = '';
  message = '';
  loading = false;
  submitting = false;
  error: string | undefined;
  private modelRequest = 0;
  private browseRequest = 0;

  constructor(
    private readonly client: NewSessionClient,
    private readonly starter: NewSessionStarter,
  ) {
    super();
  }

  get agent(): Agent | undefined {
    return this.agents.find((agent) => agent.id === this.agentId);
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
    this.models = [];
    this.modelId = undefined;
    this.modelsLoading = true;
    const request = ++this.modelRequest;
    this.changed();
    try {
      const result = await this.client.request<ModelListResult>('model/list', { agentId });
      if (request !== this.modelRequest) return;
      this.models = result.models;
      this.modelId = (result.models.find((m) => m.default) ?? result.models[0])?.id;
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
        startParams({ agentId: this.agentId!, cwd: this.cwd!, title: this.title, model: this.modelId, defaultModel, message: this.message }),
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
