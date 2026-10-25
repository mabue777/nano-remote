# Interaction feel prototype (/lab), 2026-10-24

The operator finds that the app does not feel as smooth as the ChatGPT iPhone app, without being able to say
why. On main (2026-10-24) the app has almost no motion: sheets and pages appear at once, there is one press
state, two 150 ms transitions and one pulse. This prototype puts ten motion and response techniques side by
side, each with a Now/Smooth switch. Now is today's behaviour; Smooth is the proposal. The operator tries them
on the phone and picks which become build tickets. The real screens are unchanged.

**The short version.** All ten techniques work in the lab. None of them blocks the main thread: zero long tasks
in every gesture, at normal speed and with the CPU slowed four times. Only transform and opacity animate, plus
the "Thinking" shimmer, which moves a gradient over one short line of text. If only a few become tickets, the
suggested ones are press feedback, streaming text with "Thinking", auto-scroll and sheets. They cost little
and are what you touch or watch most.

## How to try it on the phone

1. Open `https://<host>/lab` in the installed app or in Safari, where `<host>` is the address you use for the
   app. The Mac must run a build that includes the lab. It needs no pairing and uses only fake data.
2. Tap the small **Lab** button in the middle of the top bar. A panel lists the ten techniques. Each has a
   Now | Smooth switch, and there are **All Now**, **All Smooth** and **Replay stream** buttons. Your choices
   stay after a reload.
3. Flip one switch, tap **Done**, and repeat the same gesture: open a session, go back, open a sheet, watch the
   answer stream. The "try it" line under each switch says which gesture shows the difference.

Tips. Use the installed app (Home Screen icon) for the back swipe, because in a Safari tab Safari's own back
swipe from the edge competes with it. If **Reduce Motion** is on in iOS, Smooth shows no animations and the
panel says so. Changing the streaming switch replays the session's answer.

## The techniques

Measurements come from `web/e2e/lab-perf.spec.ts` (run it with `LAB_PERF=1 pnpm exec playwright test
lab-perf`). It runs at 390 × 844 in Chromium with every switch on Smooth. Long tasks are main-thread blocks over
50 ms, each one a dropped frame for sure. Busy is the main thread's share of the gesture's wall time, from the
DevTools protocol. Animated lists every CSS property a running animation touched. The numbers are at 1× CPU;
the 4× runs had the same long-task and animated results.

Effort to adopt in the real app: S is about a day, M two to three days, L about a week.

| # | Technique | What Smooth does, in plain words | Measured (Smooth, 1× CPU) | Effort | Real components it would touch |
|---|---|---|---|---|---|
| 1 | Press feedback | A row or button dims and shrinks a little (to 97%) the moment a finger lands, and springs back in 90 ms. The grey tap flash is gone. | 0 long tasks; busy 4%; animates transform, opacity | S | `base.css` (buttons, links, tap highlight), `.session:active` in `HomeScreen.css`, one passive touchstart listener in `main.tsx` |
| 2 | Page push and back swipe | A session slides in from the right over the list, which shifts left a little. Back slides it out. A swipe from the left edge drags the page with the finger, and on release the finger's speed decides whether it goes back or snaps home. Uses View Transitions (Safari 18+), with a Web Animations fallback. | 0 long tasks; busy 6%; animates transform, opacity | L | `app.tsx` (render the page under the top one during a swipe), `Router` (push or pop direction), `BackHeader`, each screen's root container; must not fight pull-to-refresh or the row swipe in `chat/hooks.tsx` |
| 3 | Sheets | A sheet slides up on a spring (a hint of overshoot) while the dim layer fades in. A drag down follows the finger from anywhere while the content is at its top, and a flick or a pull past 30% dismisses it; otherwise it springs back. Closing slides it out before it unmounts. | 0 long tasks; busy 3%; animates transform, opacity | M | `ui/Sheet.tsx` and `.sheet*` in `components.css`; every caller's close path (`NewSessionSheet`, `ItemDetailSheet`, `ChangesSheet`, `SessionSettingsSheet`, `SessionActionsSheets`, the chat model picker, the provider delete confirmation) |
| 4 | Streaming text | Chunks from the network go into a small buffer that reveals a few characters per frame, so text flows at the stream's average speed instead of jumping in bursts. The newest words fade in over 320 ms. Before the first words, a grey "Thinking" with a slow shimmer (2.8 s) holds the answer's place instead of "Working…". | 0 long tasks; busy 3%; animates opacity and the shimmer's background position | M | `.msg.agent` rendering in `SessionScreen.tsx` and `ChatScreen.tsx`, the turn state line (`.turn-state`); the buffer sits between the replica's text deltas and the render; markdown in local chat (`chat/markdown.ts`) needs the fade on the last block only |
| 5 | Auto-scroll | While you are at the bottom, the view eases down to new content each frame instead of snapping. The moment you touch the list or scroll up, it stops following. "Jump to latest" fades and rises in rather than popping, and a tap glides back down. | 0 long tasks; busy 4%; animates opacity, transform (the pill; scrolling itself is not an animation) | S–M | the scroll effect, `onScroll` and `.jump-pill` in `SessionScreen.tsx` / `SessionScreen.css`; the same in `ChatScreen.tsx` |
| 6 | Sending | Your message appears at once, rising out of the composer. It is not dimmed while it is being sent. The composer clears in the same frame, and the older messages glide up into place instead of jumping. | 0 long tasks; busy 6%; animates transform, opacity, plus the reply's "Thinking" shimmer | S | `Composer` and the turn list in `SessionScreen.tsx` (`.turn.sending` dimming), the composer in `ChatScreen.tsx` |
| 7 | Keyboard | The page takes the visible area above the iOS keyboard (visualViewport) and stays in it while iOS scrolls, so the composer rides on the keyboard and the header does not jump away. The transcript stays pinned to the bottom when the keyboard opens. | Not measurable in desktop Chromium (no on-screen keyboard); the viewport rules are unit-tested | M | `.session-screen` height (`100dvh` today), the app shell, `ChatScreen`; needs a pass on a real iPhone before it becomes a ticket |
| 8 | List changes | Rows that move slide to their new place, new rows fade and grow in, removed rows fade out and the rest close the gap (FLIP: measure, change, then animate the difference). Status words cross-fade. | 0 long tasks; busy 4%; animates transform, opacity | M | the session list in `HomeScreen.tsx`, `ChatsPanel.tsx` (its swipe rows already use horizontal touches), `.status` and `.pill` |
| 9 | Expand and collapse | A tool row's output and an answered approval card change height smoothly: the box's background stretches with transform while the content fades, and everything below slides instead of jumping. | 0 long tasks; busy 5%; animates transform, opacity | M | item rows in `SessionScreen.tsx` (reasoning toggle, background tasks strip), the approval card in `approvals/RequestCards.tsx` and its answered state |
| 10 | Haptic tick | A light system tick on Accept and Send on an iPhone with iOS 18 or later. It toggles a hidden `<input type="checkbox" switch>` through its label. | Not measurable here (Chromium has no haptics); unverified on a device | S if it works | the Accept handler in `RequestCards.tsx` and the send in `SessionScreen.tsx` / `ChatScreen.tsx` |

