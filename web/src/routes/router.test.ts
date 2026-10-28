import { describe, expect, it, vi } from 'vitest';

import { depthOf, directionOf, parseRoute, routePath, Router, type PopEvent, type Route, type WindowLike } from './router';

/** A fake window whose history moves location the way a browser does. */
class FakeWindow implements WindowLike {
  location = { pathname: '/', hash: '', search: '' };
  readonly entries: string[] = [];
  readonly states: unknown[] = [];
  private index = -1;
  private readonly pop = new Set<(event: PopEvent) => void>();
  /** Set by `history.back()`: the step waits for `flush()`, like the browser's asynchronous popstate. */
  queued = false;
  readonly history: WindowLike['history'] & { state: unknown } = {
    state: null,
    scrollRestoration: 'auto',
    pushState: (data: unknown, _u: string, url?: string) => {
      this.entries.splice(this.index + 1);
      this.states.splice(this.index + 1);
      this.entries.push(url!);
      this.states.push(data);
      this.index = this.entries.length - 1;
      this.go(url!);
    },
    replaceState: (data: unknown, _u: string, url?: string) => {
      this.entries[Math.max(this.index, 0)] = url!;
      this.states[Math.max(this.index, 0)] = data;
      this.index = Math.max(this.index, 0);
      this.go(url!);
    },
    back: () => {
      this.queued = true;
    },
  };

  constructor(start: string) {
    this.entries.push(start);
    this.index = 0;
    this.go(start);
  }

  /** The browser's back button (or a back swipe, with `event`). */
  back(event: PopEvent = {}): void {
    this.index -= 1;
    this.go(this.entries[this.index]!);
    for (const fn of this.pop) fn(event);
  }

  /** Delivers the popstate a `history.back()` asked for. */
  flush(): void {
    if (!this.queued) return;
    this.queued = false;
    this.back();
  }

  addEventListener(_type: 'popstate', listener: (event: PopEvent) => void): void {
    this.pop.add(listener);
  }

  removeEventListener(_type: 'popstate', listener: (event: PopEvent) => void): void {
    this.pop.delete(listener);
  }

  get listenerCount(): number {
    return this.pop.size;
  }

  private go(url: string): void {
    this.history.state = this.states[this.index] ?? null;
    const parsed = new URL(url, 'https://host.example');
    this.location = { pathname: parsed.pathname, hash: parsed.hash, search: parsed.search };
  }
}

