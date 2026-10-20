# Runtime capture: the Codex desktop app and its remote-control link, observed live

Date: 2026-10-20, on the operator's Mac. Target: `/Applications/ChatGPT.app` (bundle `com.openai.codex`
26.1007.21159; the bundled engine reports itself as 0.163.0-alpha.10.2 in its user agent while the
package manifest says 0.162.0-alpha.17.2). All observations are from this machine; identifiers below
are the operator's own and the account id, cookies, and tokens have been removed.

Method:
1. Launched the app normally and recorded the process tree, open files, and sockets (`ps`, `lsof`, `nettop`).
2. Read the app's own log (`~/Library/Logs/com.openai.codex/...`), the engine's SQLite log, and the
   engine state database (`~/.config/codex/state_5.sqlite`, read-only).
3. Quit the app and checked what survived.
4. Relaunched with `--remote-debugging-port=9229` and, through the renderer's own bridge
   (`electronBridge.sendMessageFromView`), sent real app-server requests to the live engine.
5. Quit the app again and ran the engine alone for 25 s with `RUST_LOG=trace`, first under a probe
   client name and then under the desktop's client name, which made it reconnect to the relay for real.
   The app was relaunched afterwards. No pairing code was requested and no approval or turn was triggered.

## Behaviors confirmed at runtime

### Local link
1. **Observed.** The engine is a direct child of the Electron main process, started as
   `codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.…` and
   its fds 0, 1 and 2 are Unix socket pairs to the parent. No `--listen` flag.
   Evidence: `ps` tree (engine pid 17671, parent 17508); `lsof -p` shows `0u/1u/2u unix`.
2. **Observed.** No process of the app listens on any TCP port. The only Unix sockets it owns are
   `~/.config/codex/ipc/ipc.sock` (the desktop's own IPC for the `codex` CLI to reach the app, created
   by the main process with mode 0700 checks) and `/tmp/codex-browser-use/<uuid>.sock` (browser use).
   Evidence: `lsof -iTCP -sTCP:LISTEN` empty for ChatGPT/codex; `lsof -U`.
3. **Observed.** The engine's home is `~/.config/codex` on this Mac (XDG layout), not `~/.codex`. It holds
   `state_5.sqlite`, `sessions/` (1237 rollouts), `logs_2.sqlite` (a 1000-row rotating log),
   `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite`. The desktop's sidebar cache stays in `~/.codex/sqlite/codex-dev.db`.
   Evidence: `initialize` response `"codexHome":"/Users/mabue/.config/codex"`; `lsof -p` file list.
4. **Observed.** Handshake: the desktop's `initialize` took 133 ms; the app logs
   `initialize_handshake_result … initializeRequestId=__codex_initialize__ outcome=success transportKind=stdio`.
   Evidence: app log 03:51:56.509Z.
5. **Observed.** The engine's trace log prints every request as
   `app-server request: <method> connection_id=ConnectionId(n)` with `rpc.transport="stdio"`, and
   it serializes `remoteControl/*` requests through a global queue named `remote-control`.
   Evidence: engine stderr, target `codex_app_server::message_processor` and `request_serialization`.
6. **Observed.** Quitting the app kills the engine, closes every connection to OpenAI, and leaves no
   daemon socket. Hosting therefore stops when the GUI quits unless the CLI daemon is used.
   Evidence: after `quit app "ChatGPT"`, `pgrep` for ChatGPT/codex empty, no `app-server-control/` dir.

### Second host: Codex Cloud ("durable")
7. **Observed.** Besides the local engine, the desktop opens a WebSocket app-server connection to a
   host it calls `durable` (code constant `wss://codex-cloud-backend.chatgpt.com/`), which reports
   app-server version 0.1.0. Its `thread/list` returns only cloud-agent threads
   (`source: {custom: "codex-cloud-agent"}`, cwd `/workspace/scratch/...`), none of the local threads,
   and it rejects `remoteControl/status/read` and `server/diagnostics` with "unsupported app-server method".
   Evidence: app log `Starting app-server connection hostId=durable transport=websocket`,
   `Current reported app-server version: currentVersion=0.1.0 hostId=durable`; live `thread/list` on both hosts.
   Conclusion: local sessions are not mirrored into a cloud transcript store. The cloud host is a
   separate agent runtime, and the phone reaches local sessions only through the relay below.

