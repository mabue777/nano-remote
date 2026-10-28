// The app shell: the router picks the screen; a paired device gets one StreamClient and one Replica for
// the page's lifetime. Local chat (screens/chat) lives outside the pairing: its stores and engine exist for
// the page's lifetime, and the stream client is plugged into it while the phone is paired. No clientId
// stored (never paired, or forgotten after `unpaired`) means the pairing page, unless this phone already
// has a provider or a chat: then Home shows Chats with a "Pair your Mac" link. Close 4003 or
// `unauthorized` (revoked, or the host lost the cookie) forgets the device and goes back to pairing.
// Settings opens without a host too: a cloud provider needs no Mac (ADR 0006). With a host it also shows
// Notifications (Web Push) and the host section (keep this Mac awake while plugged in).
// Pages slide (routes/PageStack.tsx): a session, a chat or Settings is pushed over Home and slides back out on
// Back or on a swipe from the left edge; PageMotion hears each route change before the app renders it.
import { useEffect, useLayoutEffect, useMemo, useState } from 'preact/hooks';

import { LabRoute } from './lab/LabRoute';
import { watchBadge } from './pwa/badge';
import { PushModel, type PushEnvironment } from './pwa/push';
import { Replica } from './replica/replica';
import { defaultStorage, type StorageLike } from './replica/storage';
import { browserOwnsEdge, PageMotion, PageStack } from './routes/PageStack';
import { Router, type Route } from './routes/router';
import { ChatScreen } from './screens/chat/ChatScreen';
import { ChatsHome } from './screens/chat/ChatsHome';
import { ChatsPanel } from './screens/chat/ChatsPanel';
import { createChatServices, hasLocalChat, type ChatServices } from './screens/chat/services';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { forgetDevice, loadDevice, type PairedDevice } from './screens/device';
import { AwayTracker, homeTitle, type SessionStorageLike } from './screens/home-model';
import { HomeScreen } from './screens/HomeScreen';
import { SessionActions } from './screens/session-actions';
import type { FetchLike } from './screens/pair-model';
import { PairScreen } from './screens/PairScreen';
import { DeviceNames } from './screens/session/approvals/devices';
import { browserResize } from './screens/session/attachments/resize';
import { xhrUploader } from './screens/session/attachments/upload';
import type { AttachmentServices } from './screens/session/session-model';
import { SessionScreen } from './screens/session/SessionScreen';
import { FileRoute, preloadFileViewer } from './screens/session/files/FileRoute';
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
  const motion = useMemo(() => new PageMotion(), []);
  const ownsEdge = useMemo(browserOwnsEdge, []);
  useEffect(() => router.subscribe((next, navigation) => motion.change(navigation, () => setRoute(next))), [router, motion]);
  // After the pages' own layout effects (scroll put back): the slide may capture the new page.
  useLayoutEffect(() => motion.rendered(), [route, motion]);

  // Without a host, local chat still works: home, /chats and chat pages stay when this phone has any.
  const localOnly =
    device === null && (route.name === 'settings' || (hasLocalChat(chat) && (route.name === 'home' || route.name === 'chats' || route.name === 'chat')));
  const settings = () => router.navigate('/settings');
  useEffect(() => {
    if (device === null && route.name !== 'pair' && route.name !== 'lab' && !localOnly) router.navigate('/pair', { replace: true });
  }, [device, route, router, localOnly]);

  // The hidden interaction lab: fake data, no host, no pairing needed.
  if (route.name === 'lab') return <LabRoute />;
  if (localOnly) {
    const page = (shown: Route) => {
      if (shown.name === 'settings') return <SettingsScreen services={chat} backLabel={homeTitle(false)} onBack={() => router.back('/')} />;
      if (shown.name === 'chat') {
        return <ChatScreen key={shown.chatId} chatId={shown.chatId} services={chat} backLabel="Chats" onBack={() => router.back('/')} onSettings={settings} />;
      }
      return <ChatsHome services={chat} onOpenChat={(chatId) => router.navigate({ name: 'chat', chatId })} onNavigate={(path) => router.navigate(path)} />;
    };
    return (
      <PageStack
        route={route}
        motion={motion}
        render={page}
        parentOf={(shown) => (shown.name === 'chat' || shown.name === 'settings' ? { name: 'home' } : null)}
        onSwipeBack={(to) => router.back(to, { animate: false })}
        ownsEdge={ownsEdge}
      />
    );
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
      motion={motion}
      ownsEdge={ownsEdge}
      onUnpaired={() => {
        forgetDevice(storage);
        setDevice(null);
      }}
    />
  );
}

interface ConnectedProps {
  device: PairedDevice;
  route: Exclude<Route, { name: 'pair' } | { name: 'lab' }>;
  router: Router;
  storage: StorageLike | null;
  push: PushEnvironment | null;
  chat: ChatServices;
  motion: PageMotion;
  ownsEdge: boolean;
  onUnpaired: () => void;
}

