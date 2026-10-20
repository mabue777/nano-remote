# Codex desktop app: remote-control host (phone controls this Mac)

Target: `/Applications/ChatGPT.app` (bundle `com.openai.codex`, 26.1007.21159), bundled engine
`Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` (codex-cli 0.162.0-alpha.17.2).
Method: static only. The asar was extracted to `/tmp/rea-codex-asar` and searched with grep and Python.
Strings were pulled from the engine with `strings -n 6 -t d`, and offsets below are decimal file offsets
in that binary. No app launch, no network traffic. The local Electron-UI to engine link is covered in
`codex-desktop-local-session-link.md` and is not repeated here.

Short answer: the Mac never accepts inbound connections. The bundled Codex engine (`codex app-server`)
dials OUT over a WebSocket to the ChatGPT backend (`chatgpt.com/backend-api/wham/remote/control/server`).
The backend relays JSON "envelopes" between that host socket and each authorized phone or computer.
Every remote client becomes a virtual app-server JSON-RPC connection on the Mac. Pairing works like
this: the host asks the backend for a short-lived pairing code. The code is shown as a QR code
(`https://chatgpt.com/codex/pair?pairing_code=…`) for phones, or as an 8-digit PIN for other computers.

Path abbreviations used below:
- `MAIN` = `/tmp/rea-codex-asar/.vite/build/main-39FdJ_vp.js` (line:match from `grep -n`)
- `SRC` = `/tmp/rea-codex-asar/.vite/build/src-BJv5Mk7n.js` (char offset)
- `INIT` = `/tmp/rea-codex-asar/webview/assets/app-initial-c468e3fd7f91.js` (char offset)
- `SHARED` = `/tmp/rea-codex-asar/webview/assets/app-shared-2f2228189a8d.js`
- `SETTINGS` = `/tmp/rea-codex-asar/webview/assets/remote-connections-settings-7d29d2d8f9a0.js`
- `SETUP` = `/tmp/rea-codex-asar/webview/assets/codex-mobile-setup-dialog-4b10fcf21874.js`
- `FLOW` = `/tmp/rea-codex-asar/webview/assets/codex-mobile-setup-flow-887b25e8c51f.js`
- `BIN@n` = string at decimal offset n in the codex engine binary
- `DK` = `/Applications/ChatGPT.app/Contents/Resources/native/remote-control-device-key.node`

## Two roles in one app

The same app does two different things, and they are easy to confuse:

1. **Host ("Control this Mac")**: the Mac is controlled by a phone or another computer. The Rust
   engine implements this (`app-server-transport/src/transport/remote_control/*`). Electron only
   toggles it and renders the UI.
2. **Controller ("Control other devices")**: this Mac controls other hosts. Electron main implements
   this (`remote-control-websocket` logger, `/codex/remote/control/client*` endpoints, Secure Enclave
   device key). This is very likely the same client protocol the iOS app speaks, so it is the best
   available specimen of the phone's side.

## Behavior list

### Pairing

1. **Observed**: Host pairing has one engine RPC, `remoteControl/pairing/start`. It returns
   `pairingCode`, `manualPairingCode`, and `expiresAt`. Progress is polled with `remoteControl/pairing/status`,
   which returns `claimed`.
   Evidence: `BIN@186637366` "pairingCode manualPairingCode expiresAt"; `BIN@186638056`
   "pairing_code manual_pairing_code struct StartRemoteControlPairingResponse with 5 elements claimed struct
   RemoteControlPairingStatusResponse"; method table in the engine strings lists
   `remoteControl/pairing/start remoteControl/pairing/status`.
2. **Observed**: The renderer requests pairing with `{manualCode:true}` on the selected host's app-server.
   It caches the result until `expiresAt` and refetches when the code expires.
   Evidence: INIT@~2381900, `sPn=kl(q,({hostId:e,openId:t}…)=>({…queryFn:async()=>(await LNn(r,e),jg(r,e).sendRequest(`remoteControl/pairing/start`,{manualCode:!0})),retry:!1,gcTime:0,staleTime:e=>{let t=e.state.data?.expiresAt…`.
