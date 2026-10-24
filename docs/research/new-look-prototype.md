# New look prototype (/lab, Look: Now / New), 2026-10-24

The visual-gap study (`docs/research/visual-gap-openai-2026-10.md`) ranked the changes that would make Nano Remote
look like the ChatGPT / Codex iPhone app. This prototype builds them in the interaction lab, so the operator can try
the redesign on the iPhone together with the smooth motion before any real screen changes. A **Look** switch at the
top of the Lab panel shows the same mini app in today's design (Now) or the redesign (New). The real screens are
unchanged.

**The short version.** The New look is in the lab: neutral greys with black (light) or white (dark) main buttons, a
grey user bubble, line icons, a floating composer with one round Send/Stop button, flat one-line tool rows with
"Thinking", "Worked for 3m 12s" and "3 previous messages", a quiet approval card and a matching question card, a
centred session header, and a flat session list with host chips. It works in light and dark and with every motion
switch. Most of it is colour and shape (tokens) plus four component rewrites: transcript rows, composer, request
cards, and the session header.

## How to try it on the phone

1. Open `https://<host>/lab` (the same address as the app, no pairing needed).
2. Tap **Lab**. In the New look the button sits as a small tab on the right edge, because the centred title takes
   the middle of the top bar.
3. The first row is **Look: Now | New**. Pick New, tap **Done**. The choice stays after a reload. **All Now** and
   **All Smooth** change only the motion switches, never the look.
4. Try: the host chips on the list, open "Fix the failing parser test", watch Thinking and the answer, open
   "3 previous messages" and a tool row, the ⋯ button (details, then Changes), More on the approval card, Accept,
   send a message (the reply ends with a question card), send again and tap the round Stop button, the + button.

Screenshots from the smoke test (390 × 844, light and dark, all motion Now and all Smooth) are written to
`/tmp/look-shots/` on the build Mac each time the lab smoke runs: `new-<light|dark>-<now|smooth>-<step>.png` and,
for comparison, `now-<light|dark>-<step>.png`.

## The changes

Effort to adopt in the real app: S is about a day, M two to three days, L about a week. Item numbers are the
study's ranks. Tokens are defined in `web/src/lab/new-look.css` under `.lab[data-look='new']`, named as they would be
in `web/src/styles/tokens.css`. Adopting a token means moving its line from that block into `tokens.css`.

