// The app shell: the router picks the screen; a paired device gets one StreamClient and one Replica for
// the page's lifetime. No clientId stored (never paired, or forgotten after `unpaired`) means the
// pairing page. Close 4003 or `unauthorized` (revoked, or the host lost the cookie) forgets the device
// and goes back to pairing.
import { useEffect, useMemo, useState } from 'preact/hooks';

import { Replica } from './replica/replica';
import { defaultStorage, type StorageLike } from './replica/storage';
import { Router, type Route } from './routes/router';
import { forgetDevice, loadDevice, type PairedDevice } from './screens/device';
import { HomeScreen } from './screens/HomeScreen';
import type { FetchLike } from './screens/pair-model';
import { PairScreen } from './screens/PairScreen';
import { SessionScreen } from './screens/session/SessionScreen';
import { StreamClient } from './stream/client';

export interface AppProps {
  router: Router;
  storage?: StorageLike | null;
  fetch?: FetchLike;
  userAgent?: string;
}

export function App({ router, storage = defaultStorage(), fetch = window.fetch.bind(window), userAgent = navigator.userAgent }: AppProps) {
  const [route, setRoute] = useState<Route>(router.route);
  const [device, setDevice] = useState<PairedDevice | null>(() => loadDevice(storage));
  useEffect(() => router.subscribe(setRoute), [router]);

  useEffect(() => {
    if (device === null && route.name !== 'pair') router.navigate('/pair', { replace: true });
  }, [device, route, router]);

  if (route.name === 'pair' || device === null) {
    return (
      <PairScreen
        hash={router.hash}
        userAgent={userAgent}
        fetch={fetch}
        storage={storage}
        onPaired={(paired) => {
          setDevice(paired);
          router.navigate('/', { replace: true });
        }}
      />
    );
  }
  return (
    <Connected
      key={device.clientId}
      device={device}
      route={route}
      router={router}
      storage={storage}
      onUnpaired={() => {
        forgetDevice(storage);
        setDevice(null);
      }}
    />
  );
}

interface ConnectedProps {
  device: PairedDevice;
  route: Exclude<Route, { name: 'pair' }>;
  router: Router;
  storage: StorageLike | null;
  onUnpaired: () => void;
}

function Connected({ device, route, router, storage, onUnpaired }: ConnectedProps) {
  const services = useMemo(() => {
    const client = new StreamClient({ clientId: device.clientId, optOutNotifications: ['item/reasoning/delta'] });
    const replica = new Replica({ client, storage });
    return { client, replica };
  }, [device.clientId, storage]);

  useEffect(() => {
    const { client, replica } = services;
    const off = client.on('state', (state) => {
      if (state === 'unpaired') onUnpaired();
    });
    client.start();
    return () => {
      off();
      replica.dispose();
      client.stop();
    };
    // onUnpaired is stable enough: it only forgets the device
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);

  const open = (sessionId: string) => router.navigate({ name: 'session', sessionId });
  switch (route.name) {
    case 'home':
      return <HomeScreen client={services.client} replica={services.replica} onOpenSession={open} />;
    case 'session':
      return <SessionScreen sessionId={route.sessionId} replica={services.replica} onBack={() => router.navigate('/')} />;
    case 'notFound':
      return (
        <main class="screen">
          <h1>Not found</h1>
          <p class="muted">
            Nothing lives at <code>{route.path}</code>.
          </p>
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              router.navigate('/');
            }}
          >
            Go to sessions
          </a>
        </main>
      );
  }
}
