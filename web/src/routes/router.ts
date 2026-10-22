// A tiny history router for the app's pages: /pair, / (home), /chats (home on its Chats tab),
// /s/:sessionId and /c/:chatId (a local chat). The host answers each of these paths with index.html (host/src/http/static.ts), so a reload or a push link
// lands on the right page. The fragment is left alone: the pairing link carries its code there
// (`/pair#code=12345678`, spec 8), and a fragment never reaches the host.

export type Route =
  | { name: 'pair' }
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'session'; sessionId: string }
  | { name: 'chat'; chatId: string }
  | { name: 'notFound'; path: string };

const SESSION = /^\/s\/([^/]+)\/?$/;
const CHAT = /^\/c\/([^/]+)\/?$/;

/** The route a pathname names. Unknown paths are `notFound` (the app shows a way home). */
export function parseRoute(pathname: string): Route {
  const path = pathname === '' ? '/' : pathname;
  if (path === '/' || path === '/index.html') return { name: 'home' };
  if (path === '/pair' || path === '/pair/') return { name: 'pair' };
  if (path === '/chats' || path === '/chats/') return { name: 'chats' };
  const sessionId = idOf(SESSION, path);
  if (sessionId !== undefined) return { name: 'session', sessionId };
  const chatId = idOf(CHAT, path);
  if (chatId !== undefined) return { name: 'chat', chatId };
  return { name: 'notFound', path };
}

/** The decoded id a pattern captures from a path; undefined for no match, an empty id or bad encoding. */
function idOf(pattern: RegExp, path: string): string | undefined {
  const match = pattern.exec(path);
  if (match === null) return undefined;
  try {
    const id = decodeURIComponent(match[1]!);
    return id === '' ? undefined : id;
  } catch {
    return undefined; // malformed percent-encoding: not this page
  }
}

/** The pathname of a route; the inverse of parseRoute. */
export function routePath(route: Route): string {
  switch (route.name) {
    case 'home':
      return '/';
    case 'pair':
      return '/pair';
    case 'chats':
      return '/chats';
    case 'session':
      return `/s/${encodeURIComponent(route.sessionId)}`;
    case 'chat':
      return `/c/${encodeURIComponent(route.chatId)}`;
    case 'notFound':
      return route.path;
  }
}

/** The parts of `window` the router uses; injected so tests run in Node. */
export interface WindowLike {
  location: { pathname: string; hash: string; search: string };
  history: {
    pushState(data: unknown, unused: string, url?: string): void;
    replaceState(data: unknown, unused: string, url?: string): void;
  };
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one (redirects, leaving the pair page). */
  replace?: boolean;
}

export class Router {
  private current: Route;
  private readonly listeners = new Set<(route: Route) => void>();
  private readonly onPop = () => this.sync();

  constructor(private readonly win: WindowLike) {
    this.current = parseRoute(win.location.pathname);
    win.addEventListener('popstate', this.onPop);
  }

  get route(): Route {
    return this.current;
  }

  /** The current fragment without the leading `#`. */
  get hash(): string {
    return this.win.location.hash.replace(/^#/, '');
  }

  /** Goes to a path (or route); listeners hear about it when the route actually changes. */
  navigate(to: string | Route, options: NavigateOptions = {}): void {
    const path = typeof to === 'string' ? to : routePath(to);
    const here = this.win.location.pathname + this.win.location.search + this.win.location.hash;
    if (path === here) return;
    if (options.replace) this.win.history.replaceState(null, '', path);
    else this.win.history.pushState(null, '', path);
    this.sync();
  }

  subscribe(listener: (route: Route) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.win.removeEventListener('popstate', this.onPop);
    this.listeners.clear();
  }

  /**
   * A click handler for in-app links: plain left clicks on same-origin `/...` hrefs navigate without a
   * page load. Returns true when it handled the click.
   */
  handleClick(event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
    preventDefault(): void;
  }, href: string | null): boolean {
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (href === null || !href.startsWith('/') || href.startsWith('//')) return false;
    event.preventDefault();
    this.navigate(href);
    return true;
  }

  private sync(): void {
    const next = parseRoute(this.win.location.pathname);
    if (sameRoute(next, this.current)) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}

function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b) && a.name === b.name;
}