| Study item | What it is, in plain words | Tokens it introduces or retunes | Effort | Real components it touches |
|---|---|---|---|---|
| 1. Neutral palette, ink buttons | Pure greys instead of warm grey and blue. White page (near-black in dark), grey fills, see-through hairlines. The main button of each screen is black on light and white on dark. Blue is kept for links and the running spinner only. | Retuned: `--bg`, `--surface`, `--text`, `--muted`, `--line`, `--accent`, `--accent-text`, `--busy`, `--ok`, `--error`, `--warn`. New: `--surface-raised`, `--fill`, `--fill-strong`, `--text-tertiary`, `--line-subtle`, `--primary`, `--primary-text`, `--warn-text`, `--warn-bg` | S | `styles/tokens.css`; `button.primary` in `base.css`; `.choice.selected` in `components.css`; `.segmented` in `HomeScreen.css`; every screen changes colour at once, so a light and dark check of each screen follows (study item 16) |
| 2. Grey user bubble | Your messages sit in a grey bubble with dark text and one round shape (18 px) instead of a blue speech bubble. | `--radius-bubble` (uses `--fill`) | S | `.msg.user` in `screens/session/SessionScreen.css`, used by local chat too |
| 7. Line icons | Thin line icons (Lucide shapes, ISC licence) instead of the text signs ‹ › + ⋯ ⚙ ▾. The lab inlines the 20 it needs (`web/src/lab/icons.tsx`, about 4 KB unzipped), so no package was added. | none (icons use `currentColor`) | S | move `lab/icons.tsx` to `ui/Icon.tsx`; `BackHeader`, `Sheet` header, composer, transcript rows, list rows, gear button on Home |
| 3. Floating composer | The bottom bar becomes a raised rounded card with a round + at the left and one round button at the right: an arrow (Send) when you have typed, a filled square (Stop) while the agent runs. Typing while it runs shows "Steers the running turn" above the field and Send steers. | `--radius-composer`, `--shadow-lg`, `--shadow-ring`, `--surface-raised` | M | `.composer*`, `button.stop` in `SessionScreen.css`; the composer in `SessionScreen.tsx` and `ChatScreen.tsx`, best as one shared `ui/Composer`; Steer/Queue labels; the attachment button |
| 4. Flat tool rows, Thinking, Worked for, previous messages | Each tool call is one grey line: an icon, a verb ("Ran npm test -- parser", "Edited src/parser.ts"), a chevron; tapping opens the output under it. "Working…" becomes a grey "Thinking". When a turn ends its work folds behind "3 previous messages ⌄" and a hairline line says "Worked for 3m 12s". | type roles below; uses `--fill`, `--text-tertiary`, `--duration-shimmer` (exists) | M | item rendering in `SessionScreen.tsx` (`.item`, `.item-line`, `.state`, `.turn-state`, `.older`), the detail sheet stays as is; "Worked for" needs no protocol change: turns already carry `startedAt` and `completedAt` |
| 5. Quiet approval card | A soft grey card: terminal icon and bold title, the command in a white inner box with the folder and reason under it, one black pill **Accept** and one grey pill **Decline**. "Accept for this session" and "Cancel the turn" sit behind **More**. Once answered, the card stays where it was, one line high, with a check and "Approved" in green. | `--radius-card`, `--radius-inner` (uses `--fill`, `--surface`, `--primary`) | M | `approvals/RequestCards.tsx` and `.css` (`.request-card`, `.request-command`, `.request-actions`); `.decision-banner` in `SessionScreen.css` (drop it while the card is on screen) |
| 13. Question card | Same card: question icon and bold question, the options as rows in one white inner box with round checks, "Other…" as the last row, one black **Send answer** pill. Answered, it keeps its place with a check and the answer. | same as item 5 | S | the question part of `RequestCards.tsx` and `.css` (`.question-field`, `.question-options`, `.option`, `.pinned-questions`) |
| 8. Centred session header | A round back button, the title centred at 17 px with a grey line under it (host · folder), and a round ⋯ button. The status pill, the task state and the model line move into the ⋯ sheet, so the conversation starts right under the header. | `--type-nav-title` | M | `ui/BackHeader.tsx`; `.session-head`, `.session-model-button` in `SessionScreen.css`; the ⋯ sheet joins `SessionActionsSheets` / `SessionSettingsSheet` |
| 6. Flat session list | Rows straight on the page: the title at 17 px, one grey meta line, and one sign at the right: a blue spinner (running), an orange "Awaiting approval" pill, an orange "?" (needs your input), a red "!" (failed), nothing when finished. A large "Sessions" title with a round black + (New session) and host chips under it. | `--type-large-title`, `--type-body`, `--type-footnote`, `--warn-text`, `--warn-bg` | M | `HomeScreen.tsx` / `.css` (`.session-list`, `.session*`, `.host`, `.notifications`), `.pill`, `.badge`, `.dot` in `components.css`, `ChatsPanel.tsx`. The real app pairs with one host, so the chips would show that host (or the agents) until more hosts exist; the host card and the notifications explainer move to Settings |
| 9. Type roles | Named text styles instead of loose sizes: large title 34/41 bold, nav title 17/22 semibold, body 17/24, callout 15/20, footnote 13/18, caption 12/16, code 13/18, titles slightly tightened. | `--font-ui`, `--font-code`, `--type-large-title`, `--type-nav-title`, `--type-headline`, `--type-body`, `--type-callout`, `--type-footnote`, `--type-caption`, `--type-code`, `--tracking-title` | S for the tokens, M to map every screen | `tokens.css`, `base.css` (`h1`, `h2`, `.small`, `code`), then each screen's CSS |
| 14. Radii and shadows | Named shapes for the pieces above, and the shadow scale. | `--radius-inner` 12, `--radius-bubble` 18, `--radius-card` 20, `--radius-sheet` 20, `--radius-composer` 26; `--shadow-xs`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-card`, `--shadow-ring` | S | `tokens.css`; `.sheet` top corners in `components.css` |
| 11 (only what the sheet needs) | In the Changes sheet the coloured outline badges become grey kind words and the diff uses the Codex green and red. | `--diff-add`, `--diff-del`, `--diff-add-bg`, `--diff-del-bg` | S here (the full item 11 is M) | `views.css` (`.file-kind`, `.diff-*`), `.diff-line.add/.del` in `RequestCards.css` |

Takeaway: the token work (items 1, 2, 9, 14) changes every screen at once for about two days; the four component
rewrites (rows, composer, cards, header) carry most of the remaining feel and are where the motion parts live.

## Motion inside the New look

The three techniques that were held back because they sit inside the redesigned parts work in the New look, with
the same switches:

- **Sending (6).** The grey bubble rises out of the new composer, the field clears in the same frame, older content
  glides up.
- **Expand and collapse (9).** Tool rows open and close with the output fading and the rows below sliding; the
  "previous messages" fold, the approval card collapsing to its answered line, and the question card doing the
  same all animate on Smooth. The cards' grey background is the shell that stretches, so only transform and opacity
  animate.
- **Keyboard (7).** The floating composer rides on the keyboard the same way the old bar did (the composer is still
  the last row of the session page), and focusing the field keeps the latest message in view.

The other seven switches behave as before; the smoke test runs the New look with each switch alone on Smooth, in
light and in dark.

## Recommended adoption order

The motion work is in three parts: part 1 (tokens, press feedback, sheets, haptic tick) is in the app; part 2 is
streaming text with Thinking and auto-scroll; part 3 is list changes and the page push. The look work interleaves
with them so each file is rewritten once:

1. **Look tokens (items 1, 2, 9, 14 and the icon component, 7).** S–M. Colour, type, shape and icons for every
   screen at once, then one light and dark pass on the iPhone. Do this first, so the motion parts are built on the
   new look and are not restyled later.
2. **Transcript rows with motion part 2 (item 4, techniques 4, 5 and 9).** M + M. The same render code in
   `SessionScreen.tsx`: flat rows, "previous messages", "Worked for", and Thinking land together with the paced
   streaming, auto-scroll and expand/collapse.
3. **Floating composer with sending (item 3, technique 6).** M. One shared composer for session and local chat;
   sending's entrance comes with it. Keyboard (7) only after the operator confirms it on the iPhone.
4. **Approval and question cards (items 5, 13).** M + S. Their answered state reuses the expand/collapse helper
   from step 2.
5. **Centred header and the ⋯ sheet (item 8).** M. It must come before the page push, because the push moves
   whole pages including the header.
6. **Session list with motion part 3 (item 6, techniques 8 and 2).** M + M + L. The flat list and the list
   changes rewrite the same rows; the page push and back swipe come last, as the motion study recommended.

## What the prototype is made of

All in `web/src/lab/`, in the lab's own chunk (now about 16 KB gzipped, from 14 KB):

- `look.ts` (tested at 100%): the Look switch and its storage (its own key, `nano-remote/lab/look/v1`, so the
  motion buttons cannot change it), the "Worked for" and "N previous messages" wording, the one indicator per
  session row, and the host chips' filter.
- `NewLook.tsx`: the New look's pieces. `icons.tsx`: the inline icons with the Lucide licence. `new-look.css`: the
  tokens and every rule, all under `.lab[data-look='new']`; the page background behind the lab follows through
  `body:has(.lab[data-look='new'])`, which only matches while the lab is on screen.
- `LabSession.tsx` and `Lab.tsx` render either look in the same places with the same motion hooks. New in both
  looks: a question card at the end of the first reply you send, and today's design shows it with the real
  `.request-card.question` classes. New in the New look only: Stop, the ⋯ details sheet and the + sheet.
- Fixtures: each session has a host (Mac mini or MacBook Pro), and the "Draw the app icons" session now waits for
  input instead of being idle, so the list shows every indicator.
- Tests: `web/e2e/lab-look.spec.ts` (the switch, light and dark paths with all motion Now and all Smooth, each
  switch alone, today's look for comparison, and a check that `/pair` loads none of the lab's tokens).

## Findings and limits

- **Not checked against the reference screenshots in this pass.** The agent could not open the reference folder;
  the shapes follow the study's written measurements. A side-by-side on the phone is the real check.
- **Auto-scroll on Now** leaves the view short of the approval card when a turn ends, in both looks. That is the
  lab's copy of today's behaviour (snap only while at the bottom), not part of the look; Auto-scroll on Smooth
  follows to the end.
- **Host chips** need more than one host to mean anything. The real app pairs with one; until that changes, a chip
  row of agents (Codex, Claude Code, pi) may be the better use of the space. To decide when step 6 is planned.
- **The + button** opens a sheet whose rows do nothing in the lab; attachments are a real-app feature.
- **Dark palette.** The page is #0d0d0d and raised surfaces #212121 (the study's values). On the iPhone's OLED
  this is close to black; if it reads too harsh, the iOS ChatGPT page colour #212121 with #303030 cards is the
  alternative.