3. **Observed**: For phones, the desktop renders the pairing code as a styled QR code that encodes
   `https://chatgpt.com/codex/pair?pairing_code=<pairingCode>` (an https universal link, not a custom scheme).
   Evidence: SETUP, function `Cr`: `let e=new URL(`https://chatgpt.com/codex/pair`);e.searchParams.set(`pairing_code`,a),c=kr(e.toString(),i?`L`:`M`,!i)`.
   UI copy: "Scan to continue setup in ChatGPT", "Show QR code fullscreen", "Copy pairing code", "Refresh pairing code".
4. **Observed**: For another computer, the host shows the 8-digit `manualPairingCode`. The controlling
   computer types it into "Add a device" and posts it to the backend at
   `POST /wham/remote/control/client/pair {client_id, manual_pairing_code}`.
   Evidence: SETUP "Click **Add** in the Settings > Connections > Control other devices tab on your other computer and enter this code";
   SETTINGS "Enter the 8-digit PIN below:"; INIT@2376412 `$l.safePost(`/wham/remote/control/client/pair`,{requestBody:{client_id:e,manual_pairing_code:t}})`.
5. **Observed**: Before remote control is enabled, the QR code shown is a static, platform-specific
   (iOS/Android) "continue setup in ChatGPT" app link, not a pairing code.
   Evidence: SETUP function `Tr` picks Android or iOS artwork (`yn.iosDots`). Strings
   `codexMobile.setupPage.waiting.phoneDeepLink.qrCode` "QR code to continue setup in ChatGPT", with device types iPhone/Android.
6. **Observed**: The engine reaches the backend pairing endpoints `wham/remote/control/server/pair`
   and `wham/remote/control/server/pair/status`.
   Evidence: `BIN@187774206` "wham/remote/control/server/enroll wham/remote/control/server/refresh wham/remote/control/server/pair wham/remote/control/server/pair/status wham/remote/control/server".
7. **Observed**: Pairing requires that remote control is already enabled and connected.
   Evidence: `BIN@187726736` "remote control pairing requires remote control to be enabled".
8. **Observed**: SSH pairing means the desktop runs the same `remoteControl/enable` and
   `remoteControl/pairing/start` against the app-server on an SSH host. Any phone can then control that
   SSH machine through the same relay.
   Evidence: SETTINGS "Control from your phone or other device" (`table.sshRemoteControlPairing.tooltip`),
   "Allow devices to control this connection?", "Approve on your device to use this connection remotely".
   `sPn` is keyed by `hostId`. The engine CLI also has "bootstrap: Install durable local app-server management for SSH-driven use".
9. **Observed**: Headless pairing exists through the CLI: `codex remote-control start|stop|pair`.
   `pair` prints "This machine is available for remote control as …" and "Pairing code: …".
   Evidence: `BIN@185224609`, `BIN@185224663`, `BIN@186644582` "remote-control start remote-control stop remote-control pair Starting app-server with remote control enabled...",
   `BIN@186763552` "remote-control pairing response did not include a manual pairing code".
10. **Observed**: "One-to-one pairing" is a UI mode behind a Statsig flag (`2055603567`). With it on,
    a host lists only clients paired to its own environment, using the app-server RPC `remoteControl/client/list`.
    With it off, every enrolled client on the ChatGPT account (`GET /wham/remote/control/clients`, called
    "browser" clients) can see and control the host. The toggle text changes from "Allow this device to be
    discovered and controlled" to "Allow connections".
    Evidence: FLOW `includeBrowserClients:!e(y,`2055603567`)`; INIT@2379788 `HNn` merges `xNn()`
    (`/wham/remote/control/clients`) and `WNn` (`remoteControl/client/list`); SETTINGS `label.oneToOnePairing`
    "Label for allowing remote control connections when one-to-one pairing is enabled".
