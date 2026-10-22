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
- `src/adapters/claude/` is the Claude Code adapter (protocol-v1.md section 11): the Claude Agent SDK's
  `query()` in streaming-input mode, one Claude Code process per session in its own process group.
  `ClaudeAgent` is the agent the host registers; `ClaudeAdapter` maps the SDK's messages and `canUseTool`
  onto the same adapter events. Its tests run against `testing/fake-query.ts`; `live.test.ts` drives the
  real engine and runs only with `NANO_LIVE_CLAUDE=1` (never in the gate).
- `src/config/` holds host configuration. `codexConfig()`: engine binary (default: the one bundled with
  ChatGPT.app, or `NANO_CODEX_BIN`), engine home (`NANO_CODEX_HOME`, else `CODEX_HOME`, else
  `~/.config/codex`), the default sandbox (`workspace-write`, or `NANO_CODEX_SANDBOX`) and the fixed
  approval policy `on-request`. The default model is never taken from the user's config.toml.
  `claudeConfig()`: the Claude config folder (`NANO_CLAUDE_CONFIG_DIR`, else `CLAUDE_CONFIG_DIR`, else
  `~/.claude`), the executable (`NANO_CLAUDE_BIN`, else the build bundled with the SDK) and the default
  model `opus`.

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
  "claudeConfigDir": "/Users/me/.config/claude",
  "claudeExecutable": "/path/to/claude",
  "journalPath": "…/NanoHost/journal.sqlite",
  "logFile": "~/Library/Logs/NanoHost/host.log"
}
```

`listenAddresses: []` means this Mac's tailnet addresses, asked from Tailscale; literal tailnet or
loopback IPs may be listed instead, never a wildcard. Every command takes `--config <path>` for another
file (the control socket and secret then live next to it). `start --insecure-dev` serves plain HTTP on
loopback only, for development.

`enabledAgents` lists the agents the host offers: `"codex"`, `"claude"` or both (default `["codex"]`).
`"claudeConfigDir"` and `"claudeExecutable"` are optional and only matter for Claude Code (below); both
must be absolute paths when present.

Claude Code: the host drives it through the Claude Agent SDK, which brings its own Claude Code build (a
platform package installed with the host's dependencies), so no separate install is needed;
`"claudeExecutable"` points the host at another `claude` executable instead. The engine signs in with the
login in a Claude config folder, the one `claude` itself uses: `~/.claude` by default, or the folder your
shell exports as `CLAUDE_CONFIG_DIR` (on this Mac `/Users/mabue/.config/claude`). launchd starts the host
with a bare environment (PATH only), so it never sees your shell's `CLAUDE_CONFIG_DIR`: set
`"claudeConfigDir"` to that folder whenever it is not `~/.claude`. To enable Claude Code, sign in once with
`claude` in a terminal, add `"claude"` to `enabledAgents` (for example `["codex", "claude"]`), set
`"claudeConfigDir"` if needed, and restart the job (step 6). `nano-host status` then lists `claude ready`,
or `claude unavailable` with the reason (for example a missing config folder). Sessions run with your
login but without your Claude settings files (`settingSources: []`), so approvals always reach the phone.

Optional `"vapidContact"` sets the contact the host names to push services (the VAPID `sub` claim), for
example `"mailto:me@example.org"` or `"https://example.org"`. It must be `https:` or `mailto:` with a
real domain; `localhost` is refused, because Apple's push service rejects every push signed with it
(403 `BadJwtToken`). Without it the host uses `https://github.com/mabue77/nano-remote`. When a push
service refuses a push, `host.log` shows its reason on the `push.sent` line (`reason=BadJwtToken`).

Logs: one JSON line per event, to stdout and to `~/Library/Logs/NanoHost/host.log`. Under launchd, stdout
and stderr also go to `stdout.log` and `stderr.log` in the same folder. Tokens, pairing codes, cookies and
secrets are never logged (fields with such names are redacted). Follow the log with
`tail -f ~/Library/Logs/NanoHost/host.log`.

Troubleshooting: if the job restarts every 10 s and `host.log` shows `host.start_failed` with
`tailscale status: output is not JSON: "The Tailscale GUI failed to start …"`, the Tailscale app binary
started in GUI mode because launchd gives it no terminal. The host sets `TAILSCALE_BE_CLI=1` on every
Tailscale call to force CLI mode; rebuild and restart the job if you see this on an older build.

Shutdown: on SIGTERM (`launchctl bootout`, `kickstart -k`, logout) pongs report `draining` and new streams
are refused with 4010 for a moment, then every stream closes with 4010, the engines stop, the Journal is
closed (its write-ahead log is checkpointed), and the process exits 0.

