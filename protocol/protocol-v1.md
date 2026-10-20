# Nano Remote protocol v1 (frozen)

Status: Frozen 2026-10-20 at the end of Phase 0 (host-drive spike passed). Changes follow section 12: additive only within v1; removing or renaming anything is v2.
Owner of the vocabulary: `CONTEXT.md`. Decisions this spec depends on: ADR 0001 (tailnet transport),
ADR 0002 (host Journal, phone Replica), ADR 0003 (bespoke Nano Host with one adapter per agent),
ADR 0004 (web client first), ADR 0005 (Web Push from the host).

Evidence it mirrors: the relay envelope and phone session captured live from the Codex desktop app
(`docs/research/rea/runtime-capture.md`, items 11 to 14, "Phone session" P1 to P12, "Push notifications"
N1 to N5), the desktop's resume recipe (`docs/research/rea/codex-desktop-local-session-link.md`, items
18 to 24), and the engine's generated schema (`docs/research/rea/codex-app-server-schema/`). Where this
spec departs from the captured pattern, the section says so and why.

The JSON Schemas in `protocol/schema/` are normative for shapes; this document is normative for behavior.
Examples in `protocol/examples/` validate against the schemas and double as fixtures for the host and
web test suites.

## 0. Reading guide

Three layers, bottom up:

| Layer | Unit | What it gives | Section |
|---|---|---|---|
| Transport | one WebSocket over the tailnet, authenticated at upgrade | privacy, device identity | 1 |
| Envelope | `client_message`, `server_message`, chunks, `ack`, `ping`, `pong`, `client_closed` | ordering, presence, large payloads | 2 |
| Message | JSON-RPC-shaped requests, responses, notifications | sessions, turns, items, approvals, Journal catch-up | 3 to 7 |

A **stream** is one WebSocket. A **client** is one paired device (one `client_id`, many streams over
its life). A **session** is one agent session on the host (CONTEXT.md: "agent session"). The **Journal**
is the host's per-session, sequence-numbered event log; the **Replica** is the client's local copy.
Every Journal event carries `seq`; every envelope carries `seq_id`. The two are different numbers:
`seq_id` orders envelopes on one stream and dies with the stream; `seq` orders events in one session and
is durable.

## 1. Transport

- URL: `wss://<host>.<tailnet>.ts.net:<port>/v1/stream`. The same origin serves the web app (ADR 0004).
  The host binds to its tailnet address only; never `0.0.0.0`.
- Authentication at the HTTP upgrade, never inside the envelope:
  - Browser clients: cookie `nano_device=<device token>`, set by the pairing flow (section 8),
    `Secure; HttpOnly; SameSite=Strict`. Browsers cannot set headers on WebSockets, and the web app shares
    the host's origin, so the cookie covers both the page and the socket.
  - Other clients: `Authorization: Bearer <device token>`.
  - Header `x-nano-protocol-version: 1`. The host closes with WebSocket code 4001 if the version is
    unsupported and 4003 if the token is missing, revoked or unknown.
- Text frames only, one envelope per frame, UTF-8 JSON. Binary frames are dropped.
- The host sends WebSocket-level pings every 10 s and closes a stream after 60 s without a pong.
- Client reconnect policy (recommended, not enforced): 1 s after a close, exponential to 30 s, reset on success.

Departure from the capture: there is no relay and no enrollment or refresh token (ADR 0001). The tailnet
plus the device token replace OpenAI's account auth, server token, and Secure Enclave attestation
(`attestation/generate` is not copied).

## 2. Envelope

Every frame is one envelope. Shapes are copied from the captured relay (runtime-capture 13, host report 17).

```json
{"type":"client_message","client_id":"dev_8f3a…","stream_id":"7c1e…","seq_id":12,"message":{…}}
{"type":"server_message","client_id":"dev_8f3a…","stream_id":"7c1e…","seq_id":40,"message":{…}}
{"type":"ack","client_id":"dev_8f3a…","stream_id":"7c1e…","seq_id":40}
{"type":"ping","client_id":"dev_8f3a…","stream_id":"7c1e…","seq_id":13,"state":"foreground"}
{"type":"pong","client_id":"dev_8f3a…","stream_id":"7c1e…","seq_id":13,"status":"active"}
{"type":"client_closed","client_id":"dev_8f3a…","stream_id":"7c1e…","seq_id":14,"reason":"background"}
```

