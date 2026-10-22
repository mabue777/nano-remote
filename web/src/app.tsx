// The app shell: the router picks the screen; a paired device gets one StreamClient and one Replica for
// the page's lifetime. Local chat (screens/chat) lives outside the pairing: its stores and engine exist for
// the page's lifetime, and the stream client is plugged into it while the phone is paired. No clientId
// stored (never paired, or forgotten after `unpaired`) means the pairing page, unless this phone already
// has a provider or a chat: then Home shows Chats with a "Pair your Mac" link. Close 4003 or
// `unauthorized` (revoked, or the host lost the cookie) forgets the device and goes back to pairing.
import { useEffect, useMemo, useState } from 'preact/hooks';

import { watchBadge } from './pwa/badge';
import { PushModel, type PushEnvironment } from './pwa/push';
import { Replica } from './replica/replica';
import { defaultStorage, type StorageLike } from './replica/storage';
import { Router, type Route } from './routes/router';
import { ChatScreen } from './screens/chat/ChatScreen';
import { ChatsHome } from './screens/chat/ChatsHome';
import { ChatsPanel } from './screens/chat/ChatsPanel';
import { createChatServices, hasLocalChat, type ChatServices } from './screens/chat/services';
import { forgetDevice, loadDevice, type PairedDevice } from './screens/device';
import { AwayTracker, type SessionStorageLike } from './screens/home-model';
import { HomeScreen } from './screens/HomeScreen';
import type { FetchLike } from './screens/pair-model';
import { PairScreen } from './screens/PairScreen';
import { DeviceNames } from './screens/session/approvals/devices';
import { SessionScreen } from './screens/session/SessionScreen';
import { StreamClient } from './stream/client';

export interface AppProps {
  router: Router;
  storage?: StorageLike | null;
  fetch?: FetchLike;
  userAgent?: string;
  /** Web Push in this browser; null where the app registers no service worker (the dev server). */
  push?: PushEnvironment | null;
}

export function App({ router, storage = defaultStorage(), fetch = window.fetch.bind(window), userAgent = navigator.userAgent, push = null }: AppProps) {
  const [route, setRoute] = useState<Route>(router.route);
  const [device, setDevice] = useState<PairedDevice | null>(() => loadDevice(storage));
  const chat = useMemo(() => createChatServices({ storage }), [storage]);
  useEffect(() => router.subscribe(setRoute), [router]);

  // Without a host, local chat still works: home, /chats and chat pages stay when this phone has any.
  const localOnly = device === null && hasLocalChat(chat) && (route.name === 'home' || route.name === 'chats' || route.name === 'chat');
  useEffect(() => {
    if (device === null && route.name !== 'pair' && !localOnly) router.navigate('/pair', { replace: true });
  }, [device, route, router, localOnly]);

  if (localOnly) {
    if (route.name === 'chat') {
      return <ChatScreen key={route.chatId} chatId={route.chatId} services={chat} backLabel="Chats" onBack={() => router.navigate('/')} />;
    }
    return <ChatsHome services={chat} onOpenChat={(chatId) => router.navigate({ name: 'chat', chatId })} onNavigate={(path) => router.navigate(path)} />;
  }
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
      push={push}
      chat={chat}
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
  push: PushEnvironment | null;
  chat: ChatServices;
  onUnpaired: () => void;
}

function Connected({ device, route, router, storage, push, chat, onUnpaired }: ConnectedProps) {
  const services = useMemo(() => {
    const client = new StreamClient({ clientId: device.clientId, optOutNotifications: ['item/reasoning/delta'] });
    const replica = new Replica({ client, storage });
    const devices = new DeviceNames(client);
    // Created before start(), so it hears the first ready; it lives as long as the stream client.
    const notifications = push === null ? undefined : new PushModel({ client, env: push, storage });
    const away = new AwayTracker({ client, replica, storage: tabStorage(), doc: document });
    return { client, replica, notifications, away, opened: (sessionId: string) => away.opened(sessionId), deviceName: (clientId: string) => devices.nameOf(clientId) };
  }, [device.clientId, storage, push]);

  useEffect(() => {
    const { client, replica } = services;
    chat.host.set(client); // host-routed providers (ADR 0006) go through this stream
    const stopBadge = watchBadge({ replica, client, nav: navigator, doc: document });
    const off = client.on('state', (state) => {
      if (state === 'unpaired') onUnpaired();
    });
    client.start();
    return () => {
      chat.host.set(null);
      off();
      stopBadge();
      services.away.dispose();
      services.notifications?.dispose();
      replica.dispose();
      client.stop();
    };
    // onUnpaired is stable enough: it only forgets the device
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, chat]);

  const open = (sessionId: string) => router.navigate({ name: 'session', sessionId });
  switch (route.name) {
    case 'home':
    case 'chats':
      return (
        <HomeScreen
          client={services.client}
          replica={services.replica}
          notifications={services.notifications}
          away={services.away}
          onOpenSession={open}
          tab={route.name === 'chats' ? 'chats' : 'sessions'}
          onTab={(tab) => router.navigate(tab === 'chats' ? '/chats' : '/', { replace: true })}
          chats={<ChatsPanel services={chat} onOpenChat={(chatId) => router.navigate({ name: 'chat', chatId })} onNavigate={(path) => router.navigate(path)} />}
        />
      );
    case 'chat':
      return <ChatScreen key={route.chatId} chatId={route.chatId} services={chat} backLabel="Chats" onBack={() => router.navigate('/chats')} />;
    case 'session':
      return (
        <SessionScreen
          sessionId={route.sessionId}
          replica={services.replica}
          clientId={device.clientId}
          deviceName={services.deviceName}
          onOpened={services.opened}
          onBack={() => router.navigate('/')}
        />
      );
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

/** sessionStorage, or null where reading it throws (blocked storage). */
function tabStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