/** The page Back goes to: Home from a session or Settings, the Chats tab from a chat, the session from its file. */
function connectedParent(route: Route): Route | null {
  switch (route.name) {
    case 'file':
      return { name: 'session', sessionId: route.sessionId };
    case 'session':
    case 'settings':
      return { name: 'home' };
    case 'chat':
      return { name: 'chats' };
    default:
      return null;
  }
}

function Connected({ device, route, router, storage, push, chat, motion, ownsEdge, onUnpaired }: ConnectedProps) {
  const services = useMemo(() => {
    const client = new StreamClient({ clientId: device.clientId, optOutNotifications: ['item/reasoning/delta'] });
    const replica = new Replica({ client, storage });
    const devices = new DeviceNames(client);
    // Created before start(), so it hears the first ready; it lives as long as the stream client.
    const notifications = push === null ? undefined : new PushModel({ client, env: push, storage });
    const away = new AwayTracker({ client, replica, storage: tabStorage(), doc: document });
    return {
      client,
      replica,
      // Archive and delete; one for Home and the session view, so an archive's Undo outlives the page change.
      actions: new SessionActions({ replica }),
      notifications,
      away,
      opened: (sessionId: string) => away.opened(sessionId),
      deviceName: (clientId: string) => devices.nameOf(clientId),
      // The agents and their capabilities as the current stream's initialize reported them (spec 4).
      agents: () => client.host?.agents,
      // Photos and files for the composer (spec 8.1), uploaded to this host with the device cookie.
      attachments: {
        maxBytes: () => client.host?.limits.maxAttachmentBytes,
        uploader: xhrUploader(),
        resize: browserResize,
      } satisfies AttachmentServices,
    };
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
      services.actions.dispose();
      services.notifications?.dispose();
      replica.dispose();
      client.stop();
    };
    // onUnpaired is stable enough: it only forgets the device
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, chat]);

  const open = (sessionId: string) => router.navigate({ name: 'session', sessionId });
  // A session's files open in a lazily loaded viewer: start loading it once a session is on screen.
  const inSession = route.name === 'session' || route.name === 'file';
  useEffect(() => {
    if (inSession) void preloadFileViewer().catch(() => undefined);
  }, [inSession]);
  return (
    <PageStack
      route={route}
      motion={motion}
      render={renderConnected}
      parentOf={connectedParent}
      onSwipeBack={(to) => router.back(to, { animate: false })}
      ownsEdge={ownsEdge}
    />
  );

  /** One page; during a slide or a swipe the page stack renders two. */
  function renderConnected(route: Route) {
    switch (route.name) {
      case 'home':
      case 'chats':
        return (
          <HomeScreen
            client={services.client}
            replica={services.replica}
            away={services.away}
            onOpenSession={open}
            actions={services.actions}
            tab={route.name === 'chats' ? 'chats' : 'sessions'}
            onTab={(tab) => router.navigate(tab === 'chats' ? '/chats' : '/', { replace: true })}
            onSettings={() => router.navigate('/settings')}
            chats={<ChatsPanel services={chat} onOpenChat={(chatId) => router.navigate({ name: 'chat', chatId })} onNavigate={(path) => router.navigate(path)} />}
          />
        );
      case 'chat':
        return (
          <ChatScreen
            key={route.chatId}
            chatId={route.chatId}
            services={chat}
            backLabel="Chats"
            onBack={() => router.back('/chats')}
            onSettings={() => router.navigate('/settings')}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            services={chat}
            hostLink={services.client}
            host={services.client}
            {...(services.notifications !== undefined ? { notifications: services.notifications } : {})}
            backLabel={homeTitle(true)}
            onBack={() => router.back('/')}
          />
        );
      case 'session':
        return (
          <SessionScreen
            sessionId={route.sessionId}
            replica={services.replica}
            clientId={device.clientId}
            deviceName={services.deviceName}
            onOpened={services.opened}
            agents={services.agents}
            attachments={services.attachments}
            actions={services.actions}
            link={services.client}
            onBack={() => router.back('/')}
          />
        );
      case 'file': {
        const { replica } = services;
        const sessionId = route.sessionId;
        const sessionFolder = {
          name: () => {
            const cwd = replica.session(sessionId)?.session?.cwd ?? [...replica.sessions, ...replica.archivedSessions].find((s) => s.sessionId === sessionId)?.cwd;
            return cwd?.split('/').filter((part) => part !== '').at(-1);
          },
          subscribe: (listener: () => void) => replica.subscribe(listener),
        };
        return (
          <FileRoute
            key={`${route.sessionId}:${route.path}:${route.line ?? ''}`}
            sessionId={route.sessionId}
            path={route.path}
            {...(route.line !== undefined ? { line: route.line } : {})}
            reader={services.client}
            storage={storage}
            sessionFolder={sessionFolder}
            onBack={() => router.back({ name: 'session', sessionId: route.sessionId })}
          />
        );
      }
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
      default:
        return <></>; // pair and lab never reach Connected
    }
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
