# Issue tracker: Beads (bd)

Issues, specs, and decision tickets for this repo live in **Beads**, the local
issue tracker embedded in this repo at `.beads/` (never edit those files by
hand — the `bd` CLI is the only door).

This repo is also registered with the BROCODE orchestration service, which
dispatches Beads tasks to headless coding engines. Plan in the session;
build via dispatch (see "Shipping work" below).

## Conventions

- One **parent issue per feature** (type: epic) titled `<feature-slug>`; the
  spec lives in the parent's description (or a markdown file referenced from
  it when too large for a description).
- Implementation tickets are individual `bd` issues linked to the parent with
  `bd link <child> <parent> --type parent-child`.
- Blocking edges are native: `bd link <id> <blocker>` means `<blocker>` blocks
  `<id>`. A ticket is grabbable when `bd ready` lists it.
- Triage state uses labels (see `triage-labels.md`): `bd label add <id> <label>`.
- Comments and conversation history: `bd comment <id> "..."`.

## When a skill says "publish to the issue tracker"

`bd create "Title" --type task|feature|epic --description "..."` inside this
repo. Capture the printed issue id — skills must pass real ids, never titles.

## When a skill says "fetch the relevant ticket"

`bd show <id>` (details, design, acceptance) and `bd comments <id>`.

## Wayfinding operations (used by `/wayfinder`)

- **Map**: a parent issue (type: epic) whose description carries the Notes /
  Decisions-so-far / Fog body.
- **Child ticket**: a bd issue linked `parent-child` to the map, question in
  the description, `Type:`/`Status:` recorded via labels
  (`research`/`prototype`/`grilling`/`task` and `claimed`/`resolved`).
- **Blocking**: `bd link <ticket> <blocker>`. Unblocked = appears in `bd ready`.
- **Frontier**: `bd ready` filtered to the map's children (`bd children <map>`).
- **Claim**: `bd update <id> --status in_progress` before any work.
- **Resolve**: append the answer with `bd comment <id>`, close with
  `bd close <id>`, then append a pointer to the map's Decisions-so-far via
  `bd update <map-id> --append-notes "..."`.

## Shipping work (BROCODE)

- Implementation of a ticket is dispatched, not done in the planning session:
  `brocode task dispatch <bd-id> --project NANO-REMOTE` (run from this repo).
- Dispatch prerequisites: a confirmed verification command on the project
  (`brocode project verification --project NANO-REMOTE --command "..."`) and a
  certified provider route (`brocode providers test <route>`).
- After dispatching, watch the lane: `brocode lane watch <lane-id>` or
  `brocode lane show <lane-id>` on a poll until `Completed`.
- Approve merges only when the user asked for it — that is a human decision.
