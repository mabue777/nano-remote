# Architecture review, 2026-10-23

Read-only review of host/, web/ and protocol/ against the changes the operator expects: more coding agents
(Pi now, Kimi later), more model providers, additive protocol changes, native frontends (iOS, Android, Windows,
macOS, Linux), visual redesigns, and file and module hygiene. Three independent reviewers (Mac host, phone app,
protocol and repo structure); the controller spot-checked the key claims. Nothing was changed.

## Verdict

The foundations are sound. The phone app's logic is already separated from its screens, agents are handled as
data on the phone, and the host's core has no agent-specific branches. The cost sits at the edges: adding an agent
touches 5 to 6 host files outside its adapter folder, the provider code exists twice (host and web) and has started
to drift, and the styling has colour tokens but nothing for spacing, type sizes or corner radius.

## Proposed work, in recommended order

### A. Agents as plug-ins (host) — medium. Do right after the Pi lane merges.
- One agent registry (`adapters/registry.ts`): each agent supplies its id, config validation and factory.
  Replaces `KNOWN_AGENTS` (`host/src/cli/config.ts:35`), the flat per-agent config keys (`:45-49, 93-95,
  156-168`) and the switch in `host/src/cli/service.ts:64-79`. Config becomes `agents: { codex: {...}, ... }`.
- Shared helpers in `adapters/shared/`: process-group spawn and kill (duplicated in
  `adapters/codex/engine.ts:63-91,131-145,202-208` and `adapters/claude/adapter.ts:221-227,402-422,472-490`),
  a generic stdio JSON-RPC engine (the Codex engine minus its handshake, reusable for Kimi over ACP), and
  the cached-models, state-listener and emitter boilerplate (`codex/provider.ts`, `claude/provider.ts`).
- Move `RpcError` out of the transport (`stream/router.ts:49`) to `src/errors.ts`.
- One config precedence rule (today `NANO_CODEX_BIN` is always shadowed: `cli/config.ts:81,166`).
- One app-folder path (`cli/paths.ts`, `journal/journal.ts:73-74`, `http/server.ts:38-39`).

### B. Protocol future-proofing — small. Same lane as A or next to it.
- Send each agent's capabilities on the wire: `Agent.capabilities {steer, diff, approvalModes}` (additive v1).
  Today the phone learns by trying and getting `not_supported`, and the host boots an engine just to say so
  (`core/session-manager.ts:375`).
- Move Codex-specific approval-mode text out of `common.json:154` into the per-agent data.
- Unknown item types and enum values decode as "other" (rule in the spec plus a negative example), so native
  apps built with strict decoders don't break when a new value is added.
- Fix the provider kind mismatch: web has `gemini`, the schema does not (`web/src/chat/providers/types.ts:6`
  vs `common.json:1133-1139`).

### C. One shared code package for provider and stream logic — medium.
- `host/src/providers/{url,quirks,wire,frames}.ts` are ports of `web/src/chat/...`; the two `normalizeBaseURL`
  already behave differently. Stream constants and chunking are duplicated too.
- Move them to a workspace package used by both; put stream limits in the schema so Swift and Kotlin get them.
- One provider-kind table on the phone (the relayable-kind list exists three times: `host-probe.ts:22`,
  `chat/engine/host.ts:26`, `settings-model.ts:669`).
- The type generator moves into the protocol package; the root verify includes the protocol check.

### D. Visual system — small to medium (about 1 to 2 days). Independent; can run any time.
- `tokens.css`: spacing scale, type sizes, radii and touch-target size (today 64× `8px`, 35× `10px`, 11 font
  sizes, one radius token).
- Split the 1798-line `styles.css` into base, shared components, and one file per screen next to its `.tsx`.
- Shared components: `Sheet` (copied 4 times), `BackHeader` (3 times), `Switch`, and one pull-to-refresh
  (implemented twice, `HomeScreen.tsx:270`, `SessionScreen.tsx:427`).

