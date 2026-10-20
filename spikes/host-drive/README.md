# host-drive (spike, 2026-10-20)

Question: can a host drive Codex (`codex app-server` over stdio) and Claude Code (Claude Agent SDK) through
a full phone-style approval round trip, then survive an engine kill and give the phone a catch-up from its cursor?

Result: yes for both. Step logs are in `logs/codex.log` and `logs/claude.log`; findings, including how
Claude's `canUseTool` behaves for Bash, Write and AskUserQuestion, are in `NOTES.md`.

Not part of the pnpm workspace (own `pnpm-workspace.yaml`) and not run by `scripts/verify.sh`.
