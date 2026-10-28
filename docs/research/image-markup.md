# Image markup: how OpenAI's apps send a marked-up image, and what Nano Remote has (2026-10-28)

Ticket: brocode-jsj. Plan: `docs/plan/image-markup.md`. Sibling work: the image viewer and file viewer are
studied in a parallel lane (brocode-74p); this note covers only markup (drawing, regions, comments, and how
they are sent) and assumes a viewer exists to start from.

**What this means.** OpenAI's coding app does not send regions or masks to the agent. It draws the marks
into the picture, sends that picture as an ordinary image, and turns the comments into numbered text lines
with a position in percent. Nano Remote can do the same with no protocol change: every engine we drive
already takes "image plus text". A plain `<canvas>` costs about 2 KB compressed for the drawing core.

Labels, as in `docs/research/rea/README.md`: **Observed** = seen directly in shipped code, symbols,
schema, plists or asset catalogs. **Inferred** = the best explanation of observed facts. **Unknown** = not
established. No code, assets or interface strings from the targets are copied into this repo; findings
are described in my own words, with file names and identifiers as evidence.

## Sources

| Target | What was readable | How |
|---|---|---|
| iOS ChatGPT 1.2026.279 (`resources/chatgpt-ios/ChatGPT.ipa`) | Linked-symbol tables and asset catalogs. The Swift code is FairPlay-encrypted (`ChatGPT.framework/ChatGPT` has `cryptid 1` over bytes 163 840 to 163 856 384 of 183 961 552), so only the unencrypted tail (imports, exports) and resources can be read. | Re-extracted to `/tmp/rea-markup-ios` (the old `/tmp/rea-ios` copy had been emptied); `strings` on the unencrypted tail; `xcrun assetutil --info` on every `Assets.car`; `otool -L`, `otool -l`. |
| Codex desktop app, bundle `com.openai.codex` (`/Applications/ChatGPT.app`) | Full: unencrypted, minified JS chunks. | `app.asar` extracted to `/tmp/rea-markup-codex`; chunks read under `webview/assets/`. |
| Codex engine protocol (`docs/research/rea/codex-app-server-schema/`) | Authoritative JSON Schema. | `v2/TurnStartParams.json`, `ClientRequest.json`. |
| Nano Remote | Source in this repo. | Read directly; web bundle built to `/tmp` to measure. |

`resources/chatgpt-macos` (the older Swift Mac app) was not re-opened: the prior report
(`docs/research/rea/chatgpt-macos-swift-codex-remote.md`) found no image tooling in it, and the current
Mac app is the Electron one above.

## 1. iOS ChatGPT app

1. **Observed.** The main framework links Apple's PencilKit (`otool -L` lists
   `/System/Library/Frameworks/PencilKit.framework`) and imports 44 PencilKit Swift symbols plus the
   Objective-C class `PKCanvasView`. So the iOS drawing surface is Apple's own canvas, not a custom one.
2. **Observed.** The tools are set in code, not chosen from Apple's palette: there is no `PKToolPicker`
   import at all. The imports that are present are the inking tool with exactly two ink types, `pen` and
   `monoline` (a uniform-width line), the eraser with the `fixedWidthBitmap` type (rubs out pixels under
   the finger rather than whole strokes), and the setter for `PKCanvasView.tool`.
3. **Observed.** The app reads strokes back: `PKDrawing.strokes` (get and set), `PKStroke.path`,
   `PKStrokePath` interpolated points, `PKStrokePoint.location`, and builds strokes itself (the `PKStroke`
   initialiser with ink, path, transform and mask). It also renders a drawing to a bitmap with
   `PKDrawing.image(from:scale:)`.
4. **Inferred.** Reading stroke points and rendering the drawing to a bitmap is what you need to turn a
   finger selection into either a mask image or a picture with the marks drawn in. The uniform-width
   `monoline` ink fits a "paint over the area" selection brush; `pen` fits free drawing.
5. **Observed.** The shared asset catalog (`Frameworks/ChatGPT.framework/Assets_Assets.bundle/Assets.car`)
   has a colour named `OneOff/InpaintingSelection`, sRGB (0.38, 0.57, 0.96, alpha 1), the same in light
   and dark mode: a medium blue. It also has symbol images named `scribble`, `eraser`,
   `paintbrush-stroke`, `paintbrush-stroke-dashed`, `selection-dashed`, `pen-tip`, `generate-edit`,
   `arrow-uturn-left` / `arrow-uturn-right` (undo and redo shapes) and `chat-bubble-on-photo`.
