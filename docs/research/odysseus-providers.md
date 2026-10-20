# Odysseus Provider Pattern — Research Notes

## Summary

Odysseus is a self-hosted AI workspace built with Python (FastAPI backend) and
vanilla JavaScript on the front end. It runs in Docker and serves a browser UI.
The provider system is entirely URL-driven: every LLM connection is a
`ModelEndpoint` row in a SQLite database with a `base_url` and an optional
encrypted API key. Provider identity is detected at request time by matching
the URL hostname, with an "unknown host → treat as OpenAI-compatible" fallback
that covers every custom or self-hosted OpenAI-compatible server.

---

## Provider model

| Concept | Implementation |
|---|---|
| Provider record | `ModelEndpoint` SQLite row: `id`, `name`, `base_url`, `api_key` (Fernet-encrypted), `endpoint_kind`, `model_type`, `cached_models`, `supports_tools` |
| Provider detection | `_detect_provider(url)` in `src/llm_core.py` — matches hostname; falls back to `"openai"` for anything unrecognised |
| Built-in named providers | Anthropic, OpenAI, OpenRouter, Groq, Mistral, DeepSeek, Together, Fireworks, Google Gemini, xAI Grok, Cohere, NVIDIA, Featherless, Moonshot/Kimi, xAI, Z.AI, GitHub Copilot, ChatGPT subscription |
| Generic fallback | Any URL that doesn't match a named host is treated as OpenAI-compatible (`/chat/completions` + `Authorization: Bearer <key>`) |
| Local providers | Ollama (native `/api/chat` + `/api/tags`), llama.cpp, LM Studio, vLLM, SGLang — all auto-detected by host/port |

Takeaway: there is no class hierarchy or registry of adapters. One function
reads the URL and returns a string tag; the request-building code switches on
that tag.

---

## Add-provider flow (numbered steps the user follows)

1. Open Settings > Add Models.
2. For a cloud provider: pick from a dropdown of ~18 named presets (base URL
   pre-filled) or type a custom URL. Enter an API key. Click Add.
3. For a local server: paste the endpoint URL (e.g. `http://localhost:11434/v1`)
   or click "Add Ollama" to pre-fill it. API key is hidden by default, optional.
4. Optional: click Test before adding. The backend calls `POST /api/model-endpoints/test`
   which hits `GET /v1/models` (or the provider-specific equivalent) and returns
   a model list plus online/offline status.
5. On Add, the backend POSTs to `/api/model-endpoints`. It deduplicates by
   `base_url`, stores the row, and immediately probes for models unless
   `skip_probe=true`.
6. Models discovered are cached in `ModelEndpoint.cached_models` (JSON list).
   The UI shows them in the model picker immediately.

Fields asked: base URL, optional API key (password input), endpoint kind
(proxy/direct), model type (LLM/image).

---

## Request adapters

There is no adapter class hierarchy. `src/llm_core.py` and
`src/endpoint_resolver.py` dispatch per-provider with inline functions:

- `build_chat_url(base)` — returns the correct chat completions path per
  provider (Anthropic → `/v1/messages`, Ollama → `/api/chat`, OpenAI-compat →
  `/chat/completions`).
- `build_headers(api_key, base)` — Anthropic uses `x-api-key` +
  `anthropic-version` header; OpenRouter adds `HTTP-Referer`; everything else
  uses `Authorization: Bearer`.
- `_build_anthropic_payload` / `_build_ollama_payload` — separate payload
  builders for the two non-OpenAI wire formats; all others share the OpenAI
  schema.
- Streaming: single `stream_llm()` async generator yields SSE chunks with a
  unified `{"delta": "text"}` envelope regardless of provider.
- Thinking/reasoning: `thinking_mode` and `reasoning_effort` params thread
  through to provider-specific fields (Anthropic extended thinking, Qwen
  `enable_thinking`, OpenAI `reasoning_effort`).
