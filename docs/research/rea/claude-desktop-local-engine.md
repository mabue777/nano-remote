# REA findings: how Claude.app drives agents locally, and the better path for Nano

Date: 2026-10-28. Reverse engineering of the installed Claude desktop app
(`/Applications/Claude.app`, Electron, `CFBundleShortVersionString` 4.29.0,
bundle `com.anthropic.claudefordesktop`, team `Q6L2SF6YDW`) on the operator's
Mac (macOS 26.6.2). Method: static reconstruction with REA
(`rea analyze-javascript-application`, skill `reverse-engineer-anything`) plus
byte-level string/strings evidence and read-only Accessibility probing. No app
code was executed by the analyzer; no injection tooling was built.

Labels follow the repo convention: **Observed** = seen directly in shipped
code, strings, config, schema or a read-only probe. **Inferred** = best
explanation of observed facts. **Unknown** = not established.

Primary REA Evidence: `ev_c2455ba12cc94712ebc53f8d6f2debf6434f88a995c5a070caa9da0c8a3145c4`
(static reconstruction of `.vite/build/index.chunk-smg-p8oI.js`, the main-process
chunk carrying engine-spawn and remote-control logic; root artifact sha256
`3e99c32b1f52f9ebc42041202c699aebb2fa235ecab0f88329fc5b0beeb541d6`). The record
is a partial, caller-scoped graph: 636 inventoried files were left outside scope,
and static relationships do not prove runtime execution (REA limitations,
preserved verbatim in the Evidence record).

## Why this report exists

The operator asked whether Nano Remote could "pilot" Claude.app from the phone:
a touch-native Nano UI whose backend is the real desktop app, with full
computer functionality. An earlier chat answer proposed window pixel-streaming
plus a native action layer. This REA was run to check for a materially better
path. It found one, and it does not involve piloting the GUI.

## A. What Claude.app actually is (topology)

1. **Observed.** Claude.app embeds the real Claude Code engine and runs it as a
   local child process. It bundles `claude-code` **2.1.309** under
   `~/Library/Application Support/Claude/claude-code/2.1.309/<hash>/claude.app/Contents/MacOS/claude`
   (a nested, separately code-signed CLI), and spawns it through the Claude
   Agent SDK's spawn seam: the strings `spawnClaudeCodeProcess` (x14 in the
   asar; a `createSpawnFunction(...)` factory in the main chunk),
   `pathToClaudeCodeExecutable` (x25), `getHostAuthToken` (x20). This is the
   same SDK entry Nano's own Claude adapter already uses
   (`host/src/adapters/claude/adapter.ts`: `query({ spawnClaudeCodeProcess,
   canUseTool, permissionMode, settingSources, ... })`).
2. **Observed.** Each surface is tagged with `CLAUDE_CODE_ENTRYPOINT`. The
   enumerated entrypoints include `claude-desktop`, `claude-desktop-3p`,
   `local-agent`/`local_agent`, `remote`, `remote_desktop`, `remote_mobile`,
   `remote_projects`, `remote_cowork`, `remote_trigger`, `ssh-remote`,
   `claude-in-slack`, `claude-in-teams`, plus `cli`, `mcp`, `sdk-cli`,
   `sdk-ts`, `sdk-py`. The desktop GUI is one entrypoint over the engine; the
   phone surfaces (`remote_mobile`) are others over the same engine.
3. **Observed.** Approvals and questions cross the same SDK callback Nano
   already implements: `canUseTool` (x123) and `permissionMode` (x619) appear
   throughout the desktop chunk. The GUI's permission prompts are the SDK's
   `canUseTool`, not GUI-only logic.
4. **Observed.** "Cowork" is Claude Code running inside a downloadable Linux
   microVM, not GUI magic. The app ships a `claude-code-vm` manifest listing
   `rootfs.img` versions (e.g. sha `072b6cbf…`, ~1.24 GB, published 2026-10-22)
   under `files.unix.arm64`, stored at
   `~/Library/Application Support/Claude/claude-code-vm/`. A config flag
   `lastSeenRequireCoworkFullVmSandbox` and strings `space_not_running`,
   "spawning in the workspace VM" confirm an engine-in-VM model.
5. **Observed.** Browser/Chrome control is a local **unix-socket bridge**, not a
   GUI capability. A `browser-env-bridge` creates a chmod-0600 unix socket and a
   shim, and injects `BROWSER=<shim>` plus a 32-byte key into the engine's
   environment (`{socket, key}` marker). It is a local, key-gated IPC the engine
   talks to — the same shape an MCP/tool bridge has.
6. **Observed.** MCP connectors are plain config: `mcpServers` (x249),
   `claude_desktop_config` (x98), and this Mac's
   `~/Library/Application Support/Claude/claude_desktop_config.json`
   (currently `mcpServers: []`). Connectors are declared data the engine loads,
   not GUI state.
7. **Observed.** Sessions the GUI creates live in a store keyed by account UUID:
   `~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/`
   (here holding `scheduled-tasks.json`), alongside the standard Agent-SDK
   `~/.claude/projects/*` JSONL transcripts and `~/.claude.json`. These are the
   same resume inputs Nano's adapter already accepts (`query({ resume })`).

