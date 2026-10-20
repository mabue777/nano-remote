# spikes

Throwaway experiments. Nothing here is dispatched to production paths, covered by the verify gate,
or imported by `host/` or `web/`. One directory per spike, named after the question it answers,
with a short README stating the question, the result, and the date. Delete a spike once its
finding is recorded in `docs/` (an ADR, a research note, or a plan).

Planned: `host-drive/` (Phase 0): drive Codex and Claude Code to an approval round trip from a
scripted client. Its log is the evidence for the Phase 0 acceptance in `docs/plan/roadmap.md`.