| Field | Rule |
|---|---|
| `type` | Client to host: `client_message`, `client_message_chunk`, `ping`, `client_closed`, `ack`. Host to client: `server_message`, `server_message_chunk`, `pong`, `ack`. |
| `client_id` | The device id issued at pairing. Must match the authenticated device or the host closes with 4003. |
| `stream_id` | UUID chosen by the client per socket. Fixed for the life of the socket. |
| `seq_id` | Per stream, per direction, starts at 1 and increments by one for every `*_message`, `*_chunk`, `ping` and `client_closed` envelope. `ack` and `pong` carry the `seq_id` of the envelope they answer and do not consume one. |
| `message` | The JSON-RPC-shaped message (section 3). Present on `*_message` only. |
| `state` | On `ping`: `foreground` or `background`. The host records it as the client's presence. |
| `status` | On `pong`: `active`, `degraded` (an adapter is down; details via `host/status`), `draining` (host is shutting down; reconnect later). |
| `reason` | On `client_closed`, optional: `background`, `user`, `error`. |

### 2.1 Ordering and acks
- For sequence-consuming envelopes the receiver checks `seq_id == last + 1`. A gap or a repeat is a protocol error: the receiver closes the
  socket with code 4002 and the client starts a new stream. (Same rule as the Codex client, host report 19.)
- Every `*_message` and `*_chunk` envelope is acked. Acks may be batched: an `ack` for `seq_id` N
  acknowledges everything up to N. The sender keeps an unacked buffer bounded at 256 envelopes or 4 MiB,
  whichever first; beyond that the host stops sending Journal events on that stream until acks arrive
  (backpressure), and the client is expected to stop sending until acked.
- Acks are not replayed across streams. See 2.4.

### 2.2 Ping, pong, presence
- The client sends a `ping` every 30 s and immediately when its presence changes. The host answers each
  ping with a `pong` carrying the same `seq_id`.
- A client stream with no ping for 90 s is closed by the host (4008).
- Presence feeds the notification rules (section 9): a client counts as "connected" while it has any open
  stream, whatever `state` says (the capture showed iOS closes the socket about 30 s after lock, so an open
  socket is the reliable signal). `state` is recorded for diagnostics and for future rules such as delta
  coalescing (section 14, question 2).

### 2.3 Chunking
Messages larger than 100 KiB serialized are split into `*_chunk` envelopes, each its own `seq_id`,
sent consecutively on the stream with no other envelope in between:

```json
{"type":"server_message_chunk","client_id":"…","stream_id":"…","seq_id":41,
 "segment_id":0,"segment_count":3,"message_size_bytes":245122,"message_chunk_base64":"…"}
```

`segment_id` runs from 0; chunks carry base64 of the UTF-8 JSON bytes; the receiver concatenates, decodes
and parses after the last segment. Caps: 100 KiB per segment, 16 MiB per reassembled message (the Codex
client allows 1 GiB; the phone does not need that). A message that exceeds the cap is a protocol error (4009).

### 2.4 What is deliberately not copied
- **No stream resume and no envelope replay.** Codex replays unacked envelopes on reconnect and carries a
  relay cursor on pings. Nano Remote does not: every socket is a new stream, and the client catches up
  from the Journal with `session/open` or `events/since` (section 6). Idempotency lives in the message
  layer: `turn/start` carries `clientMessageId`, Journal events carry `seq`. This is the ADR 0002 design and
  removes a whole class of relay-buffer bugs.
- **No `env_id`.** A stream is bound to one host by its URL.
- **No `skip_history`.** Not needed without replay.

## 3. Message layer

The `message` field holds one of three shapes, identical to the Codex engine's JSON-RPC-without-the-header style:

