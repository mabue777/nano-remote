# Recon: OpenClaw's remote stack — and what to reuse for NANO-REMOTE

Date: 2026-10-20. Author: recon subagent.
Primary evidence: `/Users/mabue/BROCODE/Projects/OPENCLAW-WEB-GUI` (iOS wrapper, native Swift client, oc-probe, captured artifacts, git history). Bounded upstream confirmation: official OpenClaw repo + docs site (URLs inline; all cited pages fetched and verified HTTP 200 on 2026-10-20).

---

## 1. THIS PROJECT (`OPENCLAW-WEB-GUI`): what exists and how far it got

The repo holds two generations of an OpenClaw phone client plus a protocol probe. It is itself a fork/adjunct of the OpenClaw Control web GUI (a 2.4 MB `OpenClaw Control.webarchive` snapshot of the GUI sits at repo root).

### 1.1 `ios/` — OpenClawControl (WebView wrapper, generation 1)

A thin SwiftUI shell that loads the hosted OpenClaw Control web GUI in a fully controlled `WKWebView`, fixing iOS-Safari scaling/scroll problems and persisting the GUI's own pairing state via `localStorage` — "you pair once and it sticks across launches" (`ios/README.md:15`). It assumes the gateway is reachable over Tailscale (`*.ts.net` default URL, `ios/README.md:24`, `:44`, `:57`). No protocol code here; all auth/pairing is delegated to the web GUI. This is the proven-working fallback client.

### 1.2 `native/` — OpenClawKit + OpenClawApp (native client, generation 2)

**OpenClawKit** (`native/OpenClawKit/`) bills itself as "a pure-Swift implementation of the OpenClaw gateway wire protocol… the same WebSocket + Ed25519 handshake the web GUI uses" (`native/README.md:1-8`). Milestone 1 = connection + auth + request/response + event stream + probe; milestone 2 = the SwiftUI app. Both shipped.

**What `GatewayClient` implements** (`native/OpenClawKit/Sources/OpenClawKit/GatewayClient.swift`):

- One WebSocket, JSON text frames, three frame types — `req {id, method, params}` / `res {id, ok, payload|error}` / `event {event, seq, payload}` — with UUID request correlation, per-request timeouts, and an `AsyncStream` event fan-out (`GatewayClient.swift:1-11`, `:128-160`).
- Handshake (`connect()`, `GatewayClient.swift:103-128`): opens the socket, sends an `Origin` header the gateway will accept — derived from the gateway's own URL — because "the gateway validates the WebSocket Origin against `gateway.controlUi.allowedOrigins`" (`GatewayClient.swift:28-30`, `:112-114`); waits up to 10 s for a `connect.challenge` event carrying the nonce (`challengeTimeoutMs`, `GatewayClient.swift:23-24`, `:45`); then sends an in-band signed `connect` request and retries once if a late challenge caused a nonce error (`AUTH_NONCE_REQUIRED` / `AUTH_NONCE_MISMATCH` / nonce-shaped `INVALID_REQUEST`).
- Connect params (`native/OpenClawKit/Sources/OpenClawKit/Protocol.swift`): `client.id = "openclaw-control-ui"` — the gateway validates `client.id` against an allowlist, so the Swift client impersonates the Control UI (`Protocol.swift:3-8`); `clientMode "webchat"`, `role "operator"`, scopes `operator.admin/read/write/approvals/pairing` (`Protocol.swift:11-17`), protocol version negotiated as `minProtocol = maxProtocol = 4` (`Protocol.swift:18-19`), `caps: ["tool-events"]`.
- Device identity: Ed25519 via CryptoKit, `deviceId = hex(SHA256(pubkey))`, Base64URL no-padding serialization, mirroring the GUI's `openclaw-device-identity-v1` localStorage scheme (`native/OpenClawKit/Sources/OpenClawKit/DeviceIdentity.swift:1-9`, `:38-41`). The connect signature is over the canonical pipe-joined string `"v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce"` (`Protocol.swift:22`, `:133-149`).
- Bootstrap auth: optional `token` / `deviceToken` / `password` in `connect.auth` (`Protocol.swift` `ConnectAuth`); a server-issued reusable `deviceToken` is captured from the connect hello (`GatewayClient.swift:85`, `issuedDeviceToken`).
- RPC methods used by the app (`ConnectionModel.swift`): `sessions.list` (session list, refreshed on `sessions.changed` events), `sessions.messages.subscribe {key}` / `sessions.messages.unsubscribe {key}` (`openChat`/`closeChat`, `ConnectionModel.swift:104-130`), `sessions.send {key, message}` (`sendMessage`, `ConnectionModel.swift:131-152`), `sessions.abort {key}` (`stopGeneration`, `ConnectionModel.swift:154-158`), `chat.history` tried best-effort with `{sessionKey}` then `{key}` params because its schema is undocumented (`ConnectionModel.swift:165-179`). Candidate-but-unconfirmed methods seen in the minified GUI bundle are kept as constants: `session.message` (actually an event, not a method), `agent.chat`, `session.cancelOutput`, `chat.send`, `chat.abort`, `agents.list`, `config.get`, `models.list` (`Protocol.swift` `Method` enum).
- Chat view event model (`ConnectionModel.swift` `handle(_:)`): `session.message` events append user/assistant messages; `chat` events carry assistant reply/stream state (`payload.state`, `payload.message`); `agent` events carry run lifecycle (`payload.data.phase` start/end/error → drives the "Working…" indicator); duplicates across the two streams are deduped. `ChatMessage` parses the live-confirmed shape: user `content` is a plain string, assistant `content` is an array of `{type:"text", text}` parts (`native/OpenClawKit/Sources/OpenClawAppCore/ChatMessage.swift:5-7`). The SwiftUI chat screen itself is `native/OpenClawApp/Sources/ChatView.swift:4-5` (transcript via `sessions.messages.subscribe`, composer via `sessions.send`, Stop via `sessions.abort`).

