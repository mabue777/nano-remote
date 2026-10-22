# Nano Remote — what we are building

**A phone app that lets you chat with LLMs and drive coding agents — Claude
Code, Codex, Ollama and any other providers (Kimi later, post-v1, over ACP) — running on your own computer, from anywhere, with the
polish the big vendors ship in their apps.**

Two modes in one app:

- **Local chat** — the phone talks directly to a model provider (Ollama and
  friends). No computer needed.
- **Agent sessions** — the phone connects to your computer and drives live
  agent sessions there. The code, files, credentials, and tools never leave
  your machine; the phone is a fast, synchronized window into the work.

The bar for feel: starting an agent run from the train, locking the phone,
and later opening the app to find the session exactly where it is — with
approvals answered from the phone and a push notification when the work
finishes or needs a decision.

## The reference pattern: how ChatGPT's app does remote work

(Source: OpenAI's "Remote connections" documentation,
https://learn.chatgpt.com/docs/remote-connections — verified 2026-10-20.
Claude and Kimi ship the same pattern; ChatGPT's is documented most clearly.)

1. **The desktop app is the host.** The ChatGPT desktop app runs on your Mac
   or PC, signed into your account, awake and online. It already contains the
   full agent runtime — Codex, shell access, Computer Use, browser, plugins,
   your credentials. A session you drive from the phone *executes there*, on
   your machine, with your local setup.
2. **Nothing connects directly.** Neither device ever opens a connection to
   the other. The desktop app dials *outbound* to OpenAI's cloud and
   registers itself; the phone also talks only to the cloud. OpenAI's
   servers relay between the two. There are no open inbound ports on your
   computer.
3. **Pairing is a QR code.** Setup starts on the computer (Settings →
   Connections → "Control this Mac or PC"); the app displays a QR code; the
   phone scans it. That pairs this phone to that computer inside the
   account, with whatever MFA/SSO the account requires.
4. **The transcript lives in the middle.** Because the cloud stores the
   session state, any device that opens the app sees current state instantly,
   and the phone can lock, switch networks, or die — the session never
   notices. This stored-transcript-in-the-middle is why the apps feel good:
   clients render instantly and catch up, never waiting on round trips.
5. **The phone is a control surface, not a terminal.** Send instructions and
   follow-ups, approve or deny commands, review diffs, test results, terminal
   output and screenshots, switch between connected hosts — and get push
   notifications when work finishes or needs attention. If the computer
   sleeps or goes offline, remote access simply shows unavailable until it's
   back.

## Our architecture — same roles, one substitution

We copy the pattern's shape and substitute its one piece we don't own:

| Role | ChatGPT app | Nano Remote |
| --- | --- | --- |
| Agent runtime on the computer | Their desktop app | Host daemon on your Mac |
| Middle (relay + transcript store) | OpenAI's cloud | **Your Tailscale tailnet + a Journal on the host** |
| Phone client | ChatGPT iOS app | A web app served by the host over the tailnet (native app optional later) |

- **Transport: Tailscale (recorded decision).** The phone reaches the Mac
  over the user's existing tailnet — a private, encrypted, stable address
  that works at home and away, with no relay server to build, no accounts
  system, and no inbound exposure to the public internet.
- **The Journal is our "holding place".** The host daemon keeps an
  authoritative, sequence-numbered event log per session: messages, streamed
  output, tool calls, approval requests. Clients never interrogate the agent
  directly; they subscribe to the Journal and catch up from the last event
  they saw.
- **The phone keeps a Replica.** It renders instantly — your own messages
  appear the moment you tap send, marked "sending" until the host quietly
  acknowledges. Opening the app shows the last known state immediately and
  then fills in what it missed. Disconnects become catch-up events, not
  failures. Push notifications only wake the app; they never carry the
  payload.

This is what makes the app feel like a native app instead of a remote
terminal — the exact quality gap felt in earlier experiments.

## The host side (decided)

- **Nano Host, our own daemon (ADR 0003).** A bespoke TypeScript daemon on
  the Mac, installed as a launchd service, with one adapter per agent: Codex
  through its `app-server` engine, Claude Code through the Claude Agent SDK,
  and later (post-v1) Kimi through `kimi acp`, the Agent Client Protocol. Each adapter turns its agent into the one
  protocol vocabulary (`protocol/protocol-v1.md`), so engine changes touch
  one file. The host owns the Journal, pairing, devices and the tailnet
  endpoint itself; no third-party gateway sits in between.
- **The first phone client is a web app (ADR 0004).** Nano Host serves it
  over the tailnet with Tailscale's HTTPS certificate; you add it to the
  iPhone home screen. No Apple Developer account, no re-signing, updates on
  the next open. A native app stays an option for later and would reuse the
  same protocol.
- **Notifications are Web Push from the host (ADR 0005).** The phone
  subscribes through the browser, the host stores the subscription and signs
  each push with its own key. A push carries only a short title and a link,
  never session content.

The OpenClaw gateway was studied during research and remains a reference
for ideas only (docs/research/); it is not part of the build.

## Where we are

Design records (docs/adr/): transport = Tailscale, no cloud relay (0001);
session state = host Journal with phone Replica (0002); our own host daemon
with one adapter per agent (0003); web client first, native optional (0004);
Web Push from the host (0005). Protocol v1 is frozen
(`protocol/protocol-v1.md`), and the host-drive spike proved an approval round
trip and resume for Codex and Claude Code (`spikes/host-drive/NOTES.md`).

Next: Phase 1 builds the host, Phase 2 the web client (docs/plan/roadmap.md).
