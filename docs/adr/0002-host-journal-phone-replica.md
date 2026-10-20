# Session state is journaled on the host; the phone renders an optimistic replica

Phone-driven agent sessions risk feeling laggy — every message and approval
that waits on a network round trip makes the app feel remote. Observed pain:
the OpenClaw iOS client's chat felt unpolished for exactly this reason. The
vendors (Claude relay stores the transcript server-side; ChatGPT routes
through account cloud) solve it by making a server-side store the source of
truth the client never waits on.

Decision: the host daemon keeps a **Journal** per agent session — an
authoritative, sequence-numbered event log (user messages, streamed deltas,
tool calls, approval requests). The phone keeps a **Replica** it renders
instantly: outgoing messages appear immediately as "sending" and reconcile on
acknowledgment; on open or reconnect the app shows the Replica first, then
catches up from its last seen sequence number (snapshot + deltas). Push
notifications (and the existing Live Activities machinery) only wake the app
or show glanceable progress — they never carry the payload.

Consequences: the daemon is a stateful service, not a dumb pipe; every
protocol event carries a per-session sequence number and is idempotent to
apply; disconnects, tailnet drops, and phone sleep become catch-up events
instead of failures. The trade-off — daemon complexity in exchange for
perceived responsiveness — was chosen deliberately and confirmed by the user.
