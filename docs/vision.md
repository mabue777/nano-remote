# Nano Remote — what we are building

**A phone app that lets you chat with LLMs and drive coding agents — Claude
Code, Codex, Kimi — running on your own computer, from anywhere, with the
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
| Phone client | ChatGPT iOS app | Our app |

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
  failures. Push notifications (and glanceable Live Activities) only wake the
  app; they never carry the payload.

This is what makes the app feel like a native app instead of a remote
terminal — the exact quality gap felt in earlier experiments.

## The host side (working direction, pending final confirmation)

The **OpenClaw gateway** — already running locally — is the recommended host
daemon, rather than building one from scratch. It is Tailscale-native
(loopback daemon with tailnet serving built in), has cryptographic device
pairing, and exposes both a plain chat endpoint (compatible with standard LLM
API clients — phase one) and a full event socket with sessions, approvals,
and run state (phase two). Claude Code driving is built in; Codex goes
through its harness; Kimi driving is the open gap the prototype phase must
validate — with a bespoke daemon as the documented fallback if validation
fails.

## Where we are

Design records so far (docs/adr/): transport = Tailscale, no cloud relay
(0001); session state = host Journal with phone Replica (0002). Full vendor
feature research and OpenClaw protocol recon live in docs/research/.

Next: a prototype validates driving the three coding agents (approvals above
all) through the host; then the plan becomes a spec and tickets; then build
work is dispatched.