```json
{"id":"c-17","method":"turn/start","params":{…}}        request (either direction)
{"id":"c-17","result":{…}}                               success response
{"id":"c-17","error":{"code":"session_busy","message":"…","data":{…}}}   error response
{"method":"item/delta","params":{…}}                     notification (no id, no reply)
```

- `id`: string or integer, unique per sender per stream. Client ids and host ids live in separate spaces.
- `method`: lower-case segments joined by `/`. Noun first (`session/open`, `turn/start`).
- Error `code` is a string from section 10. `message` is for logs, not for the user; clients map codes to copy.
- Unknown methods get `method_not_found`. Unknown fields are ignored (forward compatibility within v1).
- A request with no response within 30 s may be considered failed by the sender; the host answers slow
  operations (`turn/start` on a cold agent) with a result quickly and reports progress as events.

### 3.1 Who sends what

| Direction | Requests | Notifications |
|---|---|---|
| Client to host | `initialize`, `session/*`, `turn/*`, `events/since`, `approval/resolve`, `input/answer`, `agent/list`, `model/list`, `fs/readDirectory`, `push/*`, `device/*`, `host/status` | `initialized` |
| Host to client | none in v1 (see 5.3 for why) | every Journal event (section 5), `session/updated`, `host/status/changed` |

Departure: the Codex engine sends approvals as host-to-client requests that must be answered on the same
connection (capture P6, N3, where the host re-sent a pending request on the new stream 11 ms after resume).
Nano Remote turns them into Journal events with a client-initiated resolution (5.3), so a request survives a
dead socket without special replay code.

## 4. Handshake and discovery

### `initialize` (client to host, first message on every stream)
```json
{"id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "client":{"name":"Nano Remote Web","version":"0.1.0","platform":"ios-web","userAgent":"…"},
  "optOutNotifications":["item/reasoning/delta","usage/updated"]
}}
```
Result:
```json
{"id":1,"result":{
  "protocolVersion":1,
  "host":{"hostId":"host_2b…","name":"mabue-mbp","version":"0.1.0","os":"darwin","arch":"arm64"},
  "device":{"clientId":"dev_8f3a…","displayName":"iPhone (Safari)"},
  "agents":[{"id":"codex","name":"Codex","status":"ready","version":"0.163.0"},
            {"id":"claude","name":"Claude Code","status":"ready"},
            {"id":"kimi","name":"Kimi","status":"unavailable","reason":"CLI not found"}],
  "push":{"vapidPublicKey":"BOr…","subscribed":true},
  "limits":{"maxMessageBytes":16777216,"snapshotTurns":5}
}}
```
- `optOutNotifications` is the Codex relay's `optOutNotificationMethods` idea (capture item 12): the client
  names event methods it does not want on this stream to save mobile bandwidth. Opted-out events are still
  journaled and still returned by `events/since` when asked with `includeOptedOut: true`.
- Until `initialize` succeeds the host answers every other request with `not_initialized`.
- The client then sends the `initialized` notification (mirrors Codex; the host uses it to start sending
  unsolicited notifications such as `session/updated`).

### `host/status` → `{host, agents, sessionsActive, uptimeSeconds}`; `host/status/changed` notification
with the same shape whenever an agent's status changes.

### `agent/list` → `{agents}` (same objects as in `initialize`). `model/list {agentId}` → `{models:[{id, displayName, default}]}`.

### `fs/readDirectory {path}` → `{entries:[{name, kind:"dir"|"file", path}]}`; `project/list` →
`{projects:[{path, name, lastUsedAt, sessions}]}` (recent working folders, for the folder picker; capture P3).

## 5. Sessions, turns, items (the vocabulary adapters normalize to)

### 5.1 Objects

