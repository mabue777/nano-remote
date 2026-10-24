# Visual gap: Nano Remote vs the ChatGPT / Codex apps (2026-10)

Research for the redesign after the visual groundwork (tokens, shared Sheet / BackHeader / Switch). It compares every
Nano screen, light and dark, with the closest OpenAI reference, puts the extracted OpenAI design values next to Nano's
tokens, and ends with a ranked list of changes phrased as tickets. Nothing here was copied into the repo: values are
measured and described, not reused.

**The short version.** Nano reads as a careful web form; the OpenAI apps read as a quiet iOS list. The gap is mostly five
things: a blue-tinted, card-on-grey palette where OpenAI is neutral grey with black (light) or white (dark) primary
buttons; boxed transcript items with "Details ›" links where OpenAI has flat one-line tool rows; a full-width
form-style composer where OpenAI has a floating rounded composer with round icon buttons; an approval card with an
amber border and four buttons where OpenAI has a soft grey card with one pill; and no icons at all (Nano uses text
glyphs ‹ › + ⋯ ⚙). Fixing the palette, the composer and the transcript rows covers most of the difference in feel.

## Sources and method

| Source | What was taken | Where it lives |
|---|---|---|
| ChatGPT desktop app (Electron, holds Codex), `app.asar` | CSS custom properties and the two built-in Codex themes from the webview bundle | extracted to `/tmp/visual-gap/asar-x` (not in the repo; nothing run from it) |
| ChatGPT iOS 1.2026.279 IPA, asset catalogs | 443 named colours with light and dark values (`xcrun assetutil --info`) | `/tmp/visual-gap/ios-colors.tsv` |
| `docs/research/rea/chatgpt-ios-readable-resources.md` | state strings (Running, On hold, Needs your input, Approval required, Failed) | in repo |
| Reference screenshots | `resources/openai-ref-screens/web/*` (35 files) and `local-nano/*` (Nano dark, real iPhone) in the main project folder | read in place |
| Nano at 390 × 844 | 24 captures, light and dark, via the Playwright fake host | `/tmp/visual-gap/nano/<screen>-<light\|dark>.png` |
| Side-by-side pairs | reference(s), Nano light, Nano dark, (real-iPhone Nano dark) | `/tmp/visual-gap/pairs/NN-<screen>.png` |

The capture script is a throwaway Playwright spec kept at `/tmp/visual-gap/scripts/zz-visual-gap.spec.ts`. To rerun it,
copy it into `web/e2e/` after a `vite build`, run `pnpm exec playwright test zz-visual-gap`, and delete it again. It
was not committed.

Reference paths below are relative to `/Users/mabue/BROCODE/Projects/NANO-REMOTE/resources/openai-ref-screens/`. The
official OpenAI video frames (25–35) and the widget frames (23–24) are treated as authoritative; 19 and 20 are the older
2025 cloud design, and third-party mocks are secondary.

## Extracted design values next to Nano's tokens

### Colour

Two OpenAI palettes matter. The iOS app's named colours are what the phone shows. The desktop Codex app has two
built-in themes; the default one ("chatgpt" accent source) is the same family as iOS.

