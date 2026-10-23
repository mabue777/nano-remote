# Local chat (Phase 5): rulings, nano-ai parity, field check

Status: design note for Phase 5 (ticket docs-local-chat-design-and-parity). Inputs: the Phase 5 epic's
planning rulings R1 to R4; `docs/plan/provider-connection.md` (Provider record, presets, add flow,
runtime behavior, acceptance); `docs/research/remote-ollama-support.md` (the nano-ai fork);
`docs/adr/0006-provider-routing.md`. Vocabulary: a **Provider** is a reachable model endpoint; a
**Chat** is a local conversation with one Provider's model, distinct from a host **Session**.
Section 4 records how the operator's local 27B model works with coding harnesses.

## 1. Rulings

| Ruling | In plain words | What the UI says |
|---|---|---|
| R1 Routing | An `https` provider is called straight from the phone. An `http`, private, `.local` or tailnet provider is called by the paired Mac, which streams the reply back. The app picks the route from the URL; the user never chooses it. Recorded as ADR 0006. | The provider row shows one line: "direct" or "via your Mac". |
| R2 Keys | A direct provider's key is kept on the phone in the installed app's storage and is never exported. A Mac-routed provider's key stays in the host's `config.json` and never reaches the phone. This refines section 5 of `provider-connection.md` (no Keychain in the web client). | Mac-kept providers are marked "key on your Mac"; after an import the app asks "Enter the key for <provider>". |
| R3 History | Chats live only on the phone, stored the same way as the Replica. No Journal, no push, no sync between devices for local chat in v1. The Mac's relay keeps no state. | Nothing extra; chats simply stay on this phone. |
| R4 Scope | v1 has several chats, streamed text with markdown and reasoning blocks, a model picker, a thinking switch where the model supports it, stop, copy and delete; providers can be added, edited, deleted, exported and imported. Out of v1: tools, images, voice, sharing. Protocol changes stay additive within v1. | A host-routed provider while the Mac is away: "Your Mac is not reachable; this provider runs through it." |

## 2. nano-ai feature parity

The nano-ai column comes from `docs/research/remote-ollama-support.md`: its Settings fields
(`provider, host, apiKey, defaultModel, hapticFeedback, tokensUsage, endpoints, voiceLanguage`), the
`use-chat` reasoning option, and the fork's CHANGELOG v1.1.0 as quoted there (Host may point at any
address, including `https://ollama.com` with an API key). "Not in the memo" means the memo does not
record the feature either way.

| Feature | nano-ai | Nano Remote v1 | ticket |
|---|---|---|---|
| Provider settings with host URL and key | Yes: `provider`, free-text `host`, `apiKey`, Test Connection, up to 6 remembered `endpoints` (keys in plaintext) | IN: many providers, presets, paste-a-key detection, test before add, export/import without keys | web-providers-store-and-presets, web-provider-settings, host-provider-relay |
| Model discovery and picker | Yes: `GET /api/tags`, `defaultModel` | IN: per-kind probing with cached list, picker in the chat header, "Find local servers" via the Mac | web-providers-store-and-presets, web-chat-screens, host-provider-relay |
| Streaming chat with markdown | Yes: streaming via the AI SDK `streamText`; markdown not in the memo | IN: one unified delta stream for both routes, markdown reused from the session view | web-chat-engine, web-chat-screens |
| Reasoning ("thinking") display | Yes: `use-chat` reasoning option (`think` for Ollama), `reasoning-delta` parts | IN: collapsible reasoning block, one thinking switch translated per vendor | web-chat-engine, web-chat-screens |
| Multiple conversations with history | Yes: `chats_history` list of sessions on the device | IN: chats list and history on the phone (R3) | web-chat-engine, web-chat-screens |
| Token usage display | Yes: `tokensUsage` setting | OPTIONAL: a usage line when the provider reports it | web-chat-engine, web-chat-screens |
| Haptic feedback | Yes: `hapticFeedback` setting | OPTIONAL: only where the browser offers vibration; iOS Safari does not | none planned |
| Voice input | Yes: `voiceLanguage`, speech recognition plugin | OUT for v1 (R4) | none |
| Image attachments | Not in the memo | OUT for v1 (R4) | none |
| Stop generation | Yes: `AbortController` per chat request | IN: Stop while streaming; partial text is kept | web-chat-engine, web-chat-screens |
| Copy message | Not in the memo | IN: copy on long-press | web-chat-screens |
| Delete conversation | Not in the memo | IN: swipe or long-press to delete | web-chat-screens |

Takeaway: v1 matches nano-ai on everything a text chat needs and is ahead on provider handling; it drops
voice and images and treats haptics and token usage as nice-to-have.

## 3. Phase 5 field check

This restates the acceptance of `provider-connection.md` section 7 together with the roadmap's Phase 5
acceptance (Ollama on the LAN, a cloud OpenAI-compatible endpoint, no host required for the cloud case)
as steps on the operator's iPhone, using the home-screen app. Results go to `docs/plan/field-checks.md`
under "Phase 5 local chat", one observation and pass/fail per step.

1. Preparation: pull a small local model into the Mac's Ollama, leave `OLLAMA_ORIGINS` unset, add the
   Mac's Ollama to the host's `config.json`, rebuild and restart the host.
2. Add OpenAI (or another cloud provider the operator has) by pasting only a key: under 20 s from
   Settings to the first streamed reply, and no URL typed.
