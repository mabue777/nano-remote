# Nano Remote

A phone client that chats with LLMs directly and connects to your own Mac to
drive coding agents there (Claude Code and Codex in v1; Kimi later, post-v1, over ACP), the way the Claude,
ChatGPT and Kimi mobile apps do it. The Mac runs Nano Host, our own daemon
with one adapter per agent (ADR 0003); the first phone client is a web app
that Nano Host serves over your Tailscale tailnet (ADR 0004), and
notifications are Web Push sent by the host (ADR 0005). The wire format is
`protocol/protocol-v1.md`; the terms below are the shared vocabulary.

## Language

**Host**:
Your computer — the always-on machine where agent sessions actually execute.
_Avoid_: server, machine, desktop

**Agent session**:
A live conversation with a coding agent (Claude Code, Codex; Kimi later) that runs
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

**Nano Host**:
Our own daemon on the host (TypeScript on Node, a launchd service). It runs
one adapter per agent, keeps the Journals, handles pairing and devices, serves
the web app, and sends Web Push.
_Avoid_: gateway, server, backend

**Adapter**:
The part of Nano Host that drives one agent (Codex app-server, Claude Agent
SDK; Kimi CLI over ACP, later) and normalizes it into the protocol's session, turn, item and
request vocabulary. It is the only code that knows the agent's own method names.
_Avoid_: driver, plugin, connector

**Envelope**:
The outer frame of every WebSocket message (`client_message`,
`server_message`, their chunks, `ack`, `ping`, `pong`, `client_closed`),
carrying `client_id`, `stream_id` and a per-stream `seq_id`. It gives ordering,
presence and chunking; the message inside carries the meaning.
_Avoid_: packet, frame (a frame is the WebSocket unit that carries one envelope)

**Stream**:
One WebSocket between a client and Nano Host, named by a `stream_id` the
client picks. A stream is never resumed: a new socket is a new stream, and the
client catches up from the Journal instead.
_Avoid_: connection, channel, session (a session is the agent conversation)

**Client (paired device)**:
One paired device, identified by the `client_id` issued at pairing. A client
opens many streams over its life and keeps its own Replica.
_Avoid_: user, phone (when the device kind does not matter), app

**Cursor**:
The `seq` of the last Journal event a client has applied for a session. The
client sends it to `session/open` or `events/since` and receives every event
after it. Journal `seq` is durable; envelope `seq_id` is not a cursor.
_Avoid_: offset, position, seq_id

**Snapshot**:
The `session/open` answer when there is no usable cursor: the session, its
last few turns with items in full, the pending requests, and the cursor at
snapshot time from which the client applies live events.
_Avoid_: dump, full sync

**Pending request**:
An approval request or input request (a question for the user) that the
agent is waiting on. It is state, not a message: it stays in the Journal and
in the session's pending counters until someone resolves it, `session/open`
returns it, and the first resolution wins.
_Avoid_: prompt, popup, notification

**Pairing**:
The one-time HTTPS flow that turns a device into a client: Nano Host shows a
QR code with a short-lived, single-use code, and the device exchanges it for a
`client_id` and a device token.
_Avoid_: login, enrollment, registration

**Device token**:
The 256-bit secret a client gets at pairing and presents when opening a
stream (a cookie in the browser, a bearer token elsewhere). Nano Host stores
it hashed; revoking the device invalidates it.
_Avoid_: API key, session token, password

**Web Push**:
A browser push message that Nano Host signs with its own VAPID key and sends
to a client's stored subscription. It carries only a title, a one-line body
and a link into the app, never session content.
_Avoid_: APNs, push wake, notification service