| Role | iOS ChatGPT light / dark | Desktop Codex default theme light / dark | Nano token today light / dark |
|---|---|---|---|
| Page background | `bg/primary` #ffffff / #212121; Codex theme background #ffffff / #0d0d0d | surface #fcfcfc / #000000 | `--bg` #f6f6f4 / #121211 |
| Raised surface (cards, sheets) | `bg/elevated/primary` #ffffff / #303030; `bg/elevated/secondary` #f3f3f3 / #212121 | card #ffffff / #212121 | `--surface` #ffffff / #1d1d1b |
| Secondary fill (user bubble, approval card, chips) | `bg/tertiary` #f3f3f3 / #414141; `bg/secondary` #e8e8e8 / #303030 | user message = text at 5% over the surface | none; user bubble uses `--accent` |
| Primary text | `text/primary` #0d0d0d / #ffffff | ink #0d0d0d / #ededed | `--text` #1b1b1a / #ededea |
| Secondary text | `text/secondary` #5d5d5d / #cdcdcd | gray-500 #5d5d5d / gray-700 dark #afafaf | `--muted` #6b6b66 / #9c9c95 |
| Tertiary text, placeholder | `text/tertiary` #8f8f8f / #afafaf | gray-400 #8f8f8f / #414141 | none |
| Hairline | `border/default` #000 at 10% / #fff at 15%; separators #000 at 4% / #fff at 10% | border = ink at 8%, subtle = ink at 5% | `--line` #e2e2dc / #2e2e2b (opaque) |
| Primary button | `interactive/bg/primary` #0d0d0d / #ffffff, label #ffffff / #0d0d0d | composer submit = accent | `--accent` #2f5bd3 / #6d8ef0 with `--accent-text` |
| Link / accent | `theme/blue/default` #3a83f7; `theme/codex/text` #539af8 / #a4cdfb | accent #3a83f7 (classic Codex theme: #339cff) | `--accent` #2f5bd3 / #6d8ef0 |
| Success | `text/status/success` #1f4e25 / #effaf3 on `bg/status/primary/success` #def3e5 / #1f4e25 | text-success green-700 #00692a / green-400 #04b84c | `--ok` #1f9d55 (one value for both) |
| Warning | `text/status/warning` #d25e28 / #f1a275 on #fdf5f1 / #45240d | orange-700 #923b0f / orange-500 #e25507 | `--warn` #d99a06 (one value) |
| Error / danger | `text/status/error` #f2172b / #f38884 on #fcf1f0 / #471410; danger button #f2172b | red-700 #911e1b / red-500 #e02e2a | `--error` #c4352b (one value) |
| Diff added / removed | n/a | #00a240 / #ba2623 light, #40c977 / #fa423e dark; line backgrounds are these at 15% (light) and 23% (dark) | `.diff-line.add/.del` in RequestCards.css and views.css |

Takeaway: OpenAI is neutral grey (no warm tint, no blue tint) and spends colour only on status and links; Nano tints
every surface warm-grey and makes every primary button blue.

### Type

| Role | OpenAI | Nano today |
|---|---|---|
| UI font | system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI"`); "OpenAI Sans" is bundled for brand surfaces only | same system stack |
| Code font | `ui-monospace, "SF Mono", Menlo, …`; desktop chat code 12 px | `ui-monospace, SFMono-Regular, Menlo` |
| Desktop text scale | 11 / 12 / 13 (chat) / 14 (base) / 16 / 18 / 20 / 24 / 28 px; line heights 1.25–1.5; weights 400 / 510 / 590 / 600; tracking −0.025 em on large headings | rem steps 11.2 / 12 / 12.8 / 13.6 / 14.4 / 16 / 20.8 / 22.4 / 24 px; line height 1.4 everywhere |
| Phone (measured from frames 26–33) | large title "Codex" ≈ 34 pt bold; centred nav title ≈ 17 pt semibold with a ≈ 15 pt grey subtitle; body and rows ≈ 17 pt regular; group headers ≈ 20 pt semibold with a folder icon | page title 24 px bold, left; session title 24 px bold; rows 14–16 px; meta lines 12–13 px |

### Spacing, radii, shadows, motion (desktop Codex CSS)

