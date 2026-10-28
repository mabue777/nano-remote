// The session's settings sheet: change the model and the effort of an open session (spec 6
// session/settings/update). It offers the same grouped model picker and effort control as the New session
// sheet, only for what the agent's capabilities.settingsUpdate lists. The current settings are preselected:
// the session's model (else the agent's default, which is what a session started without one runs on) and
// its effort (else the model's default; "Auto" only while the session names no level, because a change
// cannot take a level away). Save sends what differs. The change applies from the next turn: while a turn
// runs the sheet says "Applies after this turn".
import type { ModelInfo, SessionSettingsUpdateParams, SessionSettingsUpdateResult } from '../../generated/methods';
import type { SettingsKey } from '../capabilities';
import { errorText, Model } from '../model';
import { groupModels, modelLabel, pickEffort, SEARCH_FROM, type ModelGroup } from '../new-session-model';
import type { ModelEffortPicker } from '../ModelEffortFields';

/** The note while a turn runs. */
export const APPLIES_LATER = 'Applies after this turn';

/** What the sheet needs from the Replica; Replica fits. */
export interface SettingsReplica {
  models(agentId: string): Promise<ModelInfo[]>;
  updateSettings(sessionId: string, settings: SessionSettingsUpdateParams['settings']): Promise<SessionSettingsUpdateResult>;
}

export interface SessionSettingsOptions {
  sessionId: string;
  agentId: string;
  /** Session.settings as the session reports them now. */
  current: { model?: string; effort?: string };
  /** What the agent can change in an open session (capabilities.settingsUpdate). */
  keys: readonly SettingsKey[];
  /** True while a turn runs. */
  running: () => boolean;
  replica: SettingsReplica;
}

export class SessionSettingsModel extends Model implements ModelEffortPicker {
  models: ModelInfo[] = [];
  modelsLoading = false;
  modelId: string | undefined;
  modelFilter = '';
  effort: string | undefined;
  saving = false;
  error: string | undefined;
  private readonly options: SessionSettingsOptions;
  /** The level preselected on load: the session's, or the model's default when the session names none. */
  private loadedEffort: string | undefined;

  constructor(options: SessionSettingsOptions) {
    super();
    this.options = options;
  }

  get canChangeModel(): boolean {
    return this.options.keys.includes('model');
  }

  get canChangeEffort(): boolean {
    return this.options.keys.includes('effort');
  }

  get model(): ModelInfo | undefined {
    return this.models.find((m) => m.id === this.modelId);
  }

  get modelGroups(): ModelGroup[] {
    return groupModels(this.models, this.modelFilter, this.modelId);
  }

  get modelSearch(): boolean {
    return this.models.length >= SEARCH_FROM;
  }

  get efforts(): readonly string[] {
    return this.model?.efforts ?? [];
  }

  /** "Auto": the model names no default and the session names no level (a change cannot clear one). */
  get effortAuto(): boolean {
    return this.efforts.length > 0 && this.model?.defaultEffort === undefined && this.options.current.effort === undefined;
  }

  /** "Applies after this turn" while a turn runs; undefined otherwise. */
  get note(): string | undefined {
    return this.options.running() ? APPLIES_LATER : undefined;
  }

  /** The model the session runs on now: its settings.model, else the agent's default. */
  private get currentModel(): string | undefined {
    return this.options.current.model ?? (this.models.find((m) => m.default) ?? this.models[0])?.id;
  }

  /** What Save sends: the settings that differ from the session's. */
  get change(): Partial<Record<SettingsKey, string>> {
    const change: Partial<Record<SettingsKey, string>> = {};
    if (this.canChangeModel && this.modelId !== undefined && this.modelId !== this.currentModel) change.model = this.modelId;
    const baseline = this.options.current.effort ?? this.loadedEffort;
    if (this.canChangeEffort && this.effort !== undefined && this.effort !== baseline) change.effort = this.effort;
    return change;
  }

  get canSave(): boolean {
    return !this.saving && !this.modelsLoading && Object.keys(this.change).length > 0;
  }

  /** model/list for the agent; preselects the session's model and effort. */
  async load(): Promise<void> {
    this.modelsLoading = true;
    this.error = undefined;
    this.changed();
    try {
      const models = await this.options.replica.models(this.options.agentId);
      const current = this.options.current.model;
      // A model the list no longer names stays choosable, so the sheet never shows another one as current.
      this.models = current !== undefined && !models.some((m) => m.id === current) ? [{ id: current, displayName: modelLabel(current), default: false }, ...models] : models;
      this.modelId = this.currentModel;
      // The session's level, else the model's default ('' reads as Auto for a model without one).
      this.effort = pickEffort(this.model, this.options.current.effort ?? '');
      this.loadedEffort = this.effort;
    } catch (error) {
      this.error = `Could not load the models: ${errorText(error)}`;
    }
    this.modelsLoading = false;
    this.changed();
  }

  selectModel(modelId: string): void {
    if (!this.canChangeModel || !this.models.some((m) => m.id === modelId)) return;
    this.modelId = modelId;
    // Keep the chosen level when the new model has it, else its default.
    this.effort = pickEffort(this.model, this.effort ?? this.options.current.effort ?? '');
    this.changed();
  }

  selectEffort(level: string | undefined): void {
    if (!this.canChangeEffort) return;
    if (level === undefined ? !this.effortAuto : !this.efforts.includes(level)) return;
    this.effort = level;
    this.changed();
  }

  setModelFilter(filter: string): void {
    this.modelFilter = filter;
    this.changed();
  }

  /** session/settings/update with the change; resolves true when the host took it (the sheet closes). */
  async save(): Promise<boolean> {
    if (!this.canSave) return false;
    this.saving = true;
    this.error = undefined;
    this.changed();
    try {
      await this.options.replica.updateSettings(this.options.sessionId, this.change);
      return true;
    } catch (error) {
      this.error = `Could not change the settings: ${errorText(error)}`;
      return false;
    } finally {
      this.saving = false;
      this.changed();
    }
  }
}
