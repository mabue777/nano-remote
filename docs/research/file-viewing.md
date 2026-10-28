# Viewing files and images on the phone: what we have, what the references do (2026-10-28)

Study for ticket brocode-74p. Operator brief: "The way you view files, images inside the iOS nano-remote layer needs
to be polished. You can view images in sessions but you need to fix how seamless it feels; text files etc. need some
sort of viewer utility, maybe even an editor." The ranked plan that follows from this is `docs/plan/file-viewer.md`.

**The short version.** Today a tapped photo leaves the app: the thumbnail is a plain link that opens the raw image in
a new browser tab, with no zoom, no swipe and no way back except the browser's own. There is no way at all to read a
file from the session folder; the only "file content" on the phone is the per-turn diff and the command output. The
protocol can list a folder but cannot read or write a file. The references agree on the shape of the fix: a
full-screen image viewer with a counter and save/share (ChatGPT/Codex), a read-first text viewer with line numbers,
wrap, find and a size cap past which heavy features switch off or the file opens read-only (Codex desktop,
Textastic), colours as a small set of scope roles with a light and a dark theme (Textastic), and editing only with a
"changed on disk" guard (Codex desktop). Textastic for Mac could be read from its files but not screenshotted (no
Screen Recording permission in this shell); Textastic for iOS is Unknown. A syntax highlighter fits the 16 KB budget (Prism with a hand-picked
language set, about 13 KB gzipped; measured below), and the app already has a markdown renderer.

Labels as in `docs/research/rea/README.md`: **Observed** = seen directly in our code, a capture, shipped code,
strings, schema or plists. **Inferred** = best explanation of observed facts. **Unknown** = not established.
Screenshots of today's views are on the build Mac only, in `/tmp/file-viewer-shots/` (not in the repo).

## Part 1. What Nano Remote has today

### 1.1 Images in a session

| # | Finding | Label | Evidence |
|---|---|---|---|
| 1 | A sent message's images render as 96 × 96 px squares (`object-fit: cover`, radius `--radius-md`, `--fill-strong` behind them while loading), wrapped in a flex row with 6 px gaps. The box size is fixed by CSS, so a loading thumbnail does not shift the layout; the image itself has no `width`/`height` attributes and its aspect ratio is unknown to the app. | Observed | `SessionScreen.tsx` `SentAttachments` (lines 513–545); `SessionScreen.css` `.thumbs img` (364–371); capture: thumb box 96 × 96 at x 149, `width`/`height` attributes null, natural size 2048 × 1024 (`/tmp/file-viewer-shots/image-flow-measurements.json`) |
| 2 | Tapping a sent thumbnail follows `<a href="/v1/blob/<id>" target="_blank" rel="noopener">`: a new browser page with the raw image. There is no in-app viewer, no zoom, no swipe between the turn's images, no save or share, no dismiss gesture. | Observed | `SessionScreen.tsx` line 522; capture: the tap opened a second page at `/v1/blob/blb_…` (`04-tap-thumb-opens-new-tab.png`) |
| 3 | In the installed home-screen app on iOS, a `target="_blank"` link leaves the standalone app for a Safari view; that view may not carry the app's `nano_device` cookie, in which case the blob answers 401 JSON instead of the picture. | Inferred (iOS keeps a separate cookie store for home-screen apps); Unknown until tried on the phone | blob auth in `host/src/attachments/endpoint.ts` (`authenticate`) |
| 4 | Composer tray thumbnails are 72 × 72 px (`object-fit: cover`, 1 px `--line` border), shown from a local `blob:` preview URL while uploading; they are not tappable (only the × remove button is). | Observed | `SessionScreen.tsx` `TrayEntry` (570–599); `.tray-thumb` in `SessionScreen.css` (269–281); capture: `trayIsLink: false` |
| 5 | File attachments render as pill chips (▤ glyph, name, `download` attribute): a tap downloads the file; there is no preview of a text file the user attached. | Observed | `SessionScreen.tsx` 529–541; capture `chipAttrs` |
| 6 | Light and dark: thumbnails and chips use tokens only (`--fill-strong`, `--surface`); nothing image-specific changes with the scheme. The tray tile still has a 1 px border, which the look rules no longer use. | Observed | `01-tray-light.png`, `02-sent-thumbs-light.png`, `03-sent-thumbs-dark.png` |
| 7 | An image part carries only `{type:"image", url}`; uploads report no pixel size. Upload downscales photos to at most 2048 px on the long edge before sending. | Observed | `protocol/protocol-v1.md` §5 InputPart and §8.1; `attachments/resize.ts` |
| 8 | Agent messages in a session are plain text (no markdown), so an agent cannot show an image inline; Codex's `imageView` tool call (the agent looked at an image file) maps to a generic tool row with `arguments.path` and nothing to look at. Markdown rendering exists only in local chat (`screens/chat/markdown.ts`, 148 lines: paragraphs, headings, fences, lists, quotes, inline code, bold, italic, http(s) links; no images, no tables). | Observed | `TranscriptRows.tsx` `AgentMessage`; `host/src/adapters/codex/mapping.ts` line 120; `markdown.ts` header |

