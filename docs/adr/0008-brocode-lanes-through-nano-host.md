# BROCODE lanes reach the phone through Nano Host as a BROCODE client

Nano Remote becomes the human surface for BROCODE, the orchestration service that runs tracked coding
work on the same Mac: the phone lists lanes, is pushed when one settles, and records the human-only
decisions (approve a merge, request changes, answer a worker question, stop, pause, resume); it never
dispatches. The integration is one module in Nano Host that talks to BROCODE's local Unix-socket HTTP
contract as one more client, exactly as BROCODE's TUI and CLI do, and mirrors lanes the way sessions are
mirrored (a snapshot plus BROCODE's own event sequence as the cursor; no lane Replica, because BROCODE is
reachable whenever the host is). BROCODE stays unaware of phones, and its vocabulary (lane, step,
condition, review decision, worker question) enters the protocol as an additive `lane/*` section instead
of being mapped onto sessions and approval requests, whose meanings both glossaries already fix.
Considered and rejected on 2026-10-24: Nano Host proxying BROCODE's whole contract over the tailnet (more
surface than any screen needs), BROCODE shipping a Nano connector (BROCODE would know a second product and
Nano Host would grow an inbound API nothing else uses), and merging the two daemons (reopens both specs and
architectures to save two duplicated agent drivers). Consequences: the action methods wait on three
BROCODE fixes without which the phone could show the wrong attempt's diff or a Stop that does nothing
(stale merge candidate after re-dispatch and after rework; orphan worker on stop); BROCODE's lane output
endpoint is a snapshot, so the phone re-fetches a lane's output on each `worker.output` event while the
lane is open; lanes appear only while Nano Host reports BROCODE reachable; a future native client needs
nothing new from BROCODE.
