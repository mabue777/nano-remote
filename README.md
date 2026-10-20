# Nano Remote

A phone app that chats with LLMs and drives coding-agent sessions (Codex, Claude Code, Kimi)
running on your Mac. Vision in `docs/vision.md`, decisions in `docs/adr/`, plan in
`docs/plan/roadmap.md`, protocol in `protocol/`.

## Layout

```
host/        Nano Host: Node 22+ service (TypeScript, pnpm, vitest). Serves the web client from host/public.
web/         Phone client: Vite + Preact web app, built into host/public (see web/README.md).
protocol/    protocol-v1.md + JSON Schemas: the single source of message types for host and web.
spikes/      Throwaway experiments, never on production paths.
scripts/     verify.sh (the gate), bootstrap.sh (first-time install).
docs/        vision, adr, plan, research, agents.
```

No iOS project: the first client is a web app (ADR 0004).

## Verify

```
scripts/bootstrap.sh   # once per clone: pnpm install (writes the lockfile) + playwright chromium
scripts/verify.sh      # the gate: protocol check, pnpm -C host verify, pnpm -C web verify
```

`scripts/verify.sh` sets its own PATH (Homebrew first), runs in a bare environment, and installs
only when `node_modules` is missing (frozen lockfile). Protocol types in `host/src/generated` and
`web/src/generated` are regenerated from `protocol/schema` on every verify by
`host/scripts/generate-types.mjs`; they are not committed and never hand-written.
