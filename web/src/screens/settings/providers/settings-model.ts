// Settings > Providers, /settings (old address /settings/providers) (provider-connection.md section 3; local-chat.md rulings R1, R2).
// The list shows every provider on this phone and every provider kept on the paired Mac (`provider/list`,
// read-only here). The add flow is one field, "Paste an API key or a server URL", with live detection and
// the preset grid as the alternative; Test fetches the model list over the provider's route (ADR 0006) and
// Add enables only after a successful test or "Add without testing". "Find local servers" asks the Mac
// (`provider/discover`). Export writes JSON without keys; Import merges it back and asks for each key.
// Rules live here; SettingsScreen renders them.
import { createHostProbe, hostAvailable, type HostRequester } from '../../../chat/providers/host-probe';
import { CUSTOM_PRESET, detect, kindForHost, PRESETS, type Detection, type Preset } from '../../../chat/providers/presets';
import { probeModels, type FetchLike, type HostProbe, type ProbeErrorCode } from '../../../chat/providers/probe';
import { defaultName, type ProviderStore } from '../../../chat/providers/store';
import type { ModelInfo, ProviderKind, ProviderRecord, ProviderRoute } from '../../../chat/providers/types';
import { hostLabel, normalizeBaseURL, routeFor } from '../../../chat/providers/url';
import { formatAgo } from '../../home-model';
import { Model } from '../../model';

export const EXPORT_FILENAME = 'nano-remote-providers.json';
export const NO_HOST_DISCOVERY = 'Pair your Mac first: it is the one that looks for servers on your network.';
export const NO_CANDIDATES = 'Your Mac found no model servers. Start Ollama or LM Studio on it and try again.';
export const DISCOVERY_FAILED = 'Your Mac could not look for servers. Try again.';
export const NOT_AN_EXPORT = 'That file is not a Nano Remote providers export.';
export const HOST_KEY_NOTE = "Servers that run through your Mac keep their key in the Mac's config.json.";

const KIND_LABELS: Record<ProviderKind, string> = {
  'openai-compatible': 'OpenAI-compatible',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

/** The badge for a wire format. */
export function kindLabel(kind: ProviderKind): string {
  return KIND_LABELS[kind];
}

/** The route line of ADR 0006. */
export function routeLabel(route: ProviderRoute): string {
  return route === 'direct' ? 'direct' : 'via your Mac';
}

export interface ProviderRow {
  id: string;
  name: string;
  baseURL: string;
  kind: string;
  route: string;
  /** "key sk-pro…", "no key", "key on your Mac". */
  key: string;
  /** "3 models", "1 model", "no models yet". */
  models: string;
  /** "probed 5 min ago", "never probed"; empty for the Mac's rows (the Mac probes them). */
  probed: string;
  isDefault: boolean;
  /** `mac` rows are kept in the host's config.json and are read-only here. */
  source: 'phone' | 'mac';
  /** A direct provider on this phone with no key and no model list yet (after an import): "Enter the key for …". */
  needsKey: boolean;
}

export type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; models: ModelInfo[] }
  /** Reachable but no models: may be saved anyway (section 3 step 4). */
  | { status: 'empty'; message: string }
  | { status: 'failed'; code: ProbeErrorCode; message: string };

export type DiscoveryState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; candidates: Candidate[] }
  | { status: 'failed'; message: string };

export interface Candidate {
  baseURL: string;
  kind: ProviderKind;
  /** "Ollama on your Mac", "OpenAI-compatible server at 100.101.1.2:1234". */
  name: string;
  /** Already in the list (same normalized base URL). */
  added: boolean;
}

export interface Form {
  mode: 'add' | 'edit';
  /** The record being edited (edit mode). */
  id?: string;
  paste: string;
  /** What the paste field holds, as detected live. */
  detection: Detection;
  preset: Preset | null;
  baseURL: string;
  apiKey: string;
  name: string;
  test: TestState;
  /** One sentence when saving failed (edit: the address belongs to another provider). */
  error?: string;
}

/** A provider kept in the Mac's config.json (`provider/list`). */
interface HostProvider {
  id: string;
  name: string;
  baseURL: string;
  kind: ProviderKind;
  hasKey: boolean;
}

