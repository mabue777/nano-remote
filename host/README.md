# host

Nano Host: the always-on Node service on the Mac. It will drive coding agents (Codex first), keep
the per-session Journal, speak protocol v1 over WebSocket, and serve the phone web client from
`host/public` (written by `pnpm -C web build`, not committed). This is the empty scaffold; Phase 1
of `docs/plan/roadmap.md` fills it in.

- Node 22+, pnpm workspace (root `pnpm-workspace.yaml`), ESM, TypeScript strict, vitest.
- `src/generated/` holds types generated from `protocol/schema/*.json` by `scripts/generate-types.mjs`
  (json-schema-to-typescript). The directory is gitignored and regenerated on every verify, so the
  schemas stay the only source of protocol types. Import them through `src/generated/index.ts`
  (one namespace per schema file: `envelope`, `message`, `common`, `methods`, `events`).

- `src/journal/` is the Journal: the per-session, sequence-numbered event log (SQLite via `node:sqlite`,
  default file `~/Library/Application Support/NanoHost/journal.sqlite`, `":memory:"` in tests). It
  assigns `seq`, serves `events/since`, snapshot and history pages, pending requests and session
  summaries, and delivers live events to subscribers without gaps (protocol-v1.md sections 5 and 6).
- `src/stream/` is the envelope stream server (protocol-v1.md sections 2, 3, 4, 10) on the `ws` package:
  authentication at the upgrade through an injected token-to-clientId function, per-direction `seq_id`
  with 4002 on gaps, acks and the 256-envelope / 4 MiB unacked window that holds back Journal events,
  ping/pong with the 90 s timeout and the presence registry, chunking both ways, close codes 4001 to
  4010, and the typed method registry behind the initialize-first rule. `StreamServer.notifyStream` and
  `notifyClient` are the send API for the rest of the host.
- `src/adapters/codex/` is the Codex adapter (protocol-v1.md section 11): `codex app-server` over stdio
  JSON-RPC, one engine process per session in its own process group. `CodexAgent` is the agent the host
  registers (health from the engine binary, models from `model/list`); `CodexAdapter` maps threads,
  turns, items, the three approval kinds and questions onto the session core's adapter events, reports a
  dead engine as `agent/exited`, and resumes the thread on a new engine at the next call. Its tests run
  against `testing/fake-app-server.ts`, a fixture-driven fake engine. `live.test.ts` drives the real
  engine and runs only with `NANO_LIVE_CODEX=1` (never in the gate).
- `src/config/` holds host configuration. `codexConfig()`: engine binary (default: the one bundled with
  ChatGPT.app, or `NANO_CODEX_BIN`), engine home (`NANO_CODEX_HOME`, else `CODEX_HOME`, else
  `~/.config/codex`), the default sandbox (`workspace-write`, or `NANO_CODEX_SANDBOX`) and the fixed
  approval policy `on-request`. The default model is never taken from the user's config.toml.

- `src/cli/` is the `nano-host` command line (bin `dist/cli/main.js`, built by `pnpm -C host build`): the
  config file, the launchd job, the control channel the commands use to reach the running service, the
  structured log, and `HostService`, the composition root that `start` runs (Journal, device store,
  agents, session core, HTTPS server, control channel) with its graceful SIGTERM shutdown.

## Running the host on this Mac

The host runs as a per-user launchd job (ADR 0003). It needs Tailscale running and logged in, with HTTPS
certificates enabled for the tailnet (admin console, DNS page).

1. Build: `pnpm -C host build`. The bin is `host/dist/cli/main.js`; below, `nano-host` means
   `node host/dist/cli/main.js`.
2. Certificate: `nano-host cert` runs
   `tailscale cert --cert-file <config dir>/tls-cert.pem --key-file <config dir>/tls-key.pem <this Mac>.<tailnet>.ts.net`.
   Certificates last 90 days; run it again to renew, then restart the job (step 6).
