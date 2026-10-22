// The `providers` key of config.json: Providers kept on the host for the relay (protocol-v1.md section 15,
// ADR 0006 ruling R2). Their keys stay in this file; the protocol only says whether one is set.
//
//   "providers": [
//     {"id": "mac-ollama", "name": "Ollama on this Mac", "baseURL": "http://127.0.0.1:11434"},
//     {"id": "lab", "name": "Lab vLLM", "baseURL": "http://10.0.0.20:8000/v1", "apiKey": "sk-…"}
//   ]
import { isPrivateHost, normalizeBaseURL } from '../providers/url.js';

export interface ProviderConfig {
  id: string;
  name: string;
  /** Normalized (provider-connection.md section 1). */
  baseURL: string;
  apiKey?: string;
}

const ENTRY_KEYS = ['id', 'name', 'baseURL', 'apiKey'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PROVIDER_NAME = 100;

/**
 * Checks the `providers` value; `fail` throws with a message that names the field, e.g.
 * `providers[1].baseURL must be an http or https URL`. Plain http is allowed only for loopback, private,
 * `.local` and tailnet hosts (provider-connection.md section 5). Ids and normalized base URLs are unique.
 */
export function validateProviders(value: unknown, fail: (message: string) => never): ProviderConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('providers must be an array of {id, name, baseURL, apiKey?}');
  const ids = new Set<string>();
  const urls = new Set<string>();
  return (value as unknown[]).map((entry, i) => {
    const at = `providers[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(`${at} must be an object {id, name, baseURL, apiKey?}`);
    const raw = entry as Record<string, unknown>;
    for (const key of Object.keys(raw)) if (!ENTRY_KEYS.includes(key)) fail(`${at}: unknown key ${JSON.stringify(key)}`);

    const id = raw.id;
    if (typeof id !== 'string' || !ID.test(id)) fail(`${at}.id must be 1 to 64 letters, digits, - or _`);
    if (ids.has(id as string)) fail(`${at}.id ${JSON.stringify(id)} is used twice`);
    ids.add(id as string);

    const name = raw.name;
    if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_PROVIDER_NAME) {
      fail(`${at}.name must be a non-empty string of at most ${MAX_PROVIDER_NAME} characters`);
    }

    const baseURL = typeof raw.baseURL === 'string' ? normalizeBaseURL(raw.baseURL) : null;
    if (baseURL === null) return fail(`${at}.baseURL must be an http or https URL`);
    const url = new URL(baseURL);
    if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
      fail(`${at}.baseURL must use https for a public host (plain http only for loopback, private, .local and tailnet addresses)`);
    }
    if (urls.has(baseURL)) fail(`${at}.baseURL ${baseURL} is used twice`);
    urls.add(baseURL);

    const apiKey = raw.apiKey;
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.trim() === '')) fail(`${at}.apiKey must be a non-empty string`);

    return {
      id: id as string,
      name: (name as string).trim(),
      baseURL,
      ...(apiKey !== undefined ? { apiKey: (apiKey as string).trim() } : {}),
    };
  });
}
