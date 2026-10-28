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
| Client to host | `initialize`, `session/*`, `turn/*`, `events/since`, `approval/resolve`, `input/answer`, `agent/list`, `model/list`, `fs/readDirectory`, `fs/readFile`, `push/*`, `device/*`, `host/status`, `host/settings/update`, `provider/*` (section 15) | `initialized` |
| Host to client | none in v1 (see 5.3 for why) | every Journal event (section 5), `session/updated`, `host/status/changed`, `provider/delta`, `provider/usage`, `provider/done` (section 15) |

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
  "agents":[{"id":"codex","name":"Codex","status":"ready","version":"0.163.0",
             "capabilities":{"steer":true,"diff":true,"approvalModes":["untrusted","on-failure","on-request","never"]}},
            {"id":"claude","name":"Claude Code","status":"ready",
             "capabilities":{"steer":false,"diff":true,"approvalModes":["default","acceptEdits","plan","never"]}},
            {"id":"kimi","name":"Kimi","status":"unavailable","reason":"CLI not found"}],
  "push":{"vapidPublicKey":"BOr…","subscribed":true},
  "limits":{"maxMessageBytes":16777216,"snapshotTurns":5,"maxAttachmentBytes":20971520,"maxFileReadBytes":1048576},
  "files":{"read":true}
}}
```
- `optOutNotifications` is the Codex relay's `optOutNotificationMethods` idea (capture item 12): the client
  names event methods it does not want on this stream to save mobile bandwidth. Opted-out events are still
  journaled and still returned by `events/since` when asked with `includeOptedOut: true`.
- `limits.maxAttachmentBytes` (additive within v1) is the largest attachment `POST /v1/blob` accepts
  (section 8.1); a host without it takes no attachments, and clients show no attach button.
- `files {read, write?}` and `limits.maxFileReadBytes` (additive within v1) say what a client may do with
  the files of a session folder (section 4.1): `read` true when `fs/readFile`, `fs/readDirectory` with a
  `sessionId` and `GET /v1/file` work; `maxFileReadBytes` is the most one `fs/readFile` answer carries
  (1 MiB, 1 048 576 bytes). `write` is reserved for a later write method; absent means false. A host
  without `files`, or with `read` false, offers none of this: clients show no file viewer and no Files page.
- Until `initialize` succeeds the host answers every other request with `not_initialized`.
- The client then sends the `initialized` notification (mirrors Codex; the host uses it to start sending
  unsolicited notifications such as `session/updated`).

### `host/status` → `{host, agents, sessionsActive, uptimeSeconds, keepAwake?}`; `host/status/changed` notification
with the same shape whenever an agent's status or `keepAwake` changes.

`keepAwake {setting, active, onBattery}` (additive within v1) says whether the host keeps its computer awake
so a phone away from home can still reach it (a sleeping computer drops off the tailnet). `setting` is
`pluggedIn` (the default) or `off`. With `pluggedIn` the host holds a system-sleep assertion that the OS
honours on AC power only (macOS: `caffeinate -s -w <host pid>`, restarted if it dies, ended with the host);
the display may still sleep, and a Mac with its lid closed and no external display sleeps anyway. `active`
is true only while the assertion is held and the computer is on AC power; `onBattery` is the power source the
host last read (it polls lightly). A host that sends no `keepAwake` cannot do this: clients show no control.

### `host/settings/update {keepAwake?}` → `{keepAwake}` (additive within v1)
Changes host settings from a paired device, at least one per request. `keepAwake` is a `setting` value; the
host writes it to its config file (atomically, keeping the previous file as `.bak`), applies it without a
restart, answers with the new `keepAwake` status and sends `host/status/changed` to every stream. An unknown
value is `invalid_params`.

### `agent/list` → `{agents}` (same objects as in `initialize`).
`capabilities` (additive within v1) is what the agent supports, fixed per agent: `steer` (`turn/steer` works),
`diff` (`turn/diff` works; a host that computes diffs from git, section 7, declares it for every agent) and `approvalModes` (the `settings.approvalMode` values it honours, section 5.1;
empty when it honours none). Clients show only the controls an agent supports: say up front that input waits
while a turn runs when `steer` is false, no Changes view when `diff` is false, "Bypass approvals" only when
`approvalModes` contains `never`. The host answers `not_supported` for `turn/steer` and `turn/diff` without
starting the agent. A host that sends no `capabilities` is older: clients then offer every control and learn
from `not_supported`.
`capabilities.attachments {images, files}` (additive within v1) says how the agent takes attachments
(section 8.1): `images` true when image parts reach it as images it can see (its native image input),
`files` true when it accepts file parts (it gets the file's path). An agent with `images` false still takes
image parts: the host hands them over as files. Clients offer attaching only when `attachments` is present
and at least one of the two is true.
`capabilities.backgroundTasks` (additive within v1) is true when the agent reports its background tasks in
`Session.backgroundTasks` and marks messages that wait behind them `queued` (section 5.1). Claude Code
declares it; Codex and Pi declare false. Absent means false.
`capabilities.settingsUpdate` (additive within v1) lists the settings `session/settings/update` (section 6)
can change in an open session: `model`, `effort`, `approvalMode` (additive within v1), or any of them.
Codex and Claude Code declare all three; Pi declares `model` and `effort` (it honours no `approvalMode`).
Absent or empty means none: clients then offer no way to change them after `session/start`.

### `model/list {agentId}` → `{models:[{id, displayName, default, provider?, efforts?, defaultEffort?}]}`.
`provider` (additive within v1) names the provider that serves the model, for agents that reach many: pi
lists every model it has credentials for, with ids of the form `provider/model` (pi's own `--model` form,
for example `llamacpp/bonsai-27b`) and `provider` set (`llamacpp`). `session/start` with that id in
`settings.model` starts the session on it. Agents with one provider leave `provider` out.

`efforts` and `defaultEffort` (additive within v1) say how hard the model can be told to think (reasoning
effort, thinking level): `efforts` lists the `settings.effort` values it honours, lowest first, in the
engine's own names; `defaultEffort` is the level it runs at when `session/start` names none. They sit on the
model, not on `Agent.capabilities`, because every engine reports them per model and they differ between
models of one agent (Codex `model/list` `supportedReasoningEfforts` and `defaultReasoningEffort`; Claude
`supportedModels()` `supportedEffortLevels`, where an older model lacks `xhigh` and some have none; pi's
per-model thinking levels). A model without effort control has no `efforts`, and clients then show no
effort picker. `defaultEffort` is absent when the engine does not report a default: Claude Code does not
(its defaults live in its documentation), and clients then preselect no level and leave the choice to the
agent. Values per agent:
- Codex: the model's `supportedReasoningEfforts` (for example `none`, `low`, `high`, `max`) and its
  `defaultReasoningEffort`.
- Claude Code: `low` | `medium` | `high` | `xhigh` | `max`, as far as the model supports them; no
  `defaultEffort`.
- pi: `off` | `minimal` | `low` | `medium` | `high` | `xhigh` | `max`, the levels pi offers for the model
  (computed as pi does from the model's `reasoning` and `thinkingLevelMap`); a model without reasoning has
  no `efforts`. `defaultEffort` is pi's current level fitted to the model the way pi fits it on a model
  switch.

### `fs/readDirectory {path, sessionId?}` → `{entries:[{name, kind:"dir"|"file", path, size?, mtimeMs?, hidden?}]}`; `project/list` →
`{projects:[{path, name, lastUsedAt, sessions}]}` (recent working folders, for the folder picker; capture P3).
Without `sessionId`, `path` is absolute or starts with `~`, and entries carry absolute paths: the folder
picker of a new session. With `sessionId` (additive within v1) the listing is scoped to that session's
folder; see section 4.1.

### 4.1 Session files (additive within v1)

A client can read the files of a session's folder (the session's `cwd`): text through the stream, any file
through plain HTTPS. There is no write method. Every paired device can already see every session and ask
its agent to print any file, so this adds no reach; the rules below keep it inside the session folder.

**Scope.** A path is relative to the session folder; `''` and `.` name the folder itself. An absolute path
is accepted only when it resolves inside the folder. The host resolves the path with `realpath` and
requires the result to be the `realpath` of the session folder or below it. `..` that leaves the folder, an
absolute path elsewhere, a symlink (or a chain of them) pointing out of the folder, a symlink loop, a
missing file and an unreadable one all answer the same `not_found` (`data.path` is the path as sent), with
nothing that says whether or what exists outside. A symlink that stays inside is followed. An unknown or
deleted session is `not_found`; a deleted session's folder is never readable through the host. Archived
sessions stay readable. Hidden files such as `.env` are readable (the agent can read them too); clients
hide dot-files in listings by default. A path naming a folder, or anything but a regular file (a FIFO, a
socket), is `invalid_params` for a read.

**`fs/readFile {sessionId, path, offset?, maxBytes?}`** → `{path, size, mtimeMs, mediaType, binary,
encoding:"utf8"|"none", content?, offset, length, truncated}`.
- `path` in the answer is the file's path inside the folder after resolving links, `/`-separated. `size`
  is in bytes, `mtimeMs` the last modification in Unix milliseconds.
- **Binary.** A NUL byte or invalid UTF-8 in the first 8 KiB (a character cut by the 8 KiB mark does not
  count) makes the file binary: `binary` true, `encoding` `none`, no `content`, `offset` 0, `length` 0,
  `truncated` false. A client shows such a file through `GET /v1/file`.
- **`mediaType`** comes from the first bytes for PNG, JPEG, GIF, WebP and PDF, otherwise from the
  extension (`text/markdown`, `application/json`, `text/x-typescript`, …), otherwise `text/plain` for text
  and `application/octet-stream` for binary.
- **Ranges.** A text answer carries bytes `[offset, offset + length)` of the file as `content`. `maxBytes`
  defaults to 262 144 (256 KiB); the host reads at least 4 096 and at most `limits.maxFileReadBytes`.
  `offset` (default 0, bytes) moves back to the start of its line when that start is at most 1 024 bytes
  earlier, otherwise back to the start of its UTF-8 character; the answer's `offset` is where `content`
  really starts. An answer that stops before the end of the file ends right after its last newline when it
  holds one, otherwise at a character boundary, so it never splits a line it could keep whole or a UTF-8
  character. `truncated` is true when the file goes on; the next part is `offset = offset + length` of the
  previous answer, and each answer makes progress. An `offset` past the end is `invalid_params`
  (`data.path` `params.offset`). Invalid UTF-8 after the first 8 KiB arrives as U+FFFD.

**`fs/readDirectory {path, sessionId}`**: `path` relative to the session folder under the scope rule;
entries carry paths relative to the folder (`src/parser.ts`), `size` (files only), `mtimeMs` and `hidden`
(the name starts with a dot). Folders first, then files, by name. A symlink is listed as what it points to,
and only when that is inside the folder; links out of it, broken links and sockets are left out.

**`GET /v1/file?sessionId=<id>&path=<path>`** (and `HEAD`) returns a file's bytes, for images, PDFs and
other files that should not travel over the stream as base64.
- Authenticated exactly like `/v1/blob` (section 8.1): the `nano_device` cookie, or a bearer token from a
  client that sends no `Origin`; a request from another origin is refused.
- The same headers as `/v1/blob`: `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
  default-src 'none'; sandbox`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`, and `Content-Disposition: attachment` for anything but
  raster images (JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF), which are `inline`. `Content-Type` is the
  `mediaType` above, with `; charset=utf-8` for text.