3. Add a self-hosted OpenAI-compatible server by URL with test before add: a wrong key gives the
   one-sentence 401 message; an unreachable host gives the connect message within 10 s.
4. Add the Mac's Ollama found by "Find local servers" (the host's scan, including tailnet addresses)
   with one tap; it shows "via your Mac" and its model list loads.
5. Chat with the local Ollama model on home Wi-Fi: the reply streams, a reasoning block shows if the
   model emits one, and Stop keeps the partial text.
6. No host: stop the host, reopen the app: chats and history are there, the cloud provider still
   streams, and the Ollama provider shows "Your Mac is not reachable; this provider runs through it".
   Restart the host.
7. Away from home (cellular, Tailscale on): the cloud provider chats directly, and the Ollama provider
   chats through the Mac over the tailnet.
8. Export, delete all, import: providers return without keys, and the app asks for each key on first use.

## 4. Harnesses and local models

Measured by the controller on 2026-10-22/23. The question: can the operator's local 27B model drive the
coding harnesses (agent command-line tools) that Nano Remote sessions run, and how fast.

Setup. Model: PrismML "Ternary Bonsai 2" 27B (based on Qwen3.8-27B), PQ2_0 2-bit GGUF, served by the
PrismML fork of llama.cpp (`llama-server`) on `http://127.0.0.1:8080` with alias `bonsai-27b`, 4 parallel
slots, 32768 context, flash attention, q8_0 KV cache, reasoning effort medium. Machine: Apple M1 Pro,
16 GB. Prompt reading runs at about 57 tokens/s; generation at about 12 tokens/s (operator's number).

Every harness got the same task in an empty folder: "Create a file named hello.txt in the current
directory containing exactly the word hello (no newline). Use your file or shell tools. Then reply with
the single word done." Pass means `hello.txt` exists with content `hello` and the harness finished its
turn. Wall time runs from launch to exit. Prompt tokens is the peak `n_prompt_tokens` of the busy
llama.cpp slot during the run: the harness's hidden system prompt and tool definitions plus the task.

| Harness | Result | Wall time | Prompt tokens | Notes |
|---|---|---|---|---|
| Aider | pass | 25 s | ~700 | `OPENAI_API_BASE` pointed at the server; no tool loop, file edit only |
| pi (pi coding agent) | pass | 75 s | ~4,000 | needed a `models.json` entry with api `"openai-completions"`; ignores `OPENAI_BASE_URL` |
| Goose | pass | 135 s | ~6,900 | fresh `GOOSE_PATH_ROOT`; openai provider with custom host |
| Codex | pass | 165 s | ~9,000 | only with the patched template (below); `wire_api` must be `"responses"` (Codex no longer accepts `"chat"`); `model_reasoning_effort` must be `"medium"` |
| Claude Code | pass | 185 s | ~9,700 | only with the patched template; `ANTHROPIC_BASE_URL=http://127.0.0.1:8080`, `ANTHROPIC_AUTH_TOKEN=local`, `--model bonsai-27b` (llama.cpp serves `/v1/messages`) |
| Hermes | pass | 255 s | ~15,600 | needs `model.context_length` >= 65536 in its config or it refuses to start the turn |
| OpenCode | pass | 280 s | ~12,000 | openai-compatible provider in `opencode.json` |
| Kimi Code CLI | pass | 460 s | ~26,000 | thinking effort had to be `"medium"`; `"high"` is refused by the model's template |
| Qwen Code | partial | 470 s | ~17,000 | wrote the file correctly but was cut off by the 15-minute limit before saying done |

Takeaway: every harness that reached the model completed the tool call correctly, so the 2-bit 27B
handles tool use, and wall time is almost entirely prompt reading (prompt tokens / 57 per second), so the
leanest harnesses win.

For interactive use on this Mac that means pi (under a minute) or Aider (file edits only, fastest).
Codex and Claude Code work but need about three minutes before the first token of each turn, so for
Nano Remote agent sessions the Ollama cloud models remain the practical choice; the 27B is best used in
Local chat and in lean harnesses.

Template limitation and the patch. The model's embedded chat template raises "System message must be at
the beginning." when a system message appears after the first message, and raises "Unexpected reasoning
effort" for any effort other than xhigh, medium or low. Codex and Claude Code both send a later
system/developer message, so both failed with HTTP 500 on the unpatched server; Codex also sends effort
"high" by default. The operator now runs `llama-server` with a patched copy of that template with both
checks lifted: `bonsai-27b.patched.jinja`, kept next to the model files and passed with
`--jinja --chat-template-file`. The start script `start-bonsai.sh` in the operator's local-llm folder carries it
and can be overridden with `TEMPLATE=...`. With it, Codex and Claude Code pass as in the table. Caveat:
the model was probably not trained on mid-conversation system messages, so answer quality in those two
harnesses may be less reliable than in the chat window.

For the Phase 5b epic (provider models in agent sessions): when a session targets an openai-compatible
provider, Codex must be started with `wire_api` `"responses"` and reasoning effort `"medium"`, and
Claude Code is pointed at the provider through `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

Housekeeping: the raw results are in `harness-test-2026-10-22.tsv` in the operator's local-llm folder.
Qwen Code and Hermes were newly installed for this test; Kimi's config gained a llamacpp provider and
model entry, and Hermes's config gained the `context_length` override.