**oc-probe** (`native/OpenClawKit/Sources/oc-probe/Probe.swift`): a CLI that connects, does the handshake, prints the hello (including `features.methods`), lists sessions, can subscribe to a session's message stream, and send a message with a selectable method (`--send-method`) or raw `--params-json` — built expressly "so the exact sessions.messages.subscribe + send wire format can be captured against the live gateway" (commit `b8348e2`).

### 1.3 What the oc-probe live captures learned

All from probes against a real gateway on the owner's tailnet (commit messages cite "confirmed against a live gateway"; captured gateway URL `wss://martins-macbook-pro-1.tail7c4e3e.ts.net`, see `localStorage.json:3`):

1. `hello.features.methods` confirms the session-scoped `sessions.send` and `sessions.abort` methods exist (commit `c726ed3`; `Protocol.swift:42-45`).
2. `sessions.messages.subscribe` requires `{key}` (the sessionKey) and **rejects** `{limit}`; `session.message` is an event, not a method (commit `c726ed3`; `Probe.swift:124`).
3. `sessions.send` takes `{key, message}` — not `{key, text}`; the gateway's `INVALID_REQUEST` literally named the fields ("must have required property message; unexpected property text") (commit `eab3cdf`; `Probe.swift:142`).
4. `sessions.messages.subscribe` returns `{key, subscribed}` and history arrives only via the event stream (`ConnectionModel.swift:100-103` comment).
5. Empty nonce is rejected by newer gateways, and from an iPhone on cellular through a Tailscale **relay** the challenge can take seconds — hence the 10 s wait (commit `d8c4040`; this also proves the app reached real on-device-over-Tailscale testing).
6. `sessions.list` entry shape: `key`, `sessionId`, `model`, `modelProvider`, `status`, `kind`, `hasActiveRun`, `totalTokens`, `updatedAt` ("shape confirmed against a live gateway", `native/OpenClawKit/Sources/OpenClawAppCore/SessionSummary.swift:5`).
7. Session keys are namespaced strings like `agent:coder:main` (`localStorage.json:3-4`).
8. Known risk flagged but unresolved in-repo: gateways may require a Tailscale-injected identity (`AUTH_TAILSCALE_*` error names seen), i.e. WS auth alone might not suffice off-tailnet (`native/README.md:49`). Upstream docs now explain exactly this mechanism (§2.2 below).

### 1.4 Captured artifacts worth reusing

