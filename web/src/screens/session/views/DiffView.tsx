// The diff of a turn (turn/diff): one collapsible section per file with its kind and +/- counts, the
// unified diff with added and removed lines colored. State lives in ItemDetailModel.
import type { DiffFileRow, ItemDetailModel } from './detail-model';
import { NOT_SUPPORTED_TEXT } from './detail-model';

export function DiffView({ model }: { model: ItemDetailModel }) {
  const diff = model.diff;
  switch (diff.state) {
    case 'idle':
    case 'loading':
      return <p class="muted diff-status">Loading changes…</p>;
    case 'unsupported':
      return <p class="muted diff-status">{NOT_SUPPORTED_TEXT}</p>;
    case 'error':
      return (
        <div class="diff-status">
          <p class="error" role="alert">
            {diff.message}
          </p>
          <button type="button" class="small" onClick={() => void model.loadDiff()}>
            Retry
          </button>
        </div>
      );
    case 'ready':
      if (diff.files.length === 0) return <p class="muted diff-status">No file changes in this turn.</p>;
      return (
        <ul class="diff-files" aria-label="Changed files">
          {diff.files.map((file) => (
            <DiffFile key={file.path} file={file} onToggle={() => model.toggleFile(file.path)} />
          ))}
        </ul>
      );
  }
}

function DiffFile({ file, onToggle }: { file: DiffFileRow; onToggle: () => void }) {
  const bodyId = `diff-${file.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <li class="diff-file" data-file-kind={file.kind}>
      <button type="button" class="diff-file-head" aria-expanded={file.expanded} aria-controls={bodyId} onClick={onToggle}>
        <span aria-hidden="true">{file.expanded ? '▾' : '▸'}</span>
        <span class={`file-kind ${file.kind}`}>{file.label}</span>
        <code class="diff-path">
          {file.renamedFrom !== undefined && <span class="muted">{file.renamedFrom} → </span>}
          {file.path}
        </code>
        <span class="diff-counts small">
          <span class="plus">+{file.added}</span> <span class="minus">−{file.removed}</span>
        </span>
      </button>
      {file.expanded && (
        <div id={bodyId} class="diff-body" role="region" aria-label={`Diff of ${file.path}`}>
          {file.binary ? (
            <p class="muted small">Binary file; no text diff.</p>
          ) : file.lines.length === 0 ? (
            <p class="muted small">No line changes.</p>
          ) : (
            <pre class="diff-lines">
              {file.lines.map((line, i) => (
                <span key={i} class={`diff-line ${line.kind}`} data-line={line.kind}>
                  <span class="gutter" aria-hidden="true">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                  </span>
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