### Remote-control host
8. **Observed.** Remote control was already enabled on this Mac. The engine keeps one enrollment row:
   `websocket_url = wss://chatgpt.com/backend-api/wham/remote/control/server`, `app_server_client_name =
   "Codex Desktop"`, a `server_id` (`srv_e_…`), an `environment_id` (`env_e_…`), `server_name`,
   `remote_control_enabled = 1`. Evidence: `state_5.sqlite` table `remote_control_enrollments`.
9. **Observed.** The engine re-enables hosting by itself at startup from that row. The desktop UI never
   sent `remoteControl/enable` during the launch (only `remoteControl/status/read`), yet the live status
   30 s later was `connected`. The enrollment lookup is keyed by the client name: an engine started under
   a different `clientInfo.name` stayed `disabled`, and the same engine started as "Codex Desktop"
   reconnected within 1.5 s. Evidence: app log (no enable call); live `remoteControl/status/read` →
   `{"status":"connected","serverName":"<host name>","installationId":…,"environmentId":"env_e_…"}`;
   engine stderr `reusing persisted remote control enrollment: … app_server_client_name=Some("Codex Desktop")`.
10. **Observed.** Connect sequence: `remote control websocket loop started` → `status Disabled → Connecting`
    → reuse enrollment → `refreshing remote control server token` (`POST …/wham/remote/control/server/refresh`)
    → WebSocket upgrade → `Connected`, in about 1.5 s. The `remoteControl/status/changed` notification
    is emitted on stdio for each step. Evidence: engine stderr timestamps 03:58:35.161 to 03:58:36.684; engine stdout.
11. **Observed.** WebSocket upgrade request, exactly:
    ```
    GET /backend-api/wham/remote/control/server HTTP/1.1
    Host: chatgpt.com
    Connection: Upgrade
    Upgrade: websocket
    Sec-WebSocket-Version: 13
    cookie: <present, redacted>
    x-codex-installation-id: <installation uuid>
    authorization: <present, redacted>
    x-codex-protocol-version: 3
    x-codex-name: <base64 of the host name>
    x-codex-server-id: srv_e_…
    ```
    No `x-codex-subscribe-cursor` was sent on this fresh start (`subscribe_cursor_present: false`).
    The response carried a Cloudflare `cf-ray` header. Evidence: tungstenite trace line "Request:".
12. **Observed.** The relay speaks to the host as a virtual client named `codex-backend`
    ("Codex Remote Control") whose `client_id` is `backend_<server_id>`. Its first message is an
    app-server `initialize` with id `__slingshot_backend_initialize__`, capabilities
    `experimentalApi:true` and an `optOutNotificationMethods` list (`thread/closed`, `skills/changed`,
    `thread/goal/*`, `thread/settings/updated`, `thread/tokenUsage/updated`, `hook/*`, `turn/diff/updated`, …).
    So "slingshot" is OpenAI's name for the relay side, which corrects the static report that called
    it only a MIME type. Evidence: decoded relay frame at 03:58:37.202.
13. **Observed.** Envelope traffic, decoded from the trace (host = this Mac):
    ```
    RELAY→HOST {"type":"ping","client_id":"backend_srv_e_…","stream_id":"<uuid>","seq_id":1,"cursor":"<b64>","state":"background"}
    RELAY→HOST {"type":"client_message", …,"seq_id":2,"cursor":"<b64>","message":{"id":"__slingshot_backend_initialize__","method":"initialize", …}}
    HOST→RELAY {"type":"pong","status":"unknown","client_id":…,"stream_id":…,"seq_id":1}
    HOST→RELAY {"type":"server_message","message":{"id":"__slingshot_backend_initialize__","result":{"userAgent":"Codex Desktop/0.163.0-alpha.10.2 …","codexHome":"/Users/…/.config/codex",…}}, "client_id":…,"stream_id":…,"seq_id":2}
    RELAY→HOST {"type":"ack", …,"seq_id":1}   RELAY→HOST {"type":"ack", …,"seq_id":2}
    RELAY→HOST {"type":"ping", …,"seq_id":3, …}   HOST→RELAY {"type":"pong","status":"active", …}   RELAY→HOST {"type":"ack","seq_id":3}
    ```
    Application-level pings from the relay arrived every 10 s, plus WebSocket-level ping/pong every 10 s
    from both sides. The host answers each relay ping with a `pong` carrying its status (`unknown` before
    the first request is processed, then `active`). Evidence: decoded frames 03:58:37 to 03:58:57.