- Because session files change: `ETag` (a strong validator from size and modification time),
  `Last-Modified`, `Cache-Control: private, no-cache`; a request whose `If-None-Match` names the current
  `ETag` answers 304. `Accept-Ranges: bytes`: one `Range: bytes=a-b`, `a-` or `-n` answers 206 with
  `Content-Range`; a range that starts past the end answers 416 (`Content-Range: bytes */<size>`); a
  malformed range or several ranges get the whole file (200); `If-Range` with another `ETag` gets the whole
  file.
- Limit: files up to 20 MiB (20 971 520 bytes, as attachments).
- Failures answer `{error:{code, message, data?}}`: 401 `unauthorized` (no token, unknown or revoked), 403
  `unauthorized` (foreign origin), 400 `invalid_params` (`data.path` `sessionId`, `path`), 404 `not_found`
  (unknown or deleted session; a path outside the folder or missing), 405 (another method), 413
  `invalid_params` (`data.maxBytes`), 416 `invalid_params` (`data.path` `range`).

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

Optional `backgroundTasks` (additive within v1, on the summary and therefore on Session) lists the helpers
the agent runs beside its turns (background subagents, background commands, monitors):
`[{id, title, status, startedAt, endedAt?, lastActivity?}]`. `status` is `running`, `finished`,
`cancelled` or `failed`; `startedAt` and `endedAt` are Unix seconds; `title` is the one line the agent gave
the helper; `lastActivity` is the latest progress line it reported, if any. The list holds the running
helpers plus those that ended since the newest turn started: a turn starting (a user's or the engine's own)
drops the ended ones. The host reports changes with `session/changed` and puts the list in every summary it
hands out (`session/list`, `session/updated`, `session/open`); with none, or for an agent whose
`capabilities.backgroundTasks` is false, the field is absent. It is live state: after a host restart no
session lists any (the engines are gone), and archiving or deleting a session ends its running helpers as
`cancelled`. Stopping a turn (`turn/interrupt`) cancels them too: Claude Code ends its background
subagents on interrupt, and they are then listed `cancelled`. Clients ask before Stop while any runs.
Every end is journaled, so a client replaying the Journal never keeps a helper running: a host shutdown
journals the running ones `cancelled` before the engines stop, an engine that dies ends them `failed`, and
on start the host journals a `session/changed` listing as `cancelled` the helpers that the session's last
journaled list still showed running (a host that died without shutting down). Clients drop an ended helper
60 s after its `endedAt` even while the turn goes on, count only running ones in badges, and show none as
running while the session's `status` is `error` (its agent stopped; `idle` is not enough, since helpers run
between turns).