### 1.2 How the host serves images

| # | Finding | Label | Evidence |
|---|---|---|---|
| 9 | `GET /v1/blob/<id>` (and `HEAD`) streams the stored bytes with `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=86400`, `Content-Disposition: inline` for raster images (JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF) and `attachment` for everything else, plus `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`. | Observed | `host/src/attachments/endpoint.ts` `BLOB_HEADERS`, `download()` |
| 10 | No `ETag`, no `Last-Modified`, no `Accept-Ranges`/`Range` support. Blobs never change, so the one-day private cache is enough for images; Range would matter only for large files and PDFs. | Observed | same function; the e2e fake host sends fewer headers than the real host, so the capture's header list is not evidence for the real one |
| 11 | The service worker never touches `/v1/*`; images rely on the browser's HTTP cache alone. | Observed | `host/public/sw.js` line 39 (built from the web app) |
| 12 | Only uploads live in the blob store (20 MiB cap per file, one folder per session, deleted with the session). Files the agent writes in the session folder have no URL at all. | Observed | `host/src/attachments/store.ts` `MAX_ATTACHMENT_BYTES`; protocol §8.1 |

### 1.3 The "file content" surfaces that exist

| # | Finding | Label | Evidence |
|---|---|---|---|
| 13 | **Changes sheet** (`views/ChangesSheet.tsx`): a bottom sheet titled "Changes" with "N files changed"; a list of rows (grey kind word, path in code font, `+a −d` counts, chevron); a tap swaps the list for that file's diff inside the same sheet with an "All files" back link. | Observed | `DiffView.tsx` `ChangesView`, `FileDiff`; shots `diff/2-changes-list-light.png`, `diff/5-changes-list-dark.png` |
| 14 | **DiffView**: a table with old/new line numbers pinned at the left, a sign column and the code unwrapped (`white-space: pre`), the region scrolling sideways; `--type-code` 13/18 in `--font-code` (`ui-monospace, 'SF Mono', …`). No syntax colours, no wrap toggle, no find, no "view whole file". A binary file says "Binary file; no text diff." | Observed | `DiffView.tsx` 92–127; `views.css`; `tokens.css` line 64, 72; shots `diff/3-file-diff-light.png`, `diff/4-file-diff-scrolled-light.png`, `diff/6-file-diff-dark.png` |
| 15 | **OutputView**: command output, ANSI stripped, wrapped (`pre-wrap`, `overflow-wrap:anywhere`), follows the end while running, a Copy button. | Observed | `OutputView.tsx` |
| 16 | **ItemDetailSheet**: hosts OutputView and ChangesView as tabs for one item. Rows such as "Edited src/parser.ts" open it via "Show changes"; the file path itself is not tappable. | Observed | `ItemDetailSheet.tsx`; `SessionScreen.tsx` 450–462; `transcript.ts` |
| 17 | Caps the viewer must live with: diff text ≤ 64 KiB per file and ≤ 512 KiB per turn, ≤ 500 files; stream messages ≤ 16 MiB. | Observed | protocol §7 `turn/diff`; `host/src/stream/constants.ts` `MAX_MESSAGE_BYTES` |
| 18 | Motion parts available to reuse: `Sheet` (spring slide-up, drag-to-dismiss while scrolled to top, flick or 30 % pull closes, reduced motion respected), page push with edge swipe back (`routes/PageStack.tsx`, `ui/motion/page-motion.ts`), FLIP (`ui/motion/flip.ts`, `use-flip.ts`), drag and gesture helpers (`ui/motion/drag.ts`, `gesture.ts`), haptics. | Observed | file headers of the named modules |
| 19 | Client routes are a fixed list on the host: `/`, `/pair`, `/chats`, `/settings`, `/settings/providers`, `/lab`, and `/s/<id>`, `/c/<id>`. A new pushed page (a file viewer URL) needs the host's `PAGE_ROUTE` widened as well as the web router. | Observed | `host/src/http/static.ts` lines 13–19; `web/src/routes/router.ts` |
| 19b | Page zoom is off everywhere by operator decision (2026-10-24): `user-scalable=no`, `touch-action: pan-x pan-y` on html and body, and Safari's `gesturestart/change/end` cancelled on the document. An image viewer therefore cannot rely on browser zoom; it must do its own pinch from pointer events in a `touch-action: none` layer. | Observed | `web/index.html` line 9; `web/src/ui/no-zoom.ts`; `web/e2e/no-zoom.spec.ts` header |
| 20 | The main bundle is 299.95 KB minified, 93.26 KB gzipped; the lab is already split into its own lazy chunk (13.17 KB gzipped). A viewer can be a lazy chunk the same way, so its cost does not land on first load. | Observed | `vite build` output in this lane |

