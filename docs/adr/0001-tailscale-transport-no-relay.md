# Phone–host transport is the user's existing Tailscale overlay; no cloud relay

The phone app reaches the host computer over the user's existing Tailscale
tailnet (already installed on both devices), talking a plain HTTP/WebSocket
protocol to a private tailnet address. We do not build the vendor-style cloud
relay that Claude Remote Control, ChatGPT Remote connections, and Kimi Remote
Control all use: it would mean running a rented server, building accounts and
login, and owning the security of the user's agent traffic. LAN-only was
rejected because the phone must also work away from home. Consequences: no
public ingress is ever needed; tailnet membership secures the network layer,
but the host daemon still gets its own lightweight pairing credential
(user-level, on top of machine-level tailnet membership); the app keeps its
local-first privacy posture — agent traffic never touches third-party servers.