## Security

Bypass approvals: the new-session sheet has a switch "Bypass approvals (full access)". It is off by
default and applies to the one session it starts (the phone remembers the last choice per agent). With it
on, the session starts with `settings.approvalMode: "never"`, and the Codex adapter sends
`approvalPolicy: "never"` with `sandbox: "danger-full-access"` (the `--yolo` equivalent; an explicit
`settings.sandbox` wins). The agent then runs any command and edits any file the Mac user can reach,
without an approval card or a push, so anyone holding a paired phone can do the same through it. The
session header shows a red "Bypass" marker for as long as the session runs this way. Sessions started with
the switch off keep the host default (`on-request`, `workspace-write`).

For Claude Code the same switch maps `approvalMode: "never"` to Claude's permission mode
`bypassPermissions` (with `allowDangerouslySkipPermissions`): every tool runs without asking, with the same
full access to what the Mac user can reach. `acceptEdits` and `plan` pass through as the Claude modes of
those names; anything else is Claude's `default` mode, where every command, file edit and question comes
to the phone as an approval card. The session header shows the same red "Bypass" marker.

## Development commands

From the repo root:

```
pnpm -C host generate    # regenerate protocol types for host/ and web/
pnpm -C host typecheck   # tsc --noEmit
pnpm -C host test        # vitest run
pnpm -C host test:coverage  # vitest with v8 coverage; fails below 95% on src/journal or src/stream, 90% on src/core or src/adapters/codex (on demand, not in the gate)
NANO_LIVE_CODEX=1 pnpm -C host exec vitest run src/adapters/codex/live.test.ts  # the real Codex engine (login and tokens needed)
NANO_LIVE_CLAUDE=1 pnpm -C host exec vitest run src/adapters/claude/live.test.ts  # the real Claude engine (login and tokens needed)
pnpm -C host build       # emit dist/ (excludes tests), including the nano-host bin
pnpm -C host verify      # generate + typecheck + test; the gate
pnpm -C host acceptance  # the Phase 1 acceptance against the real host and Codex (below); not in the gate
pnpm -C host acceptance:claude  # the same eight steps against Claude Code (Phase 4); not in the gate
```

## Host acceptance (Phase 1 Codex, Phase 4 Claude Code)

`pnpm -C host acceptance` checks the Phase 1 acceptance of `docs/plan/roadmap.md` section 4 end to end:
the real `nano-host` CLI, the real Codex engine, and a scripted client (`scripts/acceptance.ts`).
`NANO_ACCEPTANCE_AGENT=claude pnpm -C host acceptance` (or `pnpm -C host acceptance:claude`) runs the same
eight steps against Claude Code for Phase 4: the host config enables only `claude` with `claudeConfigDir`
from `CLAUDE_CONFIG_DIR` (else `~/.claude`), the session starts with default settings, and the first turn's
approval is Claude's Write call (`fileChange`). Step 6 also lists the engine session id from every
Claude `system/init` in the host log: one id across both host processes shows the session was resumed.

- Needs: the agent's engine logged in (the same setup as its live test above). It spends a few real
  tokens and takes about 15 seconds. It touches nothing outside a temporary folder: its own config folder
  (config, Journal, control socket, log), a free loopback port, and a temporary project folder for the agent.
- What it does: generates the protocol types, builds `dist/`, then runs the eight steps: start the host
  with `start --insecure-dev`; pair two clients with `nano-host pair` and `POST /v1/pair`; start a session
  (Codex: read-only sandbox; Claude Code: default settings) and a turn that must write `hello.txt`; accept the approval, wait for
  `turn/completed` and check the file; SIGKILL the host and start it again with the same config folder; while
  the first client is away, the second runs a follow-up turn that must name the file (the resumed session
  remembers); the first client reconnects with its token and `session/open` with its saved cursor returns
  events mode with exactly the missed events; `session/open` without a cursor returns a snapshot with both
  turns; `device/list` shows both clients and `device/revoke` closes the second client's stream with 4003.
- Output: one timestamped line per step on stdout and in `acceptance/host-<agent>.log` (rewritten on every run).
  Exit 0 only when every step passes; the last line says `passed` or `FAILED` with the reason. On failure
  the temporary folder is kept (its path is on the first line) so its `config/host.log` and Journal can be read.
- Evidence: the committed `acceptance/host-v0.log` is the Phase 1 Codex run (before the script took an
  agent; a new Codex run writes `host-codex.log`), `acceptance/host-claude.log` the Phase 4 Claude Code run. `acceptance/coverage.txt` is the
  `src/journal` and `src/stream` summary of `pnpm -C host test:coverage` (both at least 95%); refresh it by
  running that command and copying those rows.