## B. The remote-control surface Anthropic ships (and why it is not Nano's path)

8. **Observed.** The app has a first-party "Remote Control" relay: entrypoints
   `remote_mobile`/`remote_desktop`, enum values `RemoteControlAccess`,
   `RemoteControlOffKeepsLocal`, `coworkRemoteControlOffKeepsLocal`, a
   control-plane bootstrap (`/v1/desktop/orgs/<org>/bootstrap`), a "local
   pairing" subsystem (`localPairingDisabledReason`, liveness probes,
   `resetLocalPairingIdentity`, an Ed25519 pinned key
   `MCowBQYDK2VwAyEA…`), an outbound reconnecting WebSocket with identity probes,
   and an inference-relay path (`onInferenceRequest`). Shape matches the Codex
   REA (`codex-desktop-remote-control-host.md`): outbound only, account-gated,
   device-keyed, relayed through the vendor cloud.
9. **Inferred.** This is the official phone→Mac path (the feature memo's
   "Remote Control"). Nano could not ride it without Anthropic's cloud relay,
   account/MFA auth, and the pinned control-plane identity — which contradicts
   ADR 0001 (Tailscale, no cloud relay) and the whole point of driving over the
   operator's own tailnet. So it is evidence of what the app does, not a Nano
   integration surface.

## C. Doors that are closed (confirming the pixel/AX ceiling)

10. **Observed.** Chrome DevTools control is deliberately locked. The main
    process denies launch when any debug/network-override switch is present
    (`remote-debugging-port`, `remote-debugging-pipe`, `inspect*`,
    `disable-web-security`, …) unless `CLAUDE_CDP_AUTH` + `CLAUDE_USER_DATA_DIR`
    carry a token whose middle segment base64-decodes to the userData path and
    whose signature verifies against Anthropic's key, with a timestamp TTL
    (function `GZ()`/`IZ()`; "refusing to start — a debugging or network-override
    switch is present"). The config-file `chromiumFlags` route is allowlisted to
    GPU/rendering switches only. Fuses: `EnableNodeCliInspectArguments` Disabled,
    `RunAsNode` Disabled, `OnlyLoadAppFromAsar` + asar integrity Enabled. No
    forgeable CDP hook.
11. **Observed.** Accessibility is attachable but thin for control. With AX
    trusted, attaching flips Chromium's a11y on
    (`accessibility support enabled features=nativeAPIs,webContents,…screenReader`
    in Claude's own log), so content is in principle readable — but the window's
    tree is a large virtualized web structure, and `AXWindows` aliases the
    application element, making it a brittle automation substrate, not a clean
    model. Good as an accessory signal (e.g. "an approval is showing"), poor as
    a primary control plane.

## D. Conclusion: the better path for Nano

12. **Inferred, high confidence from A.** "Full Claude functionality on the
    phone" does **not** require piloting the Claude.app GUI. The desktop app is
    a thin Electron shell over: the Claude Code engine (which Nano already
    drives via the Agent SDK), MCP connectors (config), a Cowork microVM (a
    downloadable rootfs + the same engine with `--entrypoint remote_cowork`),
    and a local browser-bridge socket. Every one of those is engine/CLI/MCP/
    config — reachable by Nano Host natively, over the tailnet, with no vendor
    relay.
13. **The recommended approach** (supersedes window pixel-streaming as the
    primary plan): extend Nano's existing Claude adapter rather than remote the
    GUI.
    - a. **Session discovery/resume** of GUI-created sessions from the
      account-scoped and `~/.claude` stores (item 7), so the phone opens the
      very conversations the desktop started.
    - b. **Connector/MCP parity** by reading/merging `claude_desktop_config.json`
      `mcpServers` into the adapter's `query()` options (item 6), so the phone
      session has the same tools as the desktop.
    - c. **Cowork parity (optional, heavier)** by driving the engine with the
      Cowork entrypoint against the same `claude-code-vm` rootfs (item 4); the
      only genuinely visual remainder is Cowork's artifact canvas.
    - d. **Browser tool** by letting the adapter stand up the same
      `browser-env-bridge`-style local socket (item 5) instead of screen-driving
      Chrome.
14. **What still needs pixels or is out of reach:** the Cowork visual artifact
    canvas and any pure-GUI chrome (item 13c), and the vendor Remote Control
    relay (item 9, intentionally cloud/account-bound). Pixel streaming drops
    from "the plan" to a narrow fallback for the visual-artifact case only.

## E. Residual unknowns

- The exact on-disk schema of `claude-code-sessions/<acct>/<org>/` beyond
  `scheduled-tasks.json` (only one Mac observed; transcript JSONL format assumed
  to match `~/.claude/projects`). **Unknown** until a session is captured.
- Whether two live drivers on one engine session conflict (desktop open + Nano
  resuming the same session id). Claude forks on resume in Nano's current tests;
  behavior against a desktop-held session is **Unknown** — needs a field check.
- 636 files were outside the scoped REA graph; absence of a finding there is not
  proof of absence (REA limitation, item preserved from Evidence record).