### 1.4 What the protocol offers, and what an additive v1 change needs

| # | Finding | Label | Evidence |
|---|---|---|---|
| 21 | `fs/readDirectory {path} → {entries:[{name, kind:"dir"\|"file", path}]}` exists for the new-session folder picker. It accepts any absolute path or `~` on the Mac; it is **not** limited to a session folder. Entries carry no size, no modification time, no hidden flag. Folders first, then by name; symlinks reported as their target; sockets and broken links skipped. | Observed | protocol §4; `host/src/core/host-core.ts` `readDirectory` (385–414) |
| 22 | There is no `fs/readFile`, `fs/writeFile` or `fs/stat`. `turn/diff` and `/v1/blob` are the only ways file bytes reach the phone. | Observed | protocol method list line 140; `host/src/stream/router.ts` |
| 23 | The Codex engine itself has `fs/readFile {path} → {dataBase64}`, `fs/writeFile {path, dataBase64}`, `fs/getMetadata` (`isFile`, `isDirectory`, `isSymlink`, `createdAtMs`, `modifiedAtMs`), `fs/readDirectory`, `fs/watch`, `fuzzyFileSearch`. Its read has no range and no size field: the whole file, base64. | Observed | `docs/research/rea/codex-app-server-schema/v2/Fs*.json`, `FuzzyFileSearch*.json` |
| 24 | Our host should not pass those through: they take any absolute path. Our own methods are host-level and agent-independent (like `turn/diff`), so the viewer works the same for Codex, Claude Code and Pi. | Inferred | protocol §7 sets that precedent for diffs |

What an additive v1 change needs (the design is in the plan, item P1 and P4):

- **`fs/readFile {sessionId, path, offset?, maxBytes?}`** → `{path, size, mtimeMs, mediaType, binary, encoding: "utf8"|"none",
  content?, offset, length, truncated}`. `path` is relative to the session folder (an absolute path is accepted only
  if it resolves inside it). `maxBytes` defaults to 256 KiB and is capped at 1 MiB per call; `offset` is in bytes and
  the host moves it back to a line start (and never splits a UTF-8 sequence), so "Show more" is `offset = previous
  offset + length`. `truncated` is true when the file continues.
