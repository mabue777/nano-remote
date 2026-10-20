# Research memo: remote-Ollama readiness of this fork

Date: 2025 (scout run). Codebase: fork of TonyL1u/nano-ai @ HEAD `eb1392e` + repo setup commit `ab06d3e`.
Method: static reading of the repo only. `node_modules` is **not installed**, so claims about
vendored dependency internals cite the lockfile + package metadata, not package source.

## 1. How the app connects to Ollama / where connection config lives

Connection config is a three-layer chain:

1. **Settings store** — `store/settings.ts:18-39`. `Settings { provider, host, apiKey, defaultModel, hapticFeedback, tokensUsage, endpoints, voiceLanguage }` persisted as a jotai `atomWithStorage` under `AsyncStorage` key `settings` (`lib/local-storage.ts:10-13, 56-62`). Default `{ provider: 'ollama', host: '', apiKey: '' }` (`store/settings.ts:30-39`).
2. **Settings UI** — `components/settings/server.tsx`. Host is a free-text `SelectInput` (`components/settings/server.tsx:232-260`, placeholder `"e.g. https://api.openai.com/v1"`). API key input at `server.tsx:197-230` (`secureTextEntry`). A "Test Connection" button (`handleTestConnection`, `server.tsx:55-123`) probes `GET ${host}/api/tags` for Ollama (`server.tsx:82-89`). Successful configs are remembered in `settings.endpoints[]` (max 6, `server.tsx:100-110`) shown as provider quick-switch buttons (`server.tsx:129-148`).
3. **API layer** — `lib/ai.ts`. `AIRegistry` (constructor `lib/ai.ts:41-53`) builds a Vercel AI SDK provider registry. For Ollama: `createOllama({ fetch: expo/fetch, baseURL: host ? \`${host}/api\` : void 0, headers: apiKey ? { Authorization: \`Bearer ${apiKey}\` } : {} })` (`lib/ai.ts:45`). This host+key is also used by `useChat` (`hooks/use-chat.ts:28-40`) to rebuild the `LanguageModel` whenever settings change.

The provider enum already contains more than Ollama: `OLLAMA, OPENAI, ANTHROPIC, GOOGLE, CUSTOM, OPENCLAW` (`lib/ai.ts:10-17`), with `CUSTOM`/`OPENCLAW` wired to `createOpenAICompatible` (`lib/ai.ts:49-50`) — a sign the fork (or upstream 1.1.0) was already moving toward arbitrary remote endpoints.

## 2. Remote-server support today, and hardcoded-localhost assumptions

**Remote Ollama is already supported in practice.** Host is user-typed free text (no URL validation in `server.tsx`), and `CHANGELOG.md:1-14` (v1.1.0 "Breaking change") instructs users to point Ollama-provider Host at any address, including `https://ollama.com` (Ollama Cloud) with an API key. So the app can talk to a remote host:port or HTTPS URL today.

Hardcoded / assumed defaults found:

- `lib/constants.ts:7` — `DEFAULT_CUSTOM_HOST = 'localhost:11434'` (**dead constant**, no importers; grep shows declaration only).
- `lib/constants.ts:9-10` — `OLLAMA_CLOUD_HOST = 'https://ollama.com'` and `OLLAMA_CLOUD_DOCS_LINK` (**also unused** — leftover from a pre-1.1.0 provider picker).
- `CHANGELOG.md:7` — doc-only reference to `http://localhost:11434`.
- No `localhost`/`127.0.0.1`/`11434` strings in any executable `app/`, `components/`, `hooks/`, `lib/`, `store/` code besides the dead constant (verified by case-insensitive grep; only the two hits above).
- Behavioral assumption, not a string: `components/connect-tips.tsx:14-31` shows "Ollama server connect failed" whenever `host` is empty — i.e. empty host is treated as unconfigured, and `ollama-ai-provider-v2`'s own default baseURL (its built-in default, typically `http://127.0.0.1:11434/api`) takes over when `host` is falsy (`lib/ai.ts:45` passes `void 0`). That library default is the only latent localhost assumption, and it's inside the dependency, not this repo (lockfile pin: `ollama-ai-provider-v2@3.3.1`, `pnpm-lock.yaml:4078`; not verifiable locally since `node_modules` absent).
- `hooks/use-models.ts:48` throws `'Base URL is missing'` for Ollama when host is empty, so model discovery refuses to fall back to localhost.

## 3. Ollama endpoints called and streaming mechanism

Direct fetch calls (all via `expo/fetch`, imported in `lib/ai.ts:6`, `hooks/use-models.ts:1`, `components/settings/server.tsx:1`):