3. Install: `nano-host install` writes the config file with defaults (first time only), writes
   `~/Library/LaunchAgents/dev.nano-remote.host.plist` (RunAtLoad, KeepAlive, stdout and stderr in
   `~/Library/Logs/NanoHost`) and loads it:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.nano-remote.host.plist`.
   The job runs `node host/dist/cli/main.js start` from this checkout, so rebuild and restart after a pull.
4. Check: `nano-host status` (exit 3 when the host is not running) and
   `launchctl print gui/$(id -u)/dev.nano-remote.host` (look for `state = running`).
5. Pair a phone: `nano-host pair` prints a QR code, the 8-digit code and the URL. Scan the QR with the
   phone camera, or open the URL and type the code. A code works once and lives 5 minutes.
6. Restart (after a rebuild, a new certificate or a config change):
   `launchctl kickstart -k gui/$(id -u)/dev.nano-remote.host`.
7. Uninstall: `nano-host uninstall` runs `launchctl bootout gui/$(id -u)/dev.nano-remote.host` and
   removes the plist. Config, Journal and logs stay; delete `~/Library/Application Support/NanoHost` and
   `~/Library/Logs/NanoHost` to remove everything.

Devices:

```
nano-host devices list                      # client id, name, platform, paired, last seen
nano-host devices rename <clientId> <name>  # e.g. nano-host devices rename dev_8f3a Work iPhone
nano-host devices revoke <clientId>         # a lost phone: its token stops working, its streams close (4003)
```

`status`, `pair` and `devices` talk to the running service over the control channel: HTTP on the Unix
socket `control.sock` next to the config file, authenticated with the secret in `control.secret` (0600,
created by the service). Both live in the config folder, which is 0700.

Config file `~/Library/Application Support/NanoHost/config.json` (0600; written with defaults on first
`start` or `install`, validated on every load; missing keys take the default, unknown keys are errors):

```json
{
  "hostId": "host_…",
  "listenAddresses": [],
  "port": 7420,
  "tls": { "certPath": "…/NanoHost/tls-cert.pem", "keyPath": "…/NanoHost/tls-key.pem" },
  "enabledAgents": ["codex"],
  "codexBinary": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "journalPath": "…/NanoHost/journal.sqlite",
  "logFile": "~/Library/Logs/NanoHost/host.log"
}
```

`listenAddresses: []` means this Mac's tailnet addresses, asked from Tailscale; literal tailnet or
loopback IPs may be listed instead, never a wildcard. Every command takes `--config <path>` for another
file (the control socket and secret then live next to it). `start --insecure-dev` serves plain HTTP on
loopback only, for development.

Logs: one JSON line per event, to stdout and to `~/Library/Logs/NanoHost/host.log`. Under launchd, stdout
and stderr also go to `stdout.log` and `stderr.log` in the same folder. Tokens, pairing codes, cookies and
secrets are never logged (fields with such names are redacted). Follow the log with
`tail -f ~/Library/Logs/NanoHost/host.log`.

Shutdown: on SIGTERM (`launchctl bootout`, `kickstart -k`, logout) pongs report `draining` and new streams
are refused with 4010 for a moment, then every stream closes with 4010, the engines stop, the Journal is
closed (its write-ahead log is checkpointed), and the process exits 0.

## Development commands

From the repo root:

```
pnpm -C host generate    # regenerate protocol types for host/ and web/
pnpm -C host typecheck   # tsc --noEmit
pnpm -C host test        # vitest run
pnpm -C host test:coverage  # vitest with v8 coverage; fails below 95% on src/journal or src/stream, 90% on src/core or src/adapters/codex (on demand, not in the gate)
NANO_LIVE_CODEX=1 pnpm -C host exec vitest run src/adapters/codex/live.test.ts  # the real Codex engine (login and tokens needed)
pnpm -C host build       # emit dist/ (excludes tests), including the nano-host bin
pnpm -C host verify      # generate + typecheck + test; the gate
```
