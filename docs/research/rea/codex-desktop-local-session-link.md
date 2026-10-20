# Codex desktop app: local UI to engine link and session lifecycle

Target: `/Applications/ChatGPT.app` (bundle id `com.openai.codex`, 26.1007.21159), bundled engine
`Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` (codex-cli 0.162.0-alpha.17.2).
Method: static analysis of the extracted asar at `/tmp/rea-codex-asar` (python context extraction,
because `grep` here is ugrep and rejects long context patterns), plus `codex app-server --help` and
`codex app-server daemon --help` run with a throwaway `CODEX_HOME`. The app was **not** launched: the
static evidence for the transport was unambiguous. Scope excludes remote control, pairing, relay, and phone.

Offsets are byte offsets into the named file (`/tmp/rea-codex-asar/.vite/build/` for main-process
chunks, `/tmp/rea-codex-asar/webview/assets/` for renderer chunks). Minified names (e.g. `Ws`, `Us`)
are given only so the code can be found again.

## Behaviors

### Transport (question 1)

1. **Observed.** By default the Electron main process starts the engine as a child process and talks to it over stdin/stdout pipes, one connection per host.
   `application-network-startup-CfAQmSYg.js@256438` (class `Us`, logger `StdioConnection`):
   `(0,d.spawn)(t,this.options.spawnArgs??this.options.args,{stdio:['pipe','pipe','pipe'],env:this.options.env,cwd:this.options.cwd})`, then logs `stdio_transport_spawned`.
2. **Observed.** The local command line is `codex -c features.code_mode_host=true app-server --analytics-default-enabled`, optionally followed by more `-c key=value` overrides. If the `CODEX_APP_SERVER_CHATGPT_BASE_URL` / `CODEX_APP_SERVER_OPENAI_BASE_URL` env vars are set, `app-server` goes first and those values are passed as `-c chatgpt_base_url=…` / `-c openai_base_url=…`. No `--listen` flag is passed, so the engine uses its default, `stdio://`.
   `application-network-startup-CfAQmSYg.js@254248`: `Ts='Codex Desktop',Es=['-c','features.code_mode_host=true']`; `@266717` (function `tc`): `[...Es,'app-server','--analytics-default-enabled']`; `Ks` appends `...t.flatMap(e=>['-c',e])`. `codex app-server --help`: `--listen <URL> … stdio:// (default), unix://, unix://PATH, ws://IP:PORT, off`.
3. **Observed.** The binary it runs is `<Resources>/codex-cli/CodexCLI.app/Contents/MacOS/codex`. A `codex_cli_command` in the host config, or a `CODEX_CLI_PATH`-style override, takes precedence.
   `application-network-startup-CfAQmSYg.js@46353` (`Zt`): `join(e,'codex-cli','CodexCLI.app','Contents','MacOS','codex')`; `$s` at `@265618` checks `hostConfig.codex_cli_command` first.
4. **Observed.** The child gets a curated environment: `LOG_FORMAT=json`, `RUST_LOG=warn` (unless already set), `CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop'`, `CODEX_CLI_PATH=<binary>`, `CODEX_MCP_NODE_PATH`, and PATH entries for the bundled git and rg.
   `application-network-startup-CfAQmSYg.js` function `Ks`: `o={...process.env,LOG_FORMAT:'json',RUST_LOG:process.env.RUST_LOG??'warn',CODEX_INTERNAL_ORIGINATOR_OVERRIDE:e.defaultOriginator??Ts}`.
5. **Observed.** Framing is newline-delimited JSON (JSONL). Each outbound message is `JSON.stringify(msg)+"\n"` written to stdin. Inbound stdout lines go through a JSONL reader with size and queue-depth telemetry, and stderr lines are kept as the "last error".
   `application-network-startup-CfAQmSYg.js@255431`: `send(e){… let t=`${e}\n`; … this.proc.stdin.write(t)}`; error string `Failed to parse app-server stdout JSONL message`.
