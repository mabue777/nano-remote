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

**Agent**:
A coding agent the host can drive: Codex, Claude Code, Pi (Kimi later). The
host lists the ones `enabledAgents` names and finds; each has an id, a status
and its agent capabilities. In host code an agent is an `AgentProvider`
(`host/src/core/adapter.ts`): that name predates model providers and means a
coding agent, not a model provider.
_Avoid_: engine (the agent's own program, which the adapter starts), bot, provider

**Agent capabilities**:
What an agent supports, fixed per agent and sent with it in `initialize` and
`agent/list`: `steer` (input while a turn runs), `diff` (a turn's changes),
`approvalModes` (the approval modes it honours; Pi: ask, acceptEdits, never),
`attachments` (whether it sees attached images and takes attached files) and
`backgroundTasks` (whether it reports its background tasks; Claude Code only) and
`settingsUpdate` (which of model and effort an open session can change; all three
agents change both, from the next turn). The
phone shows only the controls an agent supports; without capabilities (an older
host) it offers everything and learns from `not_supported` (attachments and
settings changes excepted: an older host takes no uploads and no settings
change, so the phone offers neither).
_Avoid_: features, flags

**Attachment**:
A photo or file the phone uploads to the host for one agent session
(`POST /v1/blob`, protocol section 8.1) before sending the message that refers
to it by URL. The host keeps it in the session's folder in its app folder until
the session is deleted, and hands it to the agent as an image the agent can see
or as a file path in the prompt.
_Avoid_: upload (the act, not the thing), blob (the URL's word, not the domain's)

**Model provider**:
A service that serves models over an OpenAI-style or Ollama API (Ollama,
OpenRouter, LM Studio, ...), used by local chat and relayed by the host for
private addresses (protocol section 15). Some agents reach many model
providers themselves (Pi names one per model).
_Avoid_: agent, backend; plain "provider" is fine where only model providers are meant

**Agent session**:
A live conversation with a coding agent (Claude Code, Codex; Kimi later) that runs
on the host, driven from the phone.
_Avoid_: job, task ("task" belongs to the issue tracker), run

**Background task**:
A helper an agent runs beside its turns: a background subagent, a background
command, a monitor (Claude Code). A command that merely runs long in the
foreground is not one. The host lists them in `Session.backgroundTasks` while
they run and until the next turn starts (the phone drops an ended one a minute
after it ended), a message sent while they run is marked queued until the agent
takes it, and stopping a turn, stopping the host or a host restart cancels them.
_Avoid_: job, worker; plain "task" (the issue tracker's word)

**Local chat**:
The mode where the phone chats with a model provider (Ollama and friends):
it talks to https providers directly and to private ones through the paired host (ADR 0006).
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

### Lanes (BROCODE, ADR 0008)

**BROCODE**:
The orchestration service on the host that runs tracked coding work in lanes
and leaves the human-only decisions to a human. Nano Host is one of its
clients; it reads and decides only through BROCODE's own contract.
_Avoid_: orchestrator, backend, the service

**Lane**:
One tracked piece of BROCODE work, a tracker task dispatched to a worker,
from Queued to a terminal outcome. The phone watches lanes and decides on
them; it never dispatches them.
_Avoid_: session (an agent conversation), job, task (the tracker's word)

**Step**:
Where a lane is in BROCODE's workflow: Queued, Preparing, Working, Checking,
Reviewing, Merging, Completed.
_Avoid_: phase, stage, status

**Condition**:
Whether a lane can proceed: Active, Waiting, Paused, Needs attention, Unknown,
or its terminal outcome (Completed, Stopped, Failed). "Needs you" on the phone
means Reviewing, Needs attention, or a waiting worker question.
_Avoid_: status, state

**Review decision**:
The human's ruling on a lane in Reviewing: approve the merge, or request
changes with a reason. Recorded once in BROCODE; the first recorded decision
wins. Not an approval request, which is an agent's mid-turn permission ask.
_Avoid_: approval, approve (alone), merge (as the decision's name)

**Worker question**:
A structured question a BROCODE worker raises and waits on: what is blocked,
the options, the evidence, a recommendation. Not an input request, which is
an agent's question inside a session.
_Avoid_: input request, prompt, pending request
