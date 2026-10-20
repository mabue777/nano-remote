# Provider connection design: connect any LLM provider in under a minute

Status: design note for Phase 0 (ticket provider-connection-design). Inputs: operator's request to copy
the ease of odysseus-dev/odysseus; `docs/research/odysseus-providers.md`;
`docs/research/rea/odysseus-behaviors.md` (items 17 to 59, 107 to 113). Odysseus is AGPL-3.0, so we
copy patterns, never code. Scope: local chat mode in the web client (ADR 0004) and, where noted, the host's
agent picker. Vocabulary: a **Provider** is a reachable model endpoint; a **Model** belongs to one Provider.

## 1. The rule: a Provider is a URL plus a key

A Provider record is small and the base URL is its identity:

| Field | Notes |
|---|---|
| id | UUID, local |
| name | Display name; defaults to the preset name or the host |
| baseURL | Required. Normalized (scheme, host, port, path prefix); unique per record |
| kind | Derived from the host, never typed by the user: `openai-compatible` (default), `anthropic`, `ollama`, `gemini`; exact or subdomain host match only, so look-alike hosts do not match |
| apiKey | Optional; stored in the Keychain, never in the record; the record keeps a fingerprint (first 6 chars) for display |
| models | Cached list `[{id, displayName, capabilities, source}]` with `lastProbedAt` |
| hidden / pinned models | Hide failed ids; pin ids the list endpoint does not return |
| supportsTools | Tri-state: yes / no / unknown; unknown falls back to a conservative heuristic |
| refresh | `manual` or `auto` with a clamped interval (30 s to 1 day) |

Everything unknown is OpenAI-compatible: `/chat/completions` with `Authorization: Bearer`. Only three
wire formats get translation (Anthropic messages API with `x-api-key` and version header; Ollama native
`/api/chat` and `/api/tags`; Gemini). That is the whole adapter story; no class per vendor.

## 2. Presets

Shipped as a JSON file in the app bundle (`providers.json`), not in UI code, so it can be updated without
touching screens and can be reused by the host. Each entry: `name, baseURL, kind, logo, keyPrefixes,
docsURL, keyHelpURL, notes`. Initial list (base URLs verified at build time): OpenAI, Anthropic, Google
Gemini, OpenRouter, Groq, Mistral, DeepSeek, Together, Fireworks, xAI, Moonshot/Kimi, Z.AI, Ollama
(local), Ollama Cloud, LM Studio (local), llama.cpp (local), vLLM (local), plus "Custom URL".
Excluded on purpose: ChatGPT-subscription and GitHub Copilot device logins (they reuse other apps'
OAuth identities, a terms-of-service risk the Odysseus inventory flagged).

## 3. The add flow (phone)

1. **Entry points.** Settings → Providers → Add; the first-run screen; and the empty model picker.
2. **One field first.** A single input: "Paste an API key or a server URL". Detection runs as the user
   types: a key prefix (`sk-ant-`, `sk-or-`, `sk-proj-`, `gsk_`, …) selects the preset and pre-fills its
   base URL; a URL selects Custom and derives the kind from the host. The preset grid below is the
   alternative entry; tapping a preset pre-fills the URL and focuses the key field.
3. **Test before add.** The Test button calls the models endpoint for the kind (`/models`, `/api/tags`,
   or the vendor equivalent), accepts both `{data:[…]}` and bare lists, and shows the live model list
   inline with a status dot. The Add button enables only after a successful test, or after the user
   explicitly chooses "Add without testing" for offline servers.
4. **Plain-language errors.** One sentence per failure that names the provider and the fix:
   wrong key (401), rate limited (429), server unreachable (connect timeout), reachable but no models
   (saved anyway, with the hint "check the key or service status"). Errors never show raw JSON.
5. **Save.** Deduplicate by normalized base URL; key goes to the Keychain under the record id; model
   list is cached; the new provider becomes the default for new chats if it is the first one.
6. **Local discovery.** A "Find local servers" action scans well-known ports (11434, 1234, 8080,
   8000 to 8020) on the phone's LAN gateway subnet is not possible from iOS; instead it probes the
   user's tailnet peers and any hosts the user has paired (the Nano Host can run the LAN scan and
   report candidates over the envelope protocol). Candidates appear as one-tap presets.
7. **Model capabilities.** Recorded per model with a source (vendor metadata, OpenRouter parameters,
   or heuristic) and a confidence; the chat UI uses them to show or hide reasoning and tool toggles.

## 4. Runtime behavior worth copying

- Streaming is one unified delta event regardless of vendor; reasoning text is flagged, not mixed in.
- Retries on 429/502/503/504 with exponential backoff and `Retry-After` honored (Odysseus uses a fixed
  half second; we do better). A dead-host cooldown of about 20 s after two connect failures.
- A first-token watchdog for local servers that accept the request and never stream.
- A single "thinking" switch translated per vendor (`reasoning` for OpenRouter, effort for OpenAI,
  extended thinking for Anthropic, `enable_thinking` for Qwen-style servers).
- Request shaping knows model quirks (max completion tokens vs max tokens, temperature omitted where
  rejected), kept in one table.

## 5. Storage, security, portability

- Keys for local chat live either on the host (preferred when a host is paired; the phone never
  sees them) or, for host-less use, in the web app's storage on the phone, encrypted with a key held
  in the browser's credential store; exports never include keys. (A native client would use the Keychain.)
- Export and import of provider configs as JSON without secrets, plus a QR for sharing a provider's
  URL and name between the user's own devices. This is a gap Odysseus has (no endpoint export).
- Local network: iOS requires the local-network permission for LAN hosts; request it only when the
  user adds a `.local`, private, or tailnet address, with a one-line explanation.
- Transport: `https` by default; plain `http` allowed only for loopback, private, `.local` and tailnet
  addresses (same rule Odysseus enforces for pairing, applied here to providers).

## 6. Where this meets the host

The Nano Host uses the same `providers.json` and the same record shape to offer **agent runtimes**
in the session picker (Codex, Claude Code, Kimi) and, later, provider-backed models for agents that
accept a base URL. The phone's "Find local servers" delegates the LAN scan to a paired host.

## 7. Acceptance for the Phase 5 tickets that implement this

- Add OpenAI by pasting a key: under 20 s from Settings to first streamed reply, no typing of a URL.
- Add a self-hosted OpenAI-compatible server by URL with test-before-add; wrong key yields the
  one-sentence 401 message; unreachable host yields the connect message within 10 s.
- Add Ollama on the tailnet via the host's scan with one tap.
- Export, delete all, import: providers return without keys; the app prompts for keys on first use.