6. **Inferred.** On iOS the finger-highlight feature the operator saw is the image-editing selection
   ("inpainting": the user paints over the part of an image to change, then types what to change). The
   colour name says so directly. The same toolset (brush, dashed brush, eraser, undo, redo) covers it.
7. **Unknown.** Whether iOS also has numbered comment pins like the desktop app (section 2). No readable
   string, nib or asset names them; the localised UI strings live in the encrypted binary (the readable
   `en.lproj/Localizable.strings` holds only 94 App Intents phrases).
8. **Unknown.** The exact wire shape iOS sends. The networking code is encrypted. **Inferred:** iOS uses
   the same backend calls as the desktop's ChatGPT-conversation path (item 14), because both talk to the
   same image-generation backend.

## 2. Codex desktop app (Electron)

The desktop app has a full image markup editor, used in three places: the image side panel of a chat,
shared Library notes, and image generation follow-ups. File names below are in `webview/assets/`.

9. **Observed. The editor.** `editor-7b8662980cbf.js` exports the image markup editor (about 25 KB
   minified). Its toolbar has select, pen, text and a shapes group, then a comment tool, an eraser,
   colour, undo and redo, and a cancel control. The default tool is a red pen (`#dc2626`). The drawing
   engine is a separate "sketch" module, `sketch-e1e0e0dd4015.js` (124 KB minified, 41 KB gzipped), whose
   object kinds include ink paths, line, arrow, ellipse, text and comment.
10. **Observed. Comments are numbered pins.** The canvas's accessible description says users draw, place
    shapes and add comment pins. Each pin carries a one-based number; a pin opens a small inline field to
    enter, save, cancel or delete its comment; saving a comment does not send anything.
11. **Observed. In the chat, the markup rides in the composer.** While an image is open for markup in the
    side panel, the composer shows a row named for the markup draft with a small thumbnail (the original
    with the drawing layered over it) and a remove button that asks before discarding annotations; the
    composer's placeholder changes to ask for instructions (`app-primary-58a09006cc0c.js`, the
    `imageMarkup.attachment`, `imageMarkup.removeAttachment` and `imageMarkup.instructions` messages).
12. **Observed. How it is sent to Codex: burned in, plus text.** On send, the Codex turn's prompt becomes
    the markup's generated text joined with the user's own text, and one more image attachment is added
    with the file name `markup.png`; the turn is flagged as an image-edit follow-up
    (`app-primary-58a09006cc0c.js`, the submit path near offset 1 305 411). That image comes from
    `createLocalMarkupPreview` (`export-ce6d3908d083.js`): it loads the original, draws it as the
    background, draws the marks over it, and exports one PNG. There is no mask, no region list and no
    coordinates outside the text.
13. **Observed. The generated text.** The export function lists every comment as one numbered line: the
    number, the pin's position as percentages of the image's width and height (one decimal), then the
    comment; the user's own text follows after a blank line. Pin numbers in the text match the numbers
    drawn on the pins in the image.
14. **Observed. ChatGPT conversations use a server-side variant.** For image generation in a ChatGPT
    conversation (`app-initial-c95ddb62696e.js`, near offset 14 334 383), the client exports only the
    transparent marks layer, uploads it with the original's file id to an image-generation
    "markup preview" endpoint, and gets back an image pointer for the composited picture plus the same
    numbered text. The composite still reaches the model as one picture with the marks drawn in.
15. **Observed. A separate mask exists only for inpainting.** The same chunk has a function that turns a
    painted selection into an inverted black-and-white `image-mask.png`, the classic inpainting mask. In
    the notes editor (`image-editor-702f2102a978.js`), the "remove" brush instead tints the selection red
    at 65 % opacity, draws the original underneath, and sends that picture with a text instruction to
    remove the red areas. So even the erase tool prefers "marks in the picture plus text".
16. **Observed. Limits.** Markup is refused above 20 million pixels; the exported PNG is refused above
    20 MiB (20 971 520 bytes); comment positions are measured on a surface scaled so the long edge is
    1024. Pen width and text size are set in those surface units.
17. **Observed. A lighter "comment only" mode.** The image side panel (`image-side-panel-d1dfed8d635e.js`)
    also lets the user click on an image to place comments without drawing. For animated GIFs the
    comments are grouped per frame, each with its position in percent, under a short preamble that
    explains the coordinates.
18. **Observed. Web page annotation is a different feature.** The many `annotation-*` and
    `site-annotation-*` chunks belong to annotating browser pages and artifacts; they are not the image
    tool and were not studied further.

## 3. The engine protocol

