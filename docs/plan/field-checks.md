# Field checks

## Phase 2 web client v0 — 2026-10-21

Operator with an iPhone (Brave browser, then Safari for the home-screen install), Mac host installed with `nano-host install`.

| Step | Result |
| --- | --- |
| 1. Install, pair over cellular | Install first failed: the host crash-looped under launchd because the Tailscale CLI started in GUI mode (fixed same day, host now sets `TAILSCALE_BE_CLI=1`). After the fix: pairing by QR worked at 10:32; home screen showed the host connected, Codex ready. |
| 2. Add to home screen | Brave on iOS offers no Add to Home Screen. Re-checked in Safari: paired, added to the home screen; the icon opens full-screen without browser bars and shows the session. |
| 3. Send a message | Over 5G: message sent, Codex ran `touch hello02.txt` inside the session folder, reply streamed back. |
| 4. Approval round trip | Over 5G: writing outside the session folder raised "Run this command?"; operator accepted; the file appeared on the Mac within the same minute. Operator: "after I approved it was pretty fast to act". Exact round-trip time not measured (the host does not log approval timing). |
| 5. Lock and reopen | Phone locked 3 minutes after the turn had finished; on reopen the session was still connected and complete. Re-checked with a longer task (Codex scripting Ghostty, about 8 minutes): phone locked while the agent worked; on reopen the approval raised while locked was waiting. |

Codex was routed through Ollama (`kimi-k3:cloud`) during the check, not the ChatGPT default.

### Defects found

1. The steer box placeholder "Add to the running turn" wraps and is clipped while a turn runs.
2. Long unbroken text (brackets, paths) in a thinking block runs past the block's right edge.
3. The token counter did not update while the second turn ran (showed the first turn's numbers).
   Finding: Codex reports usage after every model request, and the host and phone already showed each
   report at once (the Journal holds four for the two turns, two mid-turn). Codex sent the report for the
   request that asked for approval only after the approved command finished, 22 s later, so the
   first turn's numbers stood during the approval. The 1.7% was right: it is the latest request's context
   (about 17,000 of 996,147 tokens), while "in" sums every request. The footer now reads
   "Session total N in · N out · context N% full".

Checked and not a defect: the "Jump to latest" button does not cover text when already at the bottom.

## Phase 3 wake (push notifications) — 2026-10-22

Operator with an iPhone, Safari home-screen install, host running the Phase 3 build under launchd. Codex sessions.

| Step | Result |
| --- | --- |
| 1. Turn notifications on, send test | Operator reported a test notification at 06:45, but host.log shows that push (and every push since the Phase 3 deploy, 68 of 68) rejected by Apple with 403. Re-check after defect 1 is fixed. |
| 2. Turn finished while locked | Pending. |
| 3. Approval while app open | FAIL. Approval raised at 06:59 with the app open: no notification (defect 1). |
| 4. Approval raised while locked, tap opens approval card | FAIL. Phone locked at 07:00 with the approval pending: lock screen empty (defect 1). |
| 5. Short task while open: no completion notification | Pending. |
| 6. Badge while approval pending, clears after answering | Pass. One pending approval showed badge 1 on the home-screen icon and on the session row; the waiting session was listed first with the "Needs approval" state line; badge cleared after approving. |
| 7. Record results | This section. |

### Defects found

1. Every Web Push to Apple fails with 403. Replaying one push with the host's own encrypt and VAPID signer and reading
   the response body: `{"reason":"BadJwtToken"}`. The same push with `sub` = `mailto:nano-remote@example.com` or
   `https://example.com` returns 201 and the notification arrives. Cause: the default VAPID contact is
   `mailto:nano-remote@localhost`; Apple rejects a mailto without a real domain. The sender also discarded the
   response body, so host.log only showed the status. Ticket under the Phase 3 epic (host-vapid-contact-rejected-by-apple).

Not a defect but filed from this check: the operator wants a per-session mode that bypasses all approvals
(session-bypass-approvals-mode).