type Confirm = { type: 'delete'; id: string; name: string } | { type: 'delete-all' };

interface KeyPrompt {
  draft: string;
  busy: boolean;
  error?: string;
}

export interface ProviderSettingsOptions {
  providers: ProviderStore;
  /** The paired host's stream client while there is one. */
  host: () => HostRequester | null;
  /** For direct providers (ADR 0006); absent means direct tests cannot run. */
  fetch?: FetchLike;
  /** The host route of Test; by default `provider/models` on `host()`. */
  hostProbe?: HostProbe;
  now?: () => number;
  /** The probe's connect timeout; 10 s by default. */
  timeoutMs?: number;
}

export class ProviderSettingsModel extends Model {
  private readonly providers: ProviderStore;
  private readonly host: () => HostRequester | null;
  private readonly fetch: FetchLike | undefined;
  private readonly hostProbe: HostProbe;
  private readonly now: () => number;
  private readonly timeoutMs: number | undefined;
  private readonly unsubscribe: () => void;
  private hostProviders: HostProvider[] = [];
  private hostModelCounts = new Map<string, number>();
  private formValue: Form | null = null;
  private testAbort: AbortController | undefined;
  private discoveryValue: DiscoveryState = { status: 'idle' };
  private confirmValue: Confirm | null = null;
  private noticeValue: string | undefined;
  private readonly keyPrompts = new Map<string, KeyPrompt>();
  private disposed = false;

  constructor(options: ProviderSettingsOptions) {
    super();
    this.providers = options.providers;
    this.host = options.host;
    this.fetch = options.fetch;
    this.hostProbe = options.hostProbe ?? createHostProbe(options.host);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs;
    this.unsubscribe = this.providers.subscribe(() => this.changed());
  }

  dispose(): void {
    this.disposed = true;
    this.testAbort?.abort();
    this.unsubscribe();
  }

  // ---- the list ---------------------------------------------------------------------------------

  get rows(): ProviderRow[] {
    const now = this.now();
    const defaultId = this.providers.defaultProviderId;
    const phone = this.providers.list().map((r) => this.phoneRow(r, r.id === defaultId, now));
    const known = new Set(phone.map((r) => r.baseURL));
    const mac = this.hostProviders.filter((p) => !known.has(p.baseURL)).map((p) => this.macRow(p));
    return [...phone, ...mac];
  }

  get empty(): boolean {
    return this.rows.length === 0;
  }

  /** Loads the providers kept on the Mac; without a host the list simply has none. */
  async loadHostProviders(): Promise<void> {
    const host = this.host();
    if (!hostAvailable(host)) return;
    let listed: HostProvider[];
    try {
      const result = await host.request<{ providers?: unknown }>('provider/list');
      listed = Array.isArray(result?.providers) ? result.providers.map(readHostProvider).filter((p) => p !== null) : [];
    } catch {
      return; // the list stays as it was; the Mac's rows are a convenience here
    }
    if (this.disposed) return;
    this.hostProviders = listed;
    this.changed();
    await Promise.all(listed.map((p) => this.countHostModels(host, p.id)));
  }

  private async countHostModels(host: HostRequester, providerId: string): Promise<void> {
    try {
      const result = await host.request<{ models?: unknown }>('provider/models', { providerId });
      if (!Array.isArray(result?.models) || this.disposed) return;
      this.hostModelCounts.set(providerId, result.models.length);
      this.changed();
    } catch {
      // no count: the row says so
    }
  }

  private phoneRow(record: ProviderRecord, isDefault: boolean, now: number): ProviderRow {
    const route = routeFor(record.baseURL);
    const count = this.providers.visibleModels(record.id).length;
    const fp = record.apiKeyFingerprint;
    return {
      id: record.id,
      name: record.name,
      baseURL: record.baseURL,
      kind: kindLabel(record.kind),
      route: routeLabel(route),
      key: fp !== null ? `key ${fp}…` : 'no key',
      models: count === 0 ? 'no models yet' : plural(count, 'model'),
      probed: record.models.lastProbedAt === null ? 'never probed' : `probed ${formatAgo(Math.floor(record.models.lastProbedAt / 1000), now)}`,
      isDefault,
      source: 'phone',
      needsKey: route === 'direct' && this.providers.needsKey(record.id) && record.models.lastProbedAt === null,
    };
  }

