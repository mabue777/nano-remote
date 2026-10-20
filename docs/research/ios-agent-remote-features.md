# Research memo: phone-drives-your-computer features in the Claude, ChatGPT, and Kimi apps

Date: 2026-10-20. Method: direct fetch of official vendor documentation pages
(primary sources only), each cited with URL. All three vendors ship the exact
pattern the NANO-REMOTE vision refers to; this memo describes each and
distills the common architecture.

Verdict up front: **all three vendors converge on the same design — the agent
always executes on your computer; the phone is a synchronized "window" into
that local session; the vendor's cloud is only a relay + login; pairing is by
QR code / same account. None of them opens inbound ports on the machine.**

---

## 1. Claude — "Remote Control" (Claude Code)

Source: Claude Code docs, "Continue local sessions from any device with Remote
Control", https://code.claude.com/docs/en/remote-control (accessed 2026-10-20).
Cloud-session counterpart: https://code.claude.com/docs/en/claude-code-on-the-web

- **Execution stays local.** Remote Control connects claude.ai/code or the
  Claude iOS/Android app "to a Claude Code session running on your machine…
  Claude keeps running locally the entire time, so your code execution and
  filesystem access stay on your machine." Computer must stay on and the
  `claude` process must keep running.
- **Start it three ways:** `claude remote-control` (server mode, headless,
  serves multiple sessions), `claude --remote-control` / `--rc` (interactive
  session also available remotely), or `/remote-control` (`/rc`) inside a
  running session to hand it over, carrying conversation history. Also
  available in the VS Code extension and Desktop app Code tab.
- **Transport/security:** the local session "makes outbound HTTPS requests
  only and never opens inbound ports"; it registers with the Anthropic API and
  polls; phone traffic is routed over that streaming connection, all TLS.
  Multiple short-lived single-purpose credentials. Session transcript is stored
  on Anthropic servers for multi-device sync + reconnect after drops (retained
  per data-usage policy; Zero-Data-Retention orgs can't use it).
- **Connect from phone:** session URL, QR code (toggle with spacebar in server
  mode), or find it in the session list in the Claude app / claude.ai/code.
  Sessions show a computer icon + green status dot when online.
- **Multi-surface sync:** terminal, browser, and phone interchangeable —
  conversation, subagents, and workflows stay in sync across all devices.
  Phone can attach images/files (downloaded to the machine, passed as @ refs).
- **Approvals on phone:** permission prompts and AskUserQuestion questions are
  forwarded and stay open until answered; other dialogs time out after 5 min
  (configurable `dialogExpiry`).
- **Recovery:** laptop sleeps/network drops → reconnects automatically when
  back online; server mode gives up after ~10 min outage; crashed sessions in
  server mode are re-served when you message them.
- **Push notifications (iOS/Android):** Claude pushes when a long task
  finishes or needs a decision ("Push when Claude decides", "Push when actions
  required"), skipped while you're typing/at the machine
  (`CLAUDE_CLIENT_PRESENCE_FILE`). Phone refreshes its push token when the app
  is opened.
- **Enterprise security:** optional "Trusted Devices" (beta) — per-device
  enrollment, biometric step-up (Face ID/Touch ID/passkey) for sign-ins older
  than 18 h, device revocation page.
- **Gating:** Pro/Max/Team/Enterprise subscription; no API-key auth; must use
  api.anthropic.com (no Bedrock/Foundry/custom base URL).
- **Limits:** one remote session per interactive process (server mode for
  concurrency); process must stay alive (tmux advised).

## 2. ChatGPT — "Remote connections" (Codex)

Source: ChatGPT Learn docs, "Remote connections",
https://learn.chatgpt.com/docs/remote-connections (accessed 2026-10-20).

- **Host = the ChatGPT desktop app** on macOS/Windows, awake, online, signed
  into the same account + workspace. In the iOS app you open **Codex** (older
  builds: **Remote**) and pick the connected computer.
- **Everything local stays local:** "uses the connected host's projects,
  chats, files, credentials, permissions, plugins, Computer Use, browser
  setup, and local tools."
- **Pairing:** setup starts in the desktop app (Settings > Connections >
  Control this Mac or PC) and shows a QR code; scanning pairs that phone with
  that host (per-phone-per-host). Account + workspace MFA/SSO/passkey steps
  apply; workspace admins can gate it.
- **What you can do remotely:** start/continue chats in host projects, send
  follow-ups and steer, **approve commands and other actions**, review
  outputs/diffs/test results/terminal output/screenshots, get **notified when
  a task completes or needs attention**, switch between multiple connected
  hosts.
- **Availability semantics:** if the computer sleeps, loses network, or the
  app closes, remote access stops until it's back ("keep it plugged in"; host
  setting to keep awake; lid-closed Mac needs external display).
- **Also:** connect the app to projects on an **SSH host**; and a separate
  "Local computer access with Work Cloud" mode where OpenAI's cloud
  coordinates and can fall back to a cloud container (without local files)
  when the machine is unavailable.

## 3. Kimi — "Remote Control" (Kimi Code CLI, `kimi rc`)

Source: Kimi Code docs, "Remote Control",
https://moonshotai.github.io/kimi-code/en/guides/remote-control.md (accessed
2026-10-20). Repo: https://github.com/MoonshotAI/kimi-code (open source, MIT).
Shipped in Kimi Code 0.39.0, experimental.

