// The phone's Provider list (provider-connection.md sections 1, 3 step 5 and 5; local-chat.md ruling R2).
// Records and keys are two versioned entries in the same storage: the record keeps only a fingerprint,
// keys sit in a map keyed by record id, and only direct providers may have one (a host-routed provider's
// key stays on the Mac). Persistence follows replica/storage.ts: localStorage, injected in tests.
import type { StorageLike } from '../../replica/storage';
import { kindForHost, PRESETS } from './presets';
import type {
  ExportedProvider,
  ModelInfo,
  ProviderRecord,
  ProviderRoute,
  ProvidersExport,
  RefreshPolicy,
  SupportsTools,
} from './types';
import { hostLabel, normalizeBaseURL, routeFor } from './url';

export const PROVIDERS_STORAGE_KEY = 'nano-remote/providers/v1';
export const PROVIDER_KEYS_STORAGE_KEY = 'nano-remote/provider-keys/v1';

export const MIN_REFRESH_SECONDS = 30;
export const MAX_REFRESH_SECONDS = 86_400;
const FINGERPRINT_LENGTH = 6;

interface PersistedProviders {
  v: 1;
  providers: ProviderRecord[];
  defaultProviderId: string | null;
}

interface PersistedKeys {
  v: 1;
  keys: Record<string, string>;
}

export interface ProviderStoreOptions {
  storage: StorageLike | null;
  recordsKey?: string;
  keysKey?: string;
  now?: () => number;
  randomId?: () => string;
}

export interface NewProvider {
  baseURL: string;
  name?: string;
  apiKey?: string | null;
  /** A successful probe's list; cached with lastProbedAt = now. */
  models?: ModelInfo[];
  supportsTools?: SupportsTools;
  refresh?: RefreshPolicy;
}

export interface ProviderPatch {
  name?: string;
  baseURL?: string;
  supportsTools?: SupportsTools;
  refresh?: RefreshPolicy;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
}

/** Clamps an auto refresh interval to 30 s .. 1 day. */
export function clampRefresh(policy: RefreshPolicy): RefreshPolicy {
  if (policy.mode === 'manual') return { mode: 'manual' };
  const seconds = Number.isFinite(policy.intervalSeconds) ? Math.round(policy.intervalSeconds) : MIN_REFRESH_SECONDS;
  return { mode: 'auto', intervalSeconds: Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, seconds)) };
}

/** First 6 characters of a key, for display. */
export function fingerprint(apiKey: string): string {
  return apiKey.slice(0, FINGERPRINT_LENGTH);
}

/** The default display name: the preset's name for a preset URL, else the host. */
export function defaultName(baseURL: string): string {
  return PRESETS.find((p) => p.baseURL !== '' && p.baseURL === baseURL)?.name ?? hostLabel(baseURL);
}

export class ProviderStore {
  private readonly storage: StorageLike | null;
  private readonly recordsKey: string;
  private readonly keysKey: string;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private records: ProviderRecord[];
  private keys: Record<string, string>;
  private defaultId: string | null;
  private readonly listeners = new Set<() => void>();

  constructor(options: ProviderStoreOptions) {
    this.storage = options.storage;
    this.recordsKey = options.recordsKey ?? PROVIDERS_STORAGE_KEY;
    this.keysKey = options.keysKey ?? PROVIDER_KEYS_STORAGE_KEY;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    const persisted = loadRecords(this.storage, this.recordsKey);
    this.records = persisted?.providers ?? [];
    this.defaultId = persisted?.defaultProviderId ?? null;
    if (this.defaultId !== null && this.find(this.defaultId) === undefined) this.defaultId = this.records[0]?.id ?? null;
    this.keys = loadKeys(this.storage, this.keysKey);
  }

  /** Copies of all records, in insertion order. */
  list(): ProviderRecord[] {
    return this.records.map(clone);
  }

  get(id: string): ProviderRecord | undefined {
    const record = this.find(id);
    return record === undefined ? undefined : clone(record);
  }

