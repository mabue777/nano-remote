# Notifications are Web Push sent by the host; no push service of our own

Supersedes the earlier draft (content-free push wake service). With a web client (ADR 0004) the host
can send Web Push messages directly: the phone subscribes through the browser, the subscription is
stored on the host, and the host signs each push with its own VAPID key. No Apple account, no APNs key
and no server of ours are involved; the push travels through the browser vendor's push service and
carries only a short title and a link into the app, never session content. The notification rules copy
what was observed live on 2026-10-20 (`docs/research/rea/runtime-capture.md`): push a completion only
when the phone's stream is closed, push an approval request always, and replay pending approvals to a
phone that resumes the session. Consequences: the host needs outbound internet for pushes to be
delivered; the web app must be installed to the home screen for iOS to deliver Web Push; if a native
client is ever built, it would need APNs and a small content-free wake service, which is then a new
decision, not this one.
