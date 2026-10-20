# Nano Remote: plan from vision to a polished app and service

Date: 2026-10-20. Status: proposal for the operator's decision. Inputs: `docs/vision.md`, ADR 0001
(Tailscale, no cloud relay), ADR 0002 (host Journal, phone Replica), `docs/research/*` (vendor memo,
OpenClaw recon, nano-ai readiness), and `docs/research/rea/*` (reverse engineering and live captures of
the ChatGPT/Codex apps, including a full phone session and push behavior).

## 1. What we are building, in one paragraph

Two deliverables. **Nano Host**: a small always-on service on the Mac that drives coding agents
(Codex first, then Claude Code, then Kimi), keeps a sequence-numbered Journal per session, and serves
phones over the tailnet with an envelope protocol (sequence numbers, acks, resume cursor, chunking) that
is a clean-room copy of the pattern ChatGPT uses. **Nano Remote (iOS)**: a native phone app with the
polish of the vendor apps: pair by QR, see hosts and their online state, open a session and have it render
instantly from a local Replica, send and steer, approve or deny, answer questions, read diffs and output,
get a push when work finishes or needs you, and chat locally with Ollama-class providers when no host is involved.

## 2. Three decisions to make before building (Phase 0)

Each comes with a recommendation. They become ADR 0003 to 0005 once decided.

### D1. Host daemon: bespoke Nano Host, or the OpenClaw gateway?
Recommendation: **bespoke Nano Host in TypeScript on Node; no OpenClaw dependency anywhere.** Why:
- The runtime captures show Codex's `app-server` is a complete, documented JSON-RPC engine over stdio
  (threads, turns, approvals, user-input questions, resume with pagination, interrupt, status). Driving it
  directly is a few hundred lines; we have the generated schema in `docs/research/rea/codex-app-server-schema/`.
- Claude Code has an official Agent SDK for TypeScript with streaming, permission callbacks (our approvals)
  and session resume. Kimi ships a CLI with `--output-format stream-json`. All three fit one Node process.
- ADR 0002 needs a stateful Journal with our own sequence semantics; OpenClaw's event stream is not that,
  and its approvals surface abstracts away the CLIs' native prompts. Its upstream moves fast (protocol
  breaks noted in the recon memo) and Kimi through it is unproven.
- Cost of bespoke: pairing, TLS-free transport over the tailnet, and the launchd service are ours to build.
  The captures give us the exact pairing and presence patterns to copy, so this is bounded work.
Gate: a two-day spike (Phase 0) must show Codex and Claude both driven to an approval round trip from a
fake phone client. If Claude's SDK cannot surface approvals, the fallback stays inside Claude Code:
its hooks (permission request events) or its streaming JSON CLI mode driven by the same adapter shape.
OpenClaw is not used: it would add a fast-moving third-party gateway for one agent and a different
approval model from the other two. The recon memo in `docs/research/openclaw-remote.md` stays as history.

### D2. Phone app stack: native SwiftUI, or Expo/React Native (nano-ai heritage)?
Recommendation: **native SwiftUI, iOS 18+, iPhone first.** Why: the bar is the ChatGPT iOS app, whose
polish comes from native Live Activities, Dynamic Island, Face ID lock, keychain-held device keys,
time-sensitive notifications, and tight background behavior. nano-ai's Expo code was already removed from
this repo; its UX ideas (chat feel, settings, provider picker) carry over as design, not code. The
OpenClawKit Swift client in the sibling repo is a working reference for a tailnet WebSocket client.
Cost: no Android in v1. If Android is a must, choose Expo now and accept weaker Live Activity and
background behavior; do not plan to switch later.

### D3. Push notifications without a cloud relay
Recommendation: **a minimal "push wake" service we run, carrying no content.** Why: Apple only delivers
pushes from a server holding the app's APNs key. Embedding that key in a host binary on users' Macs is a
leak. The service accepts `{device_token, kind}` from a host and forwards an empty wake to APNs; all
content stays on the tailnet, which matches the spirit of ADR 0001 (no traffic relay) and the letter of
ADR 0002 (pushes only wake the app). The captures show the rule to copy: push completion only when the
phone's stream is closed, push approvals always, and replay pending approvals when the phone resumes.
Alternative: no push at all in v1 and rely on the roughly 30 s of background socket iOS allows after lock.
That fails the "start it from the train" bar in the vision.

## 3. Architecture (what the decisions imply)

```
 iPhone (SwiftUI)                 Tailnet                    Mac
 Replica per session   <== WSS envelope stream ==>   Nano Host (Node, launchd)
 device key (SE)       pair: QR = tailnet addr + code    Journal (SQLite, seq per session)
 local chat (Ollama…)  ---- direct HTTPS to provider      Adapters: Codex app-server (stdio JSON-RPC)
                                                                    Claude Agent SDK
                                                                    Kimi CLI (stream-json)
 APNs  <-- push wake service <-- host (empty wake, kind only)
```

- **Protocol v1** (documented in `protocol/`): envelope `{type, client_id, stream_id, seq_id, cursor?, message}`
  with `ack`, `ping/pong` carrying presence, and `*_chunk` for large payloads; the message is a JSON-RPC
  request, response, or notification in a vocabulary modeled on Codex's: `session/list`, `session/open`
  (resume + last N turns), `turn/start`, `turn/steer`, `turn/interrupt`, `item/*` deltas, `approval/request`
  and `approval/resolve`, `input/request`, `status/changed`. Adapters normalize each agent into that vocabulary.