- `GET ${host}/api/tags` — connection test (`components/settings/server.tsx:83`) and model discovery (`hooks/use-models.ts:49`). Response parsed as `{ models: [{ name, details: { family } }] }`; family is used to set `canThink` (`hooks/use-models.ts:52-54`).
- Chat/generation goes through `ollama-ai-provider-v2` with `baseURL = ${host}/api` (`lib/ai.ts:45`), i.e. the provider posts to Ollama's `/api/chat` family internally (standard for that provider; not directly readable here — `node_modules` not installed).
- No calls to `/api/generate`, `/api/ps`, `/api/pull`, or any model-management endpoint exist in app code.

Streaming protocol:

- `chat({ stream: true })` (`lib/ai.ts:74-98`) wraps Vercel AI SDK `streamText` and returns `[fullStream, abort]` where `abort` fires an `AbortController` (`lib/ai.ts:78-87`).
- `hooks/use-chat.ts:71-172` consumes the stream with `for await (const part of stream)` (`use-chat.ts:88`) over typed `TextStreamPart`s: `reasoning-delta`, `text-delta`, `finish`, `abort`, `error`, etc. (`use-chat.ts:91-172`), incrementally patching the assistant `UIMessage` via the immer-wrapped session store.
- Thinking/reasoning is enabled per-provider through `providerOptions` — for Ollama `{ think: reasoning }` (`hooks/use-chat.ts:32-38`).
- Under the hood the AI SDK Ollama provider parses Ollama's NDJSON stream; `expo/fetch` is what makes streaming bodies work in RN (it's Expo's fetch with streaming support — chosen deliberately in `lib/ai.ts:6`).

## 4. Auth headers / TLS / proxies

- **Auth:** Only `Authorization: Bearer ${apiKey}`. For Ollama it's passed as provider `headers` (`lib/ai.ts:45`) and re-created ad hoc in test/discovery calls (`components/settings/server.tsx:83`, `hooks/use-models.ts:25,49`). No other auth schemes, no header customization UI.
- **TLS:** Supported implicitly — host is a full URL, so `https://` works (CHANGELOG documents `https://ollama.com`). No certificate pinning, no custom CA support; iOS ATS is fully relaxed (see §6), so self-signed/plain-HTTP LAN servers connect.
- **Proxies:** None. No proxy config anywhere; RN `fetch` doesn't honor system HTTP proxies reliably, and nothing compensates.
- No timeouts, retries, or backoff around fetches beyond the single `AbortController` per chat request (`lib/ai.ts:78-87`).

## 5. Persistence ("local-first privacy") and multi-device fit

