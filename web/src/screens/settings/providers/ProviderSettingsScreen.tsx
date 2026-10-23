// Settings > Providers, /settings/providers. Rules and state live in ProviderSettingsModel; this file
// renders them, focuses the key field after a preset tap, and hands the export file to the share sheet
// (or a download where the browser has none) and the import file picker's file to the model.
import { useEffect, useMemo, useRef } from 'preact/hooks';

import type { HostRequester } from '../../../chat/providers/host-probe';
import { PRESETS } from '../../../chat/providers/presets';
import type { FetchLike } from '../../../chat/providers/probe';
import { useLiveModel } from '../../chat/hooks';
import { KeepAwakeSection } from '../host/KeepAwakeSection';
import type { KeepAwakeLink } from '../host/keep-awake-model';
import type { ChatServices } from '../../chat/services';
import { HOST_KEY_NOTE, kindLabel, ProviderSettingsModel, routeLabel, type Form, type ProviderRow } from './settings-model';

/** How many models the test lists inline before "and N more". */
const SHOWN_MODELS = 8;

export interface ProviderSettingsScreenProps {
  services: Pick<ChatServices, 'providers' | 'host'>;
  onBack: () => void;
  backLabel: string;
  /** The paired host's stream: shows the host section (keep this Mac awake). Absent without a host. */
  hostLink?: KeepAwakeLink;
}

export function ProviderSettingsScreen({ services, onBack, backLabel, hostLink }: ProviderSettingsScreenProps) {
  const model = useLiveModel(
    useMemo(
      () =>
        new ProviderSettingsModel({
          providers: services.providers,
          host: () => services.host.current as HostRequester | null,
          fetch: ((url, init) => window.fetch(url, init)) as FetchLike,
        }),
      [services],
    ),
  );
  useEffect(() => {
    void model.loadHostProviders();
    return () => model.dispose();
  }, [model]);

  const form = model.form;
  return (
    <main class="screen settings-screen">
      <header class="topbar">
        <a
          class="back"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            onBack();
          }}
        >
          ‹ {backLabel}
        </a>
      </header>
      <h1>Providers</h1>
      {model.notice !== undefined && (
        <p class="card settings-notice" role="status">
          {model.notice}{' '}
          <button type="button" class="link" onClick={() => model.dismissNotice()} aria-label="Dismiss">
            ✕
          </button>
        </p>
      )}
      {form !== null ? <ProviderForm model={model} form={form} /> : <Overview model={model} />}
      {form === null && hostLink !== undefined && <KeepAwakeSection link={hostLink} />}
      {model.confirm !== null && <ConfirmSheet model={model} />}
    </main>
  );
}

