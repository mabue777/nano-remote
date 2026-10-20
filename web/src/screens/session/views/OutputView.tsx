// The output of a command item: monospace, ANSI codes stripped, long lines wrapped, a copy button, and
// while the command runs the view follows the end of the stream unless the user scrolled up.
import { useLayoutEffect, useRef } from 'preact/hooks';

import type { ItemDetailModel } from './detail-model';

/** Within this many px of the end counts as "at the end" (following stays on). */
const END_SLACK = 24;

export function OutputView({ model }: { model: ItemDetailModel }) {
  const scroller = useRef<HTMLPreElement>(null);
  const output = model.output;
  const command = model.command;

  // After every render: keep showing the end while following.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && model.following) element.scrollTop = element.scrollHeight;
  });

  return (
    <div class="output-view">
      {command !== undefined && (
        <div class="output-head">
          <code class="output-command" title={command.cwd}>
            $ {command.text}
          </code>
          <button type="button" class="small" onClick={() => void model.copy()} disabled={output === ''}>
            {model.copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {model.copyError !== undefined && (
        <p class="error small" role="alert">
          {model.copyError}
        </p>
      )}
      <pre
        class="output-text"
        ref={scroller}
        aria-label="Command output"
        data-running={model.running ? 'true' : 'false'}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget as HTMLElement;
          model.setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= END_SLACK);
        }}
      >
        {output !== '' ? output : <span class="muted">{model.running ? 'Waiting for output…' : 'No output.'}</span>}
      </pre>
      {model.running && <p class="muted small">Running…</p>}
    </div>
  );
}
