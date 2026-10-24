// The model picker and the effort control, shared by the New session sheet and the session's settings
// sheet: models grouped by provider with a search field for long lists (spec 4 model/list), and the chosen
// model's effort levels as segments, with "Auto" for a model that names no default.
import type { ModelInfo } from '../generated/methods';
import { effortLabel, type ModelGroup } from './new-session-model';

/** What the fields read and call; NewSessionModel and SessionSettingsModel fit. */
export interface ModelEffortPicker {
  readonly models: readonly ModelInfo[];
  readonly modelsLoading: boolean;
  readonly modelId: string | undefined;
  readonly model: ModelInfo | undefined;
  readonly modelGroups: ModelGroup[];
  readonly modelSearch: boolean;
  readonly modelFilter: string;
  readonly efforts: readonly string[];
  readonly effortAuto: boolean;
  readonly effort: string | undefined;
  selectModel(modelId: string): void;
  setModelFilter(filter: string): void;
  selectEffort(level: string | undefined): void;
}

export interface ModelEffortFieldsProps {
  picker: ModelEffortPicker;
  /** Prefix of the select's id (`<prefix>-model`), unique per sheet. */
  idPrefix: string;
  /** Show the model picker (default true); false leaves only the effort control. */
  showModel?: boolean;
  /** Show the effort control (default true). */
  showEffort?: boolean;
}

export function ModelEffortFields({ picker, idPrefix, showModel = true, showEffort = true }: ModelEffortFieldsProps) {
  const selectId = `${idPrefix}-model`;
  return (
    <>
      {showModel && (picker.modelsLoading || picker.models.length > 0) && (
        <div class="field model-field">
          <label for={selectId}>Model</label>
          {picker.modelSearch && (
            <input
              type="search"
              name="model-search"
              class="model-search"
              placeholder={`Search ${picker.models.length} models`}
              aria-label="Search models"
              autocomplete="off"
              value={picker.modelFilter}
              onInput={(event) => picker.setModelFilter(event.currentTarget.value)}
            />
          )}
          <select
            id={selectId}
            name="model"
            value={picker.modelId ?? ''}
            disabled={picker.modelsLoading}
            onChange={(event) => picker.selectModel(event.currentTarget.value)}
          >
            {picker.modelsLoading && <option value="">Loading…</option>}
            {picker.modelGroups.map((group) =>
              group.provider === undefined ? (
                group.models.map((m) => <ModelOption key={m.id} model={m} />)
              ) : (
                <optgroup key={group.provider} label={group.provider}>
                  {group.models.map((m) => (
                    <ModelOption key={m.id} model={m} />
                  ))}
                </optgroup>
              ),
            )}
          </select>
          {picker.model?.provider !== undefined && <p class="small muted model-provider">via {picker.model.provider}</p>}
        </div>
      )}

      {showEffort && picker.efforts.length > 0 && (
        <fieldset class="field effort-field">
          <legend>Effort</legend>
          <div class="effort-choices" role="radiogroup" aria-label="Effort">
            {picker.effortAuto && <EffortChoice label="Auto" checked={picker.effort === undefined} onPick={() => picker.selectEffort(undefined)} />}
            {picker.efforts.map((level) => (
              <EffortChoice key={level} label={effortLabel(level)} checked={picker.effort === level} onPick={() => picker.selectEffort(level)} />
            ))}
          </div>
          <p class="small muted effort-hint">
            {picker.model?.defaultEffort !== undefined
              ? `${effortLabel(picker.model.defaultEffort)} is this model's default.`
              : 'Auto leaves the level to the agent.'}
          </p>
        </fieldset>
      )}
    </>
  );
}

function EffortChoice({ label, checked, onPick }: { label: string; checked: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} class={`choice${checked ? ' selected' : ''}`} onClick={onPick}>
      {label}
    </button>
  );
}

function ModelOption({ model }: { model: ModelInfo }) {
  return (
    <option value={model.id}>
      {model.displayName}
      {model.default ? ' (default)' : ''}
    </option>
  );
}
