// A tiny history router for the app's pages: /pair, / (home), /chats (home on its Chats tab),
// /settings (Settings; /settings/providers is its old address and opens it too), /s/:sessionId, /c/:chatId (a local chat) and /lab (the
// hidden interaction lab, reached only by typing the URL). The host answers each of these paths with index.html (host/src/http/static.ts), so a reload or a push link
// lands on the right page. The fragment is left alone: the pairing link carries its code there
// (`/pair#code=12345678`, spec 8), and a fragment never reaches the host.
//
// Every change says which way it goes (page push and back swipe, docs/research/interaction-feel-prototype.md
// row 2): a push opens a deeper page (Home -> a session, a chat or Settings), a pop goes back up, and a
// change between pages of the same depth (Home's Sessions | Chats switch, a redirect) has no direction. The
// depth comes from the pages, not from history, so the browser's back and forward buttons get the right
// direction too. Each entry this router adds remembers the path it was pushed from (history.state.back), so
// `back` can step back through the browser's history instead of piling up a new entry.

export type Route =
  | { name: 'pair' }
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'settings' }
  | { name: 'session'; sessionId: string }
  | { name: 'chat'; chatId: string }
  | { name: 'lab' }
  | { name: 'notFound'; path: string };

const SESSION = /^\/s\/([^/]+)\/?$/;
const CHAT = /^\/c\/([^/]+)\/?$/;

/** The route a pathname names. Unknown paths are `notFound` (the app shows a way home). */
export function parseRoute(pathname: string): Route {
  const path = pathname === '' ? '/' : pathname;
  if (path === '/' || path === '/index.html') return { name: 'home' };
  if (path === '/pair' || path === '/pair/') return { name: 'pair' };
  if (path === '/chats' || path === '/chats/') return { name: 'chats' };
  if (path === '/settings' || path === '/settings/' || path === '/settings/providers' || path === '/settings/providers/') return { name: 'settings' };
  if (path === '/lab' || path === '/lab/') return { name: 'lab' };
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
    case 'settings':
      return '/settings';
    case 'session':
      return `/s/${encodeURIComponent(route.sessionId)}`;
    case 'chat':
      return `/c/${encodeURIComponent(route.chatId)}`;
    case 'lab':
      return '/lab';
    case 'notFound':
      return route.path;
  }
}

export type Direction = 'push' | 'pop' | 'none';

/** How deep a page sits: Home 0, a session or chat 1, Settings 2 (it opens from Home and from a chat). */
export function depthOf(route: Route): number {
  switch (route.name) {
    case 'session':
    case 'chat':
      return 1;
    case 'settings':
      return 2;
    default:
      return 0;
  }
}

/** Which way going from one page to another moves: deeper is a push, shallower a pop. */
export function directionOf(from: Route, to: Route): Direction {
  const a = depthOf(from);
  const b = depthOf(to);
  return b > a ? 'push' : b < a ? 'pop' : 'none';
}

/** One route change as listeners hear it. */
export interface Navigation {
  from: Route;
  to: Route;
  direction: Direction;
  /**
   * Whether the app should animate the change. False when the motion already happened: the app's own back
   * swipe, or the browser's back swipe (Safari in a tab), which plays its own animation before the pop.
   */
  animate: boolean;
}

/** What the browser says about a popstate: `hasUAVisualTransition` is true when it already animated it. */
export interface PopEvent {
  hasUAVisualTransition?: boolean;
}

/** The parts of `window` the router uses; injected so tests run in Node. */
export interface WindowLike {
  location: { pathname: string; hash: string; search: string };
  history: {
    pushState(data: unknown, unused: string, url?: string): void;
    replaceState(data: unknown, unused: string, url?: string): void;
    /** Absent in tests that do not go back. */
    back?(): void;
    state?: unknown;
    scrollRestoration?: 'auto' | 'manual';
  };
  addEventListener(type: 'popstate', listener: (event: PopEvent) => void): void;
  removeEventListener(type: 'popstate', listener: (event: PopEvent) => void): void;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one (redirects, leaving the pair page). */
  replace?: boolean;
  /** False when the caller already animated the change (the back swipe). Default: true, false for a replace (a redirect). */
  animate?: boolean;
}

export interface RouterOptions {
  /**
   * Whether the browser already animated this popstate. Default: its `hasUAVisualTransition`. main.tsx adds
   * a guess for Safari versions that do not report it (ui/motion/page-motion.ts).
   */
  browserAnimated?: (event: PopEvent) => boolean;
}

/** The history entry state this router writes: the path the entry was pushed from. */
interface EntryState {
  back: string | null;
}

function entryBack(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const back = (state as Partial<EntryState>).back;
  return typeof back === 'string' ? back : null;
}

export class Router {
  private current: Route;
  private readonly listeners = new Set<(route: Route, navigation: Navigation) => void>();
  /** Set by `back` while its history step is on the way: whether that pop animates. */
  private pendingBack: boolean | undefined;
  private readonly browserAnimated: (event: PopEvent) => boolean;
  private readonly onPop = (event: PopEvent) => {
    const own = this.pendingBack;
    this.pendingBack = undefined;
    this.sync(own ?? !this.browserAnimated(event ?? {}));
  };

  constructor(
    private readonly win: WindowLike,
    options: RouterOptions = {},
  ) {
    this.browserAnimated = options.browserAnimated ?? ((event) => event.hasUAVisualTransition === true);
    this.current = parseRoute(win.location.pathname);
    // The app puts each page's scroll back itself (routes/PageStack.tsx); the browser's own restore would
    // land in the middle of the slide.
    if (win.history.scrollRestoration !== undefined) win.history.scrollRestoration = 'manual';
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
    if (options.replace) this.win.history.replaceState({ back: entryBack(this.win.history.state) } satisfies EntryState, '', path);
    else this.win.history.pushState({ back: here } satisfies EntryState, '', path);
    this.sync(options.animate ?? !options.replace);
  }

  /**
   * Back to `to` (a page's Back button, the back swipe): a step back through history when the entry before
   * this one is `to`, so the browser's history stays as it was before the push; otherwise a navigation to it.
   */
  back(to: string | Route, options: { animate?: boolean } = {}): void {
    const path = typeof to === 'string' ? to : routePath(to);
    const history = this.win.history;
    if (history.back !== undefined && entryBack(history.state) === path) {
      this.pendingBack = options.animate ?? true;
      history.back();
      return;
    }
    this.navigate(path, options);
  }

  subscribe(listener: (route: Route, navigation: Navigation) => void): () => void {
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

  private sync(animate: boolean): void {
    const next = parseRoute(this.win.location.pathname);
    if (sameRoute(next, this.current)) return;
    const navigation: Navigation = { from: this.current, to: next, direction: directionOf(this.current, next), animate };
    this.current = next;
    for (const listener of [...this.listeners]) listener(next, navigation);
  }
}

function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b) && a.name === b.name;
}