11. **Observed**: A second flag (`3936985709`) disables the pairing-code request.
    Evidence: INIT `sPn` `enabled:n(kc,`2055603567`)&&!n(kc,`3936985709`)&&n(DA,e)`.
12. **Observed**: "slingshot" is not a feature name. Its only occurrence is the IANA MIME type
    `application/vnd.meridian-slingshot` in a mime-db table.
    Evidence: MAIN@3616142, worker.js@2219435, SHARED@6326519.

### Transport and enrollment (host side)

13. **Observed**: The host dials out. The engine opens a WebSocket client (tungstenite, rustls) to a
    remote-control URL. It persists an enrollment row keyed by `(websocket_url, account_id,
    app_server_client_name)` that holds `server_id`, `environment_id`, `server_name`, and `remote_control_enabled`.
    Evidence: `BIN@187288234` "creating new remote control enrollment: websocket_url="; SQL `BIN@186851030`
    "INSERT INTO remote_control_enrollments ( websocket_url, account_id, app_server_client_name, server_id, environment_id, server_name, remote_control_enabled, updated_at";
    `BIN@187292798` "failed to connect app-server remote control websocket `".
14. **Inferred**: The default URL is the ChatGPT backend base (`https://chatgpt.com/backend-api/`)
    joined with `wham/remote/control/server`, converted to `wss://`.
    Evidence: relative path `wham/remote/control/server` (`BIN@187774206`) next to "remote control URL cannot be a base" (`BIN@187740335`);
    the base `https://chatgpt.com/backend-api/` is present. The exact join was not traced in code.
15. **Observed**: The host enrolls with `POST wham/remote/control/server/enroll`
    (`EnrollRemoteServerResponse`, 4 fields, including `expires_at`). It refreshes with
    `wham/remote/control/server/refresh`, proactively before expiry. On HTTP 404 it throws away the stale
    enrollment and enrolls again.
    Evidence: `BIN@187731727` "expires_at struct EnrollRemoteServerResponse with 4 elements"; `BIN@187725456`
    "refresh_url refresh_delay next_refresh_at … proactive remote control server token refresh failed; continuing with valid token";
    `BIN@187288013` "remote control server refresh returned HTTP 404; replacing stale enrollment".
16. **Observed**: The host authenticates with ChatGPT account auth and a server token, not a hardware key.
    Handshake headers are `authorization`, `chatgpt-account-id`, `x-codex-server-id`, `x-codex-name`,
    `x-codex-protocol-version`, `x-codex-host-device-kind`, `x-codex-subscribe-cursor`, and `x-codex-installation-id`.
    The host name comes from `system_profiler SPHardwareDataType` (`machine_name`).
    Evidence: `BIN@~187731500` "x-codex-server-id x-codex-name x-codex-protocol-version 3 authorization x-codex-host-device-kind x-codex-subscribe-cursor missing remote control server token";
    `BIN@187725456` "x-codex-installation-id /usr/sbin/system_profiler -detailLevel SPHardwareDataType -json machine_name";
    `BIN@187740335` "chatgpt-account-id". The enrollment table has no key column. A `device_key_bindings` table was later dropped (`BIN@190310279`).
17. **Observed**: The relay protocol is JSON over WebSocket text frames, not Noise and not protobuf.
    The host drops binary frames. From client to host the envelopes are `client_message`,
    `client_message_chunk`, `ping`, and `client_closed`. From host to client they are `server_message`,
    `server_message_chunk`, `ack`, and `pong`. Every envelope carries `client_id`, `stream_id`, and `seq_id`
    (plus `env_id` and an optional `cursor`). Large messages are split into base64 chunks
    (`segment_id`, `segment_count`, `message_size_bytes`, `message_chunk_base64`).
    Evidence: `BIN@187773963` "server_message server_message_chunk segment_id segment_count message_size_bytes message_chunk_base64 ack … ClientEventPing ClientClosed client_id stream_id seq_id";
    `BIN@187774384` "struct ClientEnvelope … client_message client_message_chunk ping client_closed";
    `BIN@187763033` "dropping unsupported binary remote-control websocket message"; SRC@1295740 zod schemas for the same envelopes.
