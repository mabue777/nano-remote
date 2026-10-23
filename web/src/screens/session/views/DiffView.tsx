// The Changes view of a turn (turn/diff): the list of changed files with kind badges and +/- counts, and
// one file's diff at a time. The diff keeps code unwrapped: old and new line numbers stay pinned at the
// left while long lines scroll sideways. State lives in ChangesModel.
import type { ChangedFile, ChangesModel } from './changes-model';
import { NOT_A_REPOSITORY_TEXT, NOT_SUPPORTED_TEXT } from './changes-model';

/** `summary`: show "N files changed" above the list (off where the sheet's header already says it). */
export function ChangesView({ model, summary = true }: { model: ChangesModel; summary?: boolean }) {
  const state = model.state;
  switch (state.state) {
    case 'idle':
    case 'loading':
      return <p class="muted diff-status">Loading changes…</p>;
    case 'unsupported':
      return <p class="muted diff-status">{NOT_SUPPORTED_TEXT}</p>;
    case 'notRepository':
      return <p class="muted diff-status not-repository">{NOT_A_REPOSITORY_TEXT}</p>;
    case 'error':
      return (
        <div class="diff-status">
          <p class="error" role="alert">
            {state.message}
          </p>
          <button type="button" class="small" onClick={() => void model.load()}>
            Retry
          </button>
        </div>
      );
    case 'ready': {
      const file = model.file;
      if (file !== undefined) return <FileDiff file={file} onBack={() => model.back()} />;
      return (
        <div class="changes">
          {state.note !== undefined && <p class="changes-note small">{state.note}</p>}
          {state.files.length === 0 ? (
            <p class="muted diff-status">No file changes in this turn.</p>
          ) : (
            <>
              {summary && <p class="muted small changes-summary">{model.summary}</p>}
              <ul class="diff-files" aria-label="Changed files">
                {state.files.map((f) => (
                  <li key={f.path}>
                    <button type="button" class="diff-file-row" data-file-kind={f.kind} onClick={() => model.open(f.path)}>
                      <KindBadge file={f} />
                      <code class="diff-path">
                        {f.renamedFrom !== undefined && <span class="muted">{f.renamedFrom} → </span>}
                        {f.path}
                      </code>
                      <Counts file={f} />
                      <span class="muted" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {state.omittedFiles > 0 && (
            <p class="muted small changes-omitted">
              {state.omittedFiles} more {state.omittedFiles === 1 ? 'file' : 'files'} changed; too many to list.
            </p>
          )}
        </div>
      );
    }
  }
}

function KindBadge({ file }: { file: ChangedFile }) {
  return <span class={`file-kind ${file.kind}`}>{file.label}</span>;
}

function Counts({ file }: { file: ChangedFile }) {
  if (file.binary) return <span class="diff-counts small muted">binary</span>;
  return (
    <span class="diff-counts small">
      <span class="plus">+{file.added}</span> <span class="minus">−{file.removed}</span>
    </span>
  );
}

const SIGN: Record<string, string> = { add: '+', remove: '−' };

function FileDiff({ file, onBack }: { file: ChangedFile; onBack: () => void }) {
  return (
    <div class="diff-file-view" data-file-kind={file.kind}>
      <button type="button" class="link small diff-back" onClick={onBack}>
        ‹ All files
      </button>
      <div class="diff-file-head">
        <KindBadge file={file} />
        <code class="diff-path">
          {file.renamedFrom !== undefined && <span class="muted">{file.renamedFrom} → </span>}
          {file.path}
        </code>
        <Counts file={file} />
      </div>
      {file.binary ? (
        <p class="muted small">Binary file; no text diff.</p>
      ) : file.lines.length === 0 ? (
        <p class="muted small">{file.truncated ? 'Not shown: this turn changed too much text to show it all.' : 'No line changes.'}</p>
      ) : (
        <>
          {file.truncated && <p class="changes-note small">Only the first part of this file's changes is shown.</p>}
          <div class="diff-scroll" role="region" aria-label={`Diff of ${file.path}`} tabIndex={0}>
            <table class="diff-table">
              <tbody>
                {file.lines.map((line, i) => (
                  <tr key={i} class={`diff-line ${line.kind}`} data-line={line.kind}>
                    <td class="ln" aria-hidden="true">
                      <span class="old">{line.oldLine ?? ''}</span>
                      <span class="new">{line.newLine ?? ''}</span>
                    </td>
                    <td class="sign" aria-hidden="true">
                      {SIGN[line.kind] ?? ''}
                    </td>
                    <td class="code">{line.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