  findByBaseURL(baseURL: string): ProviderRecord | undefined {
    const normalized = normalizeBaseURL(baseURL);
    const record = this.records.find((r) => r.baseURL === normalized);
    return record === undefined ? undefined : clone(record);
  }

  routeOf(id: string): ProviderRoute {
    return routeFor(this.require(id).baseURL);
  }

  /** The provider new chats use; the first provider added becomes it. */
  get defaultProviderId(): string | null {
    return this.defaultId;
  }

  setDefault(id: string): void {
    this.require(id);
    this.defaultId = id;
    this.commit();
  }

  /**
   * Saves a provider (section 3 step 5). Deduplicates by normalized base URL: an existing record with the
   * same URL is updated in place and keeps its id. Throws for an invalid URL, or for a key on a provider
   * routed through the host.
   */
  add(input: NewProvider): { record: ProviderRecord; created: boolean } {
    const baseURL = normalizeBaseURL(input.baseURL);
    if (baseURL === null) throw new Error(`not a base URL: ${input.baseURL}`);
    const hasKey = input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== '';
    if (hasKey && routeFor(baseURL) === 'host') throw new Error(HOST_KEY_ERROR);

    let record = this.records.find((r) => r.baseURL === baseURL);
    const created = record === undefined;
    if (record === undefined) {
      record = {
        id: this.randomId(),
        name: defaultName(baseURL),
        baseURL,
        kind: kindForHost(baseURL),
        apiKeyFingerprint: null,
        models: { list: [], lastProbedAt: null },
        hiddenModels: [],
        pinnedModels: [],
        supportsTools: 'unknown',
        refresh: { mode: 'manual' },
      };
      this.records.push(record);
      if (this.defaultId === null) this.defaultId = record.id;
    }
    if (input.name !== undefined && input.name.trim() !== '') record.name = input.name.trim();
    if (input.supportsTools !== undefined) record.supportsTools = input.supportsTools;
    if (input.refresh !== undefined) record.refresh = clampRefresh(input.refresh);
    if (input.models !== undefined) record.models = { list: input.models.map(cloneModel), lastProbedAt: this.now() };
    if (hasKey) this.storeKey(record, input.apiKey as string);
    this.commit();
    return { record: clone(record), created };
  }

  /**
   * Edits a record. A new base URL is normalized, must not belong to another record, and re-derives the
   * kind; if it moves the provider onto the host route, the key on this phone is deleted (R2).
   */
  update(id: string, patch: ProviderPatch): ProviderRecord {
    const record = this.require(id);
    if (patch.baseURL !== undefined) {
      const baseURL = normalizeBaseURL(patch.baseURL);
      if (baseURL === null) throw new Error(`not a base URL: ${patch.baseURL}`);
      if (this.records.some((r) => r.id !== id && r.baseURL === baseURL)) {
        throw new Error(`another provider already uses ${baseURL}`);
      }
      if (baseURL !== record.baseURL) {
        record.baseURL = baseURL;
        record.kind = kindForHost(baseURL);
        record.models = { list: [], lastProbedAt: null };
        if (routeFor(baseURL) === 'host') this.dropKey(record);
      }
    }
    if (patch.name !== undefined && patch.name.trim() !== '') record.name = patch.name.trim();
    if (patch.supportsTools !== undefined) record.supportsTools = patch.supportsTools;
    if (patch.refresh !== undefined) record.refresh = clampRefresh(patch.refresh);
    this.commit();
    return clone(record);
  }

  remove(id: string): void {
    const index = this.records.findIndex((r) => r.id === id);
    if (index < 0) return;
    this.records.splice(index, 1);
    delete this.keys[id];
    if (this.defaultId === id) this.defaultId = this.records[0]?.id ?? null;
    this.commit();
  }

  removeAll(): void {
    this.records = [];
    this.keys = {};
    this.defaultId = null;
    this.commit();
  }