Takeaway: every technique keeps the main thread nearly idle, so the remaining risk is how they feel on the phone,
not whether they run smoothly.

## Recommended adoption order

1. **Motion tokens.** Move the custom properties from `web/src/lab/lab.css` into `tokens.css` unchanged
   (S). This can ride along with item 14 of the visual-gap study (`docs/research/visual-gap-openai-2026-10.md`).
2. **Press feedback (1).** S, and it is felt on every tap.
3. **Streaming text and "Thinking" (4).** M. Watching an answer arrive is the app's main moment, and the
   bursty text is the most visible difference from ChatGPT.
4. **Auto-scroll (5)** and **Sending (6)**, together. S each, in the same files as 4.
5. **Sheets (3).** M. One shared component, so all seven sheets improve at once.
6. **Expand and collapse (9)** and **List changes (8).** M each. Both reuse the FLIP helper in
   `web/src/lab/flip.ts`.
7. **Page push and back swipe (2).** L. It is the largest change to the app shell and needs care around the
   other gestures. Do it after the others prove the motion tokens.
8. **Keyboard (7).** Only after the operator confirms on the iPhone that Smooth is better. iOS keyboard
   behaviour differs between Safari, the installed app and iOS versions.
9. **Haptic tick (10).** Only if the operator feels it on the phone. If not, skip it.

## What the lab is made of

All of it is in `web/src/lab/`. It loads in its own chunk, so the real screens never load its code or styles.

- Tested logic, at 100% coverage under the 90% threshold for `src/lab/**`: the visible viewport
  (`viewport.ts`), the switches (`settings.ts`), and the seeded fake stream (`fake-stream.ts`). The stream
  buffer and fade pieces (`pacer.ts`), FLIP and leaving rows (`flip.ts`), the auto-scroll follower
  (`autoscroll.ts`), finger speed, release decision, settle time and rubber band (`gesture.ts`), the spring as
  a CSS `linear()` easing (`spring.ts`), reduced motion and CSS times (`motion.ts`), the drag listener
  (`drag.ts`) and the haptic trick (`haptic.ts`) moved to `src/ui/motion/` when the app adopted them (see
  below); the lab imports them from there, and its FLIP hook from `screens/session/motion-hooks.tsx`.
