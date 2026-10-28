# Image markup: plan (2026-10-28)

Ticket: brocode-jsj. Findings and evidence: `docs/research/image-markup.md` (cited below as R-n, its item
numbers). Viewing images and files is a separate lane (brocode-74p); this plan starts markup from the
composer's tray, and adds the viewer entry point once that lane lands.

## The decision in one paragraph

Mark up on the phone, then send a new picture with the marks drawn in, plus the comments as numbered
lines of text. This is what OpenAI's coding app does (R-12, R-13). It needs no protocol change, and all three
engines take it today (R-29). The sent message shows the marked picture and the text on every device with no
further work. Regions as a protocol field are not planned (R-34). The canvas is our own `<canvas>` with
pointer events, about 2 KB gzipped for the core (R-36), loaded only when first opened.

## What the user sees, start to finish

1. They attach a screenshot or photo as today. It appears in the tray above the field.
2. They tap the thumbnail. A full-screen cover rises over the session: the image fitted to the screen,
   Cancel at the top left, Done at the top right, undo and redo between them, and a tool row at the bottom.
3. One finger draws with the chosen tool: pen, highlighter, rectangle or arrow, in one of four colours.
   Two fingers pan and pinch-zoom the image (up to 8x) and never draw.
4. The comment tool puts a numbered pin where they tap, and a small sheet opens with one text field
   ("what about this spot"). A single tap on an existing mark, with any tool, opens the same sheet for that
   mark; its pin then sits at the mark's top-right corner. Pins are numbered 1, 2, 3 in the order made, and
   renumber when one is deleted.
5. Done closes the cover. The tray thumbnail now shows the marked picture with a small badge (a pen glyph,
   plus the comment count when there are comments). Tapping it again re-opens the canvas with every mark
   still editable. Remove asks first when marks exist.
6. Send: the agent gets the marked picture as an ordinary image, and the message text gets the comments
   appended as numbered lines. The sent bubble shows exactly that, so the user sees what the agent saw.

Text appended to the message (our own wording; the format is the decision, not the words):

```
<the user's text>

Marks on the attached image (the numbers match the pins):
1. this button is misaligned (around 62-80% across, 10-14% down)
2. wrong colour here (at 35% across, 71% down)
```

With several marked images: "Marks on image 2 of 3 (...)", counting images in the order they are sent,
because Claude and Pi move images away from the text (R-30). A pin alone gives one point ("at"); a pin on a
mark gives the mark's bounding box ("around"). Comments with empty text are not listed. No comments at all:
no lines are added.

## Rules the tickets share

- **Burn-in.** Export at the prepared image's own size (already at most 2048 px, R-37), through the same
  rules as `resize.ts`: a PNG source stays PNG (screenshots stay sharp), anything else is JPEG at 0.9. Marks
  are sized relative to the image so they survive the engine's own downscale: pen about 0.5 % of the long
  edge (at least 3 px), highlighter about 2.5 % at 35 % opacity, pin diameter about 3.5 % with a white
  number and a white ring for contrast on any background.
- **Colours.** Red (default for pen, shapes and pins), yellow (default for the highlighter), blue, green.
  Fixed values, not theme tokens: the picture does not change with light or dark mode. The chrome around
  it (bars, buttons, the comment sheet) uses the New look tokens: ink buttons, `--surface-raised` bars,
  `--radius-sheet`, type roles (`docs/research/new-look-prototype.md`).
- **Gestures.** `touch-action: none` on the canvas; pointer events only. A stroke starts after the finger
  moves a few pixels, so a second finger landing within that time becomes a pinch instead of a dot. The
  pinch guard in `ui/no-zoom.ts` stays as it is (R-31). The cover is not part of the page stack, so the left
  edge swipe does not run while drawing (R-32); if it ends up inside a page, it must claim the swipe.
- **Motion.** The cover rises like the app's sheets and is not dragged down (a downward stroke must draw).
  With Reduce Motion it cross-fades. Haptic tick when a pin is placed, as the app's other haptics.
- **Memory.** The tray entry keeps the prepared original and the list of marks, so re-opening edits marks
  instead of drawing over a flattened picture. Done uploads the new picture and drops the old upload (abort
  it if still running; an already stored blob stays until the session is deleted, R-28, which is
  acceptable).
