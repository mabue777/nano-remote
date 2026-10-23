// Settings, host section: the "Keep this Mac awake while plugged in" switch and its status line. The rules
// live in KeepAwakeModel; nothing renders until the paired host has reported `keepAwake`.
import { useEffect, useMemo } from 'preact/hooks';

import { useLiveModel } from '../../chat/hooks';
import { KEEP_AWAKE_NOTE, KEEP_AWAKE_TITLE, KeepAwakeModel, type KeepAwakeLink } from './keep-awake-model';

export function KeepAwakeSection({ link }: { link: KeepAwakeLink }) {
  const model = useLiveModel(useMemo(() => new KeepAwakeModel(link), [link]));
  useEffect(() => {
    model.start();
    return () => model.dispose();
  }, [model]);

  if (model.status === undefined) return null;
  return (
    <section class="card host-settings" aria-labelledby="host-settings-title">
      <h2 id="host-settings-title">This Mac</h2>
      <div class="keep-awake-line">
        <span id="keep-awake-title">{KEEP_AWAKE_TITLE}</span>
        <button
          type="button"
          role="switch"
          class="switch"
          aria-checked={model.checked}
          aria-labelledby="keep-awake-title"
          aria-describedby="keep-awake-status"
          disabled={model.pending !== undefined}
          onClick={() => void model.set(!model.checked)}
        >
          <span class="knob" aria-hidden="true" />
        </button>
      </div>
      <p id="keep-awake-status" class="keep-awake-status small" data-kind={model.kind} aria-live="polite">
        {model.line}
      </p>
      <p class="muted small">{KEEP_AWAKE_NOTE}</p>
      {model.error !== undefined && (
        <p class="error small" role="alert">
          {model.error}
        </p>
      )}
    </section>
  );
}