- Chats: `store/sessions.ts:29` — `{ current, data: Session[] }` as a storage atom under AsyncStorage key `chats_history` (`lib/local-storage.ts:10-13`). `Session` holds `messages: UIMessage[]`, `model`, `think` (`store/sessions.ts:23-27`).
- Settings: `settings` atom, same mechanism (`store/settings.ts:30-39`).
- Mechanism: `createStorageAtom` = jotai `atomWithStorage` + `AsyncStorage` JSON (`lib/local-storage.ts:56-62`), `getOnInit: true`; writes are fire-and-forget JSON.stringify of the whole structure (no incremental sync, no schema versioning).
- Persistence is whole-document blobs in AsyncStorage — chat history includes `apiKey`s in plaintext inside `settings.endpoints[]` (`store/settings.ts:11-16`, written at `server.tsx:100-110`). Privacy claim "Chats and settings never leave the device" (`README.md`, feature 3; `PRIVACY`) is exactly this architecture.
- **Conflict assessment for remote/multi-device:** no direct conflict with *using* a remote model server (that's already the case). The friction is only with a *multi-device companion* model: there is no sync layer, no per-remote-device session namespacing, and no auth beyond one Bearer key. Extending to "drive a computer" would need either (a) keep local-first and just add a remote-command channel, or (b) add a sync/relay — which contradicts the stated privacy posture and the whole-blob AsyncStorage design.

## 6. Networking-relevant config

- **Expo SDK 54** — `"expo": "^54.0.0"` (`package.json:37`), React Native `0.81.5` (`package.json` deps), `newArchEnabled: true` (`app.json:11`).
- **iOS ATS:** `app.json:27-30` — `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true }` inside `ios.infoPlist`. Cleartext HTTP to LAN hosts is fully allowed. (Good for local-network Ollama; would need tightening if shipped.)
- **Android:** `app.json:44-46` only sets `package`; no `android/`, `ios/` prebuild dirs in repo (both gitignored, `.gitignore`), so **no checked-in AndroidManifest**; default Expo manifest applies (cleartext default-off in modern RN → likely a gap for `http://<lan-ip>:11434` on Android; needs `usesCleartextTraffic` — unverifiable here because manifest is generated at prebuild).
- **Live Activities:** `"NSSupportsLiveActivities": true` (`app.json:23`); local Expo module `modules/activity-controller/` (`expo-module.config.json` declares apple+web; **android implementation is a no-op stub** — `modules/activity-controller/src/ActivityControllerModule.android.ts:1-6`); Swift impl in `modules/activity-controller/ios/ActivityControllerModule.swift`; widget target `targets/widget/` via `@bacons/apple-targets` (`app.json:36`, `targets/widget/expo-target.config.js`) incl. `WidgetLiveActivity.swift`; deep-link stop action handled in `app/index.tsx:115-126`.
- **Background modes:** none declared (no `UIBackgroundModes` in `app.json`); JS streams presumably pause in background — Live Activity just monitors last known state.
- Voice input: `expo-speech-recognition` plugin (`app.json:37`), `hooks/use-voice-input.ts`.
- Package registry is npmmirror (`.npmrc`: `registry=https://registry.npmmirror.com`, `node-linker=hoisted`) — CI/dispatch environments may need registry override.

## 7. Verification surface

- `package.json:5-11` scripts: `dev` (`expo start -c`), `android`, `ios` (`expo run:*`), `clean`, **`lint`: `eslint . --ext ts,tsx ... --max-warnings 0 --fix`** — note `--fix` mutates sources; for a verify gate it should be invoked without `--fix` or wrapped.
- **No `typecheck` script** — but `typescript ~5.9.2` is a devDependency, tsconfig is strict (`tsconfig.json:3`); gate can run `tsc --noEmit` via pnpm exec.
- **No test runner configured at all** — no jest/vitest/expo-jest dependency, no test script, no `__tests__` dirs (find confirms).
- Package manager: **pnpm** (`pnpm-lock.yaml` present); `.npmrc` uses hoisted linker. No `packageManager` field in `package.json` (pin pnpm version in dispatch env).
- Suggested composite gate: `pnpm install --no-frozen-lockfile` (lock may drift vs npmmirror metadata) → `pnpm exec tsc --noEmit` → non-fixing eslint.

## 8. Delta: what "remote from my phone" needs that the repo lacks

Already present: arbitrary remote host config, Bearer auth, HTTPS, remote model discovery, streaming chat.

Missing (smallest delta):

1. **A control channel beyond chat** — no RPC/exec/file/screen endpoints exist; the app only lists models and chats. Needs a new remote-agent protocol (e.g. an OpenClaw-style gateway — `AIProviderEnum.OPENCLAW` scaffolding at `lib/ai.ts:50` hints at intent but is hardcoded `x-openclaw-session-key` and OpenAI-compatible chat only).
2. **Connection security for WAN use** — only one Bearer key; no mTLS, no tunneling (Tailscale/Cloudflare) guidance, no per-connection credential isolation; API keys stored in plaintext AsyncStorage (`server.tsx:100-110` write, `lib/local-storage.ts` plaintext JSON).
3. **Android cleartext/networking config** for LAN `http://` hosts — no checked-in manifest/`usesCleartextTraffic` (§6).
4. **Background/connection resilience** — no background fetch/task modes, no reconnect/keepalive; stream dies with app backgrounding (only Live Activity visual state survives, `hooks/use-live-activity.ts`).
5. **Multi-session-per-remote model / device identity** — sessions are one flat local list (`store/sessions.ts:29`), no notion of "which computer" a session drives.
6. **Verification gate** — no test runner and no typecheck script to gate dispatched work on (§7).
7. **Cleanup**: dead constants `DEFAULT_CUSTOM_HOST`/`OLLAMA_CLOUD_HOST` (`lib/constants.ts:7,9`) and the unused `ollama.com`-era onboarding hints.

## Risks / caveats

- `node_modules` absent: `ollama-ai-provider-v2@3.3.1` internal endpoints (e.g. exact `/api/chat` usage) inferred from its public contract + the `${host}/api` baseURL wiring (`lib/ai.ts:45`), not from reading its source.
- Android manifest behavior inferred from Expo defaults; no prebuild output in repo to confirm.
- Fork vs upstream drift: current tree already differs from upstream nano-ai (multi-provider + OpenClaw enum present at HEAD of this repo).
