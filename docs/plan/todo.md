# Nano Remote: operator's master todo list

Saved 2026-10-20 from the operator's running list, verbatim. The tracker (`bd`) holds the dispatchable
tickets; this file is the operator's own view of the whole arc. Status notes below the list record what
has moved since it was written.

```
1.  ✅ Project setup — fork removed, fresh build on the researched architecture
2.  ✅ Skills-setup pass
3.  ✅ Research: nano-ai internals, vendor remote features, OpenClaw recon
3a. ✅ REA of the ChatGPT/Codex apps (static + runtime + live phone session + push rules),
       engine protocol schema captured (docs/research/rea/)
3b. ⏳ REA of Odysseus (provider study done; full behavior inventory running)
4.  ✅ Interview, done informally: host (D1), phone stack (D2), push (D3) decided
       and recorded as ADR 0003–0005; roadmap written (docs/plan/roadmap.md)
4a. ⬜ Bring old docs in line with the decisions: vision.md still names OpenClaw as
       the host; docs/agents/domain.md still describes an Expo app; CONTEXT.md needs
       the new terms (Nano Host, envelope, cursor, push wake, adapter)
4b. ⬜ Commit the research, ADRs, plan and tickets (all currently uncommitted)
5.  ⬜ Protocol v1 draft (ticket exists; planning-session work; blocks the spike)
5a. ⬜ Provider-connection design from the Odysseus pattern (ticket exists)
6.  ⬜ Prototype detour, now the "host-drive spike": Codex + Claude approval
       round trip from a scripted client; Kimi as a separate cut-or-keep spike
7.  ⬜ Repo scaffold + verify gates, and register the verify command with BROCODE
       (ticket exists, ready for an agent; dispatch needs the gate)
8.  ⬜ Spec → Beads tickets for Phase 1 (host) and Phase 2 (iOS), with blocking links
9.  ⬜ Apple prerequisites: bundle id, APNs key for the push wake service, TestFlight
10. ⬜ Security pass before Phase 1 ships: pairing code lifetime, device-key storage,
       revocation, tailnet-only binding
11. ⬜ Dispatch tickets to headless build engines; watch lanes; field-check each phase
       with the real phone away from home
```

## Status notes (2026-10-20, after the list was written)

- 3b: the Odysseus behavior inventory is complete (`docs/research/rea/odysseus-behaviors.md`).
- 4b: done; research, ADRs, plan and tickets are committed (not yet pushed).
- 5: in progress in the planning session (`protocol/protocol-v1.md`).
- 5a: done and closed (`docs/plan/provider-connection.md`).
- 8: "Phase 2 (iOS)" is now Phase 2 (web client); see ADR 0004.
- 9: superseded by ADR 0004 and 0005. No Apple Developer Program, no APNs, no TestFlight for v1.
  Replaced by: Tailscale HTTPS certificate for the host, VAPID key on the host, home-screen install.
- 10: still applies; add Web Push subscription storage and VAPID key handling to the pass.
