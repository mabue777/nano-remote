// The lab's Markup scene (docs/plan/image-markup.md, ticket 2): the markup cover on a bundled screenshot, so
// the operator can try drawing, pan and pinch on the phone before markup reaches the composer. The cover is
// its own lazily loaded chunk (screens/session/markup/MarkupScreen.tsx), fetched when the scene opens.
// The fixture is the lab's session page captured at 946 x 2047, the size resize.ts makes of an iPhone
// screenshot (at most 2048 px on the long edge).
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { MarkupScreenProps } from '../screens/session/markup/MarkupScreen';
import fixture from './markup-fixture.png';

export function MarkupScene({ onClosed }: { onClosed: (result: string) => void }) {
  const [Screen, setScreen] = useState<ComponentType<MarkupScreenProps> | null>(null);
  useEffect(() => {
    void import('../screens/session/markup/MarkupScreen').then((module) => setScreen(() => module.MarkupScreen));
  }, []);
  if (Screen === null) return null;
  return (
    <Screen
      src={fixture}
      label="Screenshot"
      onDone={(marks) => onClosed(`Done with ${marks.length === 1 ? '1 mark' : `${marks.length} marks`}.`)}
      onCancel={() => onClosed('Cancelled.')}
    />
  );
}
