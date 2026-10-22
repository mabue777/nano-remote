# Local chat reaches a Provider directly over https and through the paired host otherwise

The route to a Provider is derived from its base URL and never chosen by the user: an `https` base URL on
a public host (cloud endpoints) is called directly from the phone, and that provider's key is stored on
the phone in the installed app's storage (exports never include it); an `http`, loopback, private
(RFC 1918), `.local` or tailnet (100.64.0.0/10, `*.ts.net`) base URL is relayed by the paired Nano Host,
which makes the request and streams the deltas back over the protocol, and that provider's key lives in
the host's `config.json` and never reaches the phone. The settings screen shows the route as one line
("direct" or "via your Mac"). Reasons: the web app is served over https, so a plain-http LAN server is
mixed content and Safari blocks it regardless of anything the server does; Ollama refuses foreign
origins by default (measured 2026-10-22 on the operator's Mac: 403 for a request carrying the app's
origin, `OLLAMA_ORIGINS` not set), and asking users to reconfigure Ollama defeats "connect in under a
minute"; cloud providers answer CORS themselves and the host sends no Content-Security-Policy, so going
direct keeps cloud chat free of any host dependency, as the Phase 5 acceptance requires. Consequences: a
host-routed provider is unavailable whenever the host is unreachable, and the UI says so in one sentence
("Your Mac is not reachable; this provider runs through it") instead of failing silently; the relay
needs an additive protocol v1 addition (provider list, models, chat with streamed deltas, abort,
discover), built by the next ticket; keys for direct providers are only as safe as the phone and its
browser storage, which is accepted for v1 because the user chose a host-less cloud provider.
