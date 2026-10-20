# Push notifications come from a minimal content-free "push wake" service

Apple delivers push notifications only from a server holding the app's APNs
key, so a cloud component cannot be avoided. We run one tiny stateless service
whose only job is to accept `{device_token, kind}` from a paired host and
forward an empty wake to APNs (and Live Activity updates). It carries no
message content, no session data, and no account; all content stays on the
tailnet, which keeps the intent of ADR 0001 (no traffic relay) and the rule of
ADR 0002 (pushes only wake the app). The notification rules copy what was
observed live on 2026-10-20 (`docs/research/rea/runtime-capture.md`): push a
completion only when the phone's stream is closed, push an approval request
always, and replay pending approvals to a phone that resumes the session.
Consequences: the host needs outbound internet to reach the service; the
service must stay stateless and content-free (any growth beyond that reopens
ADR 0001); the APNs key lives only in the service; iOS keeps a backgrounded
socket for roughly thirty seconds after lock, so the app design assumes wake
by push beyond that window.