- **Binary detection**: a NUL byte or invalid UTF-8 in the first 8 KiB → `binary: true`, no `content`. `mediaType` from
  the extension (and the first bytes for PNG/JPEG/GIF/WebP/PDF), so the client knows whether it can preview it.
- **Images, PDFs and other binaries** do not travel over the stream as base64 (a 16 MiB message cap and a third more
  bytes). They are served like blobs: **`GET /v1/file?sessionId=<id>&path=<relative path>`** with the same
  authentication and the same `nosniff` / `sandbox` CSP / `attachment`-unless-raster-image headers as `/v1/blob`, plus
  `Accept-Ranges: bytes` and `ETag` (size + mtime) because session files do change. 20 MiB cap like attachments.
- **`fs/readDirectory {path, sessionId?}`**: with `sessionId`, `path` is relative to the session folder and the scope
  rule below applies; entries gain `size?`, `mtimeMs?` and `hidden?` (additive). Without `sessionId` it keeps working
  as today for the folder picker.
- **`fs/writeFile {sessionId, path, content, expectedMtimeMs, expectedSize}`** → `{mtimeMs, size}`, only if the editor
  ships (plan item P8). Text only (UTF-8), ≤ 1 MiB, only an existing regular file (no create, delete or rename),
  atomic (temp file + rename, mode kept). Answers a new **`conflict`** error (`data.mtimeMs`, `data.size`) when the
  file changed since it was read, and `session_busy` while a turn runs.
- **Capability**: `initialize` gains `limits.maxFileReadBytes` (1 MiB) and a host-level `files {read, write}`; a client
  shows no viewer entry points without `read` and no Edit button without `write`.
- **Security posture.** Any paired device can already see every session and ask the agent to print any file, so
  reading inside the session folder adds no new reach. The rules: (1) authenticated paired device only, exactly like
  the stream and `/v1/blob`; (2) the path is resolved with `realpath` and must stay inside the `realpath` of the
  session's `cwd`, so `..` and symlinks pointing outside are refused (`not_found`, no hint of what exists outside);
  (3) a deleted session's folder is not readable through it; (4) no writes outside the session folder, none into
  `.git/`, none to symlinks, none while a turn is running; (5) every write is logged with clientId, path and size;
  (6) served bytes never run as a page of the host's origin (the blob headers). Hidden files such as `.env` stay
  readable (the agent can read them too) but the folder browser hides dot-files by default.

## Part 2. Reference study

### 2a. Textastic for Mac (`/Applications/Textastic.app`), with REA

Method: static reading of the bundle (Info.plist, `otool`, resources, binary strings) with a launch of the app on
read-only copies of sample files in `/tmp/textastic-sample/` (nothing saved, no setting changed, app quit). **Limit:**
this shell has no Screen Recording or Accessibility permission, so `screencapture`, `rea observe-native-ui` and
`capture-native-ui-scenario` were refused and there are no Textastic screenshots; decompiling through REA was also
refused. Everything below is from files and strings, not from looking at the running window.

