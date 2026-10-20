# REA findings: how ChatGPT/Codex drives agent sessions on your Mac from a phone

Date: 2026-10-20. Static reverse engineering (REA) of three shipped artifacts, followed by a runtime
capture of the installed app on the operator's Mac (see `runtime-capture.md`). Items marked **Runtime**
were confirmed live. Detailed reports with byte offsets, grep hits
and quoted code live next to this file:

| Report | Target | Readability |
|---|---|---|
| `codex-desktop-local-session-link.md` | `/Applications/ChatGPT.app` (Electron Codex app, bundle `com.openai.codex` 26.1007.21159) | Full: unencrypted JS + Rust engine strings |
| `codex-desktop-remote-control-host.md` | same app, the "Control this Mac" feature | Full |
| `chatgpt-ios-readable-resources.md` | `resources/chatgpt-ios/ChatGPT.ipa` (iOS 1.2026.279) | Partial: code is FairPlay-encrypted; plists, strings, bundled scripts readable |
| `chatgpt-macos-swift-codex-remote.md` | `resources/chatgpt-macos/ChatGPT.dmg` (older Swift Mac app 1.2026.183) | Symbols and strings only (no decompiler installed) |
| `codex-app-server-schema/` | JSON Schema printed by the bundled engine (`codex app-server generate-json-schema --experimental`) | Authoritative protocol spec |
| `runtime-capture.md` | The installed app running live: process tree, live engine queries, and a decoded relay session | Runtime evidence (operator's own Mac) |

Identity correction: the app at `/Applications/ChatGPT.app` is not the Swift ChatGPT app. It is
OpenAI's Electron Codex desktop app rebranded "ChatGPT", with the Codex engine (codex-cli
0.162.0-alpha.17.2) bundled inside. The Swift app in the DMG is the previous generation; it did not
embed Codex and instead downloaded the Codex app separately.

Labels: **Observed** = seen directly in shipped code, strings, schema or plists. **Inferred** = best
explanation of observed facts. **Unknown** = not established.

## A. Topology (what connects to what)

1. **Observed.** The Mac UI drives the Codex engine as a private child process over stdin/stdout,
   one JSON object per line, JSON-RPC shaped (`id`, `method`, `params`, no `jsonrpc` field).
   Command line: `codex -c features.code_mode_host=true app-server --analytics-default-enabled`.
   Evidence: local-link report items 1 to 7; `codex app-server --help` shows `--listen` default `stdio://`.
2. **Observed.** The phone never connects to the Mac. The engine dials out over a WebSocket to
   `chatgpt.com/backend-api/wham/remote/control/server`; the phone talks to the same backend; the
   backend relays. No inbound port. Evidence: host report items 13 to 17 (binary strings for the
   endpoint list and the enrollment table).
3. **Observed.** The relay carries plain JSON text frames. Envelope types are
   `client_message`, `client_message_chunk`, `ping`, `client_closed` (phone to Mac) and
   `server_message`, `server_message_chunk`, `ack`, `pong` (Mac to phone). Each carries
   `client_id`, `stream_id`, `seq_id`, `env_id`, optional `cursor`; big payloads are base64 chunks.
   The payload inside is an ordinary app-server JSON-RPC message. Evidence: host report 17 to 19.
4. **Observed.** Reliability knobs on the controller side: protocol version 3, ping every 30 s,
   pong timeout 10 min, reconnect after 1 s, 100 KiB segments, unacked envelopes replayed on
   reconnect, sequence gap forces a stream reconnect, and an `x-codex-subscribe-cursor` header for
   resuming. Evidence: host report 19, 16.
5. **Observed.** Two other transports in the same binary are NOT the phone path: the Noise
   post-quantum relay (cloud harness executing tools on a registered machine) and MASQUE/HTTP3 to
   `codex-portals.api.openai.com` (SSH-over-QUIC into cloud environments). Evidence: host report 21 to 23.
6. **Observed.** The engine owns session state on the Mac: `$CODEX_HOME/state_5.sqlite` plus one
   rollout JSONL per thread under `sessions/`. The desktop keeps only a sidebar cache
   (`~/.codex/sqlite/codex-dev.db`). Evidence: local-link report 16, 17.