18. **Observed**: The payload inside `message` is an ordinary app-server JSON-RPC message. The client-side
    transport wraps JSON-RPC in `client_message{client_id,stream_id,env_id,message}` and replays unacked envelopes.
    Evidence: SRC@1298459 `this.unackedEnvelopeBuffer.add({type:`client_message`,client_id:this.requireClientId(),stream_id:n,env_id:e,skip_history:!1,message:t})`.
19. **Observed**: Protocol constants on the client side: protocol version 3, a per-stream ping every 30 s,
    a pong timeout of 10 min, reconnect after 1 s, a handshake timeout of 10 s, 100 KiB segments,
    a 150 KiB frame cap, and a 1 GiB cap on a reassembled message. Sequence gaps force a stream reconnect.
    Evidence: SRC `FU=3e4,IU=6e5,LU=1e3,RU=1e4,zU=4e3,BU=3,VU=102400,HU=153600,UU=1073741824`;
    `"x-codex-protocol-version":String(BU)`; "remote control app-server stream sequence gap detected".
20. **Observed**: On the host, the WebSocket also has a pong timeout and a bounded worker shutdown.
    Evidence: `BIN@187763033` "remote control websocket pong timeout", "timed out waiting for remote control connection workers to stop; aborting".
21. **Observed**: MASQUE/HTTP3 (`codex-portals.api.openai.com`) is NOT the phone path. It is "cloud-portals",
    an SSH-over-QUIC tunnel into cloud environments. Its origins are allow-listed from `masque-proxy-origins.txt`.
    Evidence: MAIN@889948 `logger=f.i(`cloud-portals`)`, `C.default.join(r,`masque-proxy-origins.txt`)`, `shell:`SSH over QUIC``;
    engine "Internal: forward a local TCP socket through an HTTP/3 CONNECT proxy" (`tcp-tunnel`).
22. **Observed**: Noise is also NOT the phone path. The `Noise relay` / "harness rendezvous" code is in
    `exec-server/src/noise_relay/*`. It belongs to remote exec-server environments, where a cloud harness
    executes tools on a registered machine. That code uses the `clatter` crate with a `noise_hybrid_ik_v1`
    scheme and harness-key validation against an environment registry.
    Evidence: `BIN@186604921` "Noise executor … registration noise_hybrid_ik_v1"; `BIN@185429906` "clatter-2.2.0/src/handshakepattern.rs";
    `BIN@188511145` "environment_id url executor_registration_id executor_public_key harness_key_authorization".
23. **Observed**: The exec-server Noise pattern is `Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256`, a post-quantum hybrid IK handshake.
    Evidence: a raw byte grep of the engine binary for `Noise_[A-Za-z0-9_+]+`.

### Authorization and trust

24. **Observed**: Turning on "Allow this device to be discovered and controlled" calls `remoteControl/enable`
    on the local app-server. The renderer then waits up to 5 s for `remoteControl/status/changed` to report
    `connected` or `errored`.
    Evidence: INIT@9776xxx `sendRequest(n?`remoteControl/enable`:`remoteControl/disable`,null)`;
    INIT@2379505 `BNn=5e3`, "Timed out waiting for remote control to connect", `RemoteControlConnectionFailedError`.
25. **Observed**: Enabling host mode first passes an MFA gate. The app reads `GET /wham/remote/control/mfa_requirement`
    and `GET /accounts/mfa_info` (`mfa_enabled_v2`). If MFA is required but off, it sends the user to
    `https://chatgpt.com/#settings/Security?mfa_source=codex_remote`.
    Evidence: INIT@2376757; FLOW `href:`https://chatgpt.com/#settings/Security?mfa_source=codex_remote``;
    SETUP "Turn on Multi-Factor Authentication".