  private macRow(p: HostProvider): ProviderRow {
    const count = this.hostModelCounts.get(p.id);
    return {
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      kind: kindLabel(p.kind),
      route: routeLabel('host'),
      key: p.hasKey ? 'key on your Mac' : 'no key',
      models: count === undefined ? 'models on your Mac' : count === 0 ? 'no models yet' : plural(count, 'model'),
      probed: '',
      isDefault: false,
      source: 'mac',
      needsKey: false,
    };
  }

  setDefault(id: string): void {
    this.providers.setDefault(id);
  }

  // ---- the add and edit form --------------------------------------------------------------------

  get form(): Form | null {
    return this.formValue;
  }

  openAdd(): void {
    this.testAbort?.abort();
    this.noticeValue = undefined;
    this.formValue = blankForm();
    this.changed();
  }

  openEdit(id: string): void {
    const record = this.providers.get(id);
    if (record === undefined) return;
    this.testAbort?.abort();
    this.noticeValue = undefined;
    this.formValue = {
      ...blankForm(),
      mode: 'edit',
      id,
      preset: PRESETS.find((p) => p.baseURL === record.baseURL) ?? CUSTOM_PRESET,
      baseURL: record.baseURL,
      name: record.name,
    };
    this.changed();
  }

  closeForm(): void {
    this.testAbort?.abort();
    this.formValue = null;
    this.changed();
  }

  /**
   * The one field (section 3 step 2): a known key prefix selects its preset and fills its base URL; a URL
   * selects Custom with the kind derived from the host; an unknown key waits for a preset to be tapped.
   */
  setPaste(text: string): void {
    const form = this.editable();
    if (form === undefined) return;
    const detection = detect(text);
    const next: Form = { ...form, paste: text, detection };
    switch (detection.type) {
      case 'key':
        Object.assign(next, { preset: detection.preset, baseURL: detection.baseURL, apiKey: detection.apiKey });
        break;
      case 'url':
        Object.assign(next, { preset: CUSTOM_PRESET, baseURL: detection.baseURL, apiKey: '' });
        break;
      case 'unknown-key':
        Object.assign(next, { apiKey: detection.apiKey, ...(next.preset === null ? {} : { baseURL: next.preset.baseURL }) });
        break;
      case 'empty':
        Object.assign(next, { preset: null, baseURL: '', apiKey: '' });
        break;
    }
    this.replaceForm(next);
  }

  /** A tap on the preset grid: fills its base URL and keeps a key pasted so far (focus goes to the key field). */
  choosePreset(preset: Preset): void {
    const form = this.editable();
    if (form === undefined) return;
    const baseURL = preset.baseURL === '' ? (form.preset === CUSTOM_PRESET ? form.baseURL : '') : preset.baseURL;
    this.replaceForm({ ...form, preset, baseURL });
  }

  setBaseURL(text: string): void {
    const form = this.editable();
    if (form !== undefined) this.replaceForm({ ...form, baseURL: text });
  }

  setApiKey(text: string): void {
    const form = this.editable();
    if (form !== undefined) this.replaceForm({ ...form, apiKey: text });
  }

  setName(text: string): void {
    const form = this.formValue;
    if (form === null) return;
    this.formValue = { ...form, name: text };
    delete this.formValue.error;
    this.changed();
  }

  /** The normalized base URL of the form, or null while it is not one. */
  get formBaseURL(): string | null {
    const form = this.formValue;
    return form === null ? null : normalizeBaseURL(form.baseURL);
  }

  get formRoute(): ProviderRoute | null {
    const baseURL = this.formBaseURL;
    return baseURL === null ? null : routeFor(baseURL);
  }

  get formKind(): ProviderKind | null {
    const baseURL = this.formBaseURL;
    return baseURL === null ? null : kindForHost(baseURL);
  }