  /** Stores (or with null, deletes) the key of a direct provider. Throws for a host-routed provider. */
  setKey(id: string, apiKey: string | null): void {
    const record = this.require(id);
    if (apiKey === null || apiKey === '') this.dropKey(record);
    else {
      if (routeFor(record.baseURL) === 'host') throw new Error(HOST_KEY_ERROR);
      this.storeKey(record, apiKey);
    }
    this.commit();
  }

  getKey(id: string): string | null {
    return this.keys[id] ?? null;
  }

  /** True for a direct provider without a key on this phone (after an import: "Enter the key for …"). */
  needsKey(id: string): boolean {
    return this.routeOf(id) === 'direct' && this.keys[id] === undefined;
  }

  /** Caches a probe's model list with lastProbedAt = now. */
  setModels(id: string, models: ModelInfo[]): void {
    this.require(id).models = { list: models.map(cloneModel), lastProbedAt: this.now() };
    this.commit();
  }

  hideModel(id: string, modelId: string): void {
    this.editList(id, 'hiddenModels', modelId, true);
  }

  unhideModel(id: string, modelId: string): void {
    this.editList(id, 'hiddenModels', modelId, false);
  }

  pinModel(id: string, modelId: string): void {
    this.editList(id, 'pinnedModels', modelId, true);
  }

  unpinModel(id: string, modelId: string): void {
    this.editList(id, 'pinnedModels', modelId, false);
  }

  /** The picker's list: cached models minus hidden ones, plus pinned ids the list did not return. */
  visibleModels(id: string): ModelInfo[] {
    const record = this.require(id);
    const hidden = new Set(record.hiddenModels);
    const visible = record.models.list.filter((m) => !hidden.has(m.id)).map(cloneModel);
    const listed = new Set(record.models.list.map((m) => m.id));
    for (const pinned of record.pinnedModels) {
      if (!listed.has(pinned) && !hidden.has(pinned)) {
        visible.push({ id: pinned, displayName: pinned, capabilities: {}, source: 'unknown' });
      }
    }
    return visible;
  }

  /** Every record without keys, fingerprints or cached models (section 5). */
  export(): ProvidersExport {
    return {
      format: 'nano-remote/providers',
      v: 1,
      providers: this.records.map(({ apiKeyFingerprint: _f, models: _m, ...rest }) => ({
        ...rest,
        hiddenModels: [...rest.hiddenModels],
        pinnedModels: [...rest.pinnedModels],
        refresh: { ...rest.refresh },
      })),
    };
  }

  /**
   * Merges an export by normalized base URL. A known URL keeps its id, key and cached models and takes the
   * imported name, tools setting and refresh, with hidden and pinned models unioned; an unknown URL
   * becomes a new record with a fresh id and no key. Kinds are re-derived from the host. Entries that are
   * not providers are skipped; a payload that is not an export throws.
   */
  import(data: unknown): ImportResult {
    if (!isExport(data)) throw new Error('not a Nano Remote providers export');
    const result: ImportResult = { added: 0, updated: 0, skipped: 0 };
    for (const entry of data.providers) {
      const incoming = readExported(entry);
      if (incoming === null) {
        result.skipped += 1;
        continue;
      }
      const existing = this.records.find((r) => r.baseURL === incoming.baseURL);
      if (existing !== undefined) {
        existing.name = incoming.name;
        existing.supportsTools = incoming.supportsTools;
        existing.refresh = incoming.refresh;
        existing.hiddenModels = union(existing.hiddenModels, incoming.hiddenModels);
        existing.pinnedModels = union(existing.pinnedModels, incoming.pinnedModels);
        result.updated += 1;
      } else {
        const record: ProviderRecord = {
          ...incoming,
          id: this.randomId(),
          kind: kindForHost(incoming.baseURL),
          apiKeyFingerprint: null,
          models: { list: [], lastProbedAt: null },
        };
        this.records.push(record);
        if (this.defaultId === null) this.defaultId = record.id;
        result.added += 1;
      }
    }
    this.commit();
    return result;
  }

