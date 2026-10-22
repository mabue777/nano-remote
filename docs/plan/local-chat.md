# Local chat (Phase 5): rulings, nano-ai parity, field check

Status: design note for Phase 5 (ticket docs-local-chat-design-and-parity). Inputs: the Phase 5 epic's
planning rulings R1 to R4; `docs/plan/provider-connection.md` (Provider record, presets, add flow,
runtime behavior, acceptance); `docs/research/remote-ollama-support.md` (the nano-ai fork);
`docs/adr/0006-provider-routing.md`. Vocabulary: a **Provider** is a reachable model endpoint; a
**Chat** is a local conversation with one Provider's model, distinct from a host **Session**.

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
