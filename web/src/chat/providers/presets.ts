// The preset list (provider-connection.md section 2) lives in ../presets/providers.json so screens and
// the host can share it; this module types it and runs the one-field detection of section 3 step 2.
import presetsJson from '../presets/providers.json';
import type { ProviderKind, ProviderRoute } from './types';
import { normalizeBaseURL, parseBase, routeFor } from './url';

/** The port Ollama listens on by default; any host on it is taken to be Ollama. */
const OLLAMA_PORT = '11434';

export interface Preset {
  name: string;
  /** Empty only for the Custom URL entry. */
  baseURL: string;
  kind: ProviderKind;
  keyPrefixes: string[];
  docsURL: string;
  keyHelpURL: string;
  notes: string;
}

export const PRESETS: readonly Preset[] = presetsJson as Preset[];

export const CUSTOM_PRESET: Preset = PRESETS.find((p) => p.baseURL === '') as Preset;

export type Detection =
  | { type: 'empty' }
  /** A key whose prefix names a preset: the preset's URL is pre-filled. */
  | { type: 'key'; preset: Preset; apiKey: string; baseURL: string; kind: ProviderKind; route: ProviderRoute }
  /** A key with no known prefix: the user picks the preset. */
  | { type: 'unknown-key'; apiKey: string }
  /** A server URL: Custom, with the kind derived from the host. */
  | { type: 'url'; preset: Preset; baseURL: string; kind: ProviderKind; route: ProviderRoute };

/**
 * Reads the single "Paste an API key or a server URL" field. A URL (with a scheme, or a host with a dot
 * or a port, or localhost) selects Custom; otherwise the longest matching key prefix selects its preset.
 */
export function detect(input: string): Detection {
  const text = input.trim();
  if (text === '') return { type: 'empty' };
  const baseURL = looksLikeURL(text) ? normalizeBaseURL(text) : null;
  if (baseURL !== null) {
    return { type: 'url', preset: CUSTOM_PRESET, baseURL, kind: kindForHost(baseURL), route: routeFor(baseURL) };
  }
  const preset = presetForKey(text);
  if (preset === null) return { type: 'unknown-key', apiKey: text };
  return {
    type: 'key',
    preset,
    apiKey: text,
    baseURL: preset.baseURL,
    kind: preset.kind,
    route: routeFor(preset.baseURL),
  };
}

/**
 * The wire format for a base URL, from its host only: an exact or subdomain match on a preset's host
 * (look-alikes such as `api.anthropic.com.example` do not match), host and port for presets on a
 * loopback address, any host on Ollama's port 11434; `openai-compatible` otherwise. Throws for input
 * that is not a base URL.
 */
export function kindForHost(baseURL: string): ProviderKind {
  const url = parseBase(baseURL);
  const host = url.hostname;
  for (const preset of PRESETS) {
    if (preset.kind === 'openai-compatible' || preset.baseURL === '') continue;
    const p = new URL(preset.baseURL);
    if (p.port !== '') {
      if (host === p.hostname && url.port === p.port) return preset.kind;
    } else if (host === p.hostname || host.endsWith(`.${p.hostname}`)) {
      return preset.kind;
    }
  }
  if (url.port === OLLAMA_PORT) return 'ollama';
  return 'openai-compatible';
}

/** The preset whose longest key prefix matches, or null. */
export function presetForKey(key: string): Preset | null {
  let best: Preset | null = null;
  let bestLength = 0;
  for (const preset of PRESETS) {
    for (const prefix of preset.keyPrefixes) {
      if (key.startsWith(prefix) && prefix.length > bestLength) {
        best = preset;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

function looksLikeURL(text: string): boolean {
  if (text.includes('://')) return true;
  if (presetForKey(text) !== null) return false;
  const host = text.split('/')[0] ?? '';
  return host.includes('.') || host.includes(':') || host.toLowerCase() === 'localhost';
}
