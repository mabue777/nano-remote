# host

Nano Host: the always-on Node service on the Mac. It will drive coding agents (Codex first), keep
the per-session Journal, speak protocol v1 over WebSocket, and serve the phone web client from
`host/public` (written by `pnpm -C web build`, not committed). This is the empty scaffold; Phase 1
of `docs/plan/roadmap.md` fills it in.

- Node 22+, pnpm workspace (root `pnpm-workspace.yaml`), ESM, TypeScript strict, vitest.
- `src/generated/` holds types generated from `protocol/schema/*.json` by `scripts/generate-types.mjs`
  (json-schema-to-typescript). The directory is gitignored and regenerated on every verify, so the
  schemas stay the only source of protocol types. Import them through `src/generated/index.ts`
  (one namespace per schema file: `envelope`, `message`, `common`, `methods`, `events`).

Commands (from the repo root):

```
pnpm -C host generate    # regenerate protocol types for host/ and web/
pnpm -C host typecheck   # tsc --noEmit
pnpm -C host test        # vitest run
pnpm -C host build       # emit dist/ (excludes tests)
pnpm -C host verify      # generate + typecheck + test; the gate
```
