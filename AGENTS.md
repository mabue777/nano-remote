# NANO-REMOTE

Fork of [nano-ai](https://github.com/TonyL1u/nano-ai) (React Native / Expo chat
client for Ollama), extended to run against and drive a computer remotely from
a phone.

## Repos and remotes

- `origin` — this fork (github.com/mabue777/nano-remote), branch `main` is the working line
- `upstream` — TonyL1u/nano-ai, kept for pulling upstream updates into this fork

## Agent skills

### Issue tracker

Issues live in Beads (`bd`) in this repo; implementation is dispatched to
headless engines via BROCODE, not done in planning sessions. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles map to Beads labels of the same name
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
