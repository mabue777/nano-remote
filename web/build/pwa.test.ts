import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ICON_SIZES, ICON_SOURCE, renderIcons } from '../scripts/icons.mjs';
import { buildVersion, installableShell, isShellFile, renderServiceWorker, webManifest, writeInstallableShell, THEME_COLOR } from './pwa';

const TEMPLATE = readFileSync(fileURLToPath(new URL('./service-worker.js', import.meta.url)), 'utf8');
const INDEX_HTML = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(png);
  expect(view.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

describe('icons', () => {
  it('renders every size from the one SVG as an opaque square PNG', async () => {
    const icons = await renderIcons(readFileSync(ICON_SOURCE, 'utf8'));
    expect([...icons.keys()].sort()).toEqual(['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']);
    for (const [name, png] of icons) {
      const size = ICON_SIZES[name]!;
      expect(pngSize(png)).toEqual({ width: size, height: size });
    }
    expect(ICON_SIZES['apple-touch-icon.png']).toBe(180);
  });
});

describe('manifest', () => {
  it('is a standalone app with theme colors and the icons the build writes', () => {
    const manifest = webManifest();
    expect(manifest).toMatchObject({ name: 'Nano Remote', short_name: 'Nano Remote', display: 'standalone', start_url: '/', scope: '/' });
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // fits under a home-screen icon
    expect(manifest.theme_color).toBe(THEME_COLOR);
    expect(manifest.background_color).toBe(THEME_COLOR);
    for (const icon of manifest.icons) {
      const file = icon.src.slice(1);
      expect(ICON_SIZES[file], icon.src).toBeDefined();
      expect(icon.sizes).toBe(`${ICON_SIZES[file]}x${ICON_SIZES[file]}`);
    }
    expect(manifest.icons.map((icon) => icon.purpose)).toContain('maskable');
  });

  it('index.html links the manifest and the iOS tags, with the same theme color', () => {
    expect(INDEX_HTML).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(INDEX_HTML).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(INDEX_HTML).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(INDEX_HTML).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="[a-z-]+" \/>/);
    expect(INDEX_HTML).toMatch(/<meta name="viewport" content="[^"]*width=device-width[^"]*viewport-fit=cover"/);
    expect(INDEX_HTML).toContain(`<meta name="theme-color" content="${THEME_COLOR}" media="(prefers-color-scheme: light)" />`);
  });
});

describe('build version', () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));

  it('is stable for the same files in any order and changes when any byte or name changes', () => {
    const base = buildVersion(files({ 'index.html': 'a', 'assets/x.js': 'b' }));
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(buildVersion(files({ 'assets/x.js': 'b', 'index.html': 'a' }))).toBe(base);
    expect(buildVersion(files({ 'index.html': 'a', 'assets/x.js': 'c' }))).not.toBe(base);
    expect(buildVersion(files({ 'index.html': 'a', 'assets/y.js': 'b' }))).not.toBe(base);
  });

  it('leaves source maps, dotfiles and the worker out of the shell', () => {
    expect(isShellFile('assets/index-abc.js')).toBe(true);
    expect(isShellFile('assets/index-abc.js.map')).toBe(false);
    expect(isShellFile('sw.js')).toBe(false);
    expect(isShellFile('.DS_Store')).toBe(false);
  });
});

describe('writeInstallableShell', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes icons, manifest and a versioned sw.js listing the shell; a changed build gets a new version', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nano-shell-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    writeFileSync(path.join(dir, 'assets', 'index-abc12345.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'assets', 'index-abc12345.js.map'), '{}');

    const first = await writeInstallableShell(dir);
    expect(first.shell).toEqual([
      '/apple-touch-icon.png',
      '/assets/index-abc12345.js',
      '/icon-192.png',
      '/icon-512.png',
      '/index.html',
      '/manifest.webmanifest',
    ]);
    expect(JSON.parse(readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'))).toEqual(webManifest());
    const sw = readFileSync(path.join(dir, 'sw.js'), 'utf8');
    expect(sw).toContain(`const VERSION = "${first.version}";`);
    expect(sw).toContain(`const SHELL = ${JSON.stringify(first.shell)};`);

    expect((await writeInstallableShell(dir)).version).toBe(first.version); // rebuilding is idempotent
    writeFileSync(path.join(dir, 'assets', 'index-abc12345.js'), 'console.log(2)');
    expect((await writeInstallableShell(dir)).version).not.toBe(first.version);
  });

  it('the Vite plugin runs only for builds and writes into the resolved outDir after the bundle', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nano-shell-'));
    mkdirSync(path.join(dir, 'out'));
    writeFileSync(path.join(dir, 'out', 'index.html'), '<html></html>');
    const plugin = installableShell();
    expect(plugin.apply).toBe('build');
    const logged: string[] = [];
    const configResolved = plugin.configResolved as (config: unknown) => void;
    configResolved({ root: dir, build: { outDir: 'out' }, logger: { info: (message: string) => logged.push(message) } });
    await (plugin.closeBundle as () => Promise<void>)();
    expect(readFileSync(path.join(dir, 'out', 'sw.js'), 'utf8')).toContain('"/index.html"');
    expect(logged).toEqual([expect.stringMatching(/^installable shell: sw.js version [0-9a-f]{16}, 5 shell files$/)]);
  });
});

