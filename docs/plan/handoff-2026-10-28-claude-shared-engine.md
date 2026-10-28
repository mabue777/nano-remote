# Handoff: "pilot Claude.app from the phone" → drive the shared engine (2026-10-28)

## The ask, and how it resolved
The operator wanted Nano Remote to pilot the macOS Claude app from the phone with a touch-native UI and
full functionality. A REA pass (rea-agents 6.7.0, `analyze-javascript-application`, scoped to the
main-process chunk; Evidence `ev_c2455ba12cc94712ebc53f8d6f2debf6434f88a995c5a070caa9da0c8a3145c4`)
showed Claude.app is a thin Electron shell over the same Claude Code engine Nano already drives through
the Agent SDK. Decision: Nano becomes a native second front-end to that shared local engine. GUI
remoting is rejected as the primary path. Operator rulings: ADR + Beads epic (not a spike, not direct
edits); Cowork visual canvas deferred to a later pixel fallback.

## Artifacts (uncommitted, on `main`)
- `docs/research/rea/claude-desktop-local-engine.md` — REA report, Observed/Inferred/Unknown.
- `docs/adr/0009-drive-the-shared-claude-engine-not-the-gui.md` — the decision and rejected paths.
- Beads epic `brocode-4o8` phase-4b-claude-shared-engine-front-end (P1), children:
  `.1` rea-capture-desktop-session-store (READY) → `.2` host-discover-and-resume-desktop-sessions
  → `.3` host-connector-parity-from-desktop-config, `.4` web-desktop-sessions-in-session-list
  → `.5` claude-shared-engine-field-acceptance. Nothing dispatched.

## Key facts a successor should not re-derive
- Claude.app 4.29.0 bundles `claude-code` 2.1.309 at
  `~/Library/Application Support/Claude/claude-code/2.1.309/<hash>/claude.app/Contents/MacOS/claude`
  and spawns it via `spawnClaudeCodeProcess` / `pathToClaudeCodeExecutable` / `canUseTool` —
  the seam in `host/src/adapters/claude/adapter.ts`.
- Surfaces are `CLAUDE_CODE_ENTRYPOINT` tags (`claude-desktop`, `remote_mobile`, `remote_cowork`, …).
- Connectors: `~/Library/Application Support/Claude/claude_desktop_config.json` → `mcpServers`.
- Desktop sessions: `~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/`
  (only `scheduled-tasks.json` seen so far) plus `~/.claude/projects/*` transcripts. Schema beyond
  that is UNKNOWN — ticket `.1` exists to capture it before `.2` is built.
- Cowork = engine inside a downloadable Linux microVM (`claude-code-vm/rootfs.img`).
- Chrome control = local key-gated unix-socket `browser-env-bridge` (sets `BROWSER` for the engine).
- Closed doors (do not retry): CDP needs Anthropic-signed `CLAUDE_CDP_AUTH`; inspect fuses off; asar
  integrity on; `config.json` `chromiumFlags` allowlisted to GPU switches. AX tree attaches but is a
  brittle virtualized web tree — accessory signal only.
- Anthropic's own Remote Control relay is cloud/account-bound; contradicts ADR 0001; not a Nano surface.

## Open questions / risks
- Two drivers on one session (desktop holds it open, phone resumes same id): untested. Ticket `.5`
  rules on it; `.2`/`.4` must flag "live at your Mac" and never silently co-drive.
- The REA graph was caller-scoped (636 files out of scope); absence there is not proof of absence.

## Next step
`bd ready` → `brocode-4o8.1`. Dispatch it per CLAUDE.md (confirmed verification command, certified
route, then watch the lane). Commit the two docs first if the operator wants them in history.

## Housekeeping done this session
Killed a stray `find ~ … | grep` background task; removed /tmp REA and AX probe artifacts. REA's
`rea mcp` server process is intentionally left running.
