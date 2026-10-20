# Nano Remote

A phone app that chats with LLMs and can connect to your computer to drive
coding agents there (Claude Code, Codex, Kimi) — the way the Claude, ChatGPT,
and Kimi mobile apps do it. Fresh codebase; direction and vocabulary
informed by research on nano-ai, the OpenClaw gateway, and the vendor
remote-control features (docs/research/).

## Language

**Host**:
Your computer — the always-on machine where agent sessions actually execute.
_Avoid_: server, machine, desktop

**Agent session**:
A live conversation with a coding agent (Kimi, Claude Code, Codex) that runs
on the host, driven from the phone.
_Avoid_: job, task ("task" belongs to the issue tracker), run

**Local chat**:
The mode where the phone chats directly with a model provider (Ollama and
friends), with no host involved.
_Avoid_: offline chat

**Journal**:
The host-side, sequence-numbered event log that is the single source of truth
for a session — messages, streamed output, tool calls, approval requests.
Clients never wait on it; they subscribe and catch up.
_Avoid_: buffer, queue, transcript

**Replica**:
The phone's local copy of a session's Journal, rendered instantly (including
optimistic "sending" states) and brought current by catching up from its last
seen event.
_Avoid_: cache, local copy
