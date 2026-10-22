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
| 1. Turn notifications on, send test | First try 06:45: operator saw a notification, but host.log shows that push rejected by Apple with 403 (defects 1 and 2). After both fixes (07:29): pass, test notification arrived. |
| 2. Turn finished while locked | Pass (07:36). Turn finished notification arrived on the locked phone; tapping it opened the session. |
| 3. Approval while app open | First try 06:59: no notification (defects 1 and 2). After both fixes (07:31): pass, approval notifications arrive with the app open; host.log shows each delivered 201. |
| 4. Approval raised while locked, tap opens approval card | First try 07:00: lock screen empty (defects 1 and 2). After both fixes: pass, the lock-screen notification opened the session with the approval card in view. |
| 5. Short task while open: no completion notification | Pass. No completion notification with the app open and connected. |
| 6. Badge while approval pending, clears after answering | Pass. One pending approval showed badge 1 on the home-screen icon and on the session row; the waiting session was listed first with the "Needs approval" state line; badge cleared after approving. |
| 7. Record results | This section. All seven observations in by 07:40; both defects fixed, merged and re-checked the same morning. |

### Defects found

1. Every Web Push to Apple fails with 403. Replaying one push with the host's own encrypt and VAPID signer and reading
   the response body: `{"reason":"BadJwtToken"}`. The same push with `sub` = `mailto:nano-remote@example.com` or
   `https://example.com` returns 201 and the notification arrives. Cause: the default VAPID contact is
   `mailto:nano-remote@localhost`; Apple rejects a mailto without a real domain. The sender also discarded the
   response body, so host.log only showed the status. Ticket under the Phase 3 epic (host-vapid-contact-rejected-by-apple).

2. After defect 1 was fixed and the host rebuilt, the next approval push (07:23) was refused with 400
   `BadWebPushTopic`. The host sends the Codex request id (`req_…`, 29 characters) as the Topic header
   unchanged because it fits RFC 8030's 32 base64url characters, but Apple refuses it. Probing Apple with
   the live subscription: every topic whose length leaves remainder 1 when divided by 4 (5, 9, 29
   characters, such as `push-test` and every `req_`/`trn_` id) gets 400 BadWebPushTopic; lengths 6, 7, 8,
   30 and 32 get 201. Apple decodes the Topic as base64url and such lengths are not decodable.
   Ticket under the Phase 3 epic (host-push-topic-rejected-by-apple).

Not a defect but filed from this check: the operator wants a per-session mode that bypasses all approvals
(session-bypass-approvals-mode).

## Phase 4 more agents — 2026-10-22

Operator with an iPhone (Safari home-screen app, Tailscale on); host = current main under launchd with codex and claude enabled. Claude Code sessions (SDK 0.3.308 / Claude Code 2.1.308, model claude-opus-5-5), work folder ~/Desktop/phone-test. Method: the operator started the first session from the phone; the rest of the turns were sent from the Mac by a protocol v1 client script paired as its own device (controller-script, revoked afterwards), so the operator only handled the phone side. Pushes are evaluated per device, so the script device did not suppress the phone's pushes. All times UTC.

| Step | Result |
| --- | --- |
| 1. New session sheet, Claude in the picker, first session | Pass. 09:31 the operator started a Claude session from the phone (bypass on, model claude-opus-5-5); three turns completed with success results; the engine process was a child of the live host (ps: the SDK's darwin-arm64 claude binary, parent = host pid). |
| 2. Approval card with push, accept, file exists | Pass. New session with default approvals; 14:20:59 the agent asked to write push-check.txt two seconds after turn start; host.log push.sent 201 at 14:21:00; the notification arrived on the phone, tapping it opened the session with the approval card; accepted 14:24:14; turn completed with "done"; file contains "hello". |
| 3. AskUserQuestion card, answer, turn continues | Pass. 14:29:03 input/request with three options (red, green, blue), push.sent 201; the notification opened the question card; answered "blue" 14:31:53; the agent then raised a fileChange approval for colour.txt (push.sent 201), accepted; turn completed with "colour saved"; file contains "blue". |
| 4. Interrupt a turn | Pass (host side). 14:29:07 a 120-second ping turn started in the bypass session; turn/interrupt at 14:29:27 returned ok; turn/completed status interrupted 0.1 s later; session status idle. Driven over the protocol, not via the composer's Stop button (the button is Phase 1 UI, unchanged). |
| 5. Lock the phone during a long turn, completion push, catch-up | Pass. First attempt 14:24:30 ended after 15 s because Claude Code refuses a foreground `sleep` and backgrounded it; a completion push was still sent (201) since the phone had no open stream. Second attempt 14:25:01 ran `ping -c 90` for two minutes; turn/completed 14:27:00, push.sent 201 at 14:27:01; the "turn finished" notification arrived on the locked phone; tapping it opened the session with the catch-up applied and the reply visible. |
| 6. Bypass session: red marker, write without approval | Pass. The 09:31 session was started with "Bypass approvals (full access)" on; shell commands (sleep, ping) ran with no approval card and no push. The red marker was seen at session start; it was not separately re-checked later in the day. |
| 7. Kill the host between turns, follow-up resumes the engine | Pass. 14:28:28 launchctl kickstart -k; the host was listening again after one second with codex and claude ready; 14:28:33 a follow-up in the 09:31 session; 14:28:41 the reply quoted its previous reply ("slept, done / pinged, done") and the command before it (`ping -c 90 127.0.0.1 \| tail -3`) exactly. |

### Defects found

None.

Notes:

- Cosmetic log nits, not filed: the adapter logs `turn=running` on the line that reports the result (it logs before
  the state flips); an interrupt shows in claude.log as `result subtype=error_during_execution is_error=true` (the SDK
  reports an interrupt as an error; the host maps it to status interrupted correctly).
- For long-turn tests ask for a real long command (ping -c N); Claude Code backgrounds `sleep`.
- Aside, not a Nano Remote matter: the phone session sent Claude Code peer messages to the controller session over
  /tmp/cc-socks; they arrived, but that session type has no SendMessage tool and could not reply.