  /** The line under the paste field: what was recognized, and where it will go. */
  get detectionText(): string {
    const form = this.formValue;
    if (form === null) return '';
    const d = form.detection;
    switch (d.type) {
      case 'empty':
        return '';
      case 'key':
        return `${d.preset.name} key · ${routeLabel(d.route)}`;
      case 'unknown-key':
        return form.preset === null ? 'A key: pick its provider below.' : `Key for ${form.preset.name}`;
      case 'url':
        return `Server URL · ${kindLabel(d.kind)} · ${routeLabel(d.route)}`;
    }
  }

  /** Keys are kept on this phone only for direct providers; the Mac keeps the others' (R2). */
  get keyAllowed(): boolean {
    return this.formRoute !== 'host';
  }

  /** The name used when saving and in messages: typed, else the preset's, else the host. */
  get formName(): string {
    const form = this.formValue;
    if (form === null) return '';
    if (form.name.trim() !== '') return form.name.trim();
    const baseURL = this.formBaseURL;
    if (form.preset !== null && form.preset !== CUSTOM_PRESET) return form.preset.name;
    return baseURL === null ? '' : defaultName(baseURL);
  }

  /** In the add form: the provider already saved under this address (saving updates it). */
  get duplicate(): ProviderRow | undefined {
    const form = this.formValue;
    const baseURL = this.formBaseURL;
    if (form === null || form.mode !== 'add' || baseURL === null) return undefined;
    return this.rows.find((r) => r.source === 'phone' && r.baseURL === baseURL);
  }

  get canTest(): boolean {
    return this.formValue !== null && this.formValue.test.status !== 'testing' && this.formBaseURL !== null;
  }

  /** Add (or Save) is enabled after a test that reached the provider; edits may always be saved. */
  get canAdd(): boolean {
    const form = this.formValue;
    if (form === null || this.formBaseURL === null) return false;
    if (form.mode === 'edit') return form.test.status !== 'testing';
    return form.test.status === 'ok' || form.test.status === 'empty';
  }

  /** "Add without testing" for offline servers: any valid address while no test is running. */
  get canAddWithoutTesting(): boolean {
    const form = this.formValue;
    return form !== null && form.mode === 'add' && this.formBaseURL !== null && form.test.status !== 'testing' && !this.canAdd;
  }

  /** Test before add (section 3 step 3): the live model list, or one sentence. */
  async test(): Promise<void> {
    const form = this.formValue;
    const baseURL = this.formBaseURL;
    if (form === null || baseURL === null || form.test.status === 'testing') return;
    this.testAbort?.abort();
    const abort = new AbortController();
    this.testAbort = abort;
    this.setTest({ status: 'testing' });
    const result = await probeModels(
      { name: this.formName, baseURL, kind: kindForHost(baseURL), apiKey: this.formKey() },
      {
        ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
        hostProbe: this.hostProbe,
        signal: abort.signal,
        ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      },
    );
    if (abort.signal.aborted || this.formValue === null || this.formValue.test.status !== 'testing') return;
    if (result.ok) this.setTest({ status: 'ok', models: result.models });
    else if (result.code === 'no-models') this.setTest({ status: 'empty', message: result.message });
    else this.setTest({ status: 'failed', code: result.code, message: result.message });
  }

  /**
   * Saves the form (section 3 step 5): the store deduplicates by normalized base URL, keeps the key (direct
   * providers only) and the tested model list, and makes the first provider the default. Returns the
   * record's id, or null when nothing was saved.
   */
  save(options: { withoutTesting?: boolean } = {}): string | null {
    const form = this.formValue;
    const baseURL = this.formBaseURL;
    if (form === null || baseURL === null) return null;
    if (!this.canAdd && !(options.withoutTesting === true && this.canAddWithoutTesting)) return null;
    const models = form.test.status === 'ok' ? form.test.models : undefined;
    const apiKey = this.formKey();
    const name = this.formName;
    if (form.mode === 'edit' && form.id !== undefined) {
      try {
        this.providers.update(form.id, { name, baseURL });
      } catch {
        this.formValue = { ...form, error: 'Another provider already uses this address. Edit that one instead.' };
        this.changed();
        return null;
      }
      if (apiKey !== null) this.providers.setKey(form.id, apiKey);
      if (models !== undefined) this.providers.setModels(form.id, models);
      this.finish(`Saved ${name}.`);
      return form.id;
    }
    const { record, created } = this.providers.add({ baseURL, name, apiKey, ...(models === undefined ? {} : { models }) });
    this.finish(created ? `Added ${record.name}.` : `Updated ${record.name}: it was already in your list.`);
    return record.id;
  }