7. **Runtime.** Local sessions are not mirrored into a cloud transcript store. The desktop's second
   host ("durable", Codex Cloud) lists only cloud-agent threads and rejects the remote-control methods;
   the relay keeps only a sequence cursor plus a presence token per host. The backend does keep
   per-environment task records (UI copy: "This removes the environment and its remote control tasks
   from ChatGPT"). So the vision document's "transcript lives in the middle" holds for cloud tasks, and
   for local sessions the Mac-side journal plus relay replay is what the phone catches up from.
   Evidence: runtime-capture items 7, 13, 14.

## B. Pairing and trust

8. **Observed.** Host pairing is one engine RPC, `remoteControl/pairing/start {manualCode}`, which
   returns `pairingCode`, `manualPairingCode`, `environmentId`, `expiresAt`; the UI polls
   `remoteControl/pairing/status` until `claimed`. Evidence: schema files
   `v2/RemoteControlPairingStart*.json`, `v2/RemoteControlPairingStatus*.json`; host report 1, 2.
9. **Observed.** The phone scans a QR that encodes
   `https://chatgpt.com/codex/pair?pairing_code=<code>` (a universal link, so the iOS app's
   `applinks:chatgpt.com` entitlement opens it). Another computer types an 8-digit PIN instead.
   The QR carries no server id, account id or key. Evidence: host report 3, 4; iOS report entitlements.
   (The older Swift app had a code-based `pairingCode` type and no QR for Codex; the QR is new in
   the Electron generation. "Slingshot" is OpenAI's name for the relay side: the relay introduces itself
   to the host with an `initialize` whose id is `__slingshot_backend_initialize__`; runtime-capture item 12.)
10. **Observed.** Pairing requires remote control already enabled, which requires MFA on the ChatGPT
    account. Evidence: host report 7, 25.
11. **Observed.** Controllers (desktop acting as controller; very likely the phone too) hold a
    non-exportable Secure Enclave P-256 key (TPM on Windows), enroll with a fresh step-up OAuth login
    (password used within 5 minutes, scope `codex.remote_control.enroll`), and sign a
    `device_key_challenge` on every WebSocket connect. Evidence: host report 27 to 29; native module
    `remote-control-device-key.node`.
12. **Observed.** The host lists and revokes paired devices (`remoteControl/client/list`,
    `remoteControl/client/revoke`; client fields `clientId, displayName, deviceType, platform,
    osVersion, deviceModel, appVersion, lastSeenAt`). A flag switches between "any device on the
    account can control this Mac" and one-to-one pairing. Admins can block the feature
    (`allowRemoteControl` requirement). Evidence: schema `v2/RemoteControlClients*.json`; host report 10, 26, 31.
13. **Observed.** Version gating: a controller refuses hosts whose engine is older than 0.141.0
    ("update required"). Evidence: host report 32.
14. **Observed.** On the phone, Face ID can lock the Codex area ("ChatGPT uses Face ID to unlock Codex
    on this device"); the Swift generation shows the same gate was phone-only ("Codex Remote local
    authentication is unavailable on macOS"). Evidence: iOS report 2; Swift report 7.

## B2. Runtime confirmations of the host link (operator's Mac)

14a. **Runtime.** The engine re-enables hosting by itself at startup from a persisted enrollment row keyed
    by `(websocket_url, account_id, client_name)`; the UI never sent `remoteControl/enable`.
    Status went `disabled → connecting → connected` in 1.5 s after a token refresh. Runtime-capture 8 to 10.
14b. **Runtime.** The upgrade request to `wss://chatgpt.com/backend-api/wham/remote/control/server` carries
    `authorization`, a cookie, `x-codex-installation-id`, `x-codex-protocol-version: 3`, `x-codex-name`
    (base64 host name) and `x-codex-server-id`. Runtime-capture 11.
14c. **Runtime.** The relay is a virtual client `codex-backend` with `client_id = backend_<server_id>`.
    It sends `ping` envelopes every 10 s with a base64 cursor `{codex_remote_control_cursor, presence_claim_token}`
    and acks every host envelope by `seq_id`; the host answers pings with `pong {status: unknown|active}`. Runtime-capture 12 to 14.
14d. **Runtime.** One iPhone (iOS 26.6, ChatGPT 1.2026.244) is paired to this Mac's environment, as returned
    by `remoteControl/client/list`. Runtime-capture 15.
14e. **Runtime.** Quitting the GUI kills the engine and ends hosting; nothing keeps running. Runtime-capture 6.
14f. **Runtime, phone end to end.** The paired iPhone drove a real task: each phone session is a new relay
    stream with `initialize` and a device `attestation/generate` challenge; the phone browses with
    `thread/list`, `fs/readDirectory`, and `command/exec` (its bundled scripts); starts work with
    `thread/start` + `turn/start`; spins a hidden side thread to name the chat; receives the normal
    notification stream (752 message deltas in one task); answered `item/commandExecution/requestApproval`
    with `{"decision":"accept"}` in 11 s; after locking, caught up with `thread/resume` + `thread/turns/list`
    + `thread/items/list`; and stopped a turn with `turn/interrupt`. The relay subscribes to each thread
    itself (`thread/resume` from the backend client), which is the inferred push trigger, and its pings
    carry the phone's foreground/background state. Runtime-capture section "Phone session".

## C. Availability

15. **Observed.** Host status enum: `disabled | connecting | connected | errored`, pushed as
    `remoteControl/status/changed {status, serverName, installationId, environmentId}`. The UI waits
    5 s for `connected` after enabling. Evidence: schema `v2/RemoteControlStatusChangedNotification.json`; host report 24, 33.
16. **Observed.** Controllers see backend-reported `online`, `busy`, `os`, `arch`,
    `app_server_version`, `last_seen_at` per environment; only offline environments can be deleted.
    Evidence: host report 34.
17. **Observed.** "Keep this Mac awake" holds a power blocker only on AC power. Enabling survives
    engine restarts (re-sent `remoteControl/enable`) and a CLI daemon can host without the GUI
    (`codex remote-control start|stop|pair`, `codex app-server daemon enable-remote-control`).
    Evidence: host report 37 to 39; CLI help captured in this session.
18. **Observed.** Phone-side copy for the same states: "Connecting...", "Connection failed",
    "Couldn't connect. Open Codex to check your hosts.", "Connect a host in Codex to see your tasks.",
    "Codex Remote is disabled for this workspace." Evidence: iOS report 1, 7 to 9.

## D. Session, turn and approval behavior (what the phone can do)

19. **Observed.** No per-method allowlist for remote clients was found; each remote stream becomes a
    normal app-server connection. So the phone has the full surface: 170 client requests, 11 server
    requests, 84 notifications (method inventory in `codex-app-server-schema/ClientRequest.json`,
    `ServerRequest.json`, `ServerNotification.json`). Negative evidence, treat as strong but not certain.
20. **Observed.** Opening a thread: `thread/read {includeTurns:false}`, then `thread/resume` with
    `initialTurnsPage:{limit:5, itemsView:'full', sortDirection:'desc'}`, then page older history
    with `thread/turns/list` and `thread/items/list`. Live notifications for that thread are buffered
    until the resume completes. Evidence: local-link report 18 to 21.
21. **Observed.** Sending: `turn/start {threadId, input[], clientUserMessageId, ...}`; mid-turn
    `turn/steer {expectedTurnId}`; stop `turn/interrupt`. A lost `turn/start` response is reconciled
    through `clientUserMessageId` instead of resending. Evidence: schema `v2/TurnStartParams.json`,
    `v2/TurnSteerParams.json`; local-link report 23.
22. **Observed.** Thread status: `notLoaded | idle | active{activeFlags: waitingOnApproval |
    waitingOnUserInput} | systemError`. Turn status: `inProgress | completed | interrupted | failed`.
    Evidence: schema `v2/ThreadStatusChangedNotification.json`, `v2/TurnCompletedNotification.json`.
23. **Observed.** The phone's widget vocabulary maps onto those states: Running, On hold,
    Needs your input, Approval required, Failed, Completed, Finished, Interrupted; Live Activity shows
    "N tasks" and the terminal state. Evidence: iOS report 10, 11, 16, 17.
24. **Observed.** Approvals arrive as server-to-client JSON-RPC requests:
    `item/commandExecution/requestApproval` (fields `command`, `cwd`, `reason`, `commandActions`,
    `availableDecisions`, `proposedExecpolicyAmendment`, network context),
    `item/fileChange/requestApproval` (`grantRoot`, `reason`), `item/permissions/requestApproval`
    (permission profile, scope `turn | session`). Decisions: `accept | acceptForSession | decline |
    cancel` (+ `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment` for commands).
    `decline` lets the turn continue; `cancel` also interrupts it. Evidence: schema
    `CommandExecutionRequestApproval*.json`, `FileChangeRequestApproval*.json`, `PermissionsRequestApproval*.json`.
25. **Observed.** Questions to the user arrive as `item/tool/requestUserInput {isBlocking, questions[{id,
    header, question, options[{label, description}], isOther, isSecret}]}` and are answered with
    `{answers}`; MCP elicitation uses `mcpServer/elicitation/request`. `serverRequest/resolved`
    tells every client that someone answered. Evidence: schema `ToolRequestUserInput*.json`,
    `v2/ServerRequestResolvedNotification.json`; local-link report 24.
26. **Observed.** One writer per thread. The desktop makes one window the owner and the rest
    followers that forward actions over IPC; the engine rejects a second writer ("already has an
    active writer"). Evidence: local-link report 31, 32.
27. **Observed.** Streaming item events the phone can render: `item/agentMessage/delta`,
    `item/reasoning/*`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`,
    `item/plan/delta`, `turn/diff/updated` (desktop opts out of this one), `thread/tokenUsage/updated`.
    Evidence: `ServerNotification.json` method list.
28. **Observed.** The iOS app ships 10 shell scripts it runs on the Mac for worktree creation,
    branch switching, environment setup, diff snapshots and file search, and renders diffs in an
    embedded HTML view. Evidence: iOS report 28, 29 (`CodexRemote_CodexRemoteCore.bundle`).
29. **Observed.** Crash handling on the desktop is manual: a dead stdio child is not reconnected;
    a full-screen "ChatGPT hit a snag" page offers "Try again", which respawns, re-initializes and
    re-resumes from disk. No replay of events missed during the outage. Evidence: local-link report 25 to 29.

## E. Notifications

30. **Runtime (was Inferred).** Phone pushes come from the relay, not the Mac. Observed: a completion push
    arrives only if the phone's stream has already closed (iOS closes it about 30 s after lock); an
    approval push arrives even though the request was also delivered live; pending approvals are
    replayed to the phone on reconnect. Runtime-capture section "Push notifications". Static evidence: the Mac registers only its own
    desktop notifications. The phone has `aps-environment production`, time-sensitive and
    communication notification entitlements, a notification service extension, Live Activities with
    frequent updates, and `voip`/`remote-notification` background modes. The Swift generation had a
    `CodexFinished` push type and suppressed the banner when the Mac was in the foreground.
    Evidence: host report 43; iOS report 12, 15, 19 to 22; Swift report 8, 9.
31. **Observed.** Setup copy promises exactly three things: "Pick up where you left off",
    "Start something new", "Stay in the loop" (notified when a task finishes or needs attention),
    plus an optional "Use your Mac apps while locked". Evidence: host report 42.

## F. What this means for Nano Remote

Copy (proven patterns):
- Host daemon spawns `codex app-server` over stdio and speaks the JSON-RPC in `codex-app-server-schema/`.
  Resume threads the way the desktop does (item 20); keep one writer per thread (26); buffer
  notifications during resume (20).
- Phone protocol: envelope with `client_id`/`stream_id`/`seq_id`, acks, chunking, ping/pong,
  resume cursor (3, 4). This is the ADR 0002 Journal/Replica idea already in the vendor's shape.
- Pairing UX: short-lived code shown as QR plus manual PIN, poll until claimed, device list with
  revoke, host status enum with push on change, keep-awake on AC (8, 9, 12, 15, 17).
- UX vocabulary: the five task states and the three-part "needs input / approval required / Allow"
  flow (23, 24, 25); the three setup promises (31).

Replace (what Tailscale removes): the OpenAI relay, server enroll/refresh tokens, step-up OAuth and
MFA gate, Secure Enclave controller key (a per-device app key is still worth keeping for revocation).

Do better than the vendor: auto-restart the engine with backoff and re-resume open threads (29);
expose an explicit allowlist to remote clients instead of the full surface (19); do not rely on the
backend to hold trust the operator cannot audit.

Still open after the runtime captures: the request bodies of `server/enroll` and `server/refresh`
(a trusted local CA would reveal them, since the engine uses the system trust store), Mac sleep
behavior, and the iOS pairing UI itself (encrypted; needs a device screen capture). Push delivery is
now observed (README item 30, runtime-capture "Push notifications").
Closed: cloud transcript question (7), quit behavior (14e), relay URL, handshake headers and envelope
protocol (14b, 14c), and the complete phone request sequence including approval, catch-up and interrupt (14f).