26. **Observed**: The host can list and revoke authorized clients. App-server RPCs are
    `remoteControl/client/list {environmentId,cursor,limit:100,order:"desc"}` and
    `remoteControl/client/revoke {environmentId,clientId}`. The engine calls the backend
    `wham/remote/control/environments/{env}/clients`. Account-wide clients are revoked with
    `DELETE /wham/remote/control/clients/{client_id}`.
    Client fields: `clientId, displayName, deviceType, platform, osVersion, deviceModel, appVersion, lastSeenAt`.
    Evidence: INIT@2379788 `UNn`/`WNn`/`GNn`; INIT@2376362 `safeDelete(`/wham/remote/control/clients/{client_id}`)`;
    `BIN@187740335` "wham/remote/control/environments clients"; `BIN@186637366` "device_type os_version device_model app_version last_seen_at".
27. **Observed**: A controller (the desktop app, and very likely the phone app) has a hardware device key.
    It is a non-exportable ECDSA P-256 key in the Secure Enclave (`protectionClass hardware_secure_enclave`,
    tag `com.openai.codex.device-key.%@.%@`), and on Windows a TPM 2.0 key. The UI errors map to these failures:
    `tpmUnavailable`/`tpmConfiguration` ("cannot use this device's TPM configuration"), `keyStoreUnavailable`
    ("cannot access its secure device-key store"), and `deviceKeyUnusable` ("cannot use its existing device identity").
    Evidence: DK strings "ecdsa_p256_sha256", "hardware_secure_enclave", "Secure Enclave key creation failed", "remote_control_device_key_tpm_configuration";
    MAIN@3017495 `createDeviceKey(`allow_os_protected_nonextractable`)`; SETTINGS `authorize.*` messages.
28. **Observed**: Controller enrollment runs in two steps:
    `POST /codex/remote/control/client/enroll/start` → `device_key_challenge`, then `…/enroll/finish`
    with `{client_id, step_up_token, device_identity, device_key_proof}`. It requires a fresh step-up OAuth
    token: PKCE against `auth.openai.com`, client `app_EMoamEEZ73f0CkXaXp7hrann`, a localhost callback on
    port 1455 or 1457, scope `codex.remote_control.enroll`, `iat` and `pwd_auth_time` no more than 300 s old,
    and a matching account. Refresh uses `…/client/refresh/start|finish` and a device-key proof.
    The result is a `remote_control_token` sent as `x-codex-client-session-token: Bearer …`.
    Evidence: MAIN line 1079 (Q3/d6/$3), line 1092 `J6=`app_EMoamEEZ73f0CkXaXp7hrann``, `$Ge=[1455,1457]`, `tKe=`codex.remote_control.enroll``;
    MAIN `GWe=`codex.remote_control.enroll`,q3=300`.
29. **Observed**: Every controller WebSocket connection must also answer a `device_key_challenge`. The
    signed payload is domain `codex-device-key-sign-payload/v1`, audience `remote_control_client_websocket`,
    scope exactly `remote_control_controller_websocket`, and it includes the SHA-256 of the session token
    and its expiry. A nonce must be at least 32 bytes.
    Evidence: MAIN line 1253 `yKe=`codex-device-key-sign-payload/v1``, "Invalid remote-control device-key connection scopes";
    SRC@1296475 `GU` schema `purpose:`remote_control_client_websocket``.
30. **Observed**: Revocation and stale-enrollment errors are recognized: "Remote-control client not found",
    "Remote-control client has been revoked", "client enrollment is inc…", and "client key material missing".
    Evidence: MAIN line 1079 `lGe`, MAIN@3017495.
31. **Observed**: Administrators can block the feature with a managed `allowRemoteControl` requirement,
    and an env kill switch also exists.
    Evidence: engine "allowRemoteControl" in configRequirements; `BIN@187109424` "RemoteControlDisabledByRequirements";
    "remote control is disabled by managed requirements"; `BIN@186631493` "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED".