6. **Observed.** Messages have the JSON-RPC shape `{id, method, params}`, with no `jsonrpc:"2.0"` field. The client classifies each message by which fields it has: response = `id` plus `result`/`error`; server request = `method` plus `id`; notification = `method` without `id`. The desktop also adds a `trace` field.
   `src-BJv5Mk7n.js@1112768`: `function tL(e){return typeof e.method=='string'&&'id'in e&&e.id!=null}function nL(e){return'id'in e&&('result'in e||'error'in e)}function rL(e){return typeof e.method=='string'&&!('id'in e)}`. The initialize request at `@1119877` has no `jsonrpc` key: `{id:SL,method:'initialize',params:{clientInfo,capabilities},trace:t}`.
7. **Observed.** The handshake is a single `initialize` request with fixed id `__codex_initialize__`. Its capabilities include `experimentalApi:true`, `explicitGatewayOauth` (local only), `requestAttestation`, extensions such as `openai/elicitation`, and `optOutNotificationMethods` (for example `turn/diff/updated`). A timeout watchdog guards it ("Codex app-server initialize handshake timed out"). Messages that arrive before the handshake completes are logged as `Message before initialization`.
   `src-BJv5Mk7n.js@1119877` (function `CL`), `@1241510`, `@1247013`.
8. **Observed.** An opt-in daemon path exists. If `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, the host is local and non-Windows, there are no config overrides or CLI overrides, the bundled git is not in use, and `codex app-server daemon version` reports a supported version, then the desktop connects over **WebSocket on the unix socket** `$CODEX_HOME/app-server-control/app-server-control.sock` at URL `ws://localhost/rpc`, instead of spawning.
   `application-network-startup-CfAQmSYg.js@261021` (class `Ws.connect`): `process.env.CODEX_APP_SERVER_USE_LOCAL_DAEMON==='1'&&process.env.CODEX_APP_SERVER_FORCE_CLI!=='1'&&… await Gs(t) ? (this.kind='websocket', new Jo({websocketUrl:'ws://localhost/rpc',createConnection:()=>createConnection(n)}).connect()) : (this.kind='stdio', new Us(t,…))`; `Gs` runs `[app-server, daemon, version]` with a 2.5 s timeout.
9. **Inferred.** In the shipped build this daemon path is off by default. The only reference to `CODEX_APP_SERVER_USE_LOCAL_DAEMON` is that check, and nothing in the asar sets it.
   `grep -o CODEX_APP_SERVER_USE_LOCAL_DAEMON *.js` finds 1 hit, in `application-network-startup-CfAQmSYg.js`.
10. **Observed.** Transport selection depends on the host kind. SSH hosts use a `ws` transport tunnelled via `codex app-server --listen unix://` on the remote side. A `websocket_url` host config uses a direct WebSocket. Everything else (local) uses the stdio/daemon class `Ws`, exported as `c._`.
    `main-39FdJ_vp.js@3244706` (function `j5`): `… return new c._({hostConfig,repoRoot,resourcesPath,defaultOriginator,getConfigOverrides})`; `exports,"_",{…return Ws}` in `application-network-startup-CfAQmSYg.js`.
11. **Observed.** The engine's CLI has a full daemon manager: `app-server daemon {bootstrap,start,restart,update,enable-remote-control,disable-remote-control,stop,version}`, an `app-server proxy` subcommand ("Proxy stdio bytes to the running app-server control socket"), and the files `app-server-startup.lock` and `loaded-threads.json`.
    `codex app-server --help` / `codex app-server daemon --help` output; binary strings: `app-server-daemonloaded-threads.json … app-server-controlapp-server-startup.lockapp-server-control.sock`.
12. **Observed.** The codex terminal UI (TUI), not the desktop app, is the client that prefers the daemon. It logs `codex.daemon.start` and `already_running`, and falls back with "local daemon connection failed; starting embedded app server".
    Binary strings (line around `tui_auto_startcodex.daemon.startlocal daemon connection failed; starting embedded app server`).

### Renderer to main bridge

