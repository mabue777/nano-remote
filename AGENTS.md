# NANO-REMOTE

A phone app that chats with LLMs and drives coding-agent sessions (Claude
Code, Codex, Kimi) running on the user's computer — the remote-control
pattern shipped by the Claude, ChatGPT, and Kimi mobile apps, built for a
fresh codebase. Started as a fork of nano-ai (now removed); design is
documented in `docs/adr/` and research in `docs/research/`.

## Repos and remotes

- `origin` — this project's repo (github.com/mabue777/nano-remote), branch `main`
  (created as a GitHub fork of nano-ai; upstream code and remote have since
  been removed after the direction change to a fresh build)

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