- Screens, covered by the Playwright smoke `web/e2e/lab.spec.ts`: `Lab.tsx` (the shell, list, panel and
  sheets' content), `LabSession.tsx` (session and composer), `LabSheet.tsx`, and `dom.tsx` (shared DOM glue).
  They reuse the real classes, `BackHeader` and `SheetHeader`, so the lab looks like today's app.
- Motion values (`lab.css`): `--duration-press` 90 ms, `--duration-fast` 150 ms, `--duration-moderate` 200 ms,
  `--duration-relaxed` 300 ms, `--duration-shimmer` 2.8 s, `--ease-standard` cubic-bezier(.4,0,.2,1),
  `--ease-enter` cubic-bezier(.23,1,.32,1), `--ease-exit` cubic-bezier(.4,0,1,1), and the sheet spring
  (stiffness 380, damping 33, about 520 ms to rest). With Reduce Motion on, every duration drops to 1 ms and
  CSS animations are off. Drags still follow the finger.

## Findings and limits

- **Frame rate is not measured in Chromium.** Headless Chromium on the build Mac does not pace animation
  frames at the display rate, even on a blank page (median gaps 33–100 ms, measured 2026-10-24, with the
  headless shell and with full Chromium). The perf spec therefore measures long tasks, main-thread time and
  animated properties, which are reliable there. Whether each technique holds 60 fps (or 120 fps on ProMotion)
  has to be judged on the iPhone. Nothing in the measurements suggests it would not.
- **The "Thinking" shimmer** is the one animation that is not transform or opacity: it moves a gradient's
  background position, which repaints one line of text each frame. If it ever shows up as a cost on the
  phone, a transform-moved mask is the alternative.
- **The page transition** first also animated width, height and backdrop-filter, through the browser's
  default View Transition on the root. The lab switches that off. The real app must do the same.
- **Press states on iPhone.** iOS Safari shows `:active` only when the page has a touchstart listener. Smooth
  adds one, Now does not, so the real app's `.session:active` probably never shows on the iPhone today. This is
  not yet checked on a device; comparing technique 1 on the phone confirms it.
- **The haptic trick** is undocumented by Apple. It works only inside a tap handler, only on iOS 18 and later,
  and it can stop working in any iOS release. It could not be checked here. If the operator feels nothing on
  Accept or Send with the switch on Smooth, it should be skipped.
- **View Transitions fallback.** Chromium supports View Transitions, so the Web Animations fallback path (for
  Safari before 18) is not exercised by the smoke. iOS 18 and later take the View Transitions path.
- **Now page mode re-renders the list** when you come back, like today's app. Smooth keeps the list mounted
  under the session, which also keeps its scroll position.
- **The service worker caches the lab chunk** with the rest of the app shell (about 14 KB gzipped), so /lab
  also works offline in the installed app. The real screens do not load it.

## Adopted in the app

Part 1 of 3 (2026-10-24): the motion tokens, press feedback (1), sheets (3) and the haptic tick (10) run in the
real app as in the lab's Smooth mode.

- **Tokens.** The custom properties from `lab.css` are in `web/src/styles/tokens.css`, unchanged, with their
  reduced-motion overrides.
- **Press feedback.** `base.css` dims every button and link to 70% and shrinks it to 97% while pressed (90 ms),
  with no tap flash; session rows shrink to 98% and keep their colour; full-width bars only dim. `main.tsx`
  adds the passive touchstart listener iOS needs for `:active`.
- **Sheets.** `ui/Sheet.tsx` with `ui/motion/sheet-motion.ts`: the spring entrance, the dim layer's fade, the
  drag down (not from a text field, not in content scrolled away from its top), and the slide-out. The
  slide-out plays on every close path because the sheet leaves an inert copy of itself (`.sheet-ghost`) on the
  page when its owner removes it; the e2e helpers in `web/e2e/sheets.ts` wait for it.
- **Haptic tick.** Accept (and Accept for session) on approval cards, Send/Steer/Queue in the session composer,
  Send in local chat. The tick gives the focus back to the field that had it, so Send keeps the keyboard up.
- The lab's Now mode switches the app's press feedback off again (`lab.css`), so the comparison still works.
- The spring comes to rest after 471 ms by `springCurve`, not the 520 ms the lab's notes estimated; the sheet
  plays the measured duration.

Part 2 of 3 (2026-10-25): streaming text with "Thinking" (4), auto-scroll (5) and expand and collapse (9) run
in the session view and local chat as in the lab's Smooth mode, together with the New look's transcript rows.

- **Streaming text.** `ui/motion/pacer.ts` gained `TextReveal`: it takes the Replica's whole message text on
  every change, paces what was appended and shows a rewritten text (a snapshot after a reload, a replay that
  differs) at once, so no delta is lost or shown twice. Local chat parses the paced text as markdown and fades
  the newest words on the last block only.
- **Auto-scroll.** `useAutoScroll` in `screens/session/motion-hooks.tsx` watches one element that holds all
  of the conversation (turns, steers, the approval and question cards), so after a turn ends the view reaches
  the card; this fixes the lab's Now defect. The page lands at the bottom at once; after that new content
  glides. The jump pill is a round arrow that fades and rises.
- **Expand and collapse.** `useFlip` moved from the lab; tool rows, thinking rows, background tasks and the
  "previous messages" fold use it. A turn that ends folds with the same motion: the screen measures the rows
  when the model reports the change, before it renders.

## New look prototype

The lab now has a **Look: Now / New** switch at the top of its panel. New shows the redesign from the visual-gap
study (neutral palette, grey bubble, line icons, floating composer, flat tool rows, quiet cards, centred header,
flat list) on the same mini app, and combines with every switch above. Sending (6), expand and collapse (9) and the
keyboard (7) work inside it. What each change is, its tokens, its effort, the real components it touches and the
adoption order interleaved with motion parts 2 and 3: `docs/research/new-look-prototype.md`.