13. **Observed.** Renderer windows never talk to the engine directly. The preload script exposes `electronBridge.sendMessageFromView` (IPC invoke on `codex_desktop:message-from-view`), and main pushes messages back on `codex_desktop:message-for-view`, which are re-dispatched as `window` `message` events. Large payloads use a chunked `codex-host-chunked-message-v1` protocol with acks.
    `preload.js`: `E='codex_desktop:message-from-view',D='codex_desktop:message-for-view'`; `sendMessageFromView:async t=>{… await e.ipcRenderer.invoke(E,t)}`.
14. **Observed.** App-server calls from the renderer are wrapped as `{type:'mcp-request', hostId, request:{id,method,params}}`. Main forwards each to the host's connection and returns `mcp-response` to the originating webContents. Engine notifications are fanned out to **all** windows as `mcp-notification`. Engine-to-client requests (approvals, user input) are broadcast to all windows as `mcp-request`.
    `main-39FdJ_vp.js@2096522`: `case'mcp-request':{… app_server.bridge_received …}`; `src-BJv5Mk7n.js@1253562`: `s={type:'mcp-notification',hostId,method,params…};this.messageDelivery.broadcastToWindows(s,…)`; `@1248856`: `this.messageDelivery.broadcastToWindows({type:'mcp-request',hostId,request:e})`.
15. **Observed.** Main runs a priority request scheduler per host (critical, interactive, background). It coalesces identical read-only requests (`thread/list`, `thread/read`, `thread/turns/list`, `model/list`, …) and rejects requests with `queue-full`. Requests from a destroyed window are dropped.
    `src-BJv5Mk7n.js@1130790`: set `hR` of coalescable methods and class `vR` (enqueue / coalescedRequestIds / `queue-full`); renderer `app-shared-2f2228189a8d.js@3228484`: `Nun=new Set(['thread/approveGuardianDeniedAction','thread/resume','thread/start','turn/addUserMessage','turn/interrupt','turn/start','turn/steer'])` are `critical`.

### Session persistence and resume (question 3)

16. **Observed.** The engine owns the thread state. Its threads table (`id`, `rollout_path`, `cwd`, `updated_at[_ms]`) lives in `$CODEX_HOME/state_5.sqlite`. The transcript lives in rollout JSONL files under `$CODEX_HOME/sessions/` (archived ones under `archived_sessions/`). The first line of each rollout file is `{"type":"session_meta","payload":{"id","cwd",…}}`.
    `main-39FdJ_vp.js@464427`: `Th='state_5.sqlite'`, query `SELECT id, rollout_path FROM threads WHERE (cwd = '' OR cwd IS NULL)…`, and the `session_meta` zod schema used to repair the cwd from the rollout's first line; binary strings `sessions … archived_sessions … active rollout files … session_index.jsonl`.
17. **Observed.** The desktop keeps its own better-sqlite3 database `~/.codex/sqlite/codex-dev.db`. It holds a sidebar cache of threads per host (`local_thread_catalog*`), a `thread_timeline_ledger`, automations, the inbox, and feature enablement. It is a cache and index; the engine stays the source of truth.
    `sqlite3 -readonly ~/.codex/sqlite/codex-dev.db .tables`; migration `legacy_0022_create_local_thread_catalog` at `src-BJv5Mk7n.js@96285`. On this Mac, `~/.codex` contains only `sqlite/` (no `sessions/` and no `state_5.sqlite`), so Codex threads have never been run here.