function click(overrides: Partial<Parameters<Router['handleClick']>[0]> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe('parseRoute and routePath', () => {
  it.each([
    ['/', { name: 'home' }],
    ['', { name: 'home' }],
    ['/index.html', { name: 'home' }],
    ['/pair', { name: 'pair' }],
    ['/pair/', { name: 'pair' }],
    ['/s/ses_01J', { name: 'session', sessionId: 'ses_01J' }],
    ['/s/ses_01J/', { name: 'session', sessionId: 'ses_01J' }],
    ['/s/a%20b', { name: 'session', sessionId: 'a b' }],
    ['/s/', { name: 'notFound', path: '/s/' }],
    ['/s/a/b', { name: 'notFound', path: '/s/a/b' }],
    ['/s/%E0%A4%A', { name: 'notFound', path: '/s/%E0%A4%A' }],
    ['/settings/other', { name: 'notFound', path: '/settings/other' }],
    ['/chats', { name: 'chats' }],
    ['/chats/', { name: 'chats' }],
    ['/settings', { name: 'settings' }],
    ['/settings/', { name: 'settings' }],
    ['/settings/providers', { name: 'settings' }],
    ['/settings/providers/', { name: 'settings' }],
    ['/c/9b1f', { name: 'chat', chatId: '9b1f' }],
    ['/c/9b1f/', { name: 'chat', chatId: '9b1f' }],
    ['/c/', { name: 'notFound', path: '/c/' }],
    ['/c/a/b', { name: 'notFound', path: '/c/a/b' }],
    ['/c/%E0%A4%A', { name: 'notFound', path: '/c/%E0%A4%A' }],
    ['/lab', { name: 'lab' }],
    ['/lab/', { name: 'lab' }],
    ['/lab/x', { name: 'notFound', path: '/lab/x' }],
  ])('%s', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it('routePath inverts parseRoute', () => {
    expect(routePath({ name: 'home' })).toBe('/');
    expect(routePath({ name: 'pair' })).toBe('/pair');
    expect(routePath({ name: 'session', sessionId: 'a b/c' })).toBe('/s/a%20b%2Fc');
    expect(parseRoute(routePath({ name: 'session', sessionId: 'a b/c' }))).toEqual({ name: 'session', sessionId: 'a b/c' });
    expect(routePath({ name: 'notFound', path: '/x' })).toBe('/x');
    expect(routePath({ name: 'chats' })).toBe('/chats');
    expect(routePath({ name: 'settings' })).toBe('/settings');
    expect(routePath({ name: 'lab' })).toBe('/lab');
    expect(routePath({ name: 'chat', chatId: 'a b' })).toBe('/c/a%20b');
    expect(parseRoute(routePath({ name: 'chat', chatId: 'a b/c' }))).toEqual({ name: 'chat', chatId: 'a b/c' });
  });
});

describe('Router', () => {
  it('reads the start route and the fragment (the pairing code lives there)', () => {
    const router = new Router(new FakeWindow('/pair#code=12345678'));
    expect(router.route).toEqual({ name: 'pair' });
    expect(router.hash).toBe('code=12345678');
  });

  it('navigate pushes history and notifies once per route change; back pops', () => {
    const win = new FakeWindow('/');
    const router = new Router(win);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate({ name: 'session', sessionId: 'ses_1' });
    expect(win.location.pathname).toBe('/s/ses_1');
    expect(seen).toHaveBeenLastCalledWith({ name: 'session', sessionId: 'ses_1' }, expect.objectContaining({ direction: 'push' }));
    router.navigate('/s/ses_1'); // same place: nothing
    expect(win.entries).toEqual(['/', '/s/ses_1']);
    expect(seen).toHaveBeenCalledTimes(1);
    win.back();
    expect(router.route).toEqual({ name: 'home' });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('replace swaps the entry, so back does not return to the pairing page', () => {
    const win = new FakeWindow('/pair#code=1');
    const router = new Router(win);
    router.navigate('/', { replace: true });
    expect(win.entries).toEqual(['/']);
    expect(router.route).toEqual({ name: 'home' });
    expect(router.hash).toBe('');
  });

  it('a hash-only change keeps the route and does not notify', () => {
    const win = new FakeWindow('/pair');
    const router = new Router(win);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate('/pair#code=2');
    expect(router.hash).toBe('code=2');
    expect(seen).not.toHaveBeenCalled();
  });

  it('unsubscribe and dispose stop notifications and detach popstate', () => {
    const win = new FakeWindow('/');
    const router = new Router(win);
    const seen = vi.fn();
    const off = router.subscribe(seen);
    off();
    router.navigate('/pair');
    expect(seen).not.toHaveBeenCalled();
    router.subscribe(seen);
    router.dispose();
    expect(win.listenerCount).toBe(0);
    router.navigate('/');
    expect(seen).not.toHaveBeenCalled();
  });

  it('handleClick takes plain clicks on in-app links and leaves everything else to the browser', () => {
    const router = new Router(new FakeWindow('/'));
    const plain = click();
    expect(router.handleClick(plain, '/s/ses_2')).toBe(true);
    expect(plain.preventDefault).toHaveBeenCalled();
    expect(router.route).toEqual({ name: 'session', sessionId: 'ses_2' });
    for (const [event, href] of [
      [click({ metaKey: true }), '/'],
      [click({ ctrlKey: true }), '/'],
      [click({ shiftKey: true }), '/'],
      [click({ altKey: true }), '/'],
      [click({ button: 1 }), '/'],
      [click({ defaultPrevented: true }), '/'],
      [click(), null],
      [click(), 'https://elsewhere.example/'],
      [click(), '//elsewhere.example/'],
    ] as const) {
      expect(router.handleClick(event, href)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(router.route).toEqual({ name: 'session', sessionId: 'ses_2' });
  });

  it('tells listeners where a change comes from, which way it goes and whether to animate it', () => {
    const win = new FakeWindow('/');
    const router = new Router(win);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate('/s/ses_1');
    expect(seen).toHaveBeenLastCalledWith(
      { name: 'session', sessionId: 'ses_1' },
      { from: { name: 'home' }, to: { name: 'session', sessionId: 'ses_1' }, direction: 'push', animate: true },
    );
    win.back();
    expect(seen).toHaveBeenLastCalledWith({ name: 'home' }, { from: { name: 'session', sessionId: 'ses_1' }, to: { name: 'home' }, direction: 'pop', animate: true });
    router.navigate('/chats', { replace: true });
    expect(seen.mock.lastCall![1]).toMatchObject({ direction: 'none', animate: false });
    router.navigate('/c/chat_1', { replace: true, animate: true });
    expect(seen.mock.lastCall![1]).toMatchObject({ direction: 'push', animate: true });
    router.navigate('/chats', { replace: true });
    router.navigate('/settings', { animate: false });
    expect(seen.mock.lastCall![1]).toMatchObject({ direction: 'push', animate: false });
  });

  it('a popstate the browser already animated (Safari\'s own back swipe) does not animate again', () => {
    const win = new FakeWindow('/');
    const router = new Router(win);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate('/s/ses_1');
    win.back({ hasUAVisualTransition: true });
    expect(seen.mock.lastCall![1]).toMatchObject({ direction: 'pop', animate: false });
  });

  it('asks an injected guess whether the browser animated a popstate', () => {
    const win = new FakeWindow('/');
    const browserAnimated = vi.fn(() => true);
    const router = new Router(win, { browserAnimated });
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate('/c/chat_1');
    win.back();
    expect(browserAnimated).toHaveBeenCalledWith({});
    expect(seen.mock.lastCall![1]).toMatchObject({ animate: false });
  });

  it('takes over scroll restoration where the browser offers it', () => {
    const win = new FakeWindow('/');
    new Router(win);
    expect(win.history.scrollRestoration).toBe('manual');
  });

  it('back steps back through history when the entry before is the target, keeping its animate choice', () => {
    const win = new FakeWindow('/');
    const router = new Router(win);
    const seen = vi.fn();
    router.subscribe(seen);
    router.navigate('/chats', { replace: true });
    router.navigate('/c/chat_1');
    expect(win.history.state).toEqual({ back: '/chats' });
    router.back('/chats', { animate: false });
    expect(win.queued).toBe(true);
    expect(router.route).toEqual({ name: 'chat', chatId: 'chat_1' }); // the popstate is still on its way
    win.flush();
    expect(router.route).toEqual({ name: 'chats' });
    expect(win.entries).toEqual(['/chats', '/c/chat_1']);
    expect(seen.mock.lastCall![1]).toMatchObject({ direction: 'pop', animate: false });
    // The next popstate (the browser's back button) decides for itself again.
    router.navigate('/c/chat_2');
    win.back();
    expect(seen.mock.lastCall![1]).toMatchObject({ animate: true });
  });

  it('back navigates when the entry before is another page or the page was opened directly', () => {
    const win = new FakeWindow('/s/ses_1');
    const router = new Router(win);
    const seen = vi.fn();
    router.subscribe(seen);
    router.back({ name: 'home' });
    expect(win.queued).toBe(false);
    expect(win.entries).toEqual(['/s/ses_1', '/']);
    expect(seen.mock.lastCall![1]).toMatchObject({ direction: 'pop', animate: true });
    router.navigate('/c/chat_1');
    router.back('/chats', { animate: false }); // pushed from '/', not '/chats'
    expect(router.route).toEqual({ name: 'chats' });
    expect(seen.mock.lastCall![1]).toMatchObject({ animate: false });
  });

  it('back without history.back (a minimal window) navigates', () => {
    const win = new FakeWindow('/');
    const { back: _drop, ...rest } = win.history;
    void _drop;
    const bare: WindowLike = { location: win.location, history: rest, addEventListener: () => {}, removeEventListener: () => {} };
    const router = new Router(bare);
    router.navigate('/s/ses_1');
    router.back('/');
    expect(router.route).toEqual({ name: 'home' });
  });
});

describe('depthOf and directionOf', () => {
  const home: Route = { name: 'home' };
  const chats: Route = { name: 'chats' };
  const session: Route = { name: 'session', sessionId: 's' };
  const chat: Route = { name: 'chat', chatId: 'c' };
  const settings: Route = { name: 'settings' };

  it('Home and its tabs are the top, sessions and chats one level down, Settings two', () => {
    expect([home, chats, { name: 'pair' } as Route, { name: 'lab' } as Route, { name: 'notFound', path: '/x' } as Route].map(depthOf)).toEqual([0, 0, 0, 0, 0]);
    expect([session, chat].map(depthOf)).toEqual([1, 1]);
    expect(depthOf(settings)).toBe(2);
  });

  it.each([
    [home, session, 'push'],
    [home, settings, 'push'],
    [chats, chat, 'push'],
    [chat, settings, 'push'],
    [session, home, 'pop'],
    [settings, home, 'pop'],
    [chat, chats, 'pop'],
    [home, chats, 'none'],
    [session, { name: 'session', sessionId: 't' } as Route, 'none'],
  ] as const)('%o to %o is %s', (from, to, direction) => {
    expect(directionOf(from, to)).toBe(direction);
  });
});
