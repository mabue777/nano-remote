import { describe, expect, it, vi } from 'vitest';

import { parseRoute, routePath, Router, type WindowLike } from './router';

/** A fake window whose history moves location the way a browser does. */
class FakeWindow implements WindowLike {
  location = { pathname: '/', hash: '', search: '' };
  readonly entries: string[] = [];
  private index = -1;
  private readonly pop = new Set<() => void>();
  readonly history = {
    pushState: (_d: unknown, _u: string, url?: string) => {
      this.entries.splice(this.index + 1);
      this.entries.push(url!);
      this.index = this.entries.length - 1;
      this.go(url!);
    },
    replaceState: (_d: unknown, _u: string, url?: string) => {
      this.entries[Math.max(this.index, 0)] = url!;
      this.index = Math.max(this.index, 0);
      this.go(url!);
    },
  };

  constructor(start: string) {
    this.entries.push(start);
    this.index = 0;
    this.go(start);
  }

  back(): void {
    this.index -= 1;
    this.go(this.entries[this.index]!);
    for (const fn of this.pop) fn();
  }

  addEventListener(_type: 'popstate', listener: () => void): void {
    this.pop.add(listener);
  }

  removeEventListener(_type: 'popstate', listener: () => void): void {
    this.pop.delete(listener);
  }

  get listenerCount(): number {
    return this.pop.size;
  }

  private go(url: string): void {
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
    ['/settings', { name: 'notFound', path: '/settings' }],
    ['/chats', { name: 'chats' }],
    ['/chats/', { name: 'chats' }],
    ['/c/9b1f', { name: 'chat', chatId: '9b1f' }],
    ['/c/9b1f/', { name: 'chat', chatId: '9b1f' }],
    ['/c/', { name: 'notFound', path: '/c/' }],
    ['/c/a/b', { name: 'notFound', path: '/c/a/b' }],
    ['/c/%E0%A4%A', { name: 'notFound', path: '/c/%E0%A4%A' }],
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
    expect(seen).toHaveBeenLastCalledWith({ name: 'session', sessionId: 'ses_1' });
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
});