18. **Observed.** Opening a thread works like this:
    1. Build a placeholder from the catalog or the thread summary.
    2. Call `thread/read` with `includeTurns:false` for metadata: `sessionId`, `path` (rollout path), `cwd`, `historyMode`, `status`.
    3. If `historyMode==='paginated'`, page history with `thread/turns/list` (`itemsView:'notLoaded'`, `sortDirection:'desc'`), then `thread/items/list` per turn.
    4. Call `thread/resume` with `{threadId, path, cwd, modelProvider, approvalPolicy, sandbox|permissions, approvalsReviewer, config, personality, excludeTurns, initialTurnsPage:{limit:5,itemsView:'full',sortDirection:'desc'}}`.

    `app-shared-2f2228189a8d.js` function `Trn` (around `@2921606` + 6–13 KB): `e.readThread(f,{includeTurns:!1,…})`, `historyMode==='paginated'`, `let He={threadId:f,history:null,path:…b.thread.path,…,excludeTurns:P&&!E,…initialTurnsPage:{limit:5,itemsView:'full',sortDirection:'desc'}}`; `@2544931`: `sendRequest('thread/turns/list',{threadId,cursor,limit,itemsView:'notLoaded',sortDirection:c??'desc'})`.
19. **Observed.** `thread/resume` gets an escalating timeout (120 s × 2^n, up to 2 retries). It is also retried up to 4 times with backoff when the engine answers "thread X is closing; retry thread/resume after the thread is closed".
    `app-shared-2f2228189a8d.js@2921606` (function `Crn`).
20. **Observed.** During a resume the renderer buffers live notifications for that thread (`beginResumeNotificationBuffer` / `releaseResumeNotificationBuffer`). This stops stream deltas that arrive mid-hydration from being lost or applied out of order.
    `Trn` body: `P&&e.beginResumeNotificationBuffer(f)`.
21. **Observed.** The renderer caches per-conversation state in memory: `resumeState` (`needs_resume` / `resuming` / `resumed`), `rolloutPath`, `sessionId`, turns pagination cursors, pending server requests, and permissions. Idle threads are evicted back to `needs_resume`, and their engine subscription is dropped with `thread/unsubscribe`.
    `app-shared-2f2228189a8d.js@2794518`: `inactive_thread_unsubscribe_started … sendRequest('thread/unsubscribe',{threadId:e})`; the eviction sets `e.resumeState='needs_resume'` and resets `turnsPagination`.
22. **Observed.** The string "Showing up to 100 recent prompts and final replies. Intermediate messages and tool activity are unavailable." is **not** in the desktop JS. It is in the Rust TUI, next to "Failed to page read-only thread history; trying summary pages". The desktop has an analogous bounded mode for cloud history (`itemsView:'summary'`, limit 1, item limit 30 when bounded; otherwise limit 5 / item limit 100).
    Binary strings; a search for "up to 100 recent" over `/tmp/rea-codex-asar` finds nothing; `Trn`: `re=a.useBoundedCloudHistory?1:5,I=a.useBoundedCloudHistory?30:100 … itemsView:'summary'`.

### Turns, approvals, input

23. **Observed.** Sending a message calls `turn/start` (with `turn/addUserMessage` for queued or extension flows). Mid-turn input calls `turn/steer`, and stop calls `turn/interrupt`. If delivery of `turn/start` is uncertain, it is marked "outcome-unknown" and reconciled through `clientUserMessageId`.
    `app-shared-2f2228189a8d.js@3051928`: `se=await e.sendRequest('turn/start',p,m)`, `JB … delivery.stage==='outcome-unknown'`; `@3059865`: `e.sendRequest('turn/steer',n,r)`.
24. **Observed.** Approvals and user input arrive as engine-to-client JSON-RPC requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `item/tool/requestOptionPicker`, `mcpServer/elicitation/request`. They are tracked per turn, and `serverRequest/resolved` clears them. The decision enum in the engine includes `accept`, `acceptForSession`, `decline`, `cancel`, and `acceptWithExecpolicyAmendment`.
    `app-shared-2f2228189a8d.js@2656653`: `case'item/commandExecution/requestApproval':case'item/fileChange/requestApproval':zH(r,o.params.turnId).approvalRequests.push(o)`; binary strings: `acceptForSessiondeclinecancel`, `acceptWithExecpolicyAmendment`.

### Crash and restart (question 4)

