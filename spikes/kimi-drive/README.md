# kimi-drive (spike, 2026-10-22)

Question: can a host drive the Kimi CLI through a full phone-style approval round trip (like Codex and
Claude in `../host-drive`), then survive an engine kill and give the phone a catch-up?

Result: **cut Kimi from v1 marketing.**

- The `--prompt --output-format stream-json` route never surfaces approvals. Prompt mode is always
  auto-approve.
- The `kimi acp` route does surface approvals. It passed the full session against a scripted local model.
- The operator's account has no Kimi Code subscription (403), so no real-model turn could run.

Details and the path back are in `NOTES.md`. Step logs are in `logs/`.

Not part of the pnpm workspace (no dependencies, no install) and not run by `scripts/verify.sh`.
