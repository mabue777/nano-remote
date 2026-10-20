# Nano Remote

A phone app (fork of nano-ai) that chats with local Ollama models AND can
connect to your computer to drive coding agents there — the way Kimi, Claude
Code, and Codex let you work on your machine from your phone.

## Language

**Host**:
Your computer — the always-on machine where agent sessions actually execute.
_Avoid_: server, machine, desktop

**Agent session**:
A live conversation with a coding agent (Kimi, Claude Code, Codex) that runs
on the host, driven from the phone.
_Avoid_: job, task ("task" belongs to the issue tracker), run

**Local chat**:
nano-ai's existing mode — the phone chats directly with an Ollama model, no
host involved.
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
