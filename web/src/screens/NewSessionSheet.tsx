import { useEffect, useMemo } from 'preact/hooks';

import type { Replica } from '../replica/replica';
import type { StreamClient } from '../stream/client';
import { NewSessionModel } from './new-session-model';
import { useModel } from './use-model';

export interface NewSessionSheetProps {
  client: StreamClient;
  replica: Replica;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}

export function NewSessionSheet({ client, replica, onClose, onStarted }: NewSessionSheetProps) {
  const model = useModel(useMemo(() => new NewSessionModel(client, replica), [client, replica]));
  useEffect(() => {
    void model.load();
  }, [model]);
  const browser = model.browser;

  return (
    <div class="sheet-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <header class="sheet-head">
          <h2 id="new-session-title">New session</h2>
          <button type="button" class="ghost" onClick={onClose}>
            Cancel
          </button>
        </header>
        {model.loading && <p class="muted">Loading agents…</p>}
        <form
          class="form"
          onSubmit={(event) => {
            event.preventDefault();
            void model.submit().then((sessionId) => sessionId !== undefined && onStarted(sessionId));
          }}
        >
          <fieldset class="field">
            <legend>Agent</legend>
            <div class="choices" role="radiogroup" aria-label="Agent">
              {model.agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="radio"
                  aria-checked={model.agentId === agent.id}
                  class={`choice ${model.agentId === agent.id ? 'selected' : ''}`}
                  disabled={agent.status !== 'ready'}
                  title={agent.reason ?? agent.status}
                  onClick={() => void model.selectAgent(agent.id)}
                >
                  {agent.name}
                  {agent.status !== 'ready' && <span class="small muted"> ({agent.status})</span>}
                </button>
              ))}
            </div>
          </fieldset>

          {(model.modelsLoading || model.models.length > 0) && (
            <label class="field">
              <span>Model</span>
              <select
                name="model"
                value={model.modelId ?? ''}
                disabled={model.modelsLoading}
                onChange={(event) => model.selectModel(event.currentTarget.value)}
              >
                {model.modelsLoading && <option value="">Loading…</option>}
                {model.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.default ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div class="field">
            <span>Folder</span>
            <div class="folder-line">
              <code class="folder">{model.cwd ?? 'No folder chosen'}</code>
              <button type="button" class="ghost" onClick={() => void model.browse()}>
                Browse
              </button>
            </div>
            {model.projects.length > 0 && browser === undefined && (
              <ul class="projects" aria-label="Recent folders">
                {model.projects.slice(0, 5).map((project) => (
                  <li key={project.path}>
                    <button
                      type="button"
                      class={`choice ${model.cwd === project.path ? 'selected' : ''}`}
                      onClick={() => model.chooseFolder(project.path)}
                    >
                      {project.name}
                      <span class="small muted"> {project.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {browser !== undefined && (
              <div class="browser" role="group" aria-label="Folder browser">
                <div class="browser-path">
                  <code>{browser.path}</code>
                </div>
                <ul class="dir-list">
                  {browser.parent !== undefined && (
                    <li>
                      <button type="button" class="dir" onClick={() => void model.browse(browser.parent)}>
                        ..
                      </button>
                    </li>
                  )}
                  {browser.folders.map((entry) => (
                    <li key={entry.path}>
                      <button type="button" class="dir" onClick={() => void model.browse(entry.path)}>
                        {entry.name}/
                      </button>
                    </li>
                  ))}
                </ul>
                {browser.loading && <p class="muted small">Loading…</p>}
                {browser.error !== undefined && <p class="error small">{browser.error}</p>}
                {!browser.loading && browser.error === undefined && browser.folders.length === 0 && <p class="muted small">No folders here.</p>}
                <div class="browser-actions">
                  <button type="button" class="ghost" onClick={() => model.closeBrowser()}>
                    Close
                  </button>
                  <button type="button" class="primary small" onClick={() => model.chooseFolder()} disabled={browser.error !== undefined}>
                    Use this folder
                  </button>
                </div>
              </div>
            )}
          </div>

          <div class={`field bypass-row${model.bypass ? ' on' : ''}`}>
            <span id="bypass-title" class="bypass-title">
              Bypass approvals (full access)
            </span>
            <button
              type="button"
              role="switch"
              class="switch"
              aria-checked={model.bypass}
              aria-labelledby="bypass-title"
              onClick={() => model.setBypass(!model.bypass)}
            >
              <span class="knob" aria-hidden="true" />
            </button>
          </div>
          {model.bypass && (
            <p class="error small" role="note">
              The agent runs every command and edit without asking, anywhere your user account can reach.
            </p>
          )}

          <label class="field">
            <span>Title (optional)</span>
            <input name="title" value={model.title} maxLength={200} onInput={(event) => model.setTitle(event.currentTarget.value)} />
          </label>
          <label class="field">
            <span>First message (optional)</span>
            <textarea
              name="message"
              rows={3}
              value={model.message}
              placeholder="What should the agent do?"
              onInput={(event) => model.setMessage(event.currentTarget.value)}
            />
          </label>
          {model.error !== undefined && (
            <p class="error" role="alert">
              {model.error}
            </p>
          )}
          <button class="primary" type="submit" disabled={!model.canSubmit}>
            {model.submitting ? 'Starting…' : 'Start session'}
          </button>
        </form>
      </section>
    </div>
  );
}