19. **Observed.** Codex's turn input (`UserInput` in `v2/TurnStartParams.json`) has seven kinds: text,
    image (`url` or `fileId`, with an optional `detail` of `auto`, `low`, `high` or `original`),
    local image (`path`), audio, local audio, skill and mention. None carries a region, box, mask or
    annotation. The only `region` fields in the whole schema are AWS Bedrock settings.
20. **Observed.** `turn/start` has a free-form `turnTrigger` string ("optional source classification").
    **Inferred:** the desktop's image-edit flag ends up there; it labels the turn for analytics and does not
    change what the model sees.
21. **Inferred.** OpenAI chose burn-in because no model API it targets takes regions as input. Models read
    marks, arrows, circles and numbers drawn on a screenshot well, and percent positions in text are a
    cheap backup when a mark covers what it points at.

## 4. Runtime capture

22. **Not done, on purpose.** The installed Mac app was not running. Reaching its markup editor live needs
    a signed-in account, a thread with an image in it, and a debug-port relaunch of the operator's app.
    The static evidence in section 2 already answers the questions this ticket asked (tools, comments,
    what is sent). Nothing was sent to OpenAI.

## 5. iOS system conventions (Photos, Mail, Notes Markup)

Web access was not granted to this lane, so these come from Apple's PencilKit reference (fetched through
the docs tool: ink types pen, marker, pencil, monoline, fountain pen, watercolor, crayon; the tool picker is
optional) and from recalled platform behaviour. Everything recalled is **Inferred** and should be checked on
the phone during the canvas ticket.

23. **Inferred.** Markup opens full screen over the image with Cancel at the top left, Done at the top
    right, and undo and redo at the top. The tool row sits at the bottom: pen, highlighter (wide and
    see-through), pencil, eraser, lasso, ruler, then a colour well. A plus button adds text, a signature,
    shapes (rectangle, oval, speech bubble, arrow) and a magnifier.
24. **Inferred.** One finger draws; two fingers pan and pinch-zoom the image without drawing. Drawing a
    shape and holding snaps it to a clean shape. The system-wide editing gestures (three-finger swipe to
    undo, shake to undo) exist natively. **Unknown** whether they reach a web page; we should not depend
    on them and should keep visible undo and redo buttons.
25. **Inferred.** Apple's highlighter colours are see-through, so the picture shows under them; text and
    shapes keep a fixed screen size while zooming so they stay readable.

## 6. What Nano Remote has today

26. **Observed. The composer's attachment flow.** `web/src/screens/session/attachments/composer.ts`
    keeps a tray of entries that are each `preparing`, `uploading`, `ready` or `failed`. A picked image is
    downscaled first (`resize.ts`: at most 2048 px on the long edge, PNG stays PNG, anything else becomes
    JPEG at quality 0.9, which also drops EXIF and location) and uploaded at once with `POST /v1/blob`
    (`upload.ts`, XMLHttpRequest for progress). The original picked file stays in memory (`sources`), and a
    local object URL feeds the thumbnail. When the message goes, `parts()` yields one
    `{type:"image", url:"/v1/blob/<id>"}` per ready image.
27. **Observed. The tray.** `AttachTray` and `TrayEntry` in `web/src/screens/session/SessionScreen.tsx`
    show a thumbnail, a progress bar, a remove button and an error with retry. A thumbnail has no tap
    action today. Images in sent messages (`SentAttachments`) are links that open the raw blob in a new tab;
    the sibling viewer lane replaces that.
28. **Observed. The protocol.** `InputPart` (`protocol/protocol-v1.md`, section 5.1) is text, image
    (`url`: a data URL or `/v1/blob/<id>`), mention or file. Section 8.1 caps an upload at 20 MiB, asks
    clients to downscale photos as above, and keeps blobs until the session is deleted.
29. **Observed. Each adapter already carries image plus text.** Codex: an uploaded image becomes
    `localImage {path}` and text stays text, in the order sent (`host/src/adapters/codex/mapping.ts`).
    Claude Code: every image becomes a base64 image block, and all text follows them in one text block
    (`claude/mapping.ts`, `toUserContent`). Pi: text parts are joined into the message and images go in a
    separate `images` list (`pi/mapping.ts`, `toPrompt`). All three declare
    `attachments: {images: true, files: true}`.
30. **Inferred. Consequence for comment text.** Claude and Pi lose the order between images and text
    (images first, or apart). So comment lines must name their image ("image 2 of 3") when a message has
    more than one, and must not rely on sitting next to it.