- **Journal**: append-only per session, every event has `seq`; `session/open` returns a snapshot plus the
  cursor; clients catch up with `events/since`. Pending approvals are state, replayed on open.
- **Pairing**: host shows a QR with `nano://pair?host=<magicdns>&port=&code=<short-lived>`; the phone
  presents its public key; the host stores it and issues a device token; devices are listed and revocable.
- **Local chat mode**: the phone talks directly to the provider (Ollama, or any OpenAI-compatible
  endpoint the user enters); no host involved.

## 4. Phases, deliverables and acceptance

Rough effort assumes build work dispatched to headless engines through BROCODE, with design rulings
from the planning session. Durations are calendar estimates for one operator reviewing.

| Phase | Deliverable | Acceptance (evidence required) | Est. |
|---|---|---|---|
| 0 Decide | ADR 0003 to 0005; spike repo `spikes/host-drive` driving Codex and Claude to an approval round trip from a scripted client; protocol v1 draft | Spike log shows `approval/request` → `accept` → turn completed for both agents | 1 week |
| 1 Host v0 | `host/` package: Codex adapter, Journal, envelope server, pairing, device list, launchd installer, `nano-host` CLI | Scripted client: pair, open session, turn, approval, kill and resume with catch-up from cursor; 95% test coverage on Journal and envelope layers; verify gate green | 2 to 3 weeks |
| 2 iOS v0 | `ios/` app: pairing scanner, host list with online dots, session list, session view with Replica, composer, approvals, questions, output and diff views, interrupt | On-device over tailnet, away from home: send appears instantly, approval round trip under 1 s, lock and reopen shows catch-up; TestFlight build | 3 to 4 weeks |
| 3 Wake and glance | Push wake service, APNs registration, notification rules from the captures, Live Activity with task count and state | Locked phone gets completion push only when disconnected, approval push always; Live Activity updates | 2 weeks |
| 4 More agents | Claude Code adapter (SDK), Kimi adapter (spike first), per-session agent picker, per-agent approval mapping | Same acceptance as Phase 1 for each adapter; Kimi either passes or is cut from v1 marketing | 2 to 3 weeks |
| 5 Local chat | Provider settings, model picker, streaming chat, nano-ai feature parity list | Works with Ollama on LAN and a cloud OpenAI-compatible endpoint; no host required | 2 weeks |
| 6 Polish and ship | Onboarding, empty and error states, accessibility, settings, host installer (Homebrew), App Store listing, privacy text | Impeccable-style audit passed; crash-free TestFlight week; release checklist done | 2 weeks |

Total: about 14 to 17 weeks of calendar time with parallel dispatch; Phases 1 and 2 overlap once protocol v1 is frozen.

## 5. Repository layout and gates

```
host/        TypeScript, Node 22+, pnpm; vitest + tsc; verify: pnpm -C host verify
ios/         Xcode project, Swift Package for NanoKit (protocol client, Replica); verify: xcodebuild test
protocol/    protocol-v1.md + JSON Schemas (single source; host and iOS generate types from it)
push/        tiny Node service (Phase 3); verify: vitest
spikes/      throwaway, never dispatched to production paths
docs/        vision, adr, plan, research
```
Dispatch prerequisites per the BROCODE rules: a confirmed verification command per package, runs under
ten minutes, no full reinstalls. Each ticket states its evidence: a log, a test, or a device capture.

## 6. Work process

1. Tracker: one Beads epic per phase; children are dispatchable tickets with acceptance text and the
   evidence they must attach. Decision tickets for D1 to D3 come first.
2. Planning session (this one): design rulings, protocol freezes, review of dispatched diffs against
   the acceptance text, and "show me the proof" on every completion claim.
3. Build: dispatched engines, one lane per ticket, staggered on the same package to keep the verify gate honest.
4. Field checks: every phase ends with the operator using the real phone away from home, the way the
   push test was run today, and the capture goes into `docs/research/`.

## 7. Risks and how the plan handles them

- **Codex engine churn.** The bundled engine is an alpha (0.163). Pin the version, regenerate the schema
  in CI, and keep the adapter behind our own vocabulary so a protocol change touches one file.
- **Claude approvals through the SDK.** Unverified until the Phase 0 spike; fallback is Claude Code's hooks or its streaming CLI mode, inside the same adapter.
- **Kimi driving.** Unknown; the plan treats it as a spike with a cut line.
- **iOS background limits.** The captures show about 30 s of socket after lock. Design assumes it; push wake covers the rest.
- **Tailscale on the phone.** Requires the Tailscale app and its VPN profile; onboarding must detect and explain it.
- **Push service is a cloud piece.** Keep it stateless and content-free; document it in ADR 0003 so it does
  not grow into the relay ADR 0001 rejected.
- **Scope creep from the vendor feature list.** v1 is sessions, approvals, questions, output, diffs,
  interrupt, push, and local chat. Voice, screen sharing, computer use, and cloud agents are out.

## 8. Immediate next steps

1. Done 2026-10-20: operator accepted D1 to D3; recorded as ADR 0003, 0004, 0005.
2. Done: Phase 0 epic in Beads with children: protocol v1 draft, provider-connection design,
   host-drive spike, repo scaffold and gates.
3. Operator addition: make connecting any LLM provider easy, following the pattern in the
   odysseus-dev/odysseus project. Studied in `docs/research/odysseus-providers.md`; design in
   `docs/plan/provider-connection.md` (Phase 0 ticket).
4. Next: protocol v1 draft (planning session), dispatch the scaffold, then the spike.
5. Freeze protocol v1 at the end of Phase 0; open Phase 1 and Phase 2 epics in parallel.