- `native/README.md:25-33` — a compact "Protocol summary (reverse-engineered)" one-pager: framing, handshake, canonical signed string. Still accurate against the current official docs (§2.4).
- `localStorage.json` (repo root, **committed to git**, commit `c5f9a29`) — a real GUI localStorage dump: the `openclaw-device-identity-v1` record format (`{version, deviceId, publicKey, privateKey, createdAtMs}`, `localStorage.json:2`) and the Control UI settings shape (`openclaw.control.settings.v1`, `localStorage.json:3-4`). ⚠️ **It contains a real Ed25519 private key for a paired device on a live gateway — treat that device credential as compromised and revoke/rotate it (`openclaw devices` / `device.token.revoke`). Do not commit captures like this in NANO-REMOTE.**
- `OpenClaw Control.webarchive` (repo root) — full snapshot of the Control GUI; the source from which the constants were reverse-engineered; still useful for mining message shapes.
- `oc-probe` itself — directly reusable as a protocol validation tool while building NANO-REMOTE's host integration (`swift run oc-probe --url wss://host.tailnet.ts.net --send "hi"`, `Probe.swift:43`).

---

## 2. OPENCLAW ITSELF: upstream architecture

Upstream: `github.com/openclaw/openclaw` ("The AI that really does things. Any OS. Any Platform."), docs at `docs.openclaw.ai`. One **Gateway** daemon is the single control plane owning sessions, auth profiles, channels, and state; "everything else is a client" (https://docs.openclaw.ai/gateway/remote).

### 2.1 Gateway daemon: where it runs

- Single multiplexed port for WebSocket **and** HTTP (Control UI, hooks, HTTP APIs): default **18789**, precedence `--port > OPENCLAW_GATEWAY_PORT > gateway.port > 18789` (https://docs.openclaw.ai/help/faq/gateway-ports-and-remote-mode).
- **Binds loopback by default** (`gateway.bind: "loopback"`); a runtime lock binds `ws://127.0.0.1:18789` on startup (same FAQ). Non-loopback binds (`lan` / `tailnet` / `custom`) require gateway auth to be enabled (https://docs.openclaw.ai/gateway/remote, "Security rules").
- This matches the local constant `defaultPort = 18789` (`Protocol.swift:24`).

### 2.2 How remote access works

All options keep the phone→Mac path private; there is no hosted relay — transport is direct or via your own tailnet/SSH (https://docs.openclaw.ai/gateway/remote, https://docs.openclaw.ai/gateway/tailscale):

- **Tailscale Serve (managed, recommended):** `gateway.tailscale.mode: "serve"` — OpenClaw auto-configures `tailscale serve` so the gateway stays on loopback while Tailscale provides HTTPS at `https://<magicdns>/`; this is what produced the `https://….ts.net` URL the iOS wrapper used. Serve injects identity headers (`tailscale-user-login`, verified by the gateway via `tailscale whois` against `x-forwarded-for`) and, when `gateway.auth.allowTailscale: true`, those headers satisfy Control UI/WebSocket auth **without a token** — the `AUTH_TAILSCALE_*` mechanism this repo stumbled on (`native/README.md:49`). The bypass applies only to the Control UI WS surface (plus avatar GETs); `/v1/*` HTTP endpoints always use normal gateway auth.
- **Direct tailnet bind:** `gateway.bind: "tailnet"` + token auth → plain `ws://<tailscale-ip>:18789`.
- **SSH tunnel fallback:** `ssh -N -L 18789:127.0.0.1:18789 user@host`; loopback sees forwarded connections as local (silent pairing, §2.3).
- **Funnel (public):** `tailscale.mode: "funnel"` — refused unless `auth.mode: "password"`. Not recommended for our use.
- Plaintext `ws://` is accepted only for loopback/private/CGNAT/`.local`/`.ts.net` hosts; public hosts must use `wss://` (https://docs.openclaw.ai/gateway/remote).

### 2.3 Device pairing & auth model

(https://docs.openclaw.ai/gateway/protocol/auth, https://docs.openclaw.ai/gateway/pairing — note `docs/gateway/authentication.md` is about *model-provider* auth, not connection auth.)

- **Auth modes:** `gateway.auth.mode`: `none` | `token` (default) | `password` | `trusted-proxy`. Shared-secret auth accepts the configured secret in either `connect.params.auth.token` or `connect.params.auth.password` (protocol/auth, "Auth").
- **Device identity (matches the local implementation exactly):** Ed25519 keypair; `device.id` is a keypair fingerprint (locally: hex SHA-256 of pubkey, `DeviceIdentity.swift:38-40`); identity persists per client (GUI: `openclaw-device-identity-v1` localStorage, `localStorage.json:2`).
- **Challenge-signed handshake:** the server sends a pre-connect `connect.challenge` `{nonce, ts}` event; **all connections must sign the nonce**; `connect.params.device.signedAt` must be the challenge's `ts`, not local time (protocol/handshake, protocol/auth). Preferred payload is now **v3** (`buildDeviceAuthPayloadV3`, binds `platform` and `deviceFamily`), with legacy **v2 still accepted** — the local client signs v2 (`Protocol.swift:22`), fine today but a tracked upgrade item.
- **Device tokens:** after pairing, the gateway issues a per-device+role `deviceToken` in `hello-ok.auth.deviceToken`; clients persist it and reconnect with it. Rotation/revocation via `device.token.rotate` / `device.token.revoke` (needs `operator.pairing`). New pairing flows can also hand a bounded **operator token** to a mobile device (`hello-ok.auth.deviceTokens`, excludes `operator.admin` and pairing-mutation scopes) — designed exactly for QR/setup-code mobile onboarding (`openclaw qr`, Control UI pairing dialog).
- **Pairing approval:** new device IDs require operator approval unless auto-approved; a waiting client gets `NOT_PAIRED` with `details.code: "PAIRING_REQUIRED"`, `waitForResolution: true`, then a `device.pair.resolved` event. **Loopback connections (including via SSH forward) silently auto-approve**; same-host tailnet/LAN connects are "remote" and still prompt. Node-role devices additionally need *capability* approval (`node.pair.approve`, breaking change `2026.3.31+`).
- **Roles & scopes:** roles `operator` / `node` / `worker`; closed operator scope set `operator.read/write/admin/approvals/questions/pairing/talk/talk.secrets` (protocol/handshake, "Roles and scopes"). The local client requests `operator.admin/read/write/approvals/pairing` (`Protocol.swift:11-17`).

### 2.4 WebSocket protocol shape

(https://docs.openclaw.ai/gateway/protocol, …/protocol/transport, …/protocol/handshake)

- WS text frames, JSON; first frame must be `connect`; frame shapes `{type:"req",id,method,params}` / `{type:"res",id,ok,payload|error}` / `{type:"event",event,payload,seq,…}` — identical to what this repo reverse-engineered (`GatewayClient.swift:5-7`, `native/README.md:25-33`).
- Handshake negotiates `minProtocol`/`maxProtocol` (current 4; an N-1 version window applies); server answers `hello-ok` with `server`, `features.methods/events`, `snapshot`, `policy` (payload limits), `auth`. The probe's "confirmed via hello.features.methods" (§1.3.1) is exactly this advertised method list.
- The whole method/event surface is defined by TypeBox schemas and published as npm packages **`@openclaw/gateway-protocol`** (schemas; tarball includes machine-readable `protocol.schema.json`) and **`@openclaw/gateway-client`** (reference Node client + **browser-safe entry** `@openclaw/gateway-client/browser`) — see protocol/transport "npm packages". The reverse-engineering era is over: the wire contract is now officially documented and packaged.

### 2.5 The `x-openclaw-session-key` pattern — where it appears upstream

**Not in the WS protocol.** It is a header on the Gateway's **OpenAI-compatible HTTP API** (https://docs.openclaw.ai/gateway/openai-http-api):

- The gateway can serve `POST /v1/chat/completions`, `GET /v1/models`, `POST /v1/embeddings` on the same multiplexed port — **disabled by default**, enable via `gateway.http.endpoints.chatCompletions.enabled: true`; auth is `Authorization: Bearer <gateway token|password>`. Upstream explicitly warns to treat this endpoint as **full operator access** and keep it loopback/tailnet-only.
- `model` is an **agent target**, not a provider model id: `openclaw` / `openclaw/default` / `openclaw/<agentId>`.
- Optional headers: **`x-openclaw-session-key: <sessionKey>`** for explicit session routing (rejects reserved namespaces `subagent:`, `cron:`, `acp:`; continuing *incognito* sessions requires `operator.admin`), `x-openclaw-model` (override backend model, needs `operator.admin`), `x-openclaw-agent-id`. Alternatively the OpenAI `user` string derives a stable session key per conversation.
- Session keys are the same namespaced `agent:<agentId>:<name>` strings — e.g. the captured `agent:coder:main` (`localStorage.json:3`) and NANO-REMOTE's hardcoded `agent:main:main` (`/Users/mabue/BROCODE/Projects/NANO-REMOTE/lib/ai.ts:50`). ACP-driven sessions get `agent:<agentId>:acp:<uuid>` (https://docs.openclaw.ai/tools/acp-agents).

So: nano-ai's existing OPENCLAW provider stub (`createOpenAICompatible` + that header, `lib/ai.ts:50`) is pointed at exactly this upstream surface.

### 2.6 Can the gateway drive arbitrary coding-agent CLIs?

**Yes — three documented paths** (https://docs.openclaw.ai/gateway/cli-backends, …/config-agents/runtime-and-cli-backends, https://docs.openclaw.ai/tools/acp-agents):

1. **CLI backends (plugin-registered):** an agent turn can execute through a local AI CLI instead of a provider API. Bundled: `claude-cli` (Anthropic plugin — talks directly to the installed Claude Code executable, keeps an authenticated subprocess warm, persists CLI session ids so follow-up turns resume; JSONL streaming; MCP loopback bridge feeds it gateway tools) and `google-gemini-cli`. Selection is model-scoped runtime policy: `agents.defaults.models["anthropic/claude-opus-5-5"].agentRuntime.id = "claude-cli"`. CLI launch mechanics are plugin code (`api.registerCliBackend(...)`), so **a bespoke CLI (e.g. a `kimi` binary) can be added as a small CLI-backend plugin**.
2. **Codex:** not a `codex-cli` backend — Codex runs through the bundled **Codex app-server harness** (plugin runtime id `codex`) for `openai/*` routes; native `/codex` chat controls (bind, threads, permissions) exist.
3. **ACP agents:** the `@openclaw/acpx` runtime plugin drives *external coding harnesses* (Claude Code, Cursor, Copilot, OpenCode, Gemini CLI, "and other supported acpx harnesses") with session controls, resume, background tasks, and conversation binding; spawned via `sessions_spawn({runtime:"acp"})` or `/acp` chat commands. This is the path for "persistent external coding sessions" — closest to NANO-REMOTE's agent-session concept.

Kimi specifically: upstream ships a **Kimi provider plugin** (`@openclaw/kimi-provider`, providers `kimi` / `kimi-code` / `kimi-coding` — https://github.com/openclaw/openclaw/blob/main/docs/plugins/reference/kimi.md). That is API/provider support; driving the actual `kimi` *CLI binary* would be via a custom CLI-backend plugin or acpx if it lists a Kimi adapter (unverified — check the acpx harness list before promising it).

---

## 3. VERDICT for NANO-REMOTE

Goal: phone app (nano-ai fork at `/Users/mabue/BROCODE/Projects/NANO-REMOTE`) driving claude-code / codex / kimi CLI sessions on the user's Mac over Tailscale. The fork already carries an "OpenClaw (Experimental)" provider in the settings UI (`components/settings/server.tsx:182`) wired to the OpenAI-compatible endpoint with a hardcoded session key (`lib/ai.ts:50`, models probed via `GET {host}/models`, `hooks/use-models.ts:75-87`).

**Verdict: yes — build the host side on OpenClaw's gateway instead of a bespoke daemon**, at two possible levels:

- **Level A (zero new host code, matches the existing stub):** run `openclaw` on the Mac with `gateway.bind: "loopback"` + `gateway.tailscale.mode: "serve"`, enable `gateway.http.endpoints.chatCompletions`, set a gateway token, and configure agents whose models route to the desired harness (`claude-cli`, Codex harness, kimi via provider/plugin). The phone keeps using its existing provider entry: `https://<mac>.ts.net` + Bearer token + one `x-openclaw-session-key` per conversation (replace the hardcoded `agent:main:main` with per-chat keys). This likely works **today** and is the right MVP.
- **Level B (rich remote-control UX):** speak the documented WS gateway protocol from the app for what the HTTP surface can't do: `sessions.list/create`, live `chat`/`agent`/`tool.call` event streams, run state and `sessions.abort`, history restore (`chat.history`), exec-approval RPCs (`operator.approvals`), and device pairing (Ed25519 + challenge + device token) instead of a shared token on the phone. In a React Native/Expo app this means a thin TS client — either adapt `@openclaw/gateway-protocol` schemas (validate frames; browser-safe client entry exists, but RN WebSocket/global quirks argue for a small hand-rolled client) or port this repo's proven Swift client logic (`GatewayClient.swift`, ~340 lines, validated on-device over Tailscale — commit `d8c4040`).

**Concrete reuse candidates**

| Asset | Where | Reuse |
| --- | --- | --- |
| Gateway itself (daemon, Tailscale Serve, pairing, approvals, CLI/ACP harnesses) | upstream | The entire host side — no bespoke daemon, no TLS/cert work |
| Official protocol docs + `@openclaw/gateway-protocol` schemas | https://docs.openclaw.ai/gateway/protocol | Wire-contract source of truth; replaces reverse engineering |
| `OpenClawKit` Swift client | `OPENCLAW-WEB-GUI/native/OpenClawKit/Sources/OpenClawKit/` (`GatewayClient.swift:103-128`, `Protocol.swift:133-149`, `DeviceIdentity.swift`) | Reference implementation for a RN/TS WS client; handshake ordering and retry logic already battle-tested against the live gateway |
| oc-probe CLI | `…/Sources/oc-probe/Probe.swift:43` | Protocol validation harness during NANO-REMOTE bring-up |
| Live-captured wire facts | §1.3 above, `localStorage.json` | Exact method names/params, session-key format, message content shapes |
| nano-ai OPENCLAW provider stub | `NANO-REMOTE/lib/ai.ts:50`, `components/settings/server.tsx:91,182` | Already-integrated transport for Level A |

**Gaps to close (our work)**

- **Per-conversation session keys & history:** stub hardcodes `agent:main:main` (`lib/ai.ts:50`); need key-per-chat + `user`-field or header plumbing, and history restore (HTTP endpoint is stateless; history needs WS `chat.history` or phone-side storage — nano-ai already stores chats locally, so Level A can dodge this).
- **Agent/CLI selection UX:** which harness (claude/codex/kimi) drives a conversation is gateway config / per-model `agentRuntime` policy, or per-request `x-openclaw-model` (needs `operator.admin`). Needs a picker in the app, not just config edits on the Mac.
- **Approvals UX:** CLI/ACP harnesses run under OpenClaw tool policy + exec approvals (RPC family exists, `operator.approvals` scope); interactive CLI permission prompts are abstracted away, so a phone-friendly approve/deny surface must be built on those RPCs (Level B). Until then, runs must be config-pre-authorized.
- **Run-state & tool rendering:** nano-ai's chat UI expects plain streamed text; `hasActiveRun`, tool calls, abort need UI (this repo's `ChatView`/`ConnectionModel` event handling is the design sketch — `ConnectionModel.swift` `handle(_:)`, dedupe included).

**Risks**

- **Fast-moving upstream:** breaking protocol changes are routine (node-command gating in `2026.3.31`; v3 signature preferred over the v2 this repo signs; protocol N-1 window). Pin gateway + client package versions and track releases.
- **Security posture:** the OpenAI HTTP endpoint is *full operator access*; it must stay tailnet-only (Serve, not Funnel). Prefer per-device pairing + device tokens (Level B) over a long-lived shared token stored on the phone. And operationally: this repo already leaked a device private key into git (`localStorage.json:2`) — revoke it, and keep NANO-REMOTE captures/key stores out of the repo.
- **Kimi CLI unproven:** upstream Kimi support is a provider plugin; driving the `kimi` binary as a harness depends on acpx adapter coverage or writing a small CLI-backend plugin — verify before committing to "kimi" in marketing.
- **Multi-agent concurrency:** "one gateway owns everything" means concurrent CLI agents = separate gateway agents with per-model runtime pins; headroom and cross-session interference on one Mac are untested by anything found locally.
- **When a bespoke daemon would still win:** raw PTY control, passing through the CLIs' native permission prompts, minimal host footprint, zero dependence on a fast-moving upstream. That trades away pairing, transport security, streaming events, and approvals that OpenClaw already solved — not worth it for v1.

**Recommended path:** Phase 0 = Level A MVP (existing stub + one gateway setup doc + per-chat session keys). Phase 1 = Level B WS client (port OpenClawKit logic to TS, guided by official protocol docs) for session list, live events, abort, and approvals. Keep oc-probe in the loop for any wire-shape question — it is faster than reading upstream source.
