# Plan: seamless images and a file viewer on the phone (2026-10-28)

Status: ranked plan from ticket brocode-74p, for the controller to turn into build tickets. Findings and evidence:
`docs/research/file-viewing.md` (numbers in brackets below, e.g. [2], point at its rows). Effort as in
`docs/research/new-look-prototype.md`: S is about a day, M two to three days, L about a week.

**The short version.** Build it in three steps. First, an in-app image viewer: no protocol change, and it fixes the
part the operator called out (a tapped photo leaves the app today [2]). Second, a small additive protocol change that
lets the phone read a file inside the session folder [21–24], followed by a read-only text viewer with line numbers,
wrap, find, markdown and syntax colours, opened from the Changes view, the "Edited …" rows and a Files page. Third,
decide on editing after the operator has used the viewer; until then an "Ask the agent to change this" action gives
the edit path without a write method on the host.

## Look and motion rules every item follows

- Look: warm neutrals, no borders (the tray tile's 1 px border goes [6]), one accent, dot + word statuses, 20 px page
  margins, type roles (`--type-body` 17/24 for prose, `--type-code` 13/18 in `--font-code` for code, `--type-footnote`
  13/18 for meta lines), `Icon` line icons, light and dark from tokens only.
- Motion: reuse what exists [18]. Text and folders are pushed pages (edge swipe back); quick actions stay in sheets
  (drag to dismiss); the image viewer is its own full-screen layer that grows out of the tapped thumbnail with FLIP
  and shrinks back on dismiss. Reduce Motion: cross-fade only, no grow or shrink, no momentum.
- Zoom: the app cancels page pinch-zoom on purpose (`ui/no-zoom.ts`, `touch-action: pan-x pan-y`). The viewer
  implements its own pinch and double-tap with pointer events inside a `touch-action: none` layer; nothing else in
  the app starts zooming.

## The ranked items

| Rank | Item | What the user sees | Real components and files it touches | Protocol change | Effort | Risk | Suggested route |
|---|---|---|---|---|---|---|---|
| 1 | **P1. In-app image viewer** | Tap any sent photo, a steer's photo or a tray thumbnail: the picture grows from its thumbnail to full screen on a black layer. Pinch and double-tap zoom (to 4×), pan when zoomed, swipe left/right between the images of that message with "2 of 3" at the top, swipe down to shrink it back into its thumbnail, a Close button, and Share (system sheet: Save Image, Copy, AirDrop). The first frame is the already-decoded thumbnail scaled up, so nothing jumps; the full image replaces it when decoded. A load failure says "Couldn't load this image" with Try again. Light/dark: the layer is black in both, like Photos. | new `ui/ImageViewer.tsx` + `.css` (lazy chunk); `SessionScreen.tsx` `SentAttachments` (button instead of `<a target="_blank">`), `TrayEntry`, `Steer`; `ui/motion/flip.ts`, `gesture.ts`, `drag.ts`, `haptic.ts`; `.thumbs`, `.tray-thumb` in `SessionScreen.css` (drop the tray border); new e2e `image-viewer.spec.ts` | none | M | Medium: custom pinch on iOS (gesture events are cancelled app-wide; pointer events must carry it); `navigator.share` with files in the installed app is untested (fallback: long-press the image for the system Save menu) | Opus (gestures and motion) |
| 2 | **P2. Read files: protocol and host** | Nothing visible on its own; it unlocks P3 to P7. | `protocol/protocol-v1.md` (new §4 entries, §10 `conflict` reserved for P8), `protocol/schema/methods.json` (normative; regenerate types, never edit them), `host/src/core/host-core.ts` (`fs/readFile`, scoped `fs/readDirectory` with `size`, `mtimeMs`, `hidden`), new `host/src/files/` (scope check with `realpath`, binary sniff, line-start ranges), `host/src/http/server.ts` + a `/v1/file` endpoint beside `attachments/endpoint.ts` (same auth and headers, plus `ETag`, `Accept-Ranges`), `initialize` `limits.maxFileReadBytes` and `files {read}`; tests for `..`, symlink escape, deleted session, binary, UTF-8 cut, Range | additive v1: `fs/readFile {sessionId, path, offset?, maxBytes?}`, `GET /v1/file?sessionId&path`, `fs/readDirectory {path, sessionId?}` with new optional entry fields, the capability and limit (details in research Part 1.4) | M | Medium: it is a new read surface; the scope check must be right first time (review it like the pairing code) | Opus (protocol and security) |
| 3 | **P3. Text file viewer page** | A pushed page titled with the file name, the folder path as a grey line under it. The text in SF Mono 13/18 with a pinned line-number gutter in `--text-tertiary`, 20 px right margin. A ⋯ menu: Wrap lines (on by default for `.md`/`.txt`, off for code, remembered per kind), Copy all, Copy path, Raw/Rendered for markdown (rendered with the chat's `markdown.ts`). A find bar (search icon in the header): field, "3 of 12", up/down, case toggle; matches highlighted with the accent at low opacity. Files over 256 KiB show the first part and "Show more" at the end (next range); a binary file shows a card with kind, size and Share. Opening `src/parser.ts:42` scrolls to and briefly tints line 42. | new `screens/session/files/FileViewer.tsx`, `file-model.ts` (+ tests), `files.css`; `routes/router.ts` (route `/s/<id>/file?path=`) and `host/src/http/static.ts` `PAGE_ROUTE` [19]; `routes/PageStack.tsx`; `ui/NavHeader.tsx`; `screens/chat/markdown.ts` (reused; tables later) | none beyond P2 | M | Low: read-only; long files need windowed rendering (render ~400 lines around the viewport) to stay smooth | Opus for the model and find; the CSS pass can go to Kimi |
| 4 | **P4. Entry points into the viewer** | In the Changes sheet's file diff, a "View file" button next to the path (the sheet closes and the page pushes). In the transcript, the path in "Edited src/parser.ts" and in an expanded file-change row is tappable. Paths the agent writes in its message (`src/foo.ts`, `src/foo.ts:12`) become links when they look like a relative path with an extension; a tap that answers `not_found` shows "That file is not in the session folder". Text files the user attached (chips [5]) open in the same viewer from `/v1/blob` instead of downloading. | `views/DiffView.tsx` (`FileDiff` head), `SessionScreen.tsx` (file-change rows, `SentAttachments` chips), `TranscriptRows.tsx` `AgentMessage` (path linkify, plain-text safe), `screens/session/transcript.ts` | none beyond P2 | S | Low; linkify can misfire on prose like "e.g." (require a `/` or a known extension and no spaces) | Kimi (bounded, exact criteria) |
| 5 | **P5. Syntax colours** | Code in the viewer (and optionally in the diff view) is coloured in light and dark: keywords, strings, comments, numbers and constants, functions and types, variables, from six new tokens in `tokens.css`; punctuation stays in the text colour. Off above 256 KiB or 5 000 lines, with no message (the text still shows). | Prism core + TS, JS, JSON, CSS, HTML, Markdown, Bash, Python, YAML, diff as a lazy chunk (13.1 KB gzipped measured, MIT); render from `Prism.tokenize` into Preact nodes, never `innerHTML`; `styles/tokens.css` (`--code-keyword`, `--code-string`, `--code-comment`, `--code-number`, `--code-function`, `--code-variable`; six roles as in research T5, starting values the GitHub Light / Dark pairs measured in T4, tuned to our warm neutrals); `files.css`; `DiffView.tsx` (optional) | none | S | Low; bundle budget watched in the build output | Kimi |
| 6 | **P6. Files page (folder browser)** | "Files" in the session ⋯ sheet pushes a page listing the session folder: Files-app rows (line icon, name at 17 px, grey line "12 KB · Today 14:02", chevron on folders), folders first, dot-files hidden behind a "Show hidden files" switch at the bottom. Tapping a folder pushes the next level; tapping a file opens P3 or P1/P7. Pull to refresh. Names changed in the last turn carry a small dot + "changed". | new `screens/session/files/FolderPage.tsx`, `folder-model.ts` (+ tests); `SessionActionsSheets.tsx`; `ui/GroupList.tsx`, `ui/PullToRefresh.tsx`, `ui/Icon.tsx` (folder, file, image icons); router and `PAGE_ROUTE` as in P3 | none beyond P2 (uses `sessionId` scoping and the new entry fields) | M | Low; big folders (node_modules) need a cap: list the first 1 000 entries and say how many more | Kimi for the page; Opus review |
| 7 | **P7. Images, PDFs and other files from the session folder** | An image the agent produced (from the Files page, a path link, or Codex's `imageView` row, which gains a thumbnail) opens in the P1 viewer via `/v1/file`. A PDF or other binary shows a card (kind, size, modified) with Share, which hands the file to the system sheet, where iOS offers Quick Look, Save to Files and other apps. No PDF renderer in the app (pdf.js would be far over budget). | `ui/ImageViewer.tsx` (URL source), `FileViewer.tsx` binary card, `SessionScreen.tsx` tool row for `imageView`, `host/src/adapters/codex/mapping.ts` unchanged | none beyond P2 | S | Medium: `navigator.share` with a fetched file from the installed app must be tried on the phone first; fallback is a download link | Kimi |
| 8 | **P8. Editing: "Ask the agent" now, a minimal editor later** | Now: in the viewer, select lines (tap a line number, drag to extend) and tap "Ask about these lines": the session composer opens with `src/parser.ts:12-20` already in it. Later, if still wanted: an Edit button (only when the session is idle) turns the page into a plain text field; Save shows the change as a diff in a confirm sheet; Undo is the field's own plus "Revert to saved"; a file changed on disk while editing says "This file changed on the Mac" and offers Reload or Keep mine. | Now: `FileViewer.tsx`, `SessionScreen.tsx` composer prefill via `SessionModel`. Later: `fs/writeFile` in protocol, schema and `host/src/files/`; a confirm sheet reusing `DiffView`; the e2e for conflict and busy | Now: none. Later: additive v1 `fs/writeFile {sessionId, path, content, expectedMtimeMs, expectedSize}`, error `conflict`, capability `files.write` | S now; M later | Now: low. Later: medium (a write surface on the Mac; agent and user editing the same file) | Opus for the later write path |

Takeaway: items 1 to 4 deliver what the brief asks for (seamless images, a real viewer, ways in) in about eight to ten
working days; 5 to 7 polish it; editing waits for the operator's verdict after using the viewer.

## Why the editor waits (recommendation)

Recommendation: ship no editor now; ship "Ask about these lines" with the viewer, and revisit a minimal editor
after the operator has used the viewer for a week. Reasons:

1. The agent is the editor in this app. A one-line fix typed on a phone keyboard is slower than telling the agent,
   which also runs the tests; the "Ask" action makes that path one tap from the exact lines.
2. A write method is the first time the phone can change the Mac's files without the agent. It needs the conflict
   guard Codex desktop has (C7: expected modification time, a conflict state, no autosave across it), a busy rule
   (no edits while a turn runs), and logging. That is real host work for a feature of unproven use.
3. User edits are invisible to the per-turn Changes view (it diffs the agent's turns) and to the agent's context,
   unless we also tell the agent "the user edited X"; that is a second design question.
4. A good phone code editor needs a keyboard accessory row (tab, brackets, arrows), which a web app cannot add to
   the iOS keyboard; it can only float a bar above it. Textastic for iOS is built around such a row (Unknown in
   detail here, see research 2b). A plain text field is fine for a typo, poor for code.

If the operator wants it anyway, the minimal editor is the "later" column of P8: a plain `textarea` (no CodeMirror: a
minimal CodeMirror 6 editor with line numbers, history and search measured 97.4 KB gzipped, six times the budget), save with a diff confirm, revert, the conflict guard, idle-only,
1 MiB cap, existing text files only.

## Order and dependencies

1. P1 (no dependency; can start now).
2. P2, then P3 and P4 together (P4's chip-to-viewer part needs only P3, not P2).
3. P5, P6, P7 in any order after P3.
4. P8 "Ask about these lines" with P3; the editor only on the operator's go.

## Acceptance shared by every item

- Gate green (`scripts/verify.sh`); new e2e at 390 × 844, light and dark, with screenshots written to `/tmp/` (not
  the repo).
- Reduce Motion: no grow/shrink, no spring; Escape and the back gesture close every new layer.
- No layout shift when an image or file finishes loading (measured in the e2e: the thumbnail's and the viewer's boxes
  do not move between first paint and load).
- Nothing reads or serves a file outside the session folder (host tests for `..`, absolute paths, symlinks out,
  deleted sessions).