**Session** = SessionSummary plus `settings` (`{model, approvalMode, sandbox, ...}` as the adapter reports them, opaque to the client except `model`, `approvalMode` and `effort`).
`approvalMode` (additive within v1) may be set in `session/start` settings and is reported back as in effect.
Its values come from the agent's `capabilities.approvalModes` (section 4); the host stores and reports an
`approvalMode` only when the agent honours that value, so a session never claims a mode its agent ignores.
Codex values: `untrusted` | `on-failure` | `on-request` | `never`; unknown values fall back to the host's default
(`on-request`). `never` bypasses all approvals and, unless `settings.sandbox` names a sandbox, runs with
`danger-full-access`; clients mark such a session ("Bypass").
Claude Code: `never` runs the session in Claude's permission mode `bypassPermissions` (no approvals, full
access to what the Mac user can reach) and is reported back as `never`, so clients mark it the same way;
`acceptEdits` and `plan` pass through as the Claude modes of those names; any other value is Claude's
`default` mode, reported as `default`.
Pi honours no `approvalMode` (`approvalModes` is empty): it always asks through Nano's approval extension
(section 11), and a Pi session reports no `approvalMode`.
An open session changes its `approvalMode` with `session/settings/update` (section 6).

`effort` (additive within v1) may be set in `session/start` settings to one of the model's `efforts`
(section 4 `model/list`) and is reported back as in effect: the level the engine runs at after any
downgrade it makes for the model, or absent when none is (a model without effort control). The adapter's
report is authoritative for this key, so a session never claims a level its model ignores. An open session
changes it, and its `model`, with `session/settings/update` (section 6).
- Codex: sent as the thread's `model_reasoning_effort` config on `thread/start` and `thread/resume` and as
  `effort` on every `turn/start`; reported as the `reasoningEffort` the thread answers with (also when
  `session/start` named none: the engine's configured default). Codex does not downgrade a level its model
  lacks.
- Claude Code: sent as the SDK's `effort` option, after the host fits it to the model's
  `supportedEffortLevels` the way Claude Code does (the highest supported level not above the requested one,
  else the lowest); left out for a model without effort control. Reported only when sent: the engine does
  not report its default level.
- pi: `set_thinking_level` after the model is set, then reported as the `thinkingLevel` of `get_state` (pi
  fits the level to the model itself). A value pi does not know is not sent.

**Turn**
```json
{"turnId":"trn_…","status":"inProgress","startedAt":1760930100,"completedAt":null,"error":null,"items":["itm_1","itm_2"]}
```
`status`: `inProgress` | `completed` | `interrupted` | `failed` (exactly Codex's `TurnStatus`). `error`:
`{code, message}` on failure.

**Item** (one of; every item has `itemId`, `type`, `turnId`, `status`: `inProgress` | `completed` | `failed` | `declined`)

| type | fields | Codex source | notes |
|---|---|---|---|
| `userMessage` | `content:[InputPart]`, `clientMessageId?`, `queued?` | `userMessage` | `clientMessageId` echoes the client's own id for Replica reconciliation; `queued: true` (additive within v1) while the message waits in the engine behind running background tasks: once the engine takes it (or its turn ends) the host journals `item/completed` for the same item without the flag |
| `agentMessage` | `text` | `agentMessage` | streamed via `item/delta` field `text` |
| `reasoning` | `summary`, `text?` | `reasoning` | streamed via `item/delta` fields `summary`, `text` |
| `command` | `command`, `cwd`, `output`, `exitCode?`, `durationMs?` | `commandExecution` | streamed via `item/delta` field `output` |
| `fileChange` | `changes:[{path, kind:"add"\|"modify"\|"delete", diff}]` | `fileChange` | streamed via `item/delta` field `patch` |
| `toolCall` | `tool`, `server?`, `arguments`, `result?`, `error?` | `mcpToolCall`, `dynamicToolCall`, `webSearch`, `imageView` | generic bucket |
| `plan` | `text` | `plan` | streamed via `item/delta` field `text` |
| `other` | `raw` | everything else | shown collapsed by the client |

**InputPart**: `{type:"text", text}` | `{type:"image", url}` (data URL or host-served `/v1/blob/<id>`) |
`{type:"mention", name, path}` | `{type:"file", url, name, mediaType}` (additive within v1: an attachment
uploaded with `POST /v1/blob`, section 8.1; `url` is `/v1/blob/<id>`, `name` and `mediaType` as the upload
answered). Mirrors Codex `UserInput`; `localImage`, `audio`, `skill` are out of v1.

### 5.2 Journal events (host to client notifications)

Every event below carries `sessionId` and `seq` (the Journal position, dense, starting at 1 per session).
Clients apply events in `seq` order and ignore any `seq <= lastApplied` (idempotent apply, ADR 0002).

| method | params beyond `sessionId, seq` | when |
|---|---|---|
| `session/changed` | `session` (full Session) | title, settings, cwd or background tasks changed |
| `status/changed` | `status` | any session status transition |
| `turn/started` | `turn` | adapter reports a new turn (after a `turn/start`, or an engine-initiated turn, below) |
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

Engine-initiated turns (additive within v1): an engine may start a turn by itself, without a
`turn/start`; Claude Code does when a background task reports in (a Monitor event, a background Bash
command or subagent finishing). The host journals it like any turn (`turn/started`, `status/changed
running`, items, `turn/completed`), except that it has no `userMessage` item of its own. Clients show it
like any other turn. The Claude adapter shows the notification that woke the engine as a finished
`toolCall` item whose `tool` is `background task: <summary>`.

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
questions:[{id, header, question, options:[{label, description}]?, isOther, isSecret, multiSelect?}]}` (Codex
`item/tool/requestUserInput`; Claude `AskUserQuestion` maps onto it). `multiSelect: true` lets the user pick
several options (Claude `AskUserQuestion` `multiSelect`); absent or false means pick one. `isOther` adds a
free-text answer, `isSecret` masks typed text. Each answer is a list of the picked option labels plus any
free text.

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

### `session/list {agentId?, cursor?, limit?, archived?}` → `{sessions:[SessionSummary], nextCursor?}`
Sorted by `updatedAt` descending. Default limit 50. Archived sessions are left out; `archived: true` lists
only them instead (additive within v1). An archived session's summary carries `archived: true` (in
`session/list`, `session/updated` and `session/open`); the field is absent otherwise.

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

### `session/unarchive {sessionId}` → `{ok:true}` (additive within v1)
Brings an archived session back: the flag clears and its status becomes `idle` (journaled as
`status/changed`), so `session/updated` moves the row back to the list. A session that is not archived
answers `{ok:true}` and nothing changes. Starting a turn in an archived session unarchives it as well.

### `session/settings/update {sessionId, settings:{model?, effort?, approvalMode?}}` → `{session, appliesAt?}` (additive within v1)
Changes the model, the effort or the approval mode of an open session. Each key given must be in the agent's
`capabilities.settingsUpdate` (section 4); otherwise the host answers `not_supported` with a plain message
(for example "Pi cannot change the approvalMode of an open session") and changes nothing. A `model` the
agent's `model/list` does not offer is `invalid_params` at `params.settings.model`; an `approvalMode` that is
not in the agent's `capabilities.approvalModes` is `invalid_params` at `params.settings.approvalMode`. A key
left out keeps its value.

The host journals `session/changed` with the new `settings` at once and answers with that session, so
`Session.settings` shows what the next turn runs with. `model` and `effort` apply from the next turn: when a
turn is running, it finishes on the model and effort it started with, and the new settings apply when that
turn ends (clients say "Applies after this turn").
`approvalMode` (additive within v1) applies from the next turn at the latest. While a turn runs the host
applies it at once where the engine can change it on a live session, so approvals the running turn asks
for from then on follow the new mode; otherwise the running turn keeps the mode it started with. A request
already waiting for the user stays open either way. `appliesAt` (additive within v1) says which: `now` when
the engine took every change at once, `nextTurn` when something waits for the next turn start (always for
`model` and `effort`). A host that sends no `appliesAt` is older: clients assume `nextTurn`. Changing
`approvalMode` also drops a `sandbox` the session reported, so the agent derives it from the new mode again
(Codex: `never` runs with `danger-full-access`, any other mode with the host's configured sandbox). After the engine took the change, the host reports the
settings in effect as usual (section 5.1): an effort the new model lacks is reported as the engine fitted
it. The settings live in the session record, so a host restart or a resumed engine session keeps them.
Per agent (section 11):
- Codex: the new `model` and `effort` go out on the next `turn/start` (its fields "for this turn and
  subsequent turns") and with every later turn; a resumed thread gets them on `thread/resume` as well. A new
  `approvalMode` goes out the same way, as `turn/start` `approvalPolicy` and `sandboxPolicy` (both "for this
  turn and subsequent turns"; app-server has no call that changes a running turn's policy, and
  `thread/settings/update` also acts on subsequent turns only), so it answers `appliesAt: "nextTurn"`.
- Claude Code: `Query.setModel(model)` and `Query.applyFlagSettings({effortLevel})` on the running query
  before the next user message (both work mid-session in streaming-input mode, SDK 0.3.308); when no query
  runs, the next one starts with them (`options.model`, `options.effort`, `resume`). A new `approvalMode`
  goes to a live query at once as `Query.setPermissionMode(<mapped mode>)` (section 5.1 mapping), also
  during a turn, and answers `appliesAt: "now"`. Claude Code switches into `bypassPermissions` only in a
  session launched with bypass available, so every query starts with `allowDangerouslySkipPermissions`
  (`--allow-dangerously-skip-permissions`: makes the mode available without entering it; the session runs
  in the mode it asked for). Without a live query, or when the call fails, the next query or the next turn
  start applies it (`nextTurn`); if the engine still refuses it, the session reports the mode in effect.
- Pi: `set_model {provider, modelId}` and `set_thinking_level {level}` on the live pi process before the
  next `prompt`, then `get_state` for what is in effect; a new pi process gets them at start.

`session/delete` also deletes the session's attachments (section 8.1) from the host's disk; their
`/v1/blob` URLs answer 404 from then on.

Journal retention: the host keeps every event of a session on disk; `cursor_expired` happens only when the
host has compacted old events into a snapshot (an implementation choice; v1 hosts may never compact).

## 7. Driving a turn

### `turn/start {sessionId, input:[InputPart], clientMessageId}` → `{turn}`
- `clientMessageId` is a client-generated UUID. The resulting `userMessage` item echoes it, so a Replica
  that showed the message as "sending" matches it by id rather than by position. If the same
  `clientMessageId` arrives twice (client retried after an uncertain delivery), the host returns the
  existing turn instead of starting another. This replaces envelope replay (capture: Codex reconciles lost
  `turn/start` by `clientUserMessageId`, local-link report 23).
- If a turn is already running: error `session_busy {turnId}`; the client offers steer instead. Exception:
  while an engine-initiated turn runs (5.2), the message joins that turn. The host journals its
  `userMessage` item in it, hands it to the engine (which takes it mid-turn), and returns that turn.
- An image or file part whose `url` is `/v1/blob/<id>` must name an attachment of this session (section
  8.1), and a file part must use such a URL; otherwise `invalid_params` with `data.path` at the part's
  `url` (`params.input.<n>.url`). An image part's blob must have an `image/*` media type. The same rules
  hold for `turn/steer` and `session/start` (whose session has no attachments yet).
- One writer per session is enforced by the host, not the client (local-link report 26, 32).

### `turn/steer {sessionId, turnId, input, clientMessageId}` → `{turn}`
Adds input to the running turn (`turnId` must be the running one, else `turn_mismatch`). Adapters that cannot
steer (Kimi, possibly) answer `not_supported`; the client then queues the message for after completion.

### `turn/interrupt {sessionId, turnId}` → `{ok:true}`
The turn ends with `turn/completed {status:"interrupted"}`. Idempotent: interrupting a finished turn is `ok`.

### `turn/diff {sessionId, turnId}` → `{files:[{path, kind, diff, oldPath?, binary?, truncated?}], truncated?, omittedFiles?, note?}`
The net change of a turn, for the Changes view. The host computes it the same way for every agent, from
git, not from the adapter or its `fileChange` items (additive within v1):

- **Snapshots.** When a turn starts, the host records the session folder's working tree as a git tree
  object; when the turn ends, it records it again and stores both tree ids with the turn. A snapshot never
  touches the user's index, stash, refs or files: it copies the index to a temporary file, runs
  `git add -A -- .` with `GIT_INDEX_FILE` pointing at the copy (so `.gitignore` is respected and ignored
  files are left out), then `git write-tree`, and deletes the copy. Only the git object store gains objects.
- **The diff** is `git diff -M` between the two trees, limited to the session folder (`--relative`).
  `path` (and `oldPath`) are relative to the session folder. `kind`: `add`, `modify`, `delete`, or
  `rename` (with `oldPath`; a file whose type changed, for example to a symlink, is a `modify`). `diff` is
  git's unified diff text of that file (`diff --git` header, `@@` hunks). A binary file is listed with
  `binary: true` and an empty `diff`.
- **Caps.** At most 64 KiB (65 536 bytes) of diff text per file and 512 KiB (524 288 bytes) in total,
  cut at a line end; a cut file has `truncated: true` (an empty `diff` when the total was already spent). At
  most 500 files are listed; `omittedFiles` counts the rest. The result has `truncated: true` when anything
  was cut or omitted.
- **Start snapshot not ready.** The start snapshot runs alongside the engine start and never delays the turn
  by more than 250 ms: if it is not done by the time the input goes to the engine, the turn starts anyway,
  that snapshot is discarded (the agent may already be writing), and the diff compares the turn-end tree
  with `HEAD` (the empty tree before the first commit). `note` then says so in one sentence the client
  shows. A finished turn without an end tree (the host stopped during the snapshot) is compared with the
  folder as it is now, also with a `note`.
- **While a turn runs**, the diff compares the start tree with the folder as it is now; it is final once
  the turn has ended (clients fetch it again on `turn/completed`).
- **Not a repository.** When the session folder is not inside a git work tree (or git is not installed),
  `turn/diff` answers `not_a_repository`. Turns that ran outside a repository have no snapshots. This stays
  an error, not an empty result with a `note`: an empty `files` would tell an older client "no file
  changes", which is wrong for a turn that edited files.
- **The agent's own edits.** git does not see a folder outside git, nor a file outside the session folder
  (`--relative`). Every `fileChange` item carries the adapter's own `diff` of the edit, so a client shows
  those for what git does not list: the item's own diff when the item is opened, and in the turn's Changes
  the files of the turn's `fileChange` items that `turn/diff` did not list (all of them on
  `not_a_repository`), marked as the agent's edits; files git listed keep git's diff. Only when there is
  neither does the client say the folder is not a git repository.
- The Codex engine's own `turn/diff/updated` notification is not used.
- Snapshot trees are not referenced by any ref, so `git gc` may prune them after its grace period (two weeks
  by default); the diff of such an old turn then answers `internal`.

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
   Failures answer `{error:{code, message, data?}}` (section 10 codes): 400 `invalid_params` (`data.path`),
   403 `unauthorized` for a wrong, expired or used code (one message for all three), 415 when the body is
   not `application/json`, 429 `rate_limited` (`data.retryAfterMs`, plus `Retry-After`) after 5 failed
   codes within a minute from one address.
4. From now on the client opens streams as in section 1.

Over the stream: `device/list` → `{devices:[{clientId, displayName, platform, createdAt, lastSeenAt, current}]}`;
`device/revoke {clientId}` → `{ok:true}`; the revoked device's streams close with 4003. `device/rename`.
The host CLI can also list and revoke (for a lost phone). These are the Codex `remoteControl/client/*` calls.

The security pass before Phase 1 (todo item 10) owns code lifetime, token storage and tailnet-only binding.

### 8.1 Attachments (additive within v1)

Photos and files from the phone reach an agent in two steps: the client uploads each one to the host,
then sends a message whose input parts refer to it by URL. Like pairing, the upload is plain HTTPS, because
a 20 MB file has no place in a 16 MiB stream message.

**`POST /v1/blob?sessionId=<id>&name=<file name>`**, body the file's bytes, `Content-Type` its media type.
- Authenticated exactly like the stream upgrade (section 1): the `nano_device` cookie, or `Authorization:
  Bearer` from a client that sends no `Origin`. A request whose `Origin` is not the host's own origin is
  refused.
- Limit: `limits.maxAttachmentBytes` (20 MiB, 20 971 520 bytes) per file. Clients check it before
  uploading; the host refuses a larger `Content-Length` before reading the body and stops storing a body
  that grows past the limit.
- Answer `201 {blobId, url, name, mediaType, size}`: `blobId` is `blb_` plus 22 base64url characters (128
  random bits), `url` is `/v1/blob/<blobId>`; `name` is the file name made safe (last path segment, no
  control characters, no leading dots, at most 120 characters; `attachment` when empty); `mediaType` is
  the `Content-Type` without parameters (`application/octet-stream` when missing or malformed).
- Failures answer `{error:{code, message, data?}}`: 401 `unauthorized` (no token, unknown or revoked), 403
  `unauthorized` (foreign origin), 400 `invalid_params` (`data.path` `sessionId`), 404 `not_found` (no
  such session, or a deleted one), 405 (another method), 413 `invalid_params` (`data.maxBytes`).
- Clients downscale photos before uploading: at most 2048 px on the long edge, JPEG stays JPEG and PNG stays
  PNG; other image types are converted to JPEG.

**`GET /v1/blob/<blobId>`** (and `HEAD`) returns the bytes with their media type, to the same
authenticated devices only (any paired device, as every paired device sees every session): 401 or 403 as
above, 404 for an unknown id or a deleted session. Responses carry `X-Content-Type-Options: nosniff`, a
`Content-Security-Policy` of `default-src 'none'; sandbox`, and `Content-Disposition: attachment` for
anything but raster images (JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF), so an uploaded file never runs as a
page of the host's origin. `Cache-Control: private`.

**Storage.** The host keeps attachments in its app folder, one folder per session
(`<app folder>/attachments/<sessionId>/<blobId>/<name>`, folders 0700, files 0600, next to a small
`meta.json`). They live as long as the session: `session/delete` removes the folder; archiving keeps it.

**Handing them to the agent** (section 11). An image part goes to the agent's native image input when
`capabilities.attachments.images` is true. A file part, and an image part for an agent without image input,
becomes one line `Attached file: <absolute path>` in the prompt text; the agent reads the file itself.
Data-URL image parts keep working as before and are never stored.

## 9. Web Push (ADR 0005)

- `push/subscribe {subscription}` stores the browser's `PushSubscription` JSON for this `clientId`;
  `push/unsubscribe` removes it; `push/test` sends one. The VAPID public key comes from `initialize`.
- `push/test` answers `{ok: true}` once the push service accepted the message. Errors the web app shows:
  `not_found` with `data.reason` `no_subscription`, or `subscription_expired` (the push service answered
  404 or 410 and the host deleted the subscription; subscribe again); `internal` with `data.reason`
  `push_failed` (`data.status`), `timeout` or `network`.
- Payload: `{title, body, url}` only; `url` deep-links to the session. Never session content beyond a one-line title.
- Rules, copied from the captured behavior (runtime-capture N1 to N3):

| Event | Push sent when |
|---|---|
| `turn/completed` (any final status) | the client has **no open stream** at that moment |
| `approval/request`, `input/request` | **always**, even while connected (iOS closes the socket about 30 s after lock; the push covers the gap) |
| `request/resolved` by another device | never; the open stream gets the event |
| `status/changed` to `error` | the client has no open stream |
| `session/changed` whose `backgroundTasks` has no `running` task after one ran (additive within v1): body "Background tasks finished" | the client has no open stream |

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
| `not_supported` | adapter lacks the operation (steer, diff, a `session/settings/update` key) | hide the control |
| `conflict` | reserved for a later file write method: the file changed since it was read; not sent by any v1 method yet, and not in the schema's code list until that method exists | reload the file |
| `not_a_repository` | `turn/diff`: the session folder is not inside a git work tree (`data.cwd`; additive within v1) | show the turn's `fileChange` diffs (section 7), else say the folder is not a git repository |
| `rate_limited` | too many requests (`data.retryAfterMs`) | back off |
| `provider_unavailable` | a relayed provider failed (`data.reason`, `data.status?`, `data.retryAfterMs?`; section 15) | show the reason's sentence |
| `internal` | host bug | retry once, then report |

WebSocket close codes used by the host: 4001 unsupported protocol version, 4002 sequence gap, 4003
unauthorized or revoked, 4008 ping timeout, 4009 message too large, 4010 host draining.

## 11. Adapter mapping (what each agent must provide)

The host has one adapter per agent; each produces the section 5 vocabulary. The Codex column is verified
by the capture and the host-drive spike, the Claude Code column by the adapter's live test
(`host/src/adapters/claude/live.test.ts`) and the Phase 4 acceptance (`host/acceptance/host-claude.log`), except cells marked
"unverified", "not probed" or "did not occur". The Kimi column records the `kimi acp` spike
(`spikes/kimi-drive/NOTES.md`), run against a scripted fake model only; Kimi is not a v1 agent. The Pi
column (Phase 5b, ADR 0007) records pi in RPC mode as probed on the operator's Mac (1.3.0, an Ollama cloud
model) and the adapter's live test on pi 1.4.0 (`host/src/adapters/pi/live.test.ts`: `llamacpp/bonsai-27b`
and `openrouter/deepseek/deepseek-v4.1-flash`); cells
marked "not probed" are covered only by the fake pi of the unit tests.

| Protocol | Codex (app-server over stdio, verified by capture and spike) | Claude Code (Agent SDK, verified by the adapter's live test) | Kimi (ACP, post-v1, fake-model spike only) | Pi (`pi --mode rpc`, JSONL over stdio, Phase 5b) |
|---|---|---|---|---|
| `session/start` | `thread/start` (`settings.effort` as `config.model_reasoning_effort`) | `query()` with a new session (`settings.effort` as `options.effort`) | `kimi acp`, `initialize`, `session/new {cwd, mcpServers}` | `pi --mode rpc --no-extensions -e <Nano approval extension> --session-id <new id>` in the session folder, then `set_model {provider, modelId}` when `settings.model` is `provider/id`, then `set_thinking_level {level}` when `settings.effort` is set |
| `session/open` snapshot | `thread/read` + `thread/resume {initialTurnsPage}` | `resume: sessionId` + host Journal | `session/load {sessionId, cwd}` replays history as `session/update`, + host Journal | the same command with the stored `--session-id` (pi reloads its session file; `get_messages` returns the history) + host Journal. `--session <id>` is not used: it exits with "No session found" for a session whose first prompt never ran |
| `turn/start` | `turn/start {clientUserMessageId}` | send user message on the query stream | `session/prompt {sessionId, prompt}`; no turn id, the host assigns one; the response `{stopReason}` ends the turn | `prompt {message, images}`; no turn id, the host assigns one; `agent_settled` ends the turn |
| `session/settings/update` | `model`, `effort`, and `approvalMode` (as `approvalPolicy` and `sandboxPolicy`) on the next `turn/start` and every later one | `Query.setModel()` and `Query.applyFlagSettings({effortLevel})` before the next user message, `Query.setPermissionMode()` at once; a new query takes them as options | not probed | `set_model`, `set_thinking_level`, `get_state` before the next `prompt`; `approvalMode` is `not_supported` |
| `turn/steer` | `turn/steer {expectedTurnId}` | `not_supported` (the adapter declares no steer capability) | not probed; `not_supported` likely | `steer {message, images}`: queued, delivered before the next model call, then reported by pi as a user message (the host journals its own) |
| `turn/interrupt` | `turn/interrupt` | `query.interrupt()`; the turn ends with result `error_during_execution`, reported `interrupted` | not probed | `clear_queue`, then `abort`, then open approvals are declined (pi's abort waits for idle, which an open dialog blocks); `agent_settled {aborted: true}`, reported `interrupted` |
| `item/*` | `item/started`, `item/*/delta`, `item/completed` | `stream_event` text deltas, then assistant text and tool_use blocks and the tool_result | `session/update`: `tool_call`, `tool_call_update` (`completed` or `failed`), `agent_message_chunk` | `message_update` `text_delta` and `thinking_delta`, `message_end`, `tool_execution_start`, `tool_execution_update` (bash output), `tool_execution_end` (`isError`; declined when the host refused it) |
| `approval/request` command | `item/commandExecution/requestApproval` | `canUseTool` fires for Bash (`input.command`) | reverse request `session/request_permission` (not probed for shell commands) | Nano's extension `tool_call` hook calls `ctx.ui.confirm`; it arrives as `extension_ui_request {method: confirm, title: "nano-approval"}` for bash, answered with `extension_ui_response {confirmed}`; a refusal blocks the tool (accepted and declined both probed). Decisions `accept`, `decline`, `cancel` |
| `approval/request` fileChange | `item/fileChange/requestApproval` (did not occur in the spike) | `canUseTool` fires for Write (observed, with suggestions, so `acceptForSession` is offered) and Edit (same callback, not probed separately) | `session/request_permission` for `Write` (observed); options `allow_once` \| `allow_always` \| `reject_once` map to `accept` \| `acceptForSession` \| `decline`, `cancel` to the `cancelled` outcome | the same confirm for `write` (probed) and `edit` (not probed); any other tool except read, grep, find, ls asks as `permission` (not probed) |
| `input/request` | `item/tool/requestUserInput` | `canUseTool` fires for `AskUserQuestion`; answers are keyed by question text | not probed (shares `session/request_permission` per the docs) | other dialogs (`select`, `input`, `editor`) become one question (not probed) |
| `status/changed` | `thread/status/changed` | derived from stream state (running on a user message or on output while no turn runs, idle on `result`) | derived (active while `session/prompt` is pending) | derived (running from `turn/start` to `agent_settled`, `error` when pi exits) |
| `usage/updated` | `thread/tokenUsage/updated` | result message usage | `session/update` `usage_update` | `get_session_stats` after every turn (`tokens`, `contextUsage.percent`) |

Attachments (section 8.1), the same for `turn/start` and `turn/steer`:

| Part | Codex | Claude Code | Pi |
|---|---|---|---|
| image (blob) | `localImage {path}` | an `image` content block, base64 (JPEG, PNG, GIF, WebP; other types as a file) | `images: [{type: "image", data, mimeType}]` |
| file | text part `Attached file: <path>` | text `Attached file: <path>`; the attachments folder is an `additionalDirectories` entry so reading it asks nothing | text `Attached file: <path>` |

All three declare `attachments: {images: true, files: true}`.

Background tasks (section 5.1), Claude Code only. Verified on 2026-10-24 (SDK 0.3.308, Claude Code 2.1.308)
by a raw SDK repro (in the Claude adapter's header comment) and by the adapter's live test
(`host/src/adapters/claude/live-background.test.ts`):

| Protocol | Claude Code | Codex, Pi |
|---|---|---|
| task launched | the engine's task events: `system/task_started` with `is_backgrounded: true`; a task started in the foreground (`is_backgrounded: false`, which a `Bash` call running past about 3 s gets) only once `system/task_updated {patch: {is_backgrounded: true}}` or `system/background_tasks_changed` (the engine's whole live set) says it moved to the background. Fallback when the engine sent none of these: an `Agent`/`Task` call with `run_in_background`, a `Bash` result naming `backgroundTaskId`, or a `Monitor` call, once its tool result confirms the launch. `id` is the tool_use id (the task id while unknown), `title` the tool input's `description` | not reported (`capabilities.backgroundTasks` false) |
| `lastActivity` | `system/task_progress` of that tool_use id: its `summary` when present, else its `description` ("Running <the subagent's tool description>"), one per subagent tool call | |
| task ended | `system/task_updated` with `patch.status` `completed`, `failed` or `killed`, or `system/task_notification` (`completed` is `finished`, `failed` is `failed`, `stopped` is `cancelled`); a running task that `system/background_tasks_changed` no longer lists is `cancelled` (a later notification's status replaces that). A run that dies ends its running tasks `failed` (`cancelled` when an unanswered Stop ended it), one the host stops ends them `cancelled`. The notification of a task that never left the foreground is not shown as a `background task` item | |
| `queued` cleared | the first top-level assistant message or stream event whose `user_message_uuid` is the message's `clientMessageId` (sent as the SDK message `uuid`) | |

Codex and Pi report none yet. The Codex app-server does have the idea as background terminals: requests
`thread/backgroundTerminals/list` (each `{command, cwd, itemId, processId, osPid?, cpuPercent?, rssKb?}`),
`.../terminate` and `.../clean`, a list to poll rather than events (engine schema in
`docs/research/rea/codex-app-server-schema/`); a Codex adapter could map it later. Pi 1.4.0's RPC mode
documents no background tasks; its in-process subagents come from extensions, which the adapter turns off
(`--no-extensions`).

The Claude Code approvals and questions reach `canUseTool` only when the adapter passes
`permissionMode: "default"` and `settingSources: []`. With the user's own settings loaded, auto mode
approves Bash and Write silently and a deny rule hides `AskUserQuestion` from the model, so the adapter
must not inherit them. The evidence for this column and for the Codex resume path is
`spikes/host-drive/NOTES.md` with its logs in `spikes/host-drive/logs/`. For the captured command
approval, Codex offered only `accept` and `cancel` (plus an object-valued amendment decision the adapter
drops), so adapters forward the engine's `availableDecisions` list instead of assuming all four decisions.

Kimi's `--prompt --output-format stream-json` mode cannot surface approvals: it always runs under the `auto`
permission policy, so a Kimi adapter must use ACP.

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

## 15. Provider relay (additive within v1)

ADR 0006: local chat calls an `https` provider on a public host straight from the phone, and any other
provider (plain `http`, loopback, RFC 1918, link-local, `.local`, tailnet `100.64.0.0/10` or `*.ts.net`)
through the paired host. These methods are that relay. The host keeps no state for them (ruling R3): no
Journal, no push, nothing survives the stream. A **Provider** is a reachable model endpoint identified by
its normalized base URL; the host knows two sorts:

- **Providers kept on the host**: the `providers` list in the host's `config.json`
  (`[{id, name, baseURL, apiKey?}]`). Their keys stay on the host; the protocol never carries a key
  (ruling R2). `nano-host status` lists their names.
- **Ad-hoc base URLs** sent by the client for a host-routed server it found or typed (for example
  Ollama on this Mac). The host only relays a `baseURL` whose route is "via the host" under ADR 0006;
  anything else answers `invalid_params` (`data.path` `params.baseURL`). No key is used.

`kind` is the wire format: `openai-compatible` (default), `ollama` or `anthropic`. The host derives it
from the base URL (host `anthropic.com` or a subdomain: `anthropic`; host `ollama.com` or port 11434:
`ollama`; anything else: `openai-compatible`). A request may name `kind` to override the derivation.

### `provider/list` → `{providers:[{id, name, baseURL, kind, hasKey}]}`
The Providers kept on the host, in config order.

### `provider/models {providerId | baseURL, kind?}` → `{models:[{id, displayName?}]}`
The host probes the provider's models endpoint (table below) and returns the list. `providerId` unknown:
`not_found`. The provider failed: `provider_unavailable` with `data: {reason, message, status?,
retryAfterMs?}` (`reason` as in `provider/done`).

### `provider/chat {requestId, providerId | baseURL, kind?, model, messages, options?}` → `{ok:true}`
- `requestId` is chosen by the client, unique among its running chats on this stream (a duplicate answers
  `invalid_params`). `messages` is `[{role: "system"|"user"|"assistant", content}]`; `options` is
  `{temperature?, maxTokens?, thinking?}`.
- The host answers `{ok:true}` first, then sends notifications **to this stream only**, unsequenced:
  - `provider/delta {requestId, kind: "text"|"reasoning", text}`: one per upstream chunk; reasoning text
    is flagged, never mixed into the answer.
  - `provider/usage {requestId, inputTokens?, outputTokens?}`: when the provider reports counts.
  - `provider/done {requestId, status: "completed"|"failed"|"aborted", error?}`: always the last one.
    `error` (present when failed) is `{reason, message, status?, retryAfterMs?}`; `reason` is
    `unauthorized` (401, 403), `rate_limited` (429), `unreachable` (connect failure, or the host is in its
    cooldown for that server), `timeout` (no first token in time), `not_found` (404, usually an unknown
    model), `upstream` (any other HTTP error or an error event in the stream), or `bad_response` (the
    stream could not be parsed). Clients map `reason` to one sentence; `message` is for logs.

### `provider/abort {requestId}` → `{ok:true}`
Cancels the upstream request; the chat ends with `provider/done {status: "aborted"}`. Aborting an
unknown or finished request is `ok`. Closing the stream aborts all its chats (no `done` is sent).

### `provider/discover` → `{candidates:[{baseURL, kind}]}`
The "Find local servers" action. The host probes its own addresses (loopback, its LAN IPv4 addresses and
its tailnet addresses) on ports 11434, 1234, 8080 and 8000 to 8020, each probe with a 1 s timeout:
`GET /api/tags` (an Ollama model list: `kind: ollama`, base URL `http://<address>:<port>`), else
`GET /v1/models` (`openai-compatible`, base URL ending in `/v1`), else `GET /models`
(`openai-compatible`). A server answering on several addresses is reported once, loopback first, then
LAN, then tailnet.

### Runtime behavior (provider-connection.md section 4)
- **Timeouts**: connecting gives up after 10 s; `provider/models` must answer within 10 s (both are
  `unreachable`); a chat is bounded by the first-token watchdog below, so a server loading a model may
  take up to 30 s before its headers.
- **Retries** on 429, 502, 503 and 504, and once on a connect failure, before any delta was sent:
  up to 3 retries with exponential backoff (0.5 s, 1 s, 2 s, with jitter, at most 8 s), honoring
  `Retry-After` (seconds or an HTTP date) up to 30 s; a longer `Retry-After` fails at once with
  `rate_limited` and `retryAfterMs`.
- **Dead-host cooldown**: after two connect failures in a row to one server (scheme, host, port), requests
  to it fail at once with `unreachable` for 20 s (`retryAfterMs` says how long is left). A success resets
  the count.
- **First-token watchdog**: a chat whose server accepts the request but sends no delta within 30 s of
  sending it is cancelled upstream and ends `failed` with `timeout`.
- **Abort** (method or stream close) cancels the upstream HTTP request, including during a backoff wait.

### Wire formats (one adapter table in the host, no class per vendor)

| | `openai-compatible` | `ollama` | `anthropic` |
|---|---|---|---|
| models | `GET {base}/models`, `{data:[{id}]}` or a bare list | `GET {base}/api/tags`, `{models:[{name}]}` | `GET {base}/v1/models` (no `/v1` added when the base ends in it), `{data:[{id, display_name}]}` |
| chat | `POST {base}/chat/completions`, `stream: true`, `stream_options.include_usage`; SSE `data:` lines until `[DONE]` | `POST {base}/api/chat`, `stream: true`; one JSON object per line until `done: true` | `POST {base}/v1/messages`, `stream: true`; SSE events until `message_stop` |
| key | `Authorization: Bearer` | `Authorization: Bearer` (Ollama Cloud) | `x-api-key`, `anthropic-version: 2023-06-01` |
| text | `choices[0].delta.content` | `message.content` | `content_block_delta` `text_delta` |
| reasoning | `delta.reasoning_content` or `delta.reasoning` | `message.thinking` | `content_block_delta` `thinking_delta` |
| usage | `usage.prompt_tokens`, `usage.completion_tokens` | `prompt_eval_count`, `eval_count` | `message_start` `usage.input_tokens`, `message_delta` `usage.output_tokens` |
| system messages | kept in `messages` | kept in `messages` | joined into `system` |
| `thinking: true` | `reasoning_effort: "medium"` | `think: true` (`false` sends `think: false`) | `thinking: {type: "enabled", budget_tokens}` (half of `max_tokens`, at least 1024; `temperature` dropped) |
| `maxTokens` | `max_tokens` | `options.num_predict` | `max_tokens` (default 4096) |
| `temperature` | `temperature` | `options.temperature` | `temperature` |