| Kind | OpenAI | Nano today |
|---|---|---|
| Spacing unit | 4 px (`--spacing: .25rem`); composer buttons 28 px (20 px small) | 2 px steps, gutter 16 px |
| Radii | xs 4, sm 6, md 8, lg 10, xl 12, 2xl 16, 3xl 20, 4xl 24 px, multiplied by 1.25 in Codex; pills 9999; composer 22–28 px; corner shape superellipse(1.5) | 8 / 10 / 14 px, pill, round |
| Shadows | xs `0 1px 2px #0000000d`; sm `0 1px 2px -1px #00000014`; md `0 2px 4px -1px #00000014`; lg `0 4px 8px -2px #0000001a`; xl `0 8px 16px -4px #0000001f`; card `0 4px 16px #0000000d`; hairline ring `0 0 0 .5px #0000001a` | one shadow (jump pill), no tokens |
| Motion | default 150 ms `cubic-bezier(.4,0,.2,1)`; moderate 200 ms; relaxed 300 ms; enter `cubic-bezier(.23,1,.32,1)`; a spring curve; "Thinking" shimmer 2.8 s loop (text shimmer 5 s); spinner for running | 150 ms ease-out on switch and pull; 1.2 s pulse on the connecting dot; no tokens |
| Icons | own line-icon set: ~1.5–2 px rounded strokes, 16–20 px, monochrome in secondary text colour; colour only on status (green spinner, orange "!", "?" bubble) | none: text glyphs ‹ › + ⋯ ⚙ ▾ |

### State words (iOS widget strings)

Running · On hold · Needs your input · Approval required · Failed · Completed · Interrupted; list pill "Awaiting
approval"; lock screen "Needs permission to run command" with "Paused" and a "Review" button; transcript "Worked for
3h 42m" and "Thinking". Nano uses Working / Needs approval / Waiting for your approval / Needs your decision / Finished
/ Idle.

## Screen by screen

Each row: the reference, Nano's capture, and the difference in plain words. "Pair" is the side-by-side image.

