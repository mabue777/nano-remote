# The first phone client is a web app served by the host; a native app stays optional

Supersedes the earlier draft of this ADR (native SwiftUI first). The operator does not want the Apple
Developer Program (about 99 USD per year) to be a requirement. Without it a native iOS app cannot use
push notifications or Live Activity updates, must be re-signed every seven days, and cannot be
installed by anyone else. So the first Nano Remote client is a web app that Nano Host serves over the
tailnet: Tailscale provides a real HTTPS certificate for the host's MagicDNS name, the app is added to
the iPhone home screen, and it gets Web Push without any Apple account. Nothing is signed, nothing is
re-installed, updates arrive on the next open, and anyone with tailnet access can use it. The host
and the envelope protocol are client-agnostic: a native SwiftUI client remains a documented option
for later (Dynamic Island, Live Activities, native Face ID) if the operator ever chooses to enroll,
and would reuse the protocol unchanged. Consequences: no Live Activities or Dynamic Island in v1;
lock with a passcode or WebAuthn instead of native Face ID; provider keys for local chat live in the
browser's storage on the phone (or on the host, which is the user's own Mac); background behavior is
the same roughly thirty-second window after lock, after which Web Push wakes the user. The removed
nano-ai Expo code stays removed; its UX ideas carry over as design.