  /** Called after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private find(id: string): ProviderRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  private require(id: string): ProviderRecord {
    const record = this.find(id);
    if (record === undefined) throw new Error(`no provider ${id}`);
    return record;
  }

  private storeKey(record: ProviderRecord, apiKey: string): void {
    this.keys[record.id] = apiKey;
    record.apiKeyFingerprint = fingerprint(apiKey);
  }

  private dropKey(record: ProviderRecord): void {
    delete this.keys[record.id];
    record.apiKeyFingerprint = null;
  }

  private editList(id: string, field: 'hiddenModels' | 'pinnedModels', modelId: string, present: boolean): void {
    const record = this.require(id);
    const without = record[field].filter((m) => m !== modelId);
    record[field] = present ? [...without, modelId] : without;
    this.commit();
  }

  private commit(): void {
    save(this.storage, this.recordsKey, { v: 1, providers: this.records, defaultProviderId: this.defaultId });
    save(this.storage, this.keysKey, { v: 1, keys: this.keys });
    for (const listener of [...this.listeners]) listener();
  }
}

const HOST_KEY_ERROR = 'this provider runs through your Mac; its key stays on the Mac';

function loadRecords(storage: StorageLike | null, key: string): PersistedProviders | null {
  const data = read(storage, key) as Partial<PersistedProviders> | null;
  if (data === null || data.v !== 1 || !Array.isArray(data.providers)) return null;
  const providers = data.providers.filter(isRecord);
  const defaultProviderId = typeof data.defaultProviderId === 'string' ? data.defaultProviderId : null;
  return { v: 1, providers, defaultProviderId };
}

function loadKeys(storage: StorageLike | null, key: string): Record<string, string> {
  const data = read(storage, key) as Partial<PersistedKeys> | null;
  if (data === null || data.v !== 1 || typeof data.keys !== 'object' || data.keys === null) return {};
  const keys: Record<string, string> = {};
  for (const [id, value] of Object.entries(data.keys)) if (typeof value === 'string') keys[id] = value;
  return keys;
}

function read(storage: StorageLike | null, key: string): unknown {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function save(storage: StorageLike | null, key: string, data: unknown): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(key, JSON.stringify(data));
    return true;
  } catch {
    return false; // quota or disabled storage: the in-memory list stays usable for this page
  }
}

function isRecord(value: unknown): value is ProviderRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<ProviderRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.baseURL === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.models === 'object' &&
    r.models !== null &&
    Array.isArray(r.models.list) &&
    Array.isArray(r.hiddenModels) &&
    Array.isArray(r.pinnedModels)
  );
}

function isExport(data: unknown): data is ProvidersExport {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Partial<ProvidersExport>;
  return d.format === 'nano-remote/providers' && d.v === 1 && Array.isArray(d.providers);
}

const TOOLS: readonly SupportsTools[] = ['yes', 'no', 'unknown'];

function readExported(entry: unknown): Omit<ExportedProvider, 'id' | 'kind'> | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Partial<ExportedProvider>;
  const baseURL = typeof e.baseURL === 'string' ? normalizeBaseURL(e.baseURL) : null;
  if (baseURL === null) return null;
  const name = typeof e.name === 'string' && e.name.trim() !== '' ? e.name.trim() : defaultName(baseURL);
  const refresh =
    e.refresh?.mode === 'auto' && typeof e.refresh.intervalSeconds === 'number'
      ? clampRefresh(e.refresh)
      : ({ mode: 'manual' } as const);
  return {
    name,
    baseURL,
    supportsTools: TOOLS.includes(e.supportsTools as SupportsTools) ? (e.supportsTools as SupportsTools) : 'unknown',
    refresh,
    hiddenModels: strings(e.hiddenModels),
    pinnedModels: strings(e.pinnedModels),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function cloneModel(model: ModelInfo): ModelInfo {
  return { ...model, capabilities: { ...model.capabilities } };
}

function clone(record: ProviderRecord): ProviderRecord {
  return {
    ...record,
    models: { list: record.models.list.map(cloneModel), lastProbedAt: record.models.lastProbedAt },
    hiddenModels: [...record.hiddenModels],
    pinnedModels: [...record.pinnedModels],
    refresh: { ...record.refresh },
  };
}