32. **Observed**: Version gating for a remote host: a controller treats a host whose `app_server_version` is
    below `0.141.0` as "Please update ChatGPT on the remote device to the latest version". Pairing has a
    separate gate, "Please upgrade to the latest version of the ChatGPT app to pair".
    Evidence: SHARED `function Ryt(e){return e===Hyt||SM(e,AM)>=0}`, `AM=`0.141.0``; SETTINGS `ka`/`Aa` use `Je(e.appServerVersion)`;
    SETUP `codexMobile.setupPage.waiting.upgradeMessage`.

### Availability

33. **Observed**: Host status is `disabled | connecting | connected | errored`. Changes are pushed as the
    notification `remoteControl/status/changed {status, serverName, installationId, environmentId}`.
    Evidence: `BIN@187205776` "RemoteControlConnectionStatus disabled connecting connected errored";
    `BIN@187207465` "RemoteControlStatusChangedNotification status serverName installationId environmentId"; INIT `PNn` subscribes to `remoteControl/status/changed`.
34. **Observed**: Controllers see backend-reported `online`, `busy`, `os`, `arch`, `app_server_version`,
    `installation_id`, and `last_seen_at` for each environment (`GET /codex/remote/control/environments`).
    Only offline environments can be deleted.
    Evidence: MAIN line 1078 (`online:e.online,busy:e.busy,os:e.os,arch:e.arch,appServerVersion:e.app_server_version…`);
    SETTINGS "Only offline environments can be deleted"; "This removes the environment and its remote control tasks from ChatGPT".
35. **Observed**: `remoteControlServerAlreadyOnline` is only the toast ID for the generic error
    "Could not enable remote control". It fires when status becomes `errored`. A separate toast covers an
    invalidated token.
    Evidence: INIT@9776679 `t instanceof zNn?…remoteControlServerAlreadyOnline`, `remoteControlTokenInvalidated`.
36. **Inferred**: The name suggests the backend rejects a second live socket for the same server, which the
    engine also guards against.
    Evidence: engine "enrollment belongs to another remote session".
37. **Observed**: Sleep handling: "Keep this Mac awake" holds an Electron `prevent-app-suspension` power
    blocker while remote control is on and the Mac is on AC power, never on battery.
    Evidence: MAIN line 1024 `!_.powerMonitor.isOnBatteryPower()&&this.pluggedInRemoteControlPowerSaveWebContentsIds.size>0)&&(e=`prevent-app-suspension`)`;
    SETTINGS "Prevent sleep when computer is plugged in and remote access is enabled".
38. **Observed**: When the desktop restarts the engine, it re-sends `remoteControl/enable`.
    Evidence: MAIN line 1024 `t.remoteControlEnabled&&await e.sendAppServerRequest(`remoteControl/enable`,null)`.
39. **Observed**: The enabled preference is persisted, and the engine resumes after auth changes or restarts.
    A CLI-managed daemon can keep hosting without the app open ("enable-remote-control / disable-remote-control: Enable remote control for future starts and a currently running managed daemon").
    Evidence: `BIN@186850391` "UPDATE remote_control_enrollments SET remote_control_enabled"; "retrying app-server remote control websocket after auth changed".
40. **Unknown**: Whether quitting the GUI app stops hosting when no CLI daemon runs. It most likely does,
    because the engine is a child process of the app.

### Capability surface and notifications

41. **Observed**: No per-method allowlist for remote clients was found. Each remote `client_id`/`stream_id`
    is handed to the normal app-server request processors as a connection, so a paired phone reaches the
    full v2 JSON-RPC surface. That includes thread and turn RPCs, fs, command/exec, process/spawn, config
    writes, and the `remoteControl/*` methods themselves.
    Evidence: client_tracker "forwarding remote control connection closed transport event", "connection_opened";
    the full method table in the engine strings; no "not allowed for remote" strings exist. A negative result in strings is weak evidence.