  private formKey(): string | null {
    const form = this.formValue;
    if (form === null || !this.keyAllowed) return null;
    const key = form.apiKey.trim();
    return key === '' ? null : key;
  }

  private finish(notice: string): void {
    this.testAbort?.abort();
    this.formValue = null;
    this.noticeValue = notice;
    this.changed();
  }

  private editable(): Form | undefined {
    return this.formValue ?? undefined;
  }

  /** Any change to what would be tested makes the last test stale. */
  private replaceForm(next: Form): void {
    this.testAbort?.abort();
    const form: Form = { ...next, test: { status: 'idle' } };
    delete form.error;
    this.formValue = form;
    this.changed();
  }

  private setTest(test: TestState): void {
    if (this.formValue === null) return;
    this.formValue = { ...this.formValue, test };
    this.changed();
  }

  // ---- find local servers -----------------------------------------------------------------------

  get discovery(): DiscoveryState {
    const state = this.discoveryValue;
    if (state.status !== 'done') return state;
    const known = new Set(this.providers.list().map((r) => r.baseURL));
    return { status: 'done', candidates: state.candidates.map((c) => ({ ...c, added: known.has(c.baseURL) })) };
  }

  /** `provider/discover` through the paired Mac; without one, the line that says so. */
  async discover(): Promise<void> {
    if (this.discoveryValue.status === 'searching') return;
    const host = this.host();
    if (!hostAvailable(host)) {
      this.discoveryValue = { status: 'failed', message: NO_HOST_DISCOVERY };
      this.changed();
      return;
    }
    this.discoveryValue = { status: 'searching' };
    this.changed();
    let next: DiscoveryState;
    try {
      const result = await host.request<{ candidates?: unknown }>('provider/discover');
      const candidates = Array.isArray(result?.candidates) ? result.candidates.map(readCandidate).filter((c) => c !== null) : [];
      next = candidates.length === 0 ? { status: 'failed', message: NO_CANDIDATES } : { status: 'done', candidates };
    } catch {
      next = { status: 'failed', message: DISCOVERY_FAILED };
    }
    if (this.disposed) return;
    this.discoveryValue = next;
    this.changed();
  }

  /**
   * One tap on a found server: tests it through the Mac and adds it when it answers; otherwise the add form
   * stays open with the sentence and "Add without testing".
   */
  async addCandidate(candidate: Candidate): Promise<void> {
    this.openAdd();
    this.replaceForm({ ...(this.formValue as Form), preset: CUSTOM_PRESET, baseURL: candidate.baseURL, name: candidate.name });
    await this.test();
    if (this.canAdd) this.save();
  }

  // ---- delete -----------------------------------------------------------------------------------

  get confirm(): Confirm | null {
    return this.confirmValue;
  }

  askDelete(id: string): void {
    const record = this.providers.get(id);
    if (record === undefined) return;
    this.confirmValue = { type: 'delete', id, name: record.name };
    this.changed();
  }

  askDeleteAll(): void {
    if (this.providers.list().length === 0) return;
    this.confirmValue = { type: 'delete-all' };
    this.changed();
  }

  cancelConfirm(): void {
    this.confirmValue = null;
    this.changed();
  }

  confirmDelete(): void {
    const confirm = this.confirmValue;
    if (confirm === null) return;
    this.confirmValue = null;
    if (confirm.type === 'delete') {
      this.providers.remove(confirm.id);
      this.keyPrompts.delete(confirm.id);
      if (this.formValue?.id === confirm.id) this.formValue = null;
      this.noticeValue = `Deleted ${confirm.name}.`;
    } else {
      this.providers.removeAll();
      this.keyPrompts.clear();
      this.formValue = null;
      this.noticeValue = 'Deleted every provider on this phone.';
    }
    this.changed();
  }

  // ---- export and import ------------------------------------------------------------------------