31. **Observed. Pinch guard.** `web/src/ui/no-zoom.ts` cancels Safari's `gesturestart`, `gesturechange`
    and `gestureend` on the document to stop page zoom; it adds no touch or pointer listeners.
    **Inferred:** a markup canvas that does its own two-finger zoom from pointer events, with
    `touch-action: none` on the canvas, does not fight it: the guard keeps stopping page zoom, and the
    pointer events still arrive. To be confirmed on the phone.
32. **Observed. Edge swipe.** The page stack's left-edge swipe (`web/src/ui/motion/page-motion.ts`,
    `EDGE` 24 px, `swipeStart` with a `claimed` flag) would start on a stroke drawn from the left edge. The
    canvas must claim its touches, or open as a cover above the page stack where the swipe does not run.
33. **Observed. Local chat.** Chats with a model provider take no images in v1
    (`docs/plan/local-chat.md`, ruling R4), so markup applies to host sessions only.

## 7. Burn-in versus a regions field

| Question | Burned-in image plus text (no protocol change) | Additive `regions:[{x,y,w,h,comment}]` on the image part |
|---|---|---|
| What the agent sees | The picture with marks and numbered pins, and numbered lines of text with positions | The plain picture, plus whatever the adapter turns the regions into |
| Engine support | Codex, Claude Code and Pi today | None: no engine takes regions (item 19); every adapter would turn them back into text, or draw them in |
| Other devices and history | The sent message shows the marked picture and the text, everywhere, with no client change | Older clients ignore the field and show a picture without marks |
| What OpenAI does | Exactly this (items 12, 13) | Nothing like it in any target |
| Cost | Client only | Schema, generated types, host validation, three adapters, every client |

34. **Inferred. Verdict.** Burn-in plus text is the right path and is enough. A regions field adds nothing
    an engine can use today. If one is added later (for example so a second device can re-open the marks
    for editing), it should be a client-side record of what was drawn, not a new way of talking to engines,
    and the burned-in picture and text stay the source of truth for the agent.

## 8. Size and cost measurements

35. **Observed.** Current web bundle (production build to `/tmp`, 2026-10-28): main script 299.95 KB,
    93.26 KB gzipped; the lazily loaded lab 38.59 KB, 13.17 KB gzipped.
36. **Observed.** A throwaway probe outside the repo (`/tmp/rea-markup-proto/markup.ts`, not committed),
    with pen, highlighter, rectangle, arrow, numbered pins, undo, redo, clear, two-finger pan and pinch,
    and a burn-in PNG export, minifies to 4 854 bytes and gzips to 1 862 bytes. **Inferred:** with the
    toolbar, the comment sheet and CSS, a markup screen lands around 5 to 8 KB gzipped, and loads lazily
    on first use, so the main bundle does not grow. A drawing library is not needed; OpenAI's own engine is
    41 KB gzipped because it also does text editing, selection, resizing and shared documents.
37. **Inferred. Pixel budget.** Our images are already at most 2048 x 2048 (4.2 MP) after `resize.ts`, far
    below OpenAI's 20 MP refusal and below iOS Safari's canvas area limit. A full-quality PNG at that size
    stays well under the 20 MiB upload cap.

## 9. Open questions

- **Unknown.** Whether the iOS ChatGPT app has comment pins (item 7), and its exact wire format (item 8).
  Answering it needs a signed-in iPhone session and a proxy, which this ticket ruled out.
- **Unknown.** How small a pin number can be before a model misreads it after the engine's own downscale
  (recalled, not re-checked here: Claude resizes large images to about 1568 px on the long edge; Codex's
  `detail` setting, item 19, changes resolution). The plan sets sizes relative to the image and asks for a live check.
- **Unknown.** Whether iOS's three-finger undo reaches a web page (item 24).

## Reproduce

```sh
# iOS: readable parts only (main executable skipped)
mkdir -p /tmp/rea-markup-ios && cd /tmp/rea-markup-ios && unzip -q <repo>/resources/chatgpt-ios/ChatGPT.ipa -x '*/ChatGPT.app/ChatGPT'
B=Payload/ChatGPT.app/Frameworks/ChatGPT.framework/ChatGPT
otool -l $B | grep -A4 ENCRYPTION          # cryptoff/cryptsize
tail -c +163856385 $B | strings -n 6 | grep -E 'PencilKit|PKCanvasView|PKToolPicker'
xcrun assetutil --info Payload/ChatGPT.app/Frameworks/ChatGPT.framework/Assets_Assets.bundle/Assets.car

# Desktop
npx @electron/asar extract /Applications/ChatGPT.app/Contents/Resources/app.asar /tmp/rea-markup-codex/app
ls /tmp/rea-markup-codex/app/webview/assets | grep -E 'image-edit|editor-|export-|sketch-|image-side-panel'
```