| # | Finding | Label | Evidence |
|---|---|---|---|
| T1 | Textastic 7.0 (build 51), bundle `com.textasticapp.textastic-mac`, macOS 15 minimum, universal; **not encrypted** (no `cryptid 1`), so strings and resources are readable. No embedded frameworks (only a logging and an Emmet resource bundle). | Observed | `Info.plist`; `otool -l`; `Contents/Frameworks` absent |
| T2 | Highlighting is its own native engine over TextMate/Sublime grammars with Oniguruma regexes (54 `onig` strings in the binary); no WebKit. 129 grammars ship as JSON in `Resources/SublimeSyntaxes/` (128 registered in `syntax_definitions.plist`), with comment and indent preferences per scope. | Observed | `Resources/SublimeSyntaxes` (129 `.json`); `syntax_definitions.plist` keys `syntaxDefinitions` (128), `preferences`, `themes` |
| T3 | A theme is plain data: `backgroundColor`, `foregroundColor`, `caretColor`, `selectionColor`, `lineHighlightColor`, `invisiblesColor`, and `styles` = list of `{name, scopeSelector, foregroundColor, backgroundColor?, fontStyle}`. 29 themes, including GitHub Light and GitHub Dark. | Observed | `syntax_definitions.plist` `themes` |
| T4 | GitHub Light: white page, text `#24292f`, current line `#eaeef2` at 50 %, 49 styles using 14 distinct text colours: keyword and storage `#cf222e`, constant and support `#0550ae`, function `#8250df`, variable `#953800`, comment `#6e7781`. GitHub Dark: page `#0d1117`, text `#c9d1d9`, 13 colours: keyword `#ff7b72`, constant `#79c0ff`, function `#d2a8ff`, variable `#ffa657`, comment `#8b949e`. Light and dark are chosen separately (`Theme`, `DarkTheme`). | Observed | same plist; binary strings `DarkTheme` |
| T5 | So a token palette of about six roles (keyword, string, comment, constant/number, function/type, variable) covers what a reader sees; the 14 colours are mostly finer splits of those. | Inferred | T4 |
| T6 | Settings that matter on a phone, by key: `EditorFont`, `LineHeightMultipleInPercent`, `ShowLineNumbers`, `WrapLines`, `IndentWrappedLines` (wrapped lines keep the indent), `ShowInvisibles` (with separate tab, space, newline switches), `TabWidth`, `SoftTabs`, `DefaultTextEncoding`, `DefaultLineEndings`. Default values: Unknown (the sandboxed preferences could not be read). | Observed (keys); Unknown (defaults) | binary strings |
| T7 | File browser: a sidebar folder tree (icon + name rows), kept live by file-system events, with folder access kept across launches; a context menu with Open, Open With, Show in Finder, Quick Look, open Terminal here; an "Open Quickly" fuzzy finder; tabs; a status bar with line, column, language, encoding, line endings and a symbol list. An open-from-sidebar call takes a "transiently" flag. | Observed (strings); Inferred (single click opens a temporary preview tab; rows show no size or date) | binary strings |
| T8 | Images are not viewed in the app; they go to the system Quick Look panel. There is no markdown preview and no preview CSS in the bundle; markdown is only highlighted. | Observed (no preview resources; Quick Look strings); Inferred (opening a PNG directly fails as unreadable text) | `Resources` listing; strings |
| T9 | In-file find uses the standard macOS find bar; a separate Find in Files has ignore case, whole word, regex, ignore diacritics and reports "Found N results in M files", skipping binary and large files. | Observed (Find in Files strings); Inferred (in-file bar behaviour) | strings |
| T10 | Large files: the symbol list switches itself off above a line count; unreadable (binary or wrongly encoded) files raise an error instead of showing garbage. Exact limits: Unknown. No minimap, no folding found. | Observed (strings); Unknown (numbers) | strings |
| T11 | The keyboard accessory row is an iOS-only concept; nothing on the Mac describes it. | Unknown | — |
| T12 | The minimum window width is 460 pt, so the "small window" chrome could not be tried at phone width. | Inferred (reported by the study's launch attempt; not re-checked) | window nib |

What a phone viewer takes from Textastic (Inferred): TextMate-style scope roles as the colour contract, kept as a
small token list with a light and a dark set; wrap, line numbers, font size and invisibles as the only settings
worth a control; a compact footer (language, line count, size); turn heavy features off above a size but always show
the plain text; detect binary before decoding and hand images to an image view; markdown preview is our own
decision, since the reference editor has none.

### 2b. Textastic for iOS

| # | Finding | Label |
|---|---|---|
| T-iOS-1 | Not on this Mac, and no download was made. Web access (App Store listing, developer manual) was not available to this lane's tools, so nothing about the iOS app is established here. | Unknown |
| T-iOS-2 | Given an IPA from the operator, the useful extractions are: the keyboard accessory row (which keys, how many rows, the cursor-move control) from nibs/storyboards and strings; the Files provider and document-picker setup (`Info.plist` `UISupportsDocumentBrowser`, `LSSupportsOpeningDocumentsInPlace`, extension plists); QuickLook use (`QLPreviewController` symbols); the default font and size per device class, theme and grammar files (the same resource formats as on the Mac, if shared); and size or "binary file" strings. App Store binaries are FairPlay-encrypted, so code would be unreadable like the ChatGPT IPA; plists, nibs, strings and bundled resources are not. | Inferred |

### 2c. ChatGPT / Codex (iOS app in `resources/`, Codex desktop at `/Applications/ChatGPT.app`)

| # | Finding | Label | Evidence |
|---|---|---|---|
| C1 | The iPhone app asks for "save images from your chats" (photo-library add permission), so a viewer with Save to Photos exists natively. | Observed | IPA `Info.plist` `NSPhotoLibraryAddUsageDescription` |
| C2 | The iPhone app's Codex thread bundle holds `visualize.html` + `visualize.css`: a host page for agent-made visual fragments (Floating UI, Lucide from unpkg, its own token set `--font-mono`, `--color-text-*`). It is not a diff or file viewer; the earlier note that it renders diffs (iOS report item 29) is not supported by its content. The phone's diff and file UI is in the encrypted binary. | Observed (file content); Inferred (purpose) | `CodexRemote_CodexRemoteThread.bundle/visualize.{html,css}` |
| C3 | The iPhone app ships Mac-side scripts for a diff snapshot and a paginated `find` over the workspace, so the phone can show "files changed" and search files of the Mac's workspace. | Observed | `docs/research/rea/chatgpt-ios-readable-resources.md` item 28 |
| C4 | Codex desktop has an image lightbox with a counter "{current} of {total}", per-image labels "Image {n}", Download image, Close viewer, and an error state "Couldn't load this image" with Try again. | Observed | webview chunk `chatgpt-image-lightbox-*.js` (strings) |
| C5 | Codex desktop has a text-file editor built on CodeMirror (search panel chunk with its own find bar "Close find"; line wrapping extension), Undo/Redo, "Saving…", and a markdown mode ("Write in Markdown…"). | Observed | chunks `text-file-editor-extensions-*.js`, `text-file-editor-search-panel-*.js`, `text-file-editor-tab-content.electron-*.js`, `pierre-file-editor-*.js` |
| C6 | Its editor refuses to load a file above 20 971 520 bytes (20 MiB), opens a large file read-only with the banner "Large file opened read-only", and gives up highlighting a comparison above 2 097 152 characters ("This comparison is too large to highlight"; the file stays editable). | Observed | `pierre-file-editor-*.js`: `size>20971520` → `failLoad`, `isReadOnly: size > <threshold>` (the read-only threshold is imported from another chunk; its value is Unknown), `ir=2097152` → `too-large` |
| C7 | It autosaves (a 3 s timer constant next to the save state) and every save sends `expectedMtimeMs`; a file that changed on disk while open becomes a `conflict` document that blocks autosave until resolved ("accept" the external change). Unsaved state is tracked and closing can discard. | Observed (fields, branches); Inferred (exact timer use) | `text-file-editor-tab-content.electron-*.js`: `baseMtimeMs`, `expectedMtimeMs`, `kind===\`conflict\``, `scheduleAutosave`; `pierre-file-editor-*.js` `Tr=3e3` |
| C8 | Codex desktop also has a file tree for review (`review-file-tree-pane`), inline file diff review, image, PDF, DOCX, notebook and JSON previews, a binary-preview loader ("Loading preview…" inside the diff view) and Shiki highlighting (`shiki-highlight-provider`). | Observed (chunk names, one string) | webview asset names |
| C9 | So the reference treats files as: preview first (rich where it can), edit only with a guard against changes on disk, hard size caps with a plain banner. | Inferred | C4–C8 |

### 2d. iOS conventions to match

| Convention | What it means for us | Label |
|---|---|---|
| QuickLook-style full-screen preview | Black (or system background) full screen, pinch to zoom and double-tap to zoom to the tapped point, swipe left/right between items with an "n of N" title, swipe down to dismiss with the image shrinking back to its thumbnail, a share button (Save Image / Copy / AirDrop in the system share sheet). | Inferred (platform knowledge; not re-checked against Apple's documentation in this lane) |
| Files-app list rows | Leading file-type icon (folder tint for folders), name at body size, a grey second line with date and size, chevron only for folders; folders first or by name. | Inferred (same) |
| Reader margins | About 20 px side margins on a 390 pt phone, body 17/24. Our 20 px page margin already matches. | Observed (our tokens); Inferred (Safari) |
| Monospace | SF Mono at 13/18 is what our `--type-code` already uses; pinch-to-change font size is common in iOS code viewers. | Observed (tokens) |
| Web share | In a web app the share sheet is `navigator.share({files:[…]})` (needs a user tap); "Save Image" is offered by that sheet for image files. A long-press on an `<img>` also gives the system menu with Save to Photos. | Inferred (Web Share Level 2 is in Safari since iOS 15); Unknown for the installed PWA until tried |

## Part 3. Library sizes for the viewer (measured)

Bundled with esbuild 0.28 (`--bundle --minify --format=esm`), gzipped at level 9, in `/tmp/hl-measure` (outside the
repo). "Set" = TypeScript, JavaScript, JSON, CSS, HTML/markup, Markdown, Bash, Python, YAML, diff.

| Candidate | What was bundled | Minified | Gzipped | Licence | Fits 16 KB? |
|---|---|---|---|---|---|
| Prism 1.30 | core only | 8.3 KB | 3.6 KB | MIT | yes |
| Prism 1.30 | core + TS/JS/JSON/diff | 16.1 KB | 6.1 KB | MIT | yes |
| Prism 1.30 | core + the full set | 35.7 KB | **13.1 KB** | MIT | yes |
| highlight.js 11.12 | core only | 21.3 KB | 8.6 KB | BSD-3 | yes, but little room |
| highlight.js 11.12 | core + the full set | 62.7 KB | 20.0 KB | BSD-3 | no |
| speed-highlight 2.1 | core + the full set | 31.0 KB | 9.3 KB | CC0 | yes |
| sugar-high 2.6 | `core` (one generic JS-like tokenizer, no grammars) | 2.1 KB | 1.1 KB | MIT | yes, but JS-like only |
| sugar-high 2.6 | default entry (all 60+ language presets) | 32.9 KB | 11.9 KB | MIT | yes |
| Shiki 4.5 | core + JS regex engine + TS/JSON/MD + 2 themes | 430.9 KB | 79.3 KB | MIT | no |
| CodeMirror 6 (for an editor) | view + state + commands + search + line numbers | 301.4 KB | 97.4 KB | MIT | no (six times the budget) |
| marked 18 | markdown → HTML | 47.7 KB | 14.2 KB | MIT | (not needed) |
| micromark 4 | markdown → HTML | 53.9 KB | 15.7 KB | MIT | (not needed) |
| our `screens/chat/markdown.ts` | already in the app | 5.9 KB source | ~0 new | ours | yes |

Takeaway: Prism with a hand-picked language set is the best fit (13 KB gzipped for ten languages, tokens as plain
class names we colour with our own tokens, grammars added one file at a time); speed-highlight is a smaller
alternative with less grammar depth. Shiki (what Codex desktop uses) is five times the budget. Markdown needs no new
library: the chat renderer exists and only lacks tables and images.