function Overview({ model }: { model: ProviderSettingsModel }) {
  const rows = model.rows;
  const discovery = model.discovery;
  const importer = useRef<HTMLInputElement>(null);
  return (
    <>
      <section class="providers" aria-labelledby="providers-title">
        <div class="section-head">
          <h2 id="providers-title">Your providers</h2>
          <button type="button" class="primary small" onClick={() => model.openAdd()}>
            Add provider
          </button>
        </div>
        {rows.length === 0 ? (
          <p class="empty muted">No providers yet. Add one to start chatting.</p>
        ) : (
          <ul class="provider-list" aria-label="Providers">
            {rows.map((row) => (
              <ProviderItem key={`${row.source}:${row.id}`} row={row} model={model} />
            ))}
          </ul>
        )}
      </section>

      <section class="card discover" aria-labelledby="discover-title">
        <div class="section-head">
          <h2 id="discover-title">Local servers</h2>
          <button type="button" class="small" onClick={() => void model.discover()} disabled={discovery.status === 'searching'}>
            {discovery.status === 'searching' ? 'Looking…' : 'Find local servers'}
          </button>
        </div>
        {discovery.status === 'idle' && <p class="muted small">Your Mac looks for Ollama, LM Studio and other servers on itself, your network and your tailnet.</p>}
        {discovery.status === 'failed' && <p class="muted small">{discovery.message}</p>}
        {discovery.status === 'done' && (
          <ul class="candidates" aria-label="Servers found">
            {discovery.candidates.map((c) => (
              <li key={c.baseURL}>
                <button type="button" class="choice candidate" disabled={c.added} onClick={() => void model.addCandidate(c)}>
                  <span class="candidate-name">{c.name}</span>
                  <span class="muted small">
                    {c.added ? 'Added' : `${kindLabel(c.kind)} · ${c.baseURL}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="card backup" aria-labelledby="backup-title">
        <h2 id="backup-title">Backup</h2>
        <p class="muted small">Exports never include keys; after an import the app asks for each key.</p>
        <div class="actions wrap">
          <button type="button" class="small" onClick={() => void shareOrDownload(model.exportFile())} disabled={model.empty}>
            Export
          </button>
          <button type="button" class="small" onClick={() => importer.current?.click()}>
            Import
          </button>
          <button type="button" class="small danger" onClick={() => model.askDeleteAll()} disabled={!rows.some((r) => r.source === 'phone')}>
            Delete all
          </button>
          <input
            ref={importer}
            type="file"
            accept="application/json,.json"
            class="visually-hidden"
            aria-label="Import file"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (file !== undefined) void file.text().then((text) => model.importText(text));
              input.value = '';
            }}
          />
        </div>
      </section>
    </>
  );
}

function ProviderItem({ row, model }: { row: ProviderRow; model: ProviderSettingsModel }) {
  const prompt = model.keyPrompt(row.id);
  return (
    <li class="card provider-row" data-source={row.source} aria-label={row.name}>
      <div class="provider-top">
        <span class="provider-name">{row.name}</span>
        {row.isDefault && <span class="pill ok">Default</span>}
        <span class="pill muted kind-badge">{row.kind}</span>
      </div>
      <p class="provider-url small">{row.baseURL}</p>
      <p class="muted small provider-meta">
        {[row.route, row.key, row.models, row.probed]
          .filter((part) => part !== '')
          .map((part, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {part}
            </span>
          ))}
      </p>
      {row.needsKey && (
        <form
          class="key-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            void model.submitKey(row.id);
          }}
        >
          <label class="field">
            <span>Enter the key for {row.name}</span>
            <input type="password" autocomplete="off" value={prompt.draft} onInput={(event) => model.setKeyDraft(row.id, event.currentTarget.value)} />
          </label>
          {prompt.error !== undefined && (
            <p class="error small" role="alert">
              {prompt.error}
            </p>
          )}
          <button type="submit" class="small primary" disabled={prompt.busy || prompt.draft.trim() === ''}>
            {prompt.busy ? 'Checking…' : 'Save key'}
          </button>
        </form>
      )}
      {row.source === 'phone' ? (
        <div class="actions">
          {!row.isDefault && (
            <button type="button" class="small ghost" onClick={() => model.setDefault(row.id)}>
              Make default
            </button>
          )}
          <button type="button" class="small" onClick={() => model.openEdit(row.id)} aria-label={`Edit ${row.name}`}>
            Edit
          </button>
          <button type="button" class="small danger" onClick={() => model.askDelete(row.id)} aria-label={`Delete ${row.name}`}>
            Delete
          </button>
        </div>
      ) : (
        <p class="muted small">Kept on your Mac: edit it in the Mac's config.json.</p>
      )}
    </li>
  );
}

function ProviderForm({ model, form }: { model: ProviderSettingsModel; form: Form }) {
  const keyField = useRef<HTMLInputElement>(null);
  const presetName = form.preset?.name;
  const lastPreset = useRef(presetName);
  useEffect(() => {
    // A tapped preset (not a detected key) moves on to the key field.
    if (presetName !== lastPreset.current && form.detection.type !== 'key' && form.detection.type !== 'url') keyField.current?.focus();
    lastPreset.current = presetName;
  }, [presetName, form.detection.type]);

  const adding = form.mode === 'add';
  const route = model.formRoute;
  const kind = model.formKind;
  const duplicate = model.duplicate;
  const showDetails = !adding || form.preset !== null || form.detection.type !== 'empty';
  const title = adding ? 'Add provider' : `Edit ${model.formName}`;

  return (
    <section class="provider-form" aria-label={title}>
      <div class="section-head">
        <h2>{title}</h2>
        <button type="button" class="ghost small" onClick={() => model.closeForm()}>
          Cancel
        </button>
      </div>
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          model.save();
        }}
      >
        {adding && (
          <label class="field">
            <span>Paste an API key or a server URL</span>
            <input
              type="text"
              value={form.paste}
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              placeholder="sk-… or http://192.168.1.20:11434"
              onInput={(event) => model.setPaste(event.currentTarget.value)}
            />
            {model.detectionText !== '' && <small class="muted detection">{model.detectionText}</small>}
          </label>
        )}
        {adding && (
          <div class="field">
            <span>Or pick a provider</span>
            <div class="preset-grid" role="group" aria-label="Presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  class={`choice preset${form.preset === preset ? ' selected' : ''}`}
                  aria-pressed={form.preset === preset}
                  onClick={() => model.choosePreset(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {showDetails && (
          <>
            <label class="field">
              <span>Base URL</span>
              <input type="url" value={form.baseURL} autocomplete="off" autocapitalize="none" spellcheck={false} onInput={(event) => model.setBaseURL(event.currentTarget.value)} />
              {route !== null && kind !== null && (
                <small class="muted">
                  {kindLabel(kind)} · {routeLabel(route)}
                </small>
              )}
            </label>
            {model.keyAllowed ? (
              <label class="field">
                <span>API key</span>
                <input
                  ref={keyField}
                  type="password"
                  value={form.apiKey}
                  autocomplete="off"
                  placeholder={adding ? 'Not needed for some servers' : 'Leave empty to keep the saved key'}
                  onInput={(event) => model.setApiKey(event.currentTarget.value)}
                />
                {form.preset?.keyHelpURL !== undefined && form.preset.keyHelpURL !== '' && (
                  <small>
                    <a href={form.preset.keyHelpURL} target="_blank" rel="noreferrer">
                      Get your key from {form.preset.name}
                    </a>
                  </small>
                )}
              </label>
            ) : (
              <p class="muted small">{HOST_KEY_NOTE}</p>
            )}
            <label class="field">
              <span>Name</span>
              <input type="text" value={form.name} placeholder={model.formName} onInput={(event) => model.setName(event.currentTarget.value)} />
            </label>
          </>
        )}
        {duplicate !== undefined && <p class="muted small">Already in your list as {duplicate.name}; adding updates it.</p>}
        <TestResult form={form} />
        {form.error !== undefined && (
          <p class="error small" role="alert">
            {form.error}
          </p>
        )}
        <div class="actions wrap">
          <button type="button" class="small" onClick={() => void model.test()} disabled={!model.canTest}>
            {form.test.status === 'testing' ? 'Testing…' : 'Test'}
          </button>
          {model.canAddWithoutTesting && (
            <button type="button" class="small ghost" onClick={() => model.save({ withoutTesting: true })}>
              Add without testing
            </button>
          )}
          <button type="submit" class="small primary" disabled={!model.canAdd}>
            {adding ? 'Add' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

function TestResult({ form }: { form: Form }) {
  const test = form.test;
  if (test.status === 'idle') return null;
  const tone = test.status === 'ok' ? 'ok' : test.status === 'testing' ? 'busy' : test.status === 'empty' ? 'attention' : 'error';
  const line =
    test.status === 'testing'
      ? 'Asking for the model list…'
      : test.status === 'ok'
        ? `Connected · ${test.models.length} model${test.models.length === 1 ? '' : 's'}`
        : test.message;
  const more = test.status === 'ok' ? test.models.length - SHOWN_MODELS : 0;
  return (
    <div class={`test-result ${tone}`} data-status={test.status}>
      <p class="test-line" role={test.status === 'failed' ? 'alert' : 'status'}>
        <span class="dot" aria-hidden="true" />
        <span>{line}</span>
      </p>
      {test.status === 'ok' && (
        <ul class="test-models" aria-label="Models">
          {test.models.slice(0, SHOWN_MODELS).map((m) => (
            <li key={m.id}>{m.displayName}</li>
          ))}
          {more > 0 && <li class="muted">and {more} more</li>}
        </ul>
      )}
    </div>
  );
}

function ConfirmSheet({ model }: { model: ProviderSettingsModel }) {
  const confirm = model.confirm;
  if (confirm === null) return null;
  const all = confirm.type === 'delete-all';
  return (
    <div class="sheet-backdrop" onClick={(event) => event.target === event.currentTarget && model.cancelConfirm()}>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{all ? 'Delete every provider?' : `Delete ${confirm.name}?`}</h2>
        <p class="muted small">
          {all ? 'Their keys on this phone go too. Chats stay, but cannot continue until you add a provider again.' : 'Its key on this phone goes too.'}
        </p>
        <div class="actions">
          <button type="button" class="small ghost" onClick={() => model.cancelConfirm()}>
            Cancel
          </button>
          <button type="button" class="small danger" onClick={() => model.confirmDelete()}>
            {all ? 'Delete all' : 'Delete'}
          </button>
        </div>
      </section>
    </div>
  );
}

/** The share sheet with the file where the browser can share files, else a download. */
async function shareOrDownload(file: { name: string; type: string; text: string }): Promise<void> {
  const blob = new Blob([file.text], { type: file.type });
  const shared = new File([blob], file.name, { type: file.type });
  if (typeof navigator.canShare === 'function' && typeof navigator.share === 'function' && navigator.canShare({ files: [shared] })) {
    try {
      await navigator.share({ files: [shared], title: 'Nano Remote providers' });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // the user closed the sheet
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