// ---- the service worker itself, run against fake ServiceWorkerGlobalScope pieces ----

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  request?: { method: string; url: string; mode: string };
  data?: unknown;
  waitUntil(promise: Promise<unknown>): void;
  respondWith(response: Promise<unknown>): void;
}

function loadWorker(shell: string[], version = 'v2', network: (url: string) => Promise<string> = async (url) => `net:${url}`) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, string>>([['nano-remote-shell-v1', new Map()], ['other-app', new Map()]]);
  const calls = { skipWaiting: 0, claim: 0, fetched: [] as string[] };
  const self = {
    location: { origin: 'https://mac.tailnet.ts.net' },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++ },
  };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
    open: async (key: string) => {
      const store = stores.get(key) ?? new Map<string, string>();
      stores.set(key, store);
      return {
        addAll: async (paths: string[]) => {
          for (const p of paths) store.set(p, `cached:${p}`);
        },
        match: async (p: string) => store.get(p),
      };
    },
  };
  const fetchFn = (request: { url: string }) => {
    calls.fetched.push(request.url);
    return network(request.url);
  };
  const Response = { error: () => 'response-error' };
  const source = renderServiceWorker(TEMPLATE, version, shell);
  new Function('self', 'caches', 'fetch', 'Response', 'URL', source)(self, caches, fetchFn, Response, URL);

  async function dispatch(type: string, init: Partial<FakeEvent> = {}): Promise<{ waited: unknown; responded: unknown; handled: boolean }> {
    let waited: Promise<unknown> | undefined;
    let responded: Promise<unknown> | undefined;
    listeners.get(type)!({ ...init, waitUntil: (p) => (waited = p), respondWith: (p) => (responded = p) });
    return { waited: await waited, responded: await responded, handled: responded !== undefined };
  }
  const get = (pathname: string, mode = 'no-cors', origin = self.location.origin) =>
    dispatch('fetch', { request: { method: 'GET', url: origin + pathname, mode } });
  return { dispatch, get, stores, calls };
}

describe('service worker', () => {
  const SHELL = ['/index.html', '/assets/index-abc12345.js', '/manifest.webmanifest'];

  it('refuses a template without the config lines', () => {
    expect(() => renderServiceWorker('const X = 1;', 'v', [])).toThrow(/config/);
  });

  it('install caches exactly the shell under the versioned name and does not activate itself', async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch('install');
    expect([...worker.stores.get('nano-remote-shell-v2')!.keys()]).toEqual(SHELL);
    expect(worker.calls.skipWaiting).toBe(0); // waits for the page's reload prompt
  });

  it('activate drops older shell caches only and claims the pages', async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch('install');
    await worker.dispatch('activate');
    expect([...worker.stores.keys()].sort()).toEqual(['nano-remote-shell-v2', 'other-app']);
    expect(worker.calls.claim).toBe(1);
  });

  it('SKIP_WAITING from the page activates the new build; other messages do nothing', async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch('message', { data: { type: 'hello' } });
    await worker.dispatch('message', { data: null });
    expect(worker.calls.skipWaiting).toBe(0);
    await worker.dispatch('message', { data: { type: 'SKIP_WAITING' } });
    expect(worker.calls.skipWaiting).toBe(1);
  });

  it('never answers /v1 (API, pairing, stream), other methods, other origins or non-shell files', async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch('install');
    for (const pathname of ['/v1', '/v1/stream', '/v1/pair', '/v1/push/subscribe']) {
      expect((await worker.get(pathname)).handled, pathname).toBe(false);
      expect((await worker.get(pathname, 'navigate')).handled, `navigate ${pathname}`).toBe(false);
    }
    expect((await worker.dispatch('fetch', { request: { method: 'POST', url: 'https://mac.tailnet.ts.net/index.html', mode: 'cors' } })).handled).toBe(false);
    expect((await worker.get('/index.html', 'no-cors', 'https://cdn.example')).handled).toBe(false);
    expect((await worker.get('/test/reset')).handled).toBe(false);
    expect((await worker.get('/v1x')).handled).toBe(false); // not shell either
    expect(worker.calls.fetched).toEqual([]);
  });

  it('serves shell files from the cache, and falls back to the network on a miss', async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch('install');
    expect((await worker.get('/assets/index-abc12345.js')).responded).toBe('cached:/assets/index-abc12345.js');
    worker.stores.get('nano-remote-shell-v2')!.delete('/manifest.webmanifest');
    expect((await worker.get('/manifest.webmanifest')).responded).toBe('net:https://mac.tailnet.ts.net/manifest.webmanifest');
  });

  it('navigations go to the network first and fall back to the cached index.html when offline', async () => {
    let online = true;
    const worker = loadWorker(SHELL, 'v2', async (url) => {
      if (!online) throw new TypeError('offline');
      return `net:${url}`;
    });
    await worker.dispatch('install');
    expect((await worker.get('/s/ses_1', 'navigate')).responded).toBe('net:https://mac.tailnet.ts.net/s/ses_1');
    online = false;
    expect((await worker.get('/s/ses_1', 'navigate')).responded).toBe('cached:/index.html');
    worker.stores.get('nano-remote-shell-v2')!.clear();
    expect((await worker.get('/', 'navigate')).responded).toBe('response-error');
  });
});