- **Accessibility.** Tool buttons have labels and pressed states; pins are listed as buttons ("Comment 2:
  wrong colour here") in a visually hidden list over the canvas, so VoiceOver users can read and edit
  comments even though they cannot draw precisely.
- **Bundle.** The markup screen is a lazily imported chunk. Budget: under 10 KB gzipped for the chunk, and
  the main bundle grows by less than 0.5 KB (the import and the tray badge).

## Tickets, ranked

Order: 1, 2, 3, 4 in sequence (each builds on the one before); 5 after the viewer lane lands; 6 is not
scheduled. Sizes: S about a day of agent work or less, M a few days, L more.

### 1. Markup model and export (S)

- **User sees:** nothing yet.
- **Work:** a pure module for marks: kinds (pen, highlighter, rectangle, arrow, pin), hit testing for a tap,
  bounding boxes in image pixels, undo and redo stacks, clear (undoable), pin numbering, the comment-line
  composer (single and multi-image wording, "at" and "around"), and burn-in drawing onto an injected 2D
  context with the size rules above. Export reuses `outputType` and the encode step of `resize.ts`.
- **Files:** new `web/src/screens/session/markup/marks.ts`, `marks.test.ts`, `burn.ts`, `burn.test.ts`
  (fake context records draw calls).
- **Protocol:** none. **Risk:** low. Bounded, exact acceptance: a good fit for the Ollama route.
- **Done when:** unit tests cover numbering after deletes, hit testing at zoom, bounding-box percentages
  rounded to whole numbers, the multi-image wording, and that a pin-only and a pin-on-mark comment produce
  "at" and "around" lines.

### 2. Markup canvas in the lab (M)

- **User sees:** in the lab (`/lab`), a "Markup" scene on a bundled fixture screenshot: the full-screen
  cover with pen, highlighter, rectangle, arrow, four colours, undo, redo, clear, two-finger pan and pinch,
  Done and Cancel, light and dark. The operator tries it on the phone before it touches the composer.
- **Work:** `MarkupScreen.tsx` (cover, top bar, tool row, colour well), the pointer-event canvas drawing
  through ticket 1's model, live rendering at device pixel ratio, fit-to-screen and double-tap to fit
  again, the stroke-start threshold, Reduce Motion, VoiceOver labels.
- **Files:** new `web/src/screens/session/markup/MarkupScreen.tsx`, `markup.css`, `gestures.ts` and its
  test (two-pointer pan and zoom maths, threshold); `web/src/lab/` scene registration and a fixture image.
- **Protocol:** none. **Risk:** medium: gesture feel on a real iPhone (pinch versus a starting stroke,
  Safari's own gestures). Opus route.
- **Done when:** on the phone, one finger never zooms and two fingers never draw; the page never zooms; the
  edge swipe never fires; 60 fps while drawing on an iPhone screenshot; the chunk is under 10 KB gzipped
  (build output quoted in the lane report); screenshots in light and dark.

### 3. Comments on marks (M)

- **User sees:** the comment tool and numbered pins; a tap on a mark or pin opens a short sheet with one
  field and Save, Delete and Cancel; pins renumber; the badge counts comments.
- **Work:** the comment sheet (the app's `Sheet`, with the keyboard riding as in the composer), pin
  placement and tap-to-edit, the hidden accessible list of pins, pins drawn at a fixed screen size while
  zoomed and at the burn-in size on export.
- **Files:** `MarkupScreen.tsx`, a new `CommentSheet.tsx`, `markup.css`; ticket 1's model gains nothing
  new if it was done right.
- **Protocol:** none. **Risk:** medium: the keyboard over a full-screen canvas on iOS. Opus route.
- **Done when:** in the lab on the phone, three comments can be added, edited, one deleted, and the
  remaining pins read 1 and 2 on screen and in the composed text; VoiceOver reads each pin's comment.

### 4. Send flow from the tray (M)

- **User sees:** the whole flow above, for real: tap a tray thumbnail, mark up, Done, badge, re-open, send;
  the sent bubble shows the marked picture and the numbered lines.
- **Work:** the tray thumbnail becomes a button that opens the cover; `ComposerAttachments` gains a way to
  replace an entry's upload with the marked picture while keeping the prepared original and the marks;
  sending appends the comment lines (ticket 1) to the text part; remove confirms when marks exist. Images
  that the browser cannot decode (sent as files) are not markable.
- **Files:** `web/src/screens/session/attachments/composer.ts` and its test,
  `web/src/screens/session/session-model.ts` (where the text and parts are put together), the tray in
  `SessionScreen.tsx` and its CSS, the Playwright smoke (attach, mark, send, check the sent parts).
- **Protocol:** none. The host and adapters need no change: the marked picture is a normal blob image part.
- **Risk:** medium: the tray's upload states (a replacement while the first upload still runs, a failed
  replacement, retry). Opus route.
- **Done when:** a live send to each engine (Codex, Claude Code, Pi) with one marked screenshot and two
  comments gets an answer that refers to both numbered marks; the screenshots and the agents' answers are in
  the lane report. Phone check: the badge, re-open, and remove-with-marks confirmation.

### 5. Mark up from the image viewer (S, after the viewer lane)

- **User sees:** in the viewer, on any image in a session (one they sent, or one the agent produced), a
  "Mark up" action opens the same cover; Done adds the marked picture to the composer's tray as a new
  attachment, ready to send with a reply.
- **Work:** the viewer's action, fetching the blob into a prepared image, and adding a pre-marked entry to
  the tray through ticket 4's API.
- **Files:** the viewer component from brocode-74p, `composer.ts`.
- **Protocol:** none. **Risk:** low once the viewer exists.

### 6. Region coordinates as a protocol field (L, not scheduled)

- **User sees:** nothing new.
- **Why not now:** no engine takes regions (R-19), every adapter would turn them back into the same text,
  and older clients would show an unmarked picture (research note, section 7). The comment lines already carry the
  positions.
- **Revisit when:** an engine adds a region or mask input that improves answers, or the operator wants to
  re-open another device's marks for editing. Then: an additive optional field on the image part, written
  by the client, ignored by adapters unless their engine can use it; the burned-in picture and text stay
  what every engine gets.

## Not in this plan

- Text boxes, ellipses, a lasso or moving marks after they are drawn (OpenAI has them; they are not needed
  to point at something and say what is wrong). Add later only if field use asks for them.
- Shape recognition (draw and hold to snap) and the system's three-finger undo (R-24).
- Markup in local chats: they take no images in v1 (R-33).
- A separate mask for image-generation inpainting (R-15): this app sends to coding agents, not an image
  model.