25. **Observed.** The stdio transport reports `supportsReconnect()===false`, so a dead child is **not** auto-reconnected. Main logs `Codex CLI process exited` and calls `broadcastFatalError`, which sends `codex-app-server-fatal-error` to every window and rejects all pending internal requests. Only the websocket kinds (daemon, SSH, remote) get the exponential-backoff `scheduleReconnect`.
    `application-network-startup-CfAQmSYg.js@261021`: `supportsReconnect(){return this.kind==='websocket'}`; `src-BJv5Mk7n.js@1233849` (`if(!this.options.transport.supportsReconnect()){… this.broadcastFatalError(l,…)`), `@1234866` (`scheduleReconnect` skipped when `unsupportedTransport`), `@1258730`.
26. **Observed.** The renderer shows a full-screen recovery page: "ChatGPT hit a snag" plus "Try again or update ChatGPT if this keeps happening", or a config-specific message when the error looks like a config problem. It has buttons Try again (`appServerCrash.restartChatGPT`), Send feedback, and Review configuration (local only). Windows opened later get the fatal error replayed through a connection snapshot.
    `app-initial-c468e3fd7f91.js@9428986` (component `T8s`), `@9629704` (`case'codex-app-server-fatal-error'`); `src-BJv5Mk7n.js@1197565` (`sendConnectionStateSnapshot … codex-app-server-fatal-error`).
27. **Observed.** "Try again" (and the reconnect button on the host status badge) dispatches `codex-app-server-restart {hostId, intent:'restart'|'reconnect', killCodexProcess?}`. Main then calls `connection.restart()`: stop process, optionally kill it, clear the fatal state, `ensureReady()` (respawn plus a new `initialize`), and re-send `remoteControl/enable` if it was on.
    `main-39FdJ_vp.js@2094253`: `case'codex-app-server-restart':{let e=this.getAppServerConnection(t.hostId);await e.restart({intent:t.intent,killCodexProcess:t.killCodexProcess??!1}) …}`; `src-BJv5Mk7n.js@1216093` (`async restart(`).
28. **Observed.** On a successful (re)initialize, main broadcasts `codex-app-server-initialized {hostId, transport, appServerVersion, installedCodexVersion}`. The renderer then clears the fatal screen, refreshes recent conversations (`thread/list`), and invalidates host queries.
    `src-BJv5Mk7n.js` (function `LL`, `completeInitialization`); `app-initial-c468e3fd7f91.js@9637499`.
29. **Inferred.** After a restart, open conversations are re-hydrated through the normal resume path (`thread/read` then `thread/resume`, with the `isReconnectRecovery` flag lowering the priority to interactive). The rollout or SQLite on disk is the replay source; there is no in-memory event log replayed from main. I found no code that replays missed notifications after a stdio crash.
    `Trn` parameter `isReconnectRecovery:d=!1`, `priority:d?'interactive':'critical'`.
30. **Observed.** Connection state is a small state machine that is broadcast to windows as `codex-app-server-connection-changed` (`connecting` / `restarting` / `connected` / `error`, plus `transport` and `error.code`, e.g. `restart-required`, `login-required`, `connection-failed`, `remote-codex-not-found`).
    `src-BJv5Mk7n.js@1244460` (`createConnectionStatePayload`).

### Multiple windows and clients (question 5)

31. **Observed.** In the desktop, one main process holds exactly one engine connection per host and multiplexes it across all windows. Multi-window is solved in the desktop rather than in the engine: each thread has one **owner** window, the one that ran `thread/resume` and holds the stream. Other windows are **followers** that forward actions to the owner over IPC (`thread-follower-start-turn`, `thread-follower-interrupt-turn`, `thread-follower-command-approval-decision`, `thread-follower-file-approval-decision`, `thread-follower-submit-user-input`, …), with `thread-owner-discovery` to find the owner.
    `src-BJv5Mk7n.js@8063`: `var De={"thread-stream-state-changed":11,…,"thread-owner-discovery":1,"thread-follower-start-turn":2,…}`; renderer `Trn`: `getStreamRole(f)?.role==='follower' … return {status:'not-ready',reason:'owner-recovering'}`, `setConversationStreamRole(f,{role:'owner'})`.