### E. Phone logic as a reusable core for native apps — medium. Do when a native app is planned.
- `packages/client-core`: stream, replica, chat, generated types, all `*-model.ts`, formatters and the ports
  (storage, fetch, socket, lifecycle). The web app keeps the screens, the Preact hook and the PWA parts.
- Pairing that works outside a browser: return and store the device token, absolute host URL, socket headers
  (`screens/pair-model.ts:12,95-98`, `stream/client.ts:67,101-109`).
- A `createServices(ports)` composition root instead of browser defaults in `app.tsx:38,197`.
- A Swift/Kotlin type-generation smoke check in the gate (the schema uses constructs such tools handle poorly).

### F. Splitting large files — do each when that file is next touched.
- Host: `journal/journal.ts` (741 lines, four jobs), `adapters/claude/adapter.ts` (702, three jobs),
  `core/host-core.ts` (four jobs; core also depends on the concrete stream server).
- Phone: `settings-model.ts` (693, four jobs), `home-model.ts` and `session-model.ts` (pure row building mixed
  with stateful models); shared formatters moved out of screen models into `format/`.
- Shared test helper `until` (defined three times).
- Vocabulary: `AgentProvider` means a coding agent while "Provider" means a model provider everywhere else;
  rename it, and add Agent, Provider and Capability to CONTEXT.md.

## Already well designed (keep)
- The adapter contract: adapters never see the journal or sequence numbers; the core has no agent branches.
- Agent ids are data everywhere in the protocol and the phone app; adding Pi needs about zero phone changes.
- The schema is the single source of types, with a real validation gate and explicit versioning rules.
- Phone view models are plain classes with injected storage, fetch and socket; the transport is layered.
- Provider quirks live in tables, not scattered conditions, so moving them to a shared package is mostly a move.
## Addendum: second pass, 2026-10-23 (after the Pi merge)

Second read-only pass in deep-module terms (module, interface, depth, seam, adapter, leverage, locality), two Opus
explorers plus controller spot checks. Corrections and additions to the review above:

- Agent seam (item A): still true and now forked. Pi is not in `KNOWN_AGENTS`; `buildAgents` (cli/service.ts) pushes
  Pi whenever its program exists, so `enabledAgents` cannot turn Pi off. Per-agent config modules live in
  host/src/config/{codex,claude,pi}.ts, apart from their adapters. cli/service.ts and cli/config.ts are the
  most-changed host files since September.
- Capabilities (item B): worse than stated. All three adapters declare `diff: false`, yet `turn/diff` boots or
  resumes the agent (session-manager.ts, ensureAdapter) before answering `not_supported`. The New session sheet
  offers "Bypass approvals" for every agent; Pi ignores approvalMode, the core still stores `never`, and the
  session header shows a "Bypass" tag while Pi keeps asking.
- Process plumbing: Codex and Pi engines share about 80 near-identical lines (call/timeout, kill, lost,
  signalGroup). They already differ in framing: Codex reads stdout with node:readline, which splits on U+2028 and
  U+2029 (verified with Node 26: a JSON line containing either arrives as two lines, and the Codex engine drops
  both as unparsable). Pi splits on LF only.
- Provider duplication (item C): confirmed, with more drift than stated (URL normalization, kind detection,
  error shape, Qwen-row order in quirks, relayable-kind list five times). Correction: the drift is mostly latent
  today, because the phone stores provider URLs already normalized with a scheme before relaying. Not urgent.
- Overall: the inner structure is sound. Core does not import adapters; adapters import only journal types and
  `RpcError` from the transport (production code); web logic (chat, replica, stream, *-model.ts) does not import
  screens and only screens/use-model.ts touches Preact. The session core (755 lines, 20 public methods) and the
  Journal (741 lines, 14 public methods) are deep and stable.

Operator ruling 2026-10-23: do now (1) agent capabilities on the wire with the phone showing only real controls,
Pi under `enabledAgents`, `turn/diff` refused before boot, `RpcError` out of the transport; (2) Codex LF-only
framing. Next: (3) visual system (item D). Parked until Kimi or a native app is planned: the agent registry
restructure and shared process module (A), the shared provider package (C), client-core (E).
