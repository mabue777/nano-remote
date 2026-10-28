# Drive the shared Claude engine, not the desktop GUI

Decided 2026-10-28. The operator asked whether Nano Remote could pilot the macOS Claude app from the
phone — a touch-native Nano surface backed by the real app, with full computer functionality. A reverse-
engineering pass on the installed app (REA, `docs/research/rea/claude-desktop-local-engine.md`, Evidence
`ev_c2455ba1…`) establishes that Claude.app is a thin Electron shell over the Claude Code engine Nano
Host already drives through the Agent SDK: the app bundles `claude-code` and spawns it via the same
`spawnClaudeCodeProcess`/`pathToClaudeCodeExecutable` seam the Claude adapter uses, tags each surface
with `CLAUDE_CODE_ENTRYPOINT` (`claude-desktop`, `remote_mobile`, `remote_cowork`, …), routes approvals
through the SDK's `canUseTool`, loads connectors from `claude_desktop_config.json` `mcpServers`, runs
Cowork as the engine inside a downloadable Linux microVM, and reaches Chrome through a local key-gated
unix-socket bridge. The desktop GUI is one front-end over that engine; the phone is simply another.

Decision: Nano reaches "full Claude functionality on the phone" by extending its existing Claude adapter
into a first-class second front-end to the shared local engine — not by remoting the GUI. Concretely the
adapter gains (1) discovery and resume of sessions the desktop created (the account-scoped
`claude-code-sessions/<acct>/<org>/` store and the standard `~/.claude/projects` transcripts), so the
phone opens the very conversations started at the Mac; (2) connector parity by reading and merging the
desktop's `mcpServers` into `query()` options, so a phone session has the same tools; (3) the native
approval/question/diff/steer UX Nano already renders, now covering desktop-originated sessions. This keeps
everything over the operator's tailnet with no vendor relay, honouring ADR 0001, and gives the phone a
native touch surface and clean programmatic control instead of a scaled desktop window.

Rejected as the primary path, with evidence: piloting the GUI over Chrome DevTools (locked — the app
refuses debug switches without an Anthropic-signed `CLAUDE_CDP_AUTH` token; inspect fuses off; asar
integrity on); driving it through the macOS Accessibility tree (attachable but a large virtualized,
release-fragile web tree — kept only as an accessory signal, e.g. detecting a visible approval); and
riding Anthropic's own "Remote Control" relay (`remote_mobile`/`remote_desktop`, control-plane bootstrap,
device-keyed outbound WebSocket) — it is cloud- and account-bound, which contradicts ADR 0001, so it is
evidence of what the app does rather than a Nano surface.

Consequences and scope: v1 covers chat, Code, connectors, approvals/questions, and session
discovery/resume natively; Cowork's visual artifact canvas is the one piece the engine does not expose as
structured data, so it is deferred to a later, optional pixel-stream fallback (ScreenCaptureKit → WebRTC
+ input injection) scoped to that single view, not the whole window. Two drivers on one engine session
(desktop open while the phone resumes the same id) is untested and gated behind a field check before the
phone offers "take over"; discovery must degrade safely when a session is already live at the Mac. The
session store schema beyond `scheduled-tasks.json` is assumed to match `~/.claude/projects` and must be
confirmed from a real capture before the discovery ticket is accepted. No change to the protocol's session
vocabulary is required; discovery is an additive host capability and a session-list source, not a new
domain.