  /** The export file: every provider on this phone, without keys or cached models (section 5). */
  exportFile(): { name: string; type: string; text: string } {
    return { name: EXPORT_FILENAME, type: 'application/json', text: `${JSON.stringify(this.providers.export(), null, 2)}\n` };
  }

  /** Merges an export file; imported direct providers then ask for their key (section 7, ruling R2). */
  importText(text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.noticeValue = NOT_AN_EXPORT;
      this.changed();
      return;
    }
    try {
      const result = this.providers.import(data);
      const total = result.added + result.updated;
      const keys = this.providers.list().filter((r) => routeFor(r.baseURL) === 'direct' && this.providers.needsKey(r.id)).length;
      this.noticeValue =
        total === 0
          ? 'That file has no providers.'
          : `Imported ${plural(total, 'provider')}.${keys > 0 ? ' Enter the key where asked.' : ''}`;
    } catch {
      this.noticeValue = NOT_AN_EXPORT;
    }
    this.changed();
  }

  get notice(): string | undefined {
    return this.noticeValue;
  }

  dismissNotice(): void {
    if (this.noticeValue === undefined) return;
    this.noticeValue = undefined;
    this.changed();
  }

  // ---- "Enter the key for …" --------------------------------------------------------------------

  keyPrompt(id: string): KeyPrompt {
    return this.keyPrompts.get(id) ?? { draft: '', busy: false };
  }

  setKeyDraft(id: string, draft: string): void {
    const prompt = this.keyPrompt(id);
    this.keyPrompts.set(id, { draft, busy: prompt.busy });
    this.changed();
  }

  /** Stores the key and refreshes the model list with it; a failed test keeps the key and shows why. */
  async submitKey(id: string): Promise<void> {
    const record = this.providers.get(id);
    const prompt = this.keyPrompt(id);
    const key = prompt.draft.trim();
    if (record === undefined || prompt.busy || key === '') return;
    this.keyPrompts.set(id, { draft: key, busy: true });
    this.changed();
    const result = await probeModels(
      { name: record.name, baseURL: record.baseURL, kind: record.kind, apiKey: key },
      { ...(this.fetch === undefined ? {} : { fetch: this.fetch }), ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }) },
    );
    if (this.providers.get(id) === undefined) return;
    if (!result.ok && result.code === 'wrong-key') {
      this.keyPrompts.set(id, { draft: key, busy: false, error: result.message });
      this.changed();
      return;
    }
    this.providers.setKey(id, key);
    if (result.ok) this.providers.setModels(id, result.models);
    if (result.ok || result.code === 'no-models') this.keyPrompts.delete(id);
    else this.keyPrompts.set(id, { draft: '', busy: false, error: result.message });
    this.changed();
  }
}

function blankForm(): Form {
  return { mode: 'add', paste: '', detection: { type: 'empty' }, preset: null, baseURL: '', apiKey: '', name: '', test: { status: 'idle' } };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const HOST_KINDS: readonly ProviderKind[] = ['openai-compatible', 'anthropic', 'ollama'];

function readHostProvider(value: unknown): HostProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const baseURL = typeof v.baseURL === 'string' ? normalizeBaseURL(v.baseURL) : null;
  if (typeof v.id !== 'string' || v.id === '' || baseURL === null) return null;
  const kind = HOST_KINDS.includes(v.kind as ProviderKind) ? (v.kind as ProviderKind) : 'openai-compatible';
  const name = typeof v.name === 'string' && v.name.trim() !== '' ? v.name.trim() : hostLabel(baseURL);
  return { id: v.id, name, baseURL, kind, hasKey: v.hasKey === true };
}

/** A `provider/discover` candidate with its display name; null when it is not one. */
export function readCandidate(value: unknown): Candidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const baseURL = typeof v.baseURL === 'string' ? normalizeBaseURL(v.baseURL) : null;
  if (baseURL === null) return null;
  const kind = HOST_KINDS.includes(v.kind as ProviderKind) ? (v.kind as ProviderKind) : kindForHost(baseURL);
  const what = kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible server';
  const host = new URL(baseURL).hostname;
  const loopback = host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  const name = loopback ? `${what} on your Mac` : `${what} at ${hostLabel(baseURL)}`;
  return { baseURL, kind, name, added: false };
}