32. **Observed.** The engine itself supports several clients. The daemon, the control socket, `app-server proxy`, and `loaded-threads.json` all exist. The engine enforces one writer per thread: the renderer special-cases the errors "already has an active writer" and "already has a live local writer", and both strings are in the binary. Engine responses also carry `notSubscribed`/`unsubscribed` subscription status.
    `app-shared-2f2228189a8d.js@2921606` (function `Srn`); binary strings ` already has an active writer`, `  already has a live local writer`, `notSubscribedunsubscribed`.
33. **Inferred.** With the default stdio transport, the desktop and a separately launched `codex` TUI do **not** share an engine. The TUI starts or attaches to the daemon at `app-server-control.sock`, and the desktop spawns a private child. They meet only through the shared files in `$CODEX_HOME` (state DB plus rollouts), which explains why the engine needs a "live local writer" guard.

## Protocol method inventory

Each method below appears as a literal in the shipped JS. "Dir" means C→S (client request), S→C (server notification), or S→C req (server request needing a response). The direction is inferred from usage (`sendRequest` vs notification and request handlers) and the naming convention.

| Area | Method | Dir | Where seen (file) |
|---|---|---|---|
| Handshake | `initialize` (id `__codex_initialize__`) | C→S | src-BJv5Mk7n.js@1119877 |
| Thread list | `thread/list`, `thread/search`, `thread/loaded/list` | C→S | app-shared, src-BJv5 |
| Thread open | `thread/read`, `thread/resume`, `thread/start`, `thread/fork`, `thread/unsubscribe` | C→S | app-shared (`Trn`), main |
| History | `thread/turns/list`, `thread/items/list`, `thread/timeline/list` | C→S | app-shared@2544931 |
| Thread admin | `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/name/set`, `thread/metadata/update`, `thread/settings/update`, `thread/rollback`, `thread/revert`, `thread/compact/start`, `thread/stop`, `thread/goal/{get,set,clear}`, `thread/queue/{add,list,update,delete,reorder,start}` | C→S | app-shared, src-BJv5 |
| Turn control | `turn/start`, `turn/steer`, `turn/interrupt`, `turn/addUserMessage`, `turn/settings/update` | C→S | app-shared@3051928, @3059865 |
| Thread events | `thread/started`, `thread/status/changed`, `thread/name/updated`, `thread/archived`, `thread/unarchived`, `thread/deleted`, `thread/closed`, `thread/settings/updated`, `thread/tokenUsage/updated`, `thread/goal/updated` | S→C | app-shared, src-BJv5 |
| Turn events | `turn/started`, `turn/completed`, `turn/plan/updated`, `turn/diff/updated` (desktop opts out) | S→C | app-shared |
| Item stream | `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}`, `item/commandExecution/outputDelta`, `item/fileChange/{outputDelta,patchUpdated}`, `item/plan/delta`, `item/mcpToolCall/progress` | S→C | app-shared, content-*.js |
| Approvals | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | S→C req | app-shared@2656653 |
| User input | `item/tool/requestUserInput`, `item/tool/requestOptionPicker`, `mcpServer/elicitation/request`, `item/tool/call` (dynamic tool) | S→C req | app-shared, src-BJv5@1248856 |
| Resolution | `serverRequest/resolved` | S→C | app-shared, main |
| Auth / account | `account/read`, `account/login/start`, `account/login/completed`, `account/logout`, `account/updated`, `account/rateLimits/read`, `getAuthStatus` | mixed | src-BJv5, main |
| Config / catalog | `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `model/list`, `collaborationMode/list`, `skills/list`, `plugin/list`, `mcpServerStatus/list`, `experimentalFeature/list` | C→S | many |
| Exec / fs | `command/exec` (+ `/write`, `/terminate`, `/outputDelta`), `process/{spawn,writeStdin,resizePty,kill}`, `process/{outputDelta,exited}`, `fs/{readFile,writeFile,readDirectory,getMetadata,watch,unwatch,changed,…}` | mixed | src-BJv5, main |

The full list of 225 method-like literals is reproducible with the extraction script in the "Reproduce" section. Excluded from this table: `remoteControl/*` (sibling scope), `thread/realtime/*` (voice), and Windows sandbox methods.

## Open questions / unknowns

- **Unknown:** whether an `initialized` notification follows the `initialize` response. No literal `initialized` method send was found near the handshake code.
- **Unknown:** the exact `turn/start` params schema (`input` items, `clientUserMessageId`, overrides) beyond the fields seen in `Trn` and `hcn`. The engine can print it: `codex app-server generate-json-schema` / `generate-ts`. This was not run, to keep the work static and avoid writing files.
- **Unknown:** runtime confirmation. The process tree (one `codex … app-server --analytics-default-enabled` child of the Electron main process, pipes, no listening socket) was not observed, because the app was not launched; the static evidence was unambiguous.
- **Unknown:** whether the desktop ever enables `CODEX_APP_SERVER_USE_LOCAL_DAEMON` through a server-side flag. Only the env-var check was found.
- **Unknown:** how the engine arbitrates a second client that tries `turn/start` on a thread owned by another connection, beyond the "active writer" error strings.

## Implications for Nano Remote

1. Drive the engine the same way the desktop does. Spawn `codex app-server` (optionally `-c features.code_mode_host=true`) with stdio pipes and exchange JSONL `{id,method,params}` messages. If several clients must share sessions, run `codex app-server daemon start` and connect a WebSocket to `ws://localhost/rpc` over `$CODEX_HOME/app-server-control/app-server-control.sock`, or use `codex app-server proxy` as a stdio bridge. Check compatibility with `codex app-server daemon version` (JSON `{appServerVersion}`).
2. Send `initialize` first with `clientInfo` and `capabilities` (`experimentalApi:true`, `optOutNotificationMethods` for noisy events such as `turn/diff/updated`). Treat any message received before the response as an error.
3. To list sessions, call `thread/list` (keep a local catalog cache the way `codex-dev.db` does, but treat the engine as the source of truth). To open one, call `thread/read` with `{includeTurns:false}`, then `thread/resume` with `{threadId, path, cwd, excludeTurns:true, initialTurnsPage:{limit:5,itemsView:'full',sortDirection:'desc'}}`, then page older history with `thread/turns/list` (`itemsView:'notLoaded'`) and `thread/items/list`. Buffer notifications for the thread while the resume is in flight. Retry `thread/resume` on "is closing; retry".
4. For turns, use `turn/start`, `turn/steer`, and `turn/interrupt`. Attach a client message id so a lost response can be reconciled against the thread rather than resent blindly.
5. Answer `item/*/requestApproval`, `item/tool/requestUserInput`, and `mcpServer/elicitation/request` as JSON-RPC responses with the request's `id` (decisions `accept` / `acceptForSession` / `decline` / `cancel`). Clear the pending UI on `serverRequest/resolved`, because another client may have answered first.
6. Keep one owner per thread. Route phone actions through the host daemon's single connection (as the desktop's owner and follower windows do) instead of opening a second writer, and handle "already has an active writer" as a "someone else is driving" state.
7. Crash handling: a stdio child does not auto-reconnect in the desktop. Our host daemon should do better: restart with backoff, run `initialize` again, run `thread/list`, then re-resume every thread a client is viewing. The rollout files are the replay source, so no event journal is needed for correctness.
8. Call `thread/unsubscribe` when no client is viewing a thread, so the engine can unload it.

## Reproduce

- Context extraction helper (not committed): `python3 -I /tmp/rea-local-scripts/ctx.py <file> '<regex>' <width> <max>`.
- Method inventory: regex `` `([a-zA-Z]+(?:/[a-zA-Z]+){1,3})` `` over `.vite/build/*.js` and `webview/assets/*.js`, saved to `/tmp/rea-local-scripts/methods.txt`.
- Engine strings: `strings -n 8 …/MacOS/codex > /tmp/rea-local-scripts/codex-strings.txt`.
