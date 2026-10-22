// The Provider record of docs/plan/provider-connection.md section 1. A Provider is a URL plus a key: the
// normalized base URL is its identity, the kind is derived from the host, and the key never lives in the
// record (it sits in a separate map keyed by record id; see store.ts).

/** Wire format family. Everything unknown is OpenAI-compatible. */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'ollama' | 'gemini';

/** ADR 0006: https on a public host is called from the phone; everything else through the paired host. */
export type ProviderRoute = 'direct' | 'host';

export type SupportsTools = 'yes' | 'no' | 'unknown';

/** `manual`, or `auto` with an interval clamped to 30 s .. 1 day. */
export type RefreshPolicy = { mode: 'manual' } | { mode: 'auto'; intervalSeconds: number };

export interface ModelCapabilities {
  tools?: boolean;
  reasoning?: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  capabilities: ModelCapabilities;
  /** Where the capabilities come from: vendor metadata, or none known yet. */
  source: 'vendor' | 'unknown';
}

export interface ModelsCache {
  list: ModelInfo[];
  /** Epoch milliseconds of the last successful probe; null when never probed. */
  lastProbedAt: number | null;
}

export interface ProviderRecord {
  id: string;
  name: string;
  baseURL: string;
  kind: ProviderKind;
  /** First 6 characters of the key, for display; null when no key is stored on this phone. */
  apiKeyFingerprint: string | null;
  models: ModelsCache;
  hiddenModels: string[];
  pinnedModels: string[];
  supportsTools: SupportsTools;
  refresh: RefreshPolicy;
}

/** A record as it leaves the phone: no key, no fingerprint, no cached models. */
export type ExportedProvider = Omit<ProviderRecord, 'apiKeyFingerprint' | 'models'>;

export interface ProvidersExport {
  format: 'nano-remote/providers';
  v: 1;
  providers: ExportedProvider[];
}
