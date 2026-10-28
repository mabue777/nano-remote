// The lab's Markup scene (docs/plan/image-markup.md, tickets 2 and 3): the markup cover on a bundled screenshot,
// so the operator can try drawing, pan, pinch and comments on the phone before markup reaches the composer. The
// cover is its own lazily loaded chunk (screens/session/markup/MarkupScreen.tsx), fetched when the scene opens.
// Done reports the marks, the badge's comment count and the lines the sent message would get. The fixture is
// the lab's session page captured at 946 x 2047, the size resize.ts makes of an iPhone screenshot (at most
// 2048 px on the long edge), as lossless WebP: every phone's service worker caches it with the app shell.
import { useEffect, useState } from 'preact/hooks';

import fixture from './markup-fixture.webp';

type MarkupModule = typeof import('../screens/session/markup/MarkupScreen');

/** What the scene ended with, for the Lab panel's Markup row. */
export interface MarkupResult {
  /** "Done with 3 marks and 2 comments.", "Cancelled." */
  summary: string;
  /** Pins on the picture: the tray badge's count. */
  comments: number;
  /** The lines appended to the message (ticket 1's composer); empty without comments. */
  lines: string[];
}

export function MarkupScene({ onClosed }: { onClosed: (result: MarkupResult) => void }) {
  const [module, setModule] = useState<MarkupModule | null>(null);
  useEffect(() => {
    void import('../screens/session/markup/MarkupScreen').then(setModule);
  }, []);
  if (module === null) return null;
  const { MarkupScreen: Screen, composeCommentLines } = module;
  return (
    <Screen
      src={fixture}
      label="Screenshot"
      onDone={(marks, size) => {
        const comments = marks.filter((m) => m.kind === 'pin').length;
        const drawn = marks.length - comments;
        const parts = [drawn === 1 ? '1 mark' : `${drawn} marks`, ...(comments === 0 ? [] : [comments === 1 ? '1 comment' : `${comments} comments`])];
        onClosed({ summary: `Done with ${parts.join(' and ')}.`, comments, lines: composeCommentLines(1, 1, marks, size) });
      }}
      onCancel={() => onClosed({ summary: 'Cancelled.', comments: 0, lines: [] })}
    />
  );
}