**SessionSummary**
```json
{"sessionId":"ses_01J…","agentId":"codex","title":"Create hello.txt and list files","cwd":"/Users/me/Desktop/phone-test",
 "status":"idle","createdAt":1760930000,"updatedAt":1760930400,"lastSeq":812,
 "pending":{"approvals":0,"inputs":0},"preview":"Done. Created hello.txt…"}
```
`status`: `idle` | `running` | `waiting_approval` | `waiting_input` | `error` | `closed`. (Codex:
`idle`, `active{activeFlags}`, `systemError`; Claude and Kimi map to the same five.)
Optional `lastTurnStatus` (a Turn `status`, below) is the status of the newest turn, absent while the
session has none; the list shows "finished", "interrupted" or "failed" from it without opening the session
(additive within v1).

**Session** = SessionSummary plus `settings` (`{model, approvalMode, sandbox, ...}` as the adapter reports them, opaque to the client except `model`).

**Turn**
```json
{"turnId":"trn_…","status":"inProgress","startedAt":1760930100,"completedAt":null,"error":null,"items":["itm_1","itm_2"]}
```
`status`: `inProgress` | `completed` | `interrupted` | `failed` (exactly Codex's `TurnStatus`). `error`:
`{code, message}` on failure.

**Item** (one of; every item has `itemId`, `type`, `turnId`, `status`: `inProgress` | `completed` | `failed` | `declined`)

| type | fields | Codex source | notes |
|---|---|---|---|
| `userMessage` | `content:[InputPart]`, `clientMessageId?` | `userMessage` | `clientMessageId` echoes the client's own id for Replica reconciliation |
| `agentMessage` | `text` | `agentMessage` | streamed via `item/delta` field `text` |
| `reasoning` | `summary`, `text?` | `reasoning` | streamed via `item/delta` fields `summary`, `text` |
| `command` | `command`, `cwd`, `output`, `exitCode?`, `durationMs?` | `commandExecution` | streamed via `item/delta` field `output` |
| `fileChange` | `changes:[{path, kind:"add"\|"modify"\|"delete", diff}]` | `fileChange` | streamed via `item/delta` field `patch` |
| `toolCall` | `tool`, `server?`, `arguments`, `result?`, `error?` | `mcpToolCall`, `dynamicToolCall`, `webSearch`, `imageView` | generic bucket |
| `plan` | `text` | `plan` | streamed via `item/delta` field `text` |
| `other` | `raw` | everything else | shown collapsed by the client |

**InputPart**: `{type:"text", text}` | `{type:"image", url}` (data URL or host-served `/v1/blob/<id>`) |
`{type:"mention", name, path}`. Mirrors Codex `UserInput`; `localImage`, `audio`, `skill` are out of v1.

### 5.2 Journal events (host to client notifications)

Every event below carries `sessionId` and `seq` (the Journal position, dense, starting at 1 per session).
Clients apply events in `seq` order and ignore any `seq <= lastApplied` (idempotent apply, ADR 0002).

| method | params beyond `sessionId, seq` | when |
|---|---|---|
| `session/changed` | `session` (full Session) | title, settings, cwd changed |
| `status/changed` | `status` | any session status transition |
| `turn/started` | `turn` | adapter reports a new turn |
| `turn/completed` | `turn` | status `completed`, `interrupted` or `failed` |
| `item/started` | `item`, `turnId` | item appears |
| `item/delta` | `itemId`, `turnId`, `field`, `delta` | streamed text; `field` is `text`, `summary`, `output` or `patch` |
| `item/completed` | `item`, `turnId` | item final state |
| `approval/request` | `request` (5.3) | agent needs a decision |
| `input/request` | `request` (5.3) | agent asks the user a question |
| `request/resolved` | `requestId`, `kind`, `resolvedBy`, `decision?`/`answers?` | someone answered (this client or another) |
| `usage/updated` | `usage:{inputTokens, outputTokens, contextPercent?}` | adapter reports usage (opt-out candidate) |
| `session/closed` | `reason` | session removed or archived |

Unsequenced notifications (not part of any Journal): `session/updated {summary}` for the session list,
`host/status/changed`.

Departure from Codex: Codex has 84 notification methods; the phone used 11 of them in the capture (P7). The
table above is the normalized set. Adapters may put anything else into `item.type: other`.

### 5.3 Approvals and questions

**approval/request** event, `request`:
```json
{"requestId":"req_…","kind":"command","sessionId":"ses_…","turnId":"trn_…","itemId":"itm_…",
 "createdAt":1760930150,"expiresAt":null,
 "command":"/bin/zsh -lc \"python3 -c …\"","cwd":"/Users/me/Desktop/phone-test",
 "reason":"May I create hello.txt in the current directory?",
 "availableDecisions":["accept","acceptForSession","decline","cancel"]}
```
`kind`: `command` (fields `command`, `cwd`, `reason`), `fileChange` (`changes`, `grantRoot?`, `reason`),
`permission` (`permissions`, `scope: "turn"|"session"`, `reason`). Decisions follow Codex: `accept`,
`acceptForSession`, `decline` (turn continues), `cancel` (turn is interrupted). Adapters that cannot offer
one of them omit it from `availableDecisions`; the client renders only what is listed.

**approval/resolve** request (client to host):
`{sessionId, requestId, decision}` → `{ok:true}` or error `already_resolved {resolvedBy}` or `not_found`.

**input/request** event, `request`: `{requestId, kind:"input", sessionId, turnId, itemId, isBlocking,
questions:[{id, header, question, options:[{label, description}]?, isOther, isSecret}]}` (Codex
`item/tool/requestUserInput`; Claude `AskUserQuestion` maps onto it).

**input/answer** request: `{sessionId, requestId, answers:{<questionId>:[string]}}` → `{ok:true}` or the same errors.

Rules:
- A pending request is **state**: it stays in the Journal and in the session's `pending` counters until
  resolved. `session/open` returns all pending requests in `pending` (section 6), which is the replay
  behavior observed in the capture (N3) done through the Journal.
- First resolution wins; the host broadcasts `request/resolved` to every subscribed stream and other clients
  drop their prompt (capture P6).
- If the agent withdraws a request (turn interrupted or failed), the host emits `request/resolved` with
  `resolvedBy: "agent"` and `decision: "cancel"`.

## 6. Opening a session, catching up, paging history

### `session/list {agentId?, cursor?, limit?}` → `{sessions:[SessionSummary], nextCursor?}`
Sorted by `updatedAt` descending. Default limit 50.

### `session/start {agentId, cwd, title?, settings?, input?}` → `{session}`
Creates the session (Codex `thread/start`). If `input` is given, the host also starts the first turn and
returns `{session, turn}` so a new chat is one round trip. The host may generate a title from the first
input (the Codex phone does this with a hidden side thread, capture P4; the host does it instead).

### `session/open {sessionId, cursor?, turns?}` → snapshot or events, plus subscription
This is the one call the Replica needs on open or reconnect. The host subscribes the stream to the
session's events and answers in one of two modes:

1. **Events mode**, when `cursor` is given and the Journal still holds everything after it:
   `{mode:"events", session, events:[…], cursor, pending}`. `events` are the same objects as live
   notifications (method and params), in `seq` order, from `cursor + 1` to the current head. The client
   applies them to its Replica exactly as it would apply live events.
2. **Snapshot mode**, when there is no cursor, or the cursor is older than the Journal keeps
   (`cursor_expired` is not an error here, just a mode switch):
   `{mode:"snapshot", session, turns:[Turn with items inlined], olderCursor?, cursor, pending}`.
   `turns` holds the last `turns` turns (default 5, the Codex desktop's `initialTurnsPage` limit), newest
   last, every item in full, at most 100 items per turn (`itemsTruncated: true` when cut; the rest via
   `session/history`). `cursor` is the Journal head at snapshot time: the client stores it and from
   then on applies live events whose `seq` is greater.

Both modes return `pending: {approvals:[request], inputs:[request]}`.

Live events for a session are delivered only after the `session/open` response on that stream, in `seq`
order, with no gap between the response's `cursor` and the first live event. (The desktop buffers live
notifications during resume for the same reason, local-link report 20; here the host does it.)

### `events/since {sessionId, cursor, limit?, includeOptedOut?}` → `{events, cursor, complete}`
Standalone catch-up for a session already open on this stream (for example after the client suspects it
dropped events, or to page a long gap in slices). `complete: false` means more remain. Error
`cursor_expired` when the Journal no longer holds `cursor + 1`; the client then re-opens in snapshot mode.

### `session/history {sessionId, before, limit?}` → `{turns, olderCursor?}`
Pages older turns, newest first, starting before the opaque `before` cursor returned by a snapshot or a
previous page. Items are inlined in full. (Codex: `thread/turns/list` + `thread/items/list`.)

### `session/close {sessionId}` → `{ok:true}` unsubscribes the stream. Closing the socket unsubscribes everything.

### `session/archive`, `session/delete`, `session/rename {sessionId, title}` → `{ok:true}`; each emits `session/changed` or `session/closed`.

Journal retention: the host keeps every event of a session on disk; `cursor_expired` happens only when the
host has compacted old events into a snapshot (an implementation choice; v1 hosts may never compact).

## 7. Driving a turn

### `turn/start {sessionId, input:[InputPart], clientMessageId}` → `{turn}`
- `clientMessageId` is a client-generated UUID. The resulting `userMessage` item echoes it, so a Replica
  that showed the message as "sending" matches it by id rather than by position. If the same
  `clientMessageId` arrives twice (client retried after an uncertain delivery), the host returns the
  existing turn instead of starting another. This replaces envelope replay (capture: Codex reconciles lost
  `turn/start` by `clientUserMessageId`, local-link report 23).
- If a turn is already running: error `session_busy {turnId}`; the client offers steer instead.
- One writer per session is enforced by the host, not the client (local-link report 26, 32).

### `turn/steer {sessionId, turnId, input, clientMessageId}` → `{turn}`
Adds input to the running turn (`turnId` must be the running one, else `turn_mismatch`). Adapters that cannot
steer (Kimi, possibly) answer `not_supported`; the client then queues the message for after completion.

### `turn/interrupt {sessionId, turnId}` → `{ok:true}`
The turn ends with `turn/completed {status:"interrupted"}`. Idempotent: interrupting a finished turn is `ok`.

### `turn/diff {sessionId, turnId}` → `{files:[{path, kind, diff}]}`
The net change of a turn, for the diff view. Adapters may compute it from `fileChange` items.

## 8. Pairing and devices (HTTPS, before a stream exists)

Pairing is the only part of the protocol that runs over plain HTTPS endpoints rather than the stream,
because the device has no token yet.

1. The host shows a QR encoding `https://<host>.<tailnet>.ts.net:<port>/pair#code=<8 digits>` plus the
   code in text (the Codex host shows both a QR and a manual code; README item 9). A code lives 5 minutes
   and is single-use.
2. The phone opens that URL (it is the web app itself, served by the host), which calls
   `POST /v1/pair {code, client:{name, platform, userAgent}}`.
3. The host answers `{clientId, deviceToken, host:{hostId, name}}` and sets the `nano_device` cookie.
   The token is a 256-bit random value stored hashed on the host; the client keeps it in the cookie
   (browser) or its keychain (native).
4. From now on the client opens streams as in section 1.

Over the stream: `device/list` → `{devices:[{clientId, displayName, platform, createdAt, lastSeenAt, current}]}`;
`device/revoke {clientId}` → `{ok:true}`; the revoked device's streams close with 4003. `device/rename`.
The host CLI can also list and revoke (for a lost phone). These are the Codex `remoteControl/client/*` calls.

The security pass before Phase 1 (todo item 10) owns code lifetime, token storage and tailnet-only binding.

## 9. Web Push (ADR 0005)

- `push/subscribe {subscription}` stores the browser's `PushSubscription` JSON for this `clientId`;
  `push/unsubscribe` removes it; `push/test` sends one. The VAPID public key comes from `initialize`.
- Payload: `{title, body, url}` only; `url` deep-links to the session. Never session content beyond a one-line title.
- Rules, copied from the captured behavior (runtime-capture N1 to N3):

| Event | Push sent when |
|---|---|
| `turn/completed` (any final status) | the client has **no open stream** at that moment |
| `approval/request`, `input/request` | **always**, even while connected (iOS closes the socket about 30 s after lock; the push covers the gap) |
| `request/resolved` by another device | never; the open stream gets the event |
| `status/changed` to `error` | the client has no open stream |

- Pending requests are replayed through `session/open` (`pending`), so a push that is tapped late still lands on a live prompt or on the resolved state.
- Pushes are per client; every paired device with a subscription is evaluated separately.

## 10. Error codes

| code | meaning | typical client action |
|---|---|---|
| `not_initialized` | request before `initialize` | send `initialize` |
| `unsupported_protocol` | `protocolVersion` mismatch | show "update the host" or "update the app" |
| `unauthorized` | device revoked mid-stream | return to pairing |
| `invalid_params` | shape or value error (`data.path`) | bug; log |
| `method_not_found` | unknown method | bug; log |
| `not_found` | session, turn, request, device unknown | refresh list |
| `session_busy` | a turn is running (`data.turnId`) | offer steer |
| `turn_mismatch` | `turnId` is not the running turn | refresh |
| `already_resolved` | request answered (`data.resolvedBy`) | dismiss prompt |
| `cursor_expired` | Journal no longer holds the cursor | re-open in snapshot mode |
| `agent_unavailable` | adapter down (`data.agentId`, `data.reason`) | show agent state |
| `not_supported` | adapter lacks the operation (steer, diff) | hide the control |
| `rate_limited` | too many requests (`data.retryAfterMs`) | back off |
| `internal` | host bug | retry once, then report |

WebSocket close codes used by the host: 4001 unsupported protocol version, 4002 sequence gap, 4003
unauthorized or revoked, 4008 ping timeout, 4009 message too large, 4010 host draining.

## 11. Adapter mapping (what each agent must provide)

The host has one adapter per agent; each produces the section 5 vocabulary. The Codex column is verified
by the capture and the host-drive spike, the Claude Code column by the spike, except cells marked
"unverified", "not probed" or "did not occur". The Kimi column is still unverified.

| Protocol | Codex (app-server over stdio, verified by capture and spike) | Claude Code (Agent SDK, verified by spike) | Kimi (CLI stream-json, unverified) |
|---|---|---|---|
| `session/start` | `thread/start` | `query()` with a new session | spawn CLI with cwd |
| `session/open` snapshot | `thread/read` + `thread/resume {initialTurnsPage}` | `resume: sessionId` + host Journal | host Journal only |
| `turn/start` | `turn/start {clientUserMessageId}` | send user message on the query stream | write prompt to stdin or new invocation |
| `turn/steer` | `turn/steer {expectedTurnId}` | queued input (unverified) | `not_supported` likely |
| `turn/interrupt` | `turn/interrupt` | `query.interrupt()` | SIGINT |
| `item/*` | `item/started`, `item/*/delta`, `item/completed` | stream message blocks and tool_use/tool_result | stream-json events |
| `approval/request` command | `item/commandExecution/requestApproval` | `canUseTool` fires for Bash (`input.command`) | unknown; may need `--yolo` off and prompt parsing |
| `approval/request` fileChange | `item/fileChange/requestApproval` (did not occur in the spike) | `canUseTool` fires for Write (observed) and Edit (same callback, not probed separately) | unknown |
| `input/request` | `item/tool/requestUserInput` | `canUseTool` fires for `AskUserQuestion`; answers are keyed by question text | unknown |
| `status/changed` | `thread/status/changed` | derived from stream state | derived |
| `usage/updated` | `thread/tokenUsage/updated` | result message usage | unknown |

The Claude Code approvals and questions reach `canUseTool` only when the adapter passes
`permissionMode: "default"` and `settingSources: []`. With the user's own settings loaded, auto mode
approves Bash and Write silently and a deny rule hides `AskUserQuestion` from the model, so the adapter
must not inherit them. The evidence for this column and for the Codex resume path is
`spikes/host-drive/NOTES.md` with its logs in `spikes/host-drive/logs/`. For the captured command
approval, Codex offered only `accept` and `cancel` (plus an object-valued amendment decision the adapter
drops), so adapters forward the engine's `availableDecisions` list instead of assuming all four decisions.

Engine churn note: the Codex engine is an alpha; the adapter is the only file that knows its method names.
The schema in `docs/research/rea/codex-app-server-schema/` is regenerated when the bundled engine updates.

## 12. Versioning

- `protocolVersion` is an integer. v1 may add optional fields, new methods and new `item.type` values
  without bumping; clients ignore what they do not know. Removing or renaming anything bumps to v2.
- The host advertises the versions it accepts in the 4001 close reason; the web app is served by the host,
  so in practice they are always in step. A native client must check `protocolVersion` in `initialize`.

## 13. Walkthroughs (the captured phone session, rewritten in this protocol)

**New chat from the phone (capture P1 to P7)**
1. socket open with cookie → `ping {state: foreground}` → `pong {status: active}`
2. `initialize` → result with agents
3. `session/list` → render list from Replica, then reconcile
4. user picks a folder: `project/list`, `fs/readDirectory`
5. `session/start {agentId:"codex", cwd, input:[{type:"text", text:"Create a file named hello.txt…"}]}` → `{session, turn}`
6. events: `turn/started`, `item/started userMessage` (with `clientMessageId`), `item/started agentMessage`, 752 × `item/delta`, `item/started command`, `approval/request kind:command`, `status/changed waiting_approval`
7. push arrives too (approval rule); user taps Allow: `approval/resolve {decision:"accept"}` → `{ok}`; event `request/resolved`
8. `item/delta output`, `item/completed command`, …, `turn/completed {status:"completed"}`, `status/changed idle`

**Lock and reopen (capture P8, N5)**
1. iOS closes the socket about 30 s after lock (the host sees the close, no `client_closed` needed).
2. On reopen: new socket, new `stream_id`, `ping`, `initialize`.
3. `session/open {sessionId, cursor: 812}` → `mode: events` with everything after 812, or `mode: snapshot` if too old.
4. The Replica rendered instantly from local storage; it now applies the events and resumes live.

**Interrupt (capture P9)**: `turn/start` → … → `turn/interrupt {sessionId, turnId}` → `turn/completed {status:"interrupted"}`.

**Completion while away (capture N1)**: socket closed → `turn/completed` journaled → no open stream for the client → push `{title:"Codex finished", body:<session title>, url}` → tap → open → `session/open` catches up.

## 14. Decisions settled by the captures

These three points were first drafted as open questions. The research already answers them, so they are
recorded as decisions with their evidence.

1. **Snapshot size: last 5 turns, items in full, at most 100 items per turn.** The Codex desktop resumes a
   thread with `initialTurnsPage:{limit:5, itemsView:'full'}` and caps items at 100 per page (local-link
   report 18 and 22); the phone follows the same recipe (capture P8). A turn with more than 100 items is
   returned with its newest 100 and `itemsTruncated: true`; the rest come from `session/history`.
2. **No delta coalescing in v1.** The phone received every one of the 752 message deltas live (capture P7),
   and no vendor app batches stream deltas (the desktop coalesces only identical read-only requests,
   local-link report 15; Odysseus streams raw SSE deltas and replays the buffer on reconnect, behaviors 65
   and 67). The socket closes about 30 s after lock anyway (N5), so a backgrounded phone receives little.
   Coalescing stays a possible later optimization, not a v1 feature.
3. **`permission` approval kind stays, rendered generically.** The engine can send
   `item/permissions/requestApproval` (README item 24), but the phone never received one in the capture and
   the iOS strings carry only the generic "Approval required" and "Allow" vocabulary (README item 23).
   So the kind is in the schema, the Codex adapter may emit it, and the client shows it as allow or deny
   with the reason text.