14. **Observed.** The `cursor` is base64 JSON: `{"codex_remote_control_cursor":2,"presence_claim_token":"<hex>"}`.
    So the relay keeps a per-server sequence position plus a presence claim token, which is what the
    host would send back as `x-codex-subscribe-cursor` to resume after a reconnect.
    Evidence: decoded cursor from the ping frames.
15. **Observed.** One phone is paired to this Mac's environment. `remoteControl/client/list` returned
    one client: `deviceType "phone"`, `platform "ios"`, `osVersion "26.6"`, `deviceModel "iPhone"`,
    `displayName "iOS 26.6 iPhone"`, `appVersion "1.2026.244"`, `lastSeenAt` about a month ago.
    Evidence: live request through the renderer bridge (request ids `rea-…` in the app log).
16. **Observed.** On shutdown the host closes cleanly: writer and reader stop, the connection cycle ends
    with reason `Shutdown`, and the desired state is still `Enabled { persistence… }` (so it will come
    back on the next start). Evidence: engine stderr 03:58:58.
17. **Observed.** The engine trusts the system root certificates ("using system root certificates
    because no CA override environment variable was selected"), so a trusted local CA would allow
    full traffic interception later if needed. Evidence: engine stderr target `codex_http_client::custom_ca`.

## What was not observed
- No phone traffic: the paired iPhone was not used during the capture, so no `client_message` from a
  real phone, no approval, and no push notification was seen. The engine log would show such requests
  as `app-server request: … connection_id=ConnectionId(n)` with a non-stdio transport.
- The body of `server/refresh` and `server/enroll` (only the URL and the fact that refresh happened).
- Sleep behavior (the Mac was not put to sleep).

## Implications for Nano Remote (additions to the README)
- A host daemon can mirror the engine's own loop: persist an enrollment keyed by client name, reconnect
  on start, publish `disabled/connecting/connected/errored`, answer relay pings with a status, and ack
  every envelope by `seq_id`.
- The relay-side `initialize` with an opt-out list is a useful pattern: let the phone declare which
  notification streams it does not want, to save bandwidth on mobile.
- Keep a cursor like `{sequence, presence_token}` per client so a reconnecting phone can resume.
- Without a daemon, hosting dies with the GUI. Nano Remote's host should be a launchd service.

## Reproduce (operator's machine)
- Process view: `open --env RUST_LOG=info -a /Applications/ChatGPT.app`, then `ps -eo pid,ppid,command | grep codex`, `lsof -nP -p <engine pid>`.
- Live requests: relaunch with `open -a /Applications/ChatGPT.app --args --remote-debugging-port=9229 --remote-allow-origins='*'`,
  connect to a page target from `http://127.0.0.1:9229/json`, and `Runtime.evaluate` a script that calls
  `window.electronBridge.sendMessageFromView({type:'mcp-request', hostId:'local', request:{id, method, params}})`
  and listens for `window` `message` events of type `mcp-response`.
- Relay trace: quit the app, then
  `RUST_LOG=trace LOG_FORMAT=json <app>/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server`
  with an `initialize` whose `clientInfo.name` is `Codex Desktop`; decode `writing frame`/`received frame` hex payloads.
  The trace contains cookies and tokens; scrub before keeping.

## Phone session, observed end to end (2026-10-20, 04:08 to 04:17 UTC)

Setup: desktop app quit; the engine ran in the foreground as "Codex Desktop" with `approval_policy="on-request"`
and `sandbox_mode="read-only"` so that a file write would need approval; every relay frame was recorded
and decoded. The operator used the paired iPhone (ChatGPT iOS, updated to the current store build) to
open Codex, start a chat in `~/Desktop/phone-test`, approve one command, lock the phone, reopen the chat,
and interrupt a second task. Totals: 3387 decoded text frames; 162 phone requests; 1119 host messages;
1029 acks; 67 relay pings. Push notifications were disabled on the phone, so that path is still unobserved.

### What the phone does, in order
P1. **Observed.** Every phone session is a new relay stream: `initialize` first (three streams in ten
    minutes: first open, new chat, reopen after lock). The phone announces `experimentalApi` and goes
    through the same handshake as the desktop. Evidence: stream ids 9C44…, 56DA…, and an earlier one; `initialize` at 04:08:17, 04:10:00, 04:15:25.
P2. **Observed.** The host asks each new phone stream for device attestation: a server request
    `attestation/generate`, answered by the phone with `{"token":"v1.…"}` (three times, once per stream).
    Evidence: host→phone `attestation/generate` ids 0, 1, 3 and the phone's responses within 300 ms.
P3. **Observed.** Browsing the host: `thread/list`, `threadSection/list`, `config/read`,
    `configRequirements/read`, `model/list`, `collaborationMode/list`, `plugin/installed`, `skills/list`,
    and repeated `fs/getMetadata` + `fs/readDirectory` pairs while the folder picker is open (about one
    pair per second), plus `fs/createDirectory` once and `command/exec` for the bundled helper scripts
    (repository discovery, branch snapshot). Evidence: request list 04:10:00 to 04:12:55.
P4. **Observed.** Starting work: `thread/start` → `turn/start` with
    `input:[{type:"text", text:"Create a file named hello.txt …"}]`, then `thread/attachment/list` and
    `thread/queue/list`. Immediately after, the phone starts a **second, hidden thread** with a
    "You are a helpful assistant…" prompt to generate the chat title, calls `thread/name/set` on the
    real thread, then `thread/unsubscribe`s the helper. Evidence: 04:13:44.472 to 04:13:48.151.
P5. **Observed.** The relay's own virtual client subscribes to the new thread with
    `thread/resume` (request id `__slingshot_backend_notification_thread_…`) each time a turn starts.
    This is the backend's hook for turn events, and therefore the most likely source of phone push
    notifications: the relay, not the Mac, watches the thread. Evidence: backend `thread/resume` at
    04:13:45.041, 04:15:26.209, 04:16:07.926.
P6. **Observed.** Approval round trip: the host sent `item/commandExecution/requestApproval` (id 2,
    command `/bin/zsh -lc "python3 -c …write_text('hello')…"`, reason "May I create hello.txt…") to
    **every** connected client, phone and relay alike, at 04:13:52.98. The phone answered
    `{"decision":"accept"}` 11 s later (human time), and the host then broadcast `serverRequest/resolved`.
    Evidence: frames seq 48 (to relay) and seq 252 (to phone); phone response seq 120 at 04:14:04.11.
P7. **Observed.** Streaming to the phone is the ordinary notification set, not a reduced one:
    752 `item/agentMessage/delta`, 68 `command/exec/outputDelta`, `item/started`/`item/completed`,
    `turn/started`/`turn/completed`, `thread/status/changed`, `thread/tokenUsage/updated`,
    `account/rateLimits/updated`, `mcpServer/startupStatus/updated`, plus `thread/readState/changed`.
    Each host message is individually acked by the relay. No message needed chunking.
    Evidence: host→phone method counts.
P8. **Observed.** Catch-up after the phone was locked: the relay sent `client_closed` for the old stream;
    on reopen the phone opened a new stream, ran `initialize`, `thread/list`, `thread/resume` (the same
    thread id), `thread/goal/get`, `thread/turns/list`, `thread/items/list`, `thread/queue/list`, and
    then continued. This is exactly the desktop's resume recipe. Evidence: 04:15:25.716 to 04:15:26.874.
P9. **Observed.** Interrupt: `turn/start` ("Count from 1 to 200 …") at 04:16:07.80, `turn/interrupt`
    with `{turnId, threadId}` at 04:16:10.31, 2.5 s later. The first attempt a minute earlier completed
    before the user could tap Stop, which matches the operator's report. Evidence: frames at 04:15:53 and 04:16:07 to 04:16:10.
P10. **Observed.** Presence: the relay's periodic `ping` carries `state: "foreground"` while the phone app
    is open and `"background"` otherwise (14 foreground, 53 background), with one unchanged cursor for
    the whole session. The host answers with `pong {status: active}`. Evidence: ping frames.
P11. **Observed.** Engine-side, every phone request appears as a normal app-server request on its own
    connection id (2, 3, 4 for the three streams; 1 for the relay client; 0 for stdio), and the request
    spans still say `rpc.transport: "stdio"`. The engine treats remote clients as ordinary connections.
    Evidence: `app-server request: … ConnectionId(n)` lines; 5386 spans all `stdio`.
P12. **Observed.** Result on disk: `~/Desktop/phone-test/hello.txt` containing `hello`, written by the
    approved command. The thread title became "Create hello.txt and list files".

### Limits of this run
- 933 incoming frames did not parse because the trace logger truncates long payloads; all of them are
  after the first 300 bytes of large `client_message`s or acks and did not affect the counts above.
- No push notification could be observed (disabled on the phone). The relay's thread subscription (P5)
  is the inferred trigger.
- Attestation token contents, cookies, and the account id were removed; the raw trace was deleted.

### Implications for Nano Remote (phone side)
- The phone is a full app-server client over an envelope stream; it needs nothing the desktop does not.
  Mirror its sequence: initialize → attestation (replace with device key) → list/browse → thread/start → turn/start.
- Title generation is a client-side side thread; cheap to copy or to do on the host.
- Approvals are broadcast to all clients and resolved once; the phone UI must handle `serverRequest/resolved`
  arriving because another device answered.
- Catch-up is resume + turns page + items page, not an event replay. The Journal/Replica design can do
  better by replaying from the last `seq_id`, which the relay already tracks per stream.
- Presence (foreground/background) rides on the ping; the host can use it to decide when to notify.

## Push notifications, observed (2026-10-20, 04:23 to 04:32 UTC)

Same setup as the phone session (foreground engine, read-only sandbox, approvals on request). The
operator had notifications enabled on the iPhone and reported a lock-screen notification in both tests.

N1. **Observed.** Completion push happens only when the phone has disconnected. Timeline: `turn/start`
    ("sleep 100 …") at 04:25:15 with the phone connected; the phone locked and iOS closed its stream
    28 s later (`client_closed` at 04:25:43); `turn/completed` at 04:27:01 was delivered to the relay's
    own subscription only, because no phone stream existed; the phone showed a notification. In the
    earlier test the task finished 8 s after approval while the phone's stream was still open, and no
    notification appeared. Evidence: frames 04:25:15 to 04:27:01.
N2. **Observed.** Approval push: `item/commandExecution/requestApproval` at 04:29:19 went to the phone
    stream and to the relay while the phone was still connected; the phone's stream closed 24 s later
    (04:29:43); a notification appeared on the locked phone. Whether the relay pushed immediately or
    only after the stream closed cannot be told from the host side.
N3. **Observed.** Pending approvals are replayed on reconnect. When the phone came back (new stream,
    `initialize` + `thread/resume` at 04:31:15), the host re-sent the still-pending
    `item/commandExecution/requestApproval` to the new stream within 11 ms of the resume, the phone
    answered `{"decision":"accept"}` one second later, the host broadcast `serverRequest/resolved`, and the
    turn completed 8 s after that. Evidence: frames 04:31:14.868 to 04:31:24.329; `~/Desktop/phone-test/approved.txt` exists.
N4. **Observed.** Presence pings are per stream and carry the client's app state: `foreground` on the
    phone's stream while the app is open, `background` on the relay's own stream. Evidence: ping lines.
N5. **Observed.** iOS keeps the backgrounded app's relay stream alive for about 25 to 30 s after the
    screen locks, then the relay reports `client_closed`. Evidence: 04:25:15 lock → 04:25:43 close; 04:29:19 → 04:29:43.

Conclusion: the relay is the notifier. It holds its own subscription to every active thread
(`thread/resume` from the backend client), knows which phone streams are open, and sends a push for
`turn/completed` when the phone is gone and for pending approvals regardless. The Mac sends nothing
to the phone directly.

### Implications for Nano Remote (notifications)
- The host daemon must keep its own subscription to each thread and decide pushes from two inputs:
  the thread event and whether the phone's stream is currently open.
- Replay pending server requests (approvals, user-input questions) to any stream that resumes the thread.
- Expect the phone's stream to die about 30 s after lock; design the Replica catch-up for that, not for
  a long-lived background socket.
