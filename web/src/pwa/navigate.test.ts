import { describe, expect, it } from 'vitest';

import { Router, type WindowLike } from '../routes/router';
import { listenForNavigate, navigateTarget, type MessageSource } from './navigate';

const ORIGIN = 'https://mac.tailnet.ts.net';

describe('navigateTarget', () => {
  it('follows navigate messages to in-app paths, absolute or relative', () => {
    expect(navigateTarget({ type: 'navigate', url: '/s/ses_1' }, ORIGIN)).toBe('/s/ses_1');
    expect(navigateTarget({ type: 'navigate', url: `${ORIGIN}/s/ses_2?x=1#end` }, ORIGIN)).toBe('/s/ses_2?x=1#end');
    expect(navigateTarget({ type: 'navigate', url: '/' }, ORIGIN)).toBe('/');
  });

  it('ignores other messages, other origins and junk', () => {
    expect(navigateTarget({ type: 'SKIP_WAITING' }, ORIGIN)).toBeUndefined();
    expect(navigateTarget({ type: 'navigate' }, ORIGIN)).toBeUndefined();
    expect(navigateTarget({ type: 'navigate', url: 'https://evil.example/s/ses_1' }, ORIGIN)).toBeUndefined();
    expect(navigateTarget({ type: 'navigate', url: '//evil.example/x' }, ORIGIN)).toBeUndefined();
    expect(navigateTarget({ type: 'navigate', url: 'http://[bad' }, ORIGIN)).toBeUndefined();
    expect(navigateTarget(null, ORIGIN)).toBeUndefined();
    expect(navigateTarget('navigate', ORIGIN)).toBeUndefined();
  });
});

describe('listenForNavigate', () => {
  function fakeWindow(pathname = '/'): WindowLike & { paths: string[] } {
    const win = {
      paths: [] as string[],
      location: { pathname, hash: '', search: '' },
      history: {
        pushState: (_d: unknown, _u: string, url?: string) => {
          win.location.pathname = url!;
          win.paths.push(url!);
        },
        replaceState: () => {},
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    return win;
  }

  it('routes the page to the session a tapped notification names, until unsubscribed', () => {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const source: MessageSource = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const win = fakeWindow('/');
    const router = new Router(win);
    const off = listenForNavigate(source, ORIGIN, (path) => router.navigate(path));
    const post = (data: unknown) => {
      for (const listener of listeners) listener({ data });
    };

    post({ type: 'navigate', url: '/s/ses_7' });
    expect(router.route).toEqual({ name: 'session', sessionId: 'ses_7' });
    post({ type: 'pushsubscriptionchange' });
    post({ type: 'navigate', url: 'https://evil.example/' });
    expect(win.paths).toEqual(['/s/ses_7']);

    off();
    expect(listeners.size).toBe(0);
  });
});
