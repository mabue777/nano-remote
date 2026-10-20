import { useEffect, useMemo } from 'preact/hooks';

import type { StorageLike } from '../replica/storage';
import type { PairedDevice } from './device';
import { codeFromHash, PairModel, type FetchLike } from './pair-model';
import { useModel } from './use-model';

export interface PairScreenProps {
  hash: string;
  userAgent: string;
  fetch: FetchLike;
  storage: StorageLike | null;
  onPaired: (device: PairedDevice) => void;
}

export function PairScreen(props: PairScreenProps) {
  const model = useModel(
    useMemo(
      () => new PairModel({ hash: props.hash, userAgent: props.userAgent, fetch: props.fetch, storage: props.storage, onPaired: props.onPaired }),
      // The model lives as long as the screen; the props are fixed for a page load.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  );
  useEffect(() => {
    // A pairing link opened while this page is already showing changes only the fragment: no reload.
    const onHash = () => {
      const code = codeFromHash(window.location.hash);
      if (code !== '') model.setCode(code);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [model]);
  const busy = model.phase === 'pairing';
  const showCode = !model.codeFromLink || model.code === '' || model.failure !== undefined;
  return (
    <main class="screen pair" aria-labelledby="pair-title">
      <header class="pair-header">
        <h1 id="pair-title">Pair this phone</h1>
        <p class="muted">
          {model.codeFromLink
            ? 'The pairing code came with the link. Name this device so you can recognize it on the host.'
            : 'Enter the 8-digit code that Nano Host shows on the computer.'}
        </p>
      </header>
      <form
        class="card form"
        onSubmit={(event) => {
          event.preventDefault();
          void model.submit();
        }}
      >
        {showCode && (
          <label class="field">
            <span>Pairing code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="12345678"
              maxLength={12}
              value={model.code}
              disabled={busy}
              onInput={(event) => model.setCode(event.currentTarget.value)}
            />
          </label>
        )}
        <label class="field">
          <span>Device name</span>
          <input
            name="deviceName"
            autoComplete="off"
            maxLength={64}
            value={model.name}
            disabled={busy}
            onInput={(event) => model.setName(event.currentTarget.value)}
          />
        </label>
        {model.errorText !== undefined && (
          <p class="error" role="alert">
            {model.errorText}
          </p>
        )}
        <button class="primary" type="submit" disabled={!model.canSubmit}>
          {busy ? 'Pairing…' : model.failure !== undefined ? 'Try again' : 'Pair'}
        </button>
      </form>
      <p class="muted small">This page keeps no secrets: the host stores the device key in a cookie only it can read.</p>
    </main>
  );
}