- **Start:** `kimi rc` (alias `kimi remote`), `kimi web --remote-control`, or
  `/remote-control` (`/rc`) inside a session. Foreground process prints an
  access URL (`https://code-rc.kimi.com/devices/<device-id>/`), a QR code
  (also saved as PNG), and opens the browser. One instance per machine; lock
  file at `~/.kimi-code/server/rc.json`.
- **Phone side is a web page**, not an app screen: open URL / scan QR, then
  **log in with the same Kimi account** (paid membership required); pick the
  machine by hostname in the device list. ~3 devices per account.
- **Relay architecture:** remote access "goes through the Kimi relay service";
  the local server binds loopback only (`--host` LAN sharing explicitly
  unsupported). "Tasks always run on your machine — the web page is just a
  remote window."
- **Capabilities remotely:** send new tasks, watch real-time progress/tool
  use, continue conversations, inspect tool call I/O, **handle approvals**
  (file edits, shell execution), interrupt/stop tasks, track subagents and
  workflows.
- **Recovery:** closing the browser doesn't stop the task; network loss
  auto-reconnects to the relay; sleep drops the connection (advice: never
  sleep); local files, MCP, shell all remain local-only (table in the doc).
- **Security:** URL contains no secrets; everything gated by account login
  after opening; startup warns the link is a full control entry point —
  "anyone who has it may control your sessions and files. Do not share it."
- Notably, Kimi Code also speaks **Agent Client Protocol** (`kimi acp`) so
  editors (Zed, JetBrains) can drive sessions over stdio — evidence that an
  open stdio-driving protocol for coding agents exists and is in production
  use. (https://moonshotai.github.io/kimi-code/en/ README section "Use it in
  your editor (ACP)", accessed 2026-10-20.)

---

## Synthesis — the reference architecture all three share

1. **A long-lived host process on your computer** owns the agent sessions and
   all execution (files, shell, creds, MCP never leave the machine).
2. **The vendor cloud is a relay, not a runtime** — the host connects OUT
   (outbound HTTPS/streaming only, zero inbound ports); phone traffic flows
   through the relay, TLS everywhere, gated by account login.
3. **Pairing is QR / same-account**; the phone appears as a device; hosts show
   online/offline status dots.
4. **The phone is a thin synchronized window:** prompt, steer, approve tool
   calls, inspect output/diffs, multi-surface in sync; sessions keep running
   and re-attachable when the phone locks or drops.
5. **Push notifications** when long work finishes or a decision is needed;
   suppressed while you're active at the machine.
6. **Failure honesty:** machine asleep/offline = clearly shown offline; tasks
   pause; auto-reconnect on return.

## Implications for NANO-REMOTE (flagged for the design interview)

- The pattern the user is pointing at is real, current, and uniform across all
  three vendors — our fork should copy its *shape*: host process + relay-ish
  transport + thin synced phone client with approvals and push.
- The component we cannot copy is the vendor account-cloud relay. Our
  transport choice is the key decision: own relay (infra/accounts/cost),
  Tailscale overlay, or LAN-only v1.
- ACP (Agent Client Protocol) deserves a serious look as the uniform
  host↔agent driving layer instead of bespoke per-CLI screen scraping.
- Approval forwarding, interruption recovery, and push-approval UX are
  first-class features in all three — expect them in our spec, not as polish.