42. **Observed**: The setup UI promises three things: "Pick up where you left off" (continue any chat or
    project), "Start something new" (send a message to start a task on your desktop), and "Stay in the loop"
    (notified when ChatGPT finishes a task or needs your attention). An optional "Use your Mac apps while
    locked" toggle extends this to computer use.
    Evidence: SETUP `codexMobile.setupDialog.initial.feature.*`, `connected.lockedComputerUse.*`, and security notice
    "ChatGPT can access your desktop—including files, apps, and your browser—to complete tasks you send from your phone".
43. **Inferred**: Phone push notifications are generated by the backend from relayed host events. The Mac
    does not send them. No host-side push call was found; the only APNs code registers the Mac's own
    desktop notifications (`/notifications/subscription/register`, `platform:"macos"`).
    Evidence: MAIN@514233 `registerForAPNSNotifications()`. No push-related strings in the remote_control transport.
44. **Observed**: Controller-side limits apply when the desktop controls a remote host: no "VS Code remote
    open", no "open in <app>", no ChatGPT-login forwarding.
    Evidence: MAIN line 1048 "Remote control does not support VS Code remote open yet."; line 1253 "does not support ChatGPT login forwarding yet".

## Topology

```
 iPhone (ChatGPT iOS)                 OpenAI backend (chatgpt.com/backend-api)             Mac (ChatGPT.app)
 --------------------                 ----------------------------------------             -----------------
 device key (SE P-256) ---enroll---> /wham|/codex/remote/control/client/enroll/*
 scan QR  ---------------claim-----> /codex/pair?pairing_code=…  <---- pair/start ---- codex app-server (Rust)
                                      wham/remote/control/server/pair[/status]            |  (child of Electron,
 WSS  /…/remote/control/client  ===>  RELAY  <===  WSS /wham/remote/control/server  <=====+   or CLI daemon)
   JSON envelopes                     routes by env_id / client_id / stream_id            dials OUT only,
   client_message{JSON-RPC}           acks, seq, segments, ping/pong                      auth = ChatGPT token
   <- server_message{JSON-RPC}        push notifications (inferred)                       + server token,
                                                                                          x-codex-server-id
 No inbound port on the Mac. No Noise or MASQUE on this path.
```

## Pairing payload and endpoints

- QR code: `https://chatgpt.com/codex/pair?pairing_code=<pairingCode>`. Error-correction level M, or L in fullscreen. The code expires at `expiresAt`, and the UI auto-refreshes it.
- Manual PIN: `manualPairingCode`, 8 digits. A controller enters it with `POST /wham/remote/control/client/pair {client_id, manual_pairing_code}`.
- The QR carries no server_id, account_id, or public key. The backend binds the code to the host's enrolled environment, so the account identity comes from the phone's own ChatGPT session.

Host (engine → backend, relative to the backend base):
`wham/remote/control/server/enroll`, `…/server/refresh`, `…/server/pair`, `…/server/pair/status`,
`wham/remote/control/server` (WebSocket), `wham/remote/control/environments/{env}/clients` (list/revoke).

Controller (Electron → backend):
`/codex/remote/control/client/enroll/start|finish`, `/codex/remote/control/client/refresh/start|finish`,
`/codex/remote/control/client` (WebSocket), `/codex/remote/control/environments` (GET),
`/codex/remote/control/environments/{env}` (PATCH rename, DELETE),
`/codex/remote/control/clients/{client}/environments`.

Renderer (account-level, via the ChatGPT API client):
`/wham/remote/control/clients` (GET), `/wham/remote/control/clients/{client_id}` (DELETE),
`/wham/remote/control/client/pair` (POST), `/wham/remote/control/mfa_requirement`, `/accounts/mfa_info`.

App-server RPCs: `remoteControl/enable`, `remoteControl/disable`, `remoteControl/status/read`,
`remoteControl/pairing/start`, `remoteControl/pairing/status`, `remoteControl/client/list`,
`remoteControl/client/revoke`; notification `remoteControl/status/changed`.

## Exposed remote capability surface