### Home (session list) — pair `/tmp/visual-gap/pairs/01-home.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-ios-codex-home-hosts-light-30.png`, `web/openai-video-ios-task-list-awaiting-approval-light-26.png` | `/tmp/visual-gap/nano/home-light.png` | OpenAI is a flat list on white: large "Codex" title, a row of host chips (selected chip is black, green online dots), pinned rows, then project groups with a folder icon and chevron. Each task is one line of 17 pt text with one trailing indicator: green spinner (running), green-tinted "Awaiting approval" pill, or a branch icon. Nano stacks four bordered cards on warm grey: a host card listing agent health, a notifications explainer paragraph, a "Sessions" header with two buttons, then two-line session cards with coloured status words and a red count badge. Nano's blue segmented control (Sessions / Chats) has no counterpart. |
| Dark | closest: `web/community-ios-codex-task-list-dark-16.jpg`, `web/community-ios-sidebar-codex-entry-dark-17.jpg` (reference missing - provisional for the remote-host home) | `/tmp/visual-gap/nano/home-dark.png`, real iPhone `local-nano/nano-sessionlist-dark-02.png` | OpenAI dark is near-black (#000 / #0d0d0d) with rows directly on it, mid-grey circular tiles and a white "+" button. Nano dark is warm charcoal #121211 with cards #1d1d1b; the periwinkle "New session" and selected tab with dark text read washed out next to OpenAI's white-on-black. |

### Session, running (streaming) — pair `02-session-streaming.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-ios-task-running-tool-light-32.png`, `web/verdent-ios-task-running-thinking-light-13.png` | `nano/session-streaming-light.png`, `nano/session-running-approval-banner-light.png` | OpenAI: centred small title "Assistant" with a grey host subtitle; grey user bubble with dark text; a tool row "app icon + Sending recap to Romain + chevron" in secondary grey; a shimmering grey "Thinking"; a floating rounded composer card (+, mic, black round stop button). Nano: left-aligned 24 px title, then status line, agent·folder line and model "Change" link before any content; a blue user bubble; every item gets a "Details ›" or "Output ›" link; commands sit in bordered boxes in mono; "Working…" in blue; the composer is a full-width bar with a round +, a field and two text buttons (red outline Stop, blue Steer). |
| Dark | reference missing - provisional (use `web/community-ios-codex-task-list-dark-16.jpg` for tokens) | `nano/session-streaming-dark.png` | Same structure; Nano's dark blue user bubble and periwinkle Steer button carry the blue tint; OpenAI dark would be a #303030-ish grey bubble with white text. |

### Session, finished thread — pair `03-session-finished.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-ios-thread-summary-light-31.png`, `web/heise-ios-task-thread-light-02.png` | `nano/session-finished-files-changed-light.png` | OpenAI collapses history into "18 previous messages ⌄" with a hairline and renders the result as 17 pt prose with bold section headings, no box. Nano shows every item expanded, each with its link, a mono "Done echo … exit 0" box, and a small blue "4 files changed ›" link. Nano body text in items is 13–14 px against OpenAI's ≈ 17 pt. |
| Dark | reference missing - provisional | `nano/session-finished-files-changed-dark.png`, real iPhone `local-nano/nano-session-dark-01.png` | The real-iPhone capture shows the token/context footer ("66,646 in · 366 out · 1.7% of context") above the composer; OpenAI shows nothing like it in the thread (it lives in usage widgets). |

### Session, approval card — pair `04-approval.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-ios-approval-prompt-light-27.png`, `web/openai-video-ios-approval-approved-light-28.png` | `nano/session-approval-light.png` | OpenAI: "Worked for 3h 42m" with a hairline, then a soft grey card (radius ≈ 20) with a small icon, a bold title "Allow Codex to continue?", an inner white box holding the action in plain words, and one grey pill "Approve" with blue text. After approval the card keeps its place with a check before the title and a green check at the right, and the next tool row ("Ran integration tests", terminal icon, chevron) follows. Nano: an amber "Needs your decision · 1 approval" banner above the conversation plus the card itself with an amber border, a grey mono command box, a mono "in /path" line, the reason, and four equal buttons in a 2 × 2 grid (blue Accept, outline Accept for session, outline Decline, solid red Cancel). The red solid Cancel draws the eye more than Accept. |
| Dark | reference missing - provisional | `nano/session-approval-dark.png`, real iPhone `local-nano/nano-approval-dark-01.png`, `-02.png` | Same as light; dark amber border and red button are the loudest things on screen. Defect seen (not fixed here): in the capture a blue sliver of the user bubble shows under the banner, and the queue composer's placeholder is cut ("Message for afte"). |

### Session, agent question — pair `05-question.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | reference missing - provisional: closest is the approval card `web/openai-video-ios-approval-prompt-light-27.png`; widget "?" bubble in `web/ithinkdiff-ios-widget-task-list-statuses-light-24.jpg` | `nano/session-question-light.png` | Nano pins the question above the composer in an amber-bordered panel: small-caps "SECTIONS" header, bold question, "(pick any)", options as bordered rows with square checkboxes and grey descriptions, an "Other…" field, and a full-width pale blue "Send answer". Measured against the approval card, the OpenAI pattern would be the same soft grey card with an icon + bold question, options as plain rows inside one white inner box, and one ink pill. The amber banner "Needs your decision · 1 question" repeats what the panel already says. |
| Dark | reference missing - provisional | `nano/session-question-dark.png` | Same; amber border on near-black is the strongest element. |

### Changes (files changed and line diff) — pair `06-changes.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-mac-changes-files-changed-light-34.png` (desktop; a phone line-level diff: reference missing - provisional) | `nano/changes-list-light.png`, `nano/changes-diff-light.png` | OpenAI puts the change summary inline in the transcript: one bordered card "2 files changed +42 −7" with Undo and Review on the right, then one row per file with the path in the UI font, green/red counts and an expand chevron. No kind badges. Nano opens a sheet "Changes · 4 files changed" with a Close button, each file in its own bordered row with a coloured outline badge (Modified / Added / Renamed / Deleted) and a mono path; the diff shows line numbers, a blue hunk header and pink/green line backgrounds, which is close to the Codex diff colours already. |
| Dark | reference missing - provisional | `nano/changes-list-dark.png`, `nano/changes-diff-dark.png` | The sheet backdrop dims the session header to near-invisible; badge outlines in four colours are busy on black. Codex dark diff colours would be #40c977 / #fa423e at 23% for line backgrounds. |

### New session sheet — pair `07-new-session.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-ios-new-task-empty-light-33.png`; composer options `web/macrumors-ios-mac-work-composer-light-05.jpg` | `nano/new-session-light.png` | OpenAI starts a task from an empty thread: centred "What should we work on?" with a folder project picker chip under it, and the model / effort picker lives inside the composer ("5.6 Sol Extra High" next to mic and send). Nano opens a sheet that is a full form: Agent chips, Model select, Effort segmented control, Folder field with Browse, a resolved-folder field, Bypass approvals switch, Title, First message, all labelled, all visible at once. |
| Dark | reference missing - provisional | `nano/new-session-dark.png`, real iPhone `local-nano/nano-newsession-dark-01.png`, `-02.png` | On the real iPhone the bypass label wraps into a narrow column and overlaps the "Title" label (older build; the current capture lays out correctly). |

### Settings — pair `08-settings.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/openai-video-ios-settings-connections-light-29.png` | `nano/settings-light.png` | OpenAI: centred nav title "Connections" with a back chevron; one inset grouped list (white rows on light grey, radius ≈ 12, inset hairlines); each row has a round grey icon tile, the host name at 17 pt, and a green iOS switch; a blue "+ Add connection" row closes the group. Nano: "‹ Chats" back link, a 24 px "Providers" title, then separate cards each with a bold heading, explanatory paragraph, mono URL, outline badge and its own buttons; the switch is blue. |
| Dark | `web/testingcatalog-mac-settings-connections-dark-08.png` (Mac; phone dark: reference missing - provisional) | `nano/settings-dark.png` | Mac dark settings: one rounded group per section on near-black, small 13 px rows with leading line icons, blue switches, "Revoke access" pill. Nano dark cards on #121211 with long paragraphs are much denser in words. |

### Local chat — pair `09-local-chat.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/appstore-ios-chat-thread-composer-light-06.jpg` | `nano/local-chat-light.png` | ChatGPT chat: floating round nav buttons (menu left, compose and ⋯ right) and no title block; light grey-blue user bubble; answer as plain prose with a row of small action icons (copy, read aloud, thumbs, retry, share); floating "Ask ChatGPT" composer pill with +, mic and a round voice button. Nano: "‹ Chats" link, a model menu pill, a 24 px title, a provider line with a "Thinking" switch, a blue user bubble, and the full-width composer bar with a pale-blue Send. |
| Dark | reference missing - provisional (dark tokens from `web/community-ios-sidebar-codex-entry-dark-17.jpg`) | `nano/local-chat-dark.png` | Dark round tiles and the white-on-black search capsule in 17 show the dark idiom: mid-grey (#212121–#303030) filled controls, no outlines. |

### Pair — pair `10-pair.png`

| | Reference | Nano | Differences |
|---|---|---|---|
| Light | `web/community-ios-pairing-waiting-desktop-light-18.jpg`, `web/apidog-mac-ios-pairing-authorize-dark-15.png` | `nano/pair-light.png` | OpenAI pairing is a centred moment: soft lavender gradient header, a large monochrome device icon, a bold one-line title, a two-line grey hint, and on the authorise step a single black full-width pill "Authorize this phone". Nano is a left-aligned form card (code field, device name field, pale blue "Pair" button) with a security note below. |
| Dark | `web/apidog-mac-ios-pairing-authorize-dark-15.png` (Mac side) | `nano/pair-dark.png` | Mac dark: #000-ish window, dark grey rounded panel, segmented control with a filled selected segment. Nano dark: same form on charcoal; disabled "Pair" button is muddy periwinkle. |

### Status icons (cross-screen) — pair `11-status-icons.png`

References: `web/ithinkdiff-ios-widget-task-list-statuses-light-24.jpg` (spinner = running, "?" bubble = needs input),
`web/openai-video-ios-lockscreen-needs-permission-light-25.png` (Paused + Review pill),
`web/verdent-mac-ios-setup-home-recents-dark-14.png` (blue spinner, orange "!", cloud). Nano shows state only as
coloured words ("Needs approval" amber, "Finished" green, "Idle" grey) plus a red number badge. OpenAI shows state as
one small trailing icon per row and keeps the title black.

## Ranked changes

Ranked by how much each changes the feel of the app, divided by effort (S ≈ a day, M ≈ 2–3 days, L ≈ a week). Each
names the token or shared component it changes. Every item applies to light and dark.

| # | Ticket | Changes | Impact | Effort |
|---|---|---|---|---|
| 1 | **Neutral palette and ink primary buttons.** Retune the colour tokens to neutral greys from the iOS values above (light page #ffffff, secondary fill #f3f3f3, text #0d0d0d / #5d5d5d / #8f8f8f; dark page #0d0d0d, raised #212121, fill #303030, text #ffffff / #cdcdcd / #afafaf). Make hairlines translucent (ink at 8–10%). Add `--primary` / `--primary-text` (black on light, white on dark) for the main action of each screen; keep `--accent` (#3a83f7-ish) for links and the running indicator only. | `web/src/styles/tokens.css` (`--bg`, `--surface`, `--text`, `--muted`, `--line`, `--accent`, new `--fill`, `--text-tertiary`, `--primary`, `--primary-text`); `button.primary` in `base.css` | High | S |
| 2 | **Grey user bubble.** User messages become a neutral fill (`--fill`, text `--text`) with one uniform radius of about 18 px instead of the blue speech bubble. | `.msg.user` in `screens/session/SessionScreen.css` (used by local chat too); token `--fill`, `--radius-bubble` | High | S |
| 3 | **Floating composer with icon buttons.** Turn the bottom bar into a raised rounded card (radius 24–28 px, `--surface` raised, `--shadow-lg`), with a round + button, the field, and one round trailing button that is Send (arrow) when idle, Stop (filled square on `--primary`) while running; Steer and Queue become the same send button with a short label above the field. | `.composer`, `.composer-form`, `.composer-actions`, `button.stop` in `SessionScreen.css`; a shared `Composer` component under `web/src/ui/` used by session and local chat; tokens `--shadow-lg`, `--radius-composer` | High | M |
| 4 | **Flat tool rows and a "Thinking" line.** Replace bordered item boxes and their "Details ›" / "Output ›" links with one-line rows: a leading icon, a verb phrase in secondary text ("Ran echo hello", "Edited 2 files"), a trailing chevron; tapping the row opens the existing detail sheet. Replace "Working…" with a grey "Thinking" label with a slow shimmer, and show "Worked for 3m 12s" with a hairline when a turn ends. Collapse older turns behind "N previous messages ⌄". | `.item`, `.item-line`, `.state`, `.turn-state`, `.older` in `SessionScreen.css`; `Sheet` unchanged; new motion token `--duration-shimmer` | High | M |
| 5 | **Quiet approval card with one primary action.** Soft grey card (`--fill`, radius 20, no coloured border), small icon + bold title, the command in an inner `--surface` box, one `--primary` pill for Accept and a secondary pill for Decline; "Accept for session" and "Cancel" move into a "More" menu. Answered cards stay in place with a check and collapse. Drop the separate amber "Needs your decision" banner when the card is on screen; keep the state in the header. | `.request-card`, `.request-command`, `.request-actions` in `screens/session/approvals/RequestCards.css`; `.decision-banner` in `SessionScreen.css`; `--fill`, `--primary` | High | M |
| 6 | **Session list as a flat list.** Rows directly on the page, title at 17 px regular in `--text`, one meta line in `--muted`, and one trailing status indicator (spinner = running, tinted pill "Awaiting approval", "?" bubble = needs input, nothing = finished). Move the host card into a row of host chips under the title, and the notifications explainer into Settings. Replace "Refresh" with pull-to-refresh (already exists) and "New session" with a round + button. | `.session-list`, `.session`, `.session-title`, `.session-meta`, `.host`, `.notifications` in `screens/HomeScreen.css`; `.pill`, `.badge`, `.dot` in `components.css`; `PullToRefresh` | High | M |
| 7 | **An open line-icon set.** Add one shared `Icon` component with a small set from Lucide (ISC licence) or Phosphor (MIT): back chevron, chevron right/down, plus, more, gear, folder, terminal, file-diff, check, spinner, question bubble, stop square, send arrow. Replace the text glyphs ‹ › + ⋯ ⚙ ▾. Stroke 1.5–2 px, 16–20 px, colour `--muted`. | new `web/src/ui/Icon.tsx`; used by `BackHeader`, `Sheet`, composer, rows | High | S–M |
| 8 | **Centred session header.** `BackHeader` shows a round back button, a centred 17 px semibold title and a grey subtitle (host · folder), and a round ⋯ button. The status pill, model line and "Change" link move into the ⋯ sheet so the conversation starts at the top of the screen. | `web/src/ui/BackHeader.tsx`; `.session-head`, `.session-model-button`, `.session-model-change` in `SessionScreen.css` | High | M |
| 9 | **Type roles instead of rem steps.** Define roles: large title 34/41 bold, nav title 17/22 semibold, body 17/24 (transcript and rows), callout 15/20 (meta), footnote 13/18, caption 12/16, code 13/18; tighten tracking on titles (−0.02 em). Map existing `--font-*` uses onto them. | `tokens.css` type tokens; `base.css` headings and `.small` | Medium | M |
| 10 | **Status vocabulary and colours.** Use the OpenAI words (Running, Needs your input, Awaiting approval, Failed, Finished) and tinted status pills: text and background from the iOS status sets (success #1f4e25 on #def3e5, warning #d25e28 on #fdf5f1, error #f2172b on #fcf1f0, dark pairs as in the table). One state, one icon, one colour across list, header and widget-like places. | `--ok`, `--warn`, `--error`, `--busy` become pairs (`--ok-text`/`--ok-bg`, …) in `tokens.css`; `.pill.*`, `.dot`, `.turn-state.*` | Medium | S |
| 11 | **Inline files-changed card.** At the end of a turn show one bordered card "N files changed +a −d" with a Review action and up to five file rows (path in the UI font, green/red counts, chevron); tapping opens the existing Changes sheet. In the sheet, drop the four-colour outline badges for a single grey kind word, and set diff colours from the Codex values (added #00a240 / removed #ba2623 light, #40c977 / #fa423e dark; line backgrounds at 15% / 23%). Reference missing - provisional for the phone diff. | `views.css` (`.changes-*`, `.diff-*`), `.diff-line.add/.del` in `RequestCards.css`; new tokens `--diff-add`, `--diff-del`, `--diff-add-bg`, `--diff-del-bg`; `ChangesSheet`, `DiffView` | Medium | M |
| 12 | **Grouped settings list.** Settings becomes inset grouped lists: rows 44+ px with a leading icon tile, a 17 px label, a trailing value / chevron / switch, inset hairlines, radius 12; explanations move to a grey footnote under each group. The switch "on" colour becomes system green. | new shared `GroupedList` / `ListRow` in `web/src/ui/`; `Switch` (new token `--switch-on` ≈ #34c759, dark #30d158); `ProviderSettingsScreen.css`, `KeepAwakeSection.css`; `.card` in `base.css` | Medium | M |
| 13 | **Question card matches the approval card.** Same grey card, icon + bold question, options as rows inside one inner `--surface` box with round (single) or rounded-square (multi) check icons, "Other" as the last row, one `--primary` "Send" pill. Drop the amber border and the small-caps header. Reference missing - provisional. | `.question-field`, `.question-options`, `.option`, `.pinned-questions` in `RequestCards.css` | Medium | S |
| 14 | **Radius, shadow and motion tokens.** Radii 6 / 10 / 12 / 16 / 20 / 28 / pill (Codex: base × 1.25); sheet top corners 20+; shadow tokens xs / sm / md / lg / xl from the table; motion tokens fast 150 ms, moderate 200 ms, relaxed 300 ms, standard ease `cubic-bezier(.4,0,.2,1)`, enter ease `cubic-bezier(.23,1,.32,1)`; use them for sheet slide-in, row press and card collapse, and honour reduced motion. | `tokens.css` (`--radius-*`, new `--shadow-*`, `--duration-*`, `--ease-*`); `Sheet`, `Switch`, `.pull` | Medium | S |
| 15 | **New session as an empty thread.** Open a blank session screen with a centred "What should we work on?" and a folder chip under it; agent, model and effort sit as chips inside the composer; bypass approvals and title move behind a "More options" disclosure. | `NewSessionSheet.tsx` / `NewSessionSheet.css`, `ModelEffortFields`; the composer from item 3 | Medium | L |
| 16 | **Dark mode pass.** After item 1, check every screen on a real iPhone: no outlines on dark controls (filled #212121 / #303030 instead), a lighter sheet backdrop so the header stays readable behind Changes, white primary buttons with black text, no periwinkle. | dark block in `tokens.css`; `.sheet-backdrop` in `components.css` | Medium | S |
| 17 | **Local chat chrome.** Round floating nav buttons (back, model menu, ⋯) instead of the "‹ Chats" link and title block; the Thinking switch moves into the composer's model chip; answer actions as a row of small icons. | `screens/chat/ChatScreen.css`; `BackHeader`; `Icon`; composer from item 3 | Low–Medium | S |
| 18 | **Centred pairing screen.** Large device icon, one bold title, a grey two-line hint, the code field, and one full-width `--primary` pill; the security note as a footnote. | `screens/PairScreen.css` | Low | S |

Suggested order: 1, 2, 7, 3, 4, 5, 8, then 6 and 10 together; 14 can ride along with 1. Items 1, 2 and 14 are token
work only and change every screen at once.

## Licensing

- **Fonts.** OpenAI ships "OpenAI Sans" in the desktop bundle; it is not to be copied or embedded. Nano already uses the
  system stack, which is SF Pro on iPhone and is what the OpenAI phone app shows; keep it. Open fallback for other
  platforms: Inter (SIL Open Font Licence). Code: the system `ui-monospace` (SF Mono on Apple), open fallback
  JetBrains Mono (OFL).
- **Icons.** OpenAI's icon set and app/tool glyphs are theirs; do not copy or trace them. Apple's SF Symbols are
  licensed for Apple-platform apps and are not to be embedded in a web app. Use Lucide (ISC) or Phosphor (MIT).
- **Colours and sizes** are facts measured from the apps; matching them is fine, copying their CSS or assets is not.
  Nothing from the extracted bundles is in the repo.

## Missing reference screenshots (for the operator to capture on the iPhone)

Capture these in the ChatGPT app's Codex section, connected to a Mac host, and add them to `local-openai/` with an
index row like the existing ones:

1. An agent question (the agent asks something with options), light and dark.
2. A phone line-level diff: tap a file in a "files changed" card and show the diff, light and dark.
3. Dark mode, iPhone Codex: home with host chips, a running thread (tool row + Thinking), an approval card before and
   after approving, Settings › Connections, and the new-task empty state.
4. The composer while a task runs, with text typed (to see how steering looks), light.
5. An approval with more than one choice (decline or "always allow"), if Codex offers one, light.
6. A Codex approval push notification on the lock screen, expanded, with its action buttons.
