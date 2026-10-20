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

- `src/journal/` is the Journal: the per-session, sequence-numbered event log (SQLite via `node:sqlite`,
  default file `~/Library/Application Support/NanoHost/journal.sqlite`, `":memory:"` in tests). It
  assigns `seq`, serves `events/since`, snapshot and history pages, pending requests and session
  summaries, and delivers live events to subscribers without gaps (protocol-v1.md sections 5 and 6).
- `src/stream/` is the envelope stream server (protocol-v1.md sections 2, 3, 4, 10) on the `ws` package:
  authentication at the upgrade through an injected token-to-clientId function, per-direction `seq_id`
  with 4002 on gaps, acks and the 256-envelope / 4 MiB unacked window that holds back Journal events,
  ping/pong with the 90 s timeout and the presence registry, chunking both ways, close codes 4001 to
  4010, and the typed method registry behind the initialize-first rule. `StreamServer.notifyStream` and
  `notifyClient` are the send API for the rest of the host.

Commands (from the repo root):

```
pnpm -C host generate    # regenerate protocol types for host/ and web/
pnpm -C host typecheck   # tsc --noEmit
pnpm -C host test        # vitest run
pnpm -C host test:coverage  # vitest with v8 coverage; fails below 95% on src/journal or src/stream (on demand, not in the gate)
pnpm -C host build       # emit dist/ (excludes tests)
pnpm -C host verify      # generate + typecheck + test; the gate
```