| What the phone can do | How (app-server JSON-RPC over relay) | Confidence |
|---|---|---|
| See and continue chats and projects | `thread/list`, `thread/read`, `thread/turns/list`, `project/list`, `thread/resume` | Inferred (full surface, no allowlist) |
| Start a new task on the Mac | `thread/start`, `turn/start` | Inferred, and promised in UI copy |
| Steer or stop a running turn | `turn/steer`, `turn/interrupt` | Inferred |
| Approve commands and patches | answer `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | Inferred (server requests exist) |
| Answer agent questions | `item/tool/requestUserInput`, `mcpServer/elicitation/request` | Inferred |
| View diffs and files | `gitDiffToRemote`, `fs/readFile`, `fuzzyFileSearch` | Inferred |
| Use Mac apps (computer use) | gated by the "Use your Mac apps while locked" and "Enable computer use" toggles | Observed (UI); mechanism unknown |
| Get notified when done or blocked | backend push to phone | Inferred |
| Manage devices | the host UI lists and revokes clients; the phone side is unknown | Observed (host) |

Takeaway: the remote client gets essentially the same JSON-RPC power as the local desktop UI. Trust rests
on account authentication, MFA, the hardware device key, pairing, and revocation, not on a narrowed method set.

## Open questions / unknowns

- The exact host WebSocket URL and request body of `server/enroll`. The JSON fields beyond `expires_at` and `remote_control_token` were not decoded.
- Whether the backend relay can read message contents. The design is TLS to OpenAI with no end-to-end encryption between phone and Mac on this path, so inferred: yes.
- Whether any per-client permission profile exists server-side. The `remoteControlClientScopedEnvironments` flag hints at scoping environments per client.
- How phone push notifications are triggered, and what `x-codex-subscribe-cursor` resumes (probably replay of missed server messages after a reconnect).
- The exact behavior when the Mac sleeps or the app quits. Pong timeout and backend `online` flags are the likely signals.

## Implications for Nano Remote

- **Copy:**
  - an outbound-only host;
  - a JSON-RPC payload that is the same protocol the local UI uses;
  - per-client `client_id`/`stream_id` multiplexing with `seq_id` and ack replay, plus a resume cursor;
  - chunking for large messages, with ping every 30 s and a pong timeout;
  - an explicit host status (`disabled/connecting/connected/errored`) with a push notification on change;
  - short-lived pairing codes as QR plus an 8-digit PIN, with polling until `claimed`;
  - a host-side list of authorized devices with revoke;
  - a "keep awake on AC power" option;
  - an MDM and env kill switch.
- **What the Tailscale design replaces:**
  - the OpenAI relay and the server enroll/refresh tokens: the tailnet provides reachability and node identity;
  - MFA and step-up OAuth: Tailscale login plus device approval;
  - the Secure Enclave controller key: a Tailscale node key. A pinned per-device app key is still worth keeping if a revocation finer than the tailnet is wanted.
  - With Tailscale, the Mac can listen on a tailnet-only interface, so no third-party relay sees the traffic.
- **Do not copy:**
  - exposing the full app-server surface to remote clients by default. Prefer an explicit allowlist covering threads, turns, approvals, and user input;
  - backend-held trust that the operator cannot audit.

## Erratum from the runtime capture (2026-10-20)

- Item 12 is wrong in spirit: "slingshot" is not only a MIME type. The relay introduces itself to the
  host with an `initialize` request whose id is `__slingshot_backend_initialize__` and client name
  `codex-backend` ("Codex Remote Control"). See `runtime-capture.md` item 12.
- Item 14 is confirmed: the host URL is exactly `wss://chatgpt.com/backend-api/wham/remote/control/server`
  (enrollment row and live handshake).
- Item 40 is answered: quitting the GUI stops hosting; the engine dies with the app.
- The relay also sends application-level `ping` envelopes with a `cursor`, and the host replies with
  `pong {status}`; the static list of envelope types was correct but incomplete about direction.