- Tool calling: standard OpenAI function-call schema; Ollama gets its messages
  normalised first; `supports_tools` column can be forced per-endpoint.

---

## Provider presets (built-in list)

Presets live in `static/index.html` as a `<select>` element with hard-coded
`<option>` entries — not a separate config file:

```html
<option value="https://api.anthropic.com" data-logo="anthropic">Anthropic</option>
<option value="https://api.openai.com/v1" data-logo="openai">OpenAI</option>
<option value="https://openrouter.ai/api/v1" data-logo="openrouter">OpenRouter</option>
<!-- … 15 more … -->
<option value="">Custom URL</option>
```

Each option carries only a base URL and a logo key. No docs link or icon URL
file — logos are inline SVG stored in `static/js/providers.js` and matched
by regex against the model ID or endpoint hostname.

Export/import (Settings > Account > Export): exports memories, presets,
skills, settings, and preferences as a JSON file. Endpoint configurations
(provider rows) are NOT included in the export, so provider setups cannot be
shared or imported.

---

## Credential storage and security

- API keys are stored in SQLite via `EncryptedText`: Fernet symmetric
  encryption using a server-generated key (`src/secret_storage.py`). The
  encryption protects the database file at rest; anyone with access to the
  running process or the key file can decrypt.
- No OS keychain integration.
- OAuth/subscription flows (GitHub Copilot, ChatGPT subscription) use a
  separate `ProviderAuthSession` table with the same Fernet encryption for
  access and refresh tokens.
- The frontend never receives the raw API key after initial entry; subsequent
  fetches return a fingerprint only.

---

## Local and self-hosted providers

- Ollama: detected by port 11434 or `/api` path prefix. Uses Ollama's native
  chat and tags API, not the OpenAI-compat shim.
- LM Studio, llama.cpp, vLLM, SGLang: detected as "local OpenAI-compatible"
  by loopback/private IP. Get llama.cpp `session_id` + `cache_prompt` extras
  for KV-cache slot affinity.
- Network scan (`GET /api/discover`): scans ports 8000-8020, 8080, 1234, 11434
  on localhost and any Tailscale peers. Parallel port probes with 50 threads.
- Tailscale peer discovery is built in; hosts are added automatically.

---

## Stack and license

- Backend: Python 3, FastAPI, SQLite (via SQLAlchemy), Docker.
- Frontend: Vanilla JavaScript (ES modules), no framework.
- Mobile / desktop companion: not a phone app. The `swift/` folder contains an
  MLX image bridge helper only.
- License: AGPL-3.0-or-later.

---

## What to copy for Nano Remote

- URL-as-identity: derive provider behaviour entirely from the base URL. No
  per-provider class needed for the common case.
- Preset picker with pre-filled base URLs: 18 named entries + custom field
  covers 90% of user setups.
- Test-before-add: hit `/v1/models` and surface the model list immediately
  so the user knows the connection works before committing.
- Local scan: port-scan well-known ports (11434, 1234, 8080, 8000-8020) on
  localhost and LAN. Very low effort, high user delight for Ollama/LM Studio.
- Encrypted-at-rest keys: Fernet (or iOS Keychain, which is better) rather
  than plaintext SQLite.

## What to avoid

- Presets baked into HTML markup: hard to update, impossible to add from
  a remote source. Use a config file or server-fetched list instead.
- No export for endpoint configs: users who migrate devices lose all their
  provider setup. Include endpoints in backup/restore.
- No iOS Keychain use: Fernet with a file-stored key is weaker than the
  platform keychain. On iOS, always use the Keychain for API keys.
- Monolithic llm_core.py (~4500 lines): the provider switch logic is correct
  but hard to extend. For Nano Remote, use a thin protocol (interface) with
  one concrete type per provider wire format.
- Admin-only provider management: Odysseus restricts endpoint CRUD to admins,
  which makes sense for a shared server but is wrong for a personal phone app.
  Every user owns their own provider list.
