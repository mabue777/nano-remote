# The host is our own Nano Host daemon that drives each agent directly

The Mac-side service is a bespoke daemon (TypeScript on Node, installed as a
launchd service) with one adapter per agent: Codex through its `app-server`
JSON-RPC engine over stdio, Claude Code through the Claude Agent SDK, Kimi
through its streaming CLI. It is not built on the OpenClaw gateway or any other
third-party control plane. Evidence that made this the clear choice: the
reverse engineering and live captures of the ChatGPT/Codex apps
(`docs/research/rea/`) show Codex's engine already provides threads, turns,
approvals, user-input questions, resume with pagination, interrupt and status
over a documented schema, and the phone side is nothing more than a client of
that engine over an envelope stream. ADR 0002's Journal needs our own
sequence semantics, which a gateway's event stream does not give us. A gateway
would add a fast-moving upstream and a different approval model for one agent.
Consequences: pairing, device management, the tailnet transport and the
installer are ours to build (bounded, with the captured patterns as the
template); every adapter normalizes its agent into one protocol vocabulary so
engine churn touches one file; the Phase 0 spike must prove an approval round
trip for Codex and Claude before Phase 1 starts, with Claude's fallback being
its own hooks or streaming CLI mode, never a gateway.
