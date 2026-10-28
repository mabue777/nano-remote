import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import { allNodes, fire, only, text, type Node } from '../../test/vnode';
import type { ViewerRequest } from './image-viewer-launch';
import { decodedSize, fetchFile, ImageViewer, LOAD_FAILED, retryUrl, SHARE_FALLBACK, Slide, type ImageViewerProps, type ShareTarget } from './ImageViewer';
import type { ViewerEnv } from './motion/viewer-motion';

vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The browser globals the viewer touches: the window's size, timers and listeners, the document's keys. */
function stubBrowser() {
  const listeners = new Map<string, (event: unknown) => void>();
  const timers: { run: () => void; ms: number }[] = [];
  const target = (scope: string) => ({
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(`${scope}:${type}`, listener),
    removeEventListener: (type: string) => listeners.delete(`${scope}:${type}`),
  });
  const win = {
    innerWidth: 390,
    innerHeight: 844,
    ...target('window'),
    setTimeout: (run: () => void, ms: number) => timers.push({ run, ms }),
    clearTimeout: () => undefined,
    fetch: vi.fn(async () => ({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) })),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', target('document'));
  return { win, listeners, timers };
}

function testEnv(timers: { run: () => void; ms: number }[] = []): ViewerEnv {
  return {
    reduced: () => false,
    viewport: () => ({ width: 390, height: 844 }),
    motion: () => ({ fast: 150, moderate: 200, relaxed: 300, standard: 's', enter: 'e', exit: 'x' }),
    linearEasing: true,
    styleOf: (element) => element.style,
    haptic: () => undefined,
    setTimeout: (run, ms) => timers.push({ run, ms }),
    clearTimeout: () => undefined,
  };
}

const images = [
  { src: '/v1/blob/blb_1', alt: 'Attached image 1' },
  { src: '/v1/blob/blb_2', alt: 'Attached image 2' },
  { src: '/v1/blob/blb_3', alt: 'Attached image 3' },
];

function decodedThumb(width: number, height: number) {
  return { complete: true, naturalWidth: width, naturalHeight: height } as HTMLImageElement;
}

function viewer(props: Omit<Partial<ImageViewerProps>, 'request'> & { request?: Partial<ViewerRequest> } = {}) {
  const onClosed = vi.fn();
  const envTimers: { run: () => void; ms: number }[] = [];
  const share: ShareTarget = props.share ?? { share: vi.fn(async () => undefined), canShare: () => true, fetch: async () => ({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }) };
  const request: ViewerRequest = { images, index: 1, origin: (i) => (i === 1 ? decodedThumb(600, 1200) : null), ...props.request };
  const { request: _partial, ...rest } = props;
  const host = renderHook(() => ImageViewer({ onClosed, env: testEnv(envTimers), share, ...rest, request }) as Node);
  const tree = () => host.value;
  const slides = () => allNodes(tree()).filter((node) => (node.type as unknown) === Slide);
  const button = (label: string) => only(tree(), (node) => node.type === 'button' && node.props['aria-label'] === label);
  const stage = () => only(tree(), (node) => node.props.class === 'iv-stage');
  return { host, tree, slides, button, stage, onClosed, envTimers, share };
}

describe('ImageViewer', () => {
  let browser: ReturnType<typeof stubBrowser>;
  beforeEach(() => {
    browser = stubBrowser();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is a modal dialog named by its place, with Close, "2 of 3" and Share, showing its picture and the neighbours', () => {
    const { tree, slides, button } = viewer();
    expect(tree().props).toMatchObject({ role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image 2 of 3', class: 'iv' });
    expect(text(only(tree(), (node) => node.props.class === 'iv-count').props.children)).toBe('2 of 3');
    expect(button('Close')).toBeDefined();
    expect(button('Share')).toBeDefined();
    expect(slides().map((slide) => slide.props.index)).toEqual([0, 1, 2]);
    // The tapped picture's size comes from its decoded thumbnail; the others are not known yet.
    expect(slides()[1]!.props).toMatchObject({ size: { width: 600, height: 1200 }, first: true, left: 406 });
    expect(slides()[0]!.props.size).toBeUndefined();
  });

  it('one picture alone has no count and is just "Image"', () => {
    const { tree } = viewer({ request: { images: [images[0]!], index: 0, origin: () => null } });
    expect(tree().props['aria-label']).toBe('Image');
    expect(allNodes(tree()).some((node) => node.props.class === 'iv-count')).toBe(false);
  });

  it('learns a size when a picture loads, and keeps the same state for the same size', () => {
    const { slides } = viewer();
    fire(slides()[0]!, 'onLoad', decodedThumb(2048, 1024));
    expect(slides()[0]!.props.size).toEqual({ width: 2048, height: 1024 });
    const before = slides()[1]!.props.size;
    fire(slides()[1]!, 'onLoad', decodedThumb(600, 1200));
    expect(slides()[1]!.props.size).toBe(before);
    fire(slides()[2]!, 'onLoad', { complete: false, naturalWidth: 0, naturalHeight: 0 });
    expect(slides()[2]!.props.size).toBeUndefined();
  });

  it('a picture that fails shows the failure; Try again loads it afresh', () => {
    const { slides } = viewer();
    fire(slides()[2]!, 'onError');
    fire(slides()[2]!, 'onError');
    expect(slides()[2]!.props).toMatchObject({ failed: true, attempt: 0 });
    fire(slides()[2]!, 'onRetry');
    expect(slides()[2]!.props).toMatchObject({ failed: false, attempt: 1 });
  });

  it('Close plays the close and hands back the picture shown', () => {
    const { button, onClosed } = viewer();
    fire(button('Close'), 'onClick');
    expect(onClosed).toHaveBeenCalledWith(1);
  });

  it('Escape closes and the arrow keys step, through the document; resizing is followed; unmounting stops listening', () => {
    const { tree, onClosed, host } = viewer();
    const preventDefault = vi.fn();
    browser.listeners.get('document:keydown')!({ key: 'ArrowRight', preventDefault });
    expect(tree().props['aria-label']).toBe('Image 3 of 3');
    browser.listeners.get('document:keydown')!({ key: 'q', preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    browser.win.innerWidth = 844;
    browser.listeners.get('window:resize')!({});
    expect(allNodes(tree()).find((node) => (node.type as unknown) === Slide)!.props.viewport).toEqual({ width: 844, height: 844 });
    browser.listeners.get('document:keydown')!({ key: 'Escape', preventDefault });
    expect(onClosed).toHaveBeenCalledWith(2);
    host.unmount();
    expect(browser.listeners.has('document:keydown')).toBe(false);
  });

  it('a single tap hides the buttons and the next shows them', () => {
    const { tree, stage, envTimers } = viewer();
    const tap = (t: number) => {
      const event = { target: { closest: () => null }, currentTarget: { setPointerCapture: vi.fn() }, pointerType: 'touch', button: 0, pointerId: 1, clientX: 100, clientY: 100 };
      fire(stage(), 'onPointerDown', { ...event, timeStamp: t });
      fire(stage(), 'onPointerUp', { ...event, timeStamp: t + 40 });
      envTimers.splice(0).forEach((timer) => timer.run());
    };
    tap(0);
    expect(tree().props.class).toBe('iv iv-bare');
    tap(1000);
    expect(tree().props.class).toBe('iv');
  });

  it('forwards pointers to the motion, but not those on a button, a right click, or a lost pointer', () => {
    const { stage, onClosed } = viewer();
    const capture = vi.fn(() => {
      throw new Error('NotFoundError');
    });
    const base = { target: { closest: () => null }, currentTarget: { setPointerCapture: capture }, pointerType: 'touch', button: 0, pointerId: 1, timeStamp: 0 };
    // A long drag down closes: the moves and the release reached the motion.
    fire(stage(), 'onPointerDown', { ...base, clientX: 200, clientY: 300 });
    expect(capture).toHaveBeenCalled();
    fire(stage(), 'onPointerMove', { ...base, clientX: 200, clientY: 700, timeStamp: 30 });
    fire(stage(), 'onPointerUp', { ...base, clientX: 200, clientY: 700, timeStamp: 40 });
    expect(onClosed).toHaveBeenCalled();
    const other = viewer();
    fire(other.stage(), 'onPointerDown', { ...base, pointerType: 'mouse', button: 2, clientX: 0, clientY: 0 });
    fire(other.stage(), 'onPointerDown', { ...base, target: { closest: () => ({}) }, clientX: 0, clientY: 0 });
    fire(other.stage(), 'onPointerCancel', { ...base, clientX: 0, clientY: 0 });
    const preventDefault = vi.fn();
    fire(other.stage(), 'onWheel', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(other.onClosed).not.toHaveBeenCalled();
  });

  it('Share hands the picture to the system sheet as a file', async () => {
    const shared: File[][] = [];
    const share: ShareTarget = {
      share: async (data) => void shared.push(data.files),
      fetch: async () => ({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }),
    };
    const { button } = viewer({ share });
    fire(button('Share'), 'onClick');
    await flush();
    expect(shared).toHaveLength(1);
    expect(shared[0]![0]!.name).toBe('image-2.png');
    expect(shared[0]![0]!.type).toBe('image/png');
  });

  it('where the file cannot be shared it says to touch and hold, and the hint goes after a while', async () => {
    const { tree, button } = viewer({ share: { canShare: () => false, share: async () => undefined, fetch: async () => ({ ok: true, blob: async () => new Blob(['x']) }) } });
    fire(button('Share'), 'onClick');
    await flush();
    expect(text(only(tree(), (node) => node.props.role === 'status').props.children)).toBe(SHARE_FALLBACK);
    const hide = browser.timers.find((timer) => timer.ms === 4000)!;
    hide.run();
    expect(allNodes(tree()).some((node) => node.props.class === 'iv-notice')).toBe(false);
  });

  it('a cancelled share sheet is no failure; a refused one shows the hint; no Web Share at all shows it too', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const cancelled = viewer({ share: { share: async () => Promise.reject(abort), fetch: async () => ({ ok: true, blob: async () => new Blob(['x']) }) } });
    fire(cancelled.button('Share'), 'onClick');
    await flush();
    expect(allNodes(cancelled.tree()).some((node) => node.props.class === 'iv-notice')).toBe(false);
    const refused = viewer({ share: { share: async () => Promise.reject(new Error('NotAllowedError')), fetch: async () => ({ ok: true, blob: async () => new Blob(['x']) }) } });
    fire(refused.button('Share'), 'onClick');
    await flush();
    expect(allNodes(refused.tree()).some((node) => node.props.class === 'iv-notice')).toBe(true);
    const none = viewer({ share: { fetch: async () => ({ ok: true, blob: async () => new Blob(['x']) }) } });
    fire(none.button('Share'), 'onClick');
    await flush();
    expect(allNodes(none.tree()).some((node) => node.props.class === 'iv-notice')).toBe(true);
  });

  it('uses the browser\'s navigator.share and fetch when none is given', async () => {
    const shareFn = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { share: shareFn, canShare: () => true });
    const { button } = viewer({ share: undefined });
    fire(button('Share'), 'onClick');
    await flush();
    await flush();
    expect(browser.win.fetch).toHaveBeenCalledWith('/v1/blob/blb_2', { credentials: 'same-origin' });
    expect(shareFn).toHaveBeenCalled();
    vi.stubGlobal('navigator', {});
    const bare = viewer({ share: undefined });
    fire(bare.button('Share'), 'onClick');
    await flush();
    expect(allNodes(bare.tree()).some((node) => node.props.class === 'iv-notice')).toBe(true);
  });

  it('grows from a thumbnail that is on the page (its box and corner radius)', () => {
    vi.stubGlobal('getComputedStyle', () => ({ borderTopLeftRadius: '10px' }));
    const thumb = { ...decodedThumb(600, 1200), isConnected: true, getBoundingClientRect: () => ({ left: 10, top: 10, width: 96, height: 96 }), style: {} };
    expect(() => viewer({ request: { origin: () => thumb as unknown as HTMLImageElement } })).not.toThrow();
    const gone = { ...thumb, isConnected: false };
    expect(() => viewer({ request: { origin: () => gone as unknown as HTMLImageElement } })).not.toThrow();
    vi.stubGlobal('getComputedStyle', () => ({ borderTopLeftRadius: '' }));
    expect(() => viewer({ request: { origin: () => thumb as unknown as HTMLImageElement } })).not.toThrow();
  });
});

describe('Slide', () => {
  const base = { image: images[0]!, index: 0, left: 0, viewport: { width: 390, height: 844 }, failed: false, attempt: 0, first: true, onLoad: vi.fn(), onError: vi.fn(), onRetry: vi.fn() };

  it('places a picture with a size at its fit box', () => {
    const tree = Slide({ ...base, size: { width: 2048, height: 1024 } }) as Node;
    const img = only(tree, (node) => node.type === 'img');
    expect(img.props).toMatchObject({ src: '/v1/blob/blb_1', alt: 'Attached image 1', decoding: 'sync', 'data-loaded': 'true', draggable: false });
    expect(img.props.style).toEqual({ left: '0px', top: '324.5px', width: '390px', height: '195px' });
    expect(allNodes(tree).some((node) => node.props.class === 'iv-loading')).toBe(false);
    fire(img, 'onLoad', { currentTarget: 'element' });
    expect(base.onLoad).toHaveBeenCalledWith('element');
    fire(img, 'onError');
    expect(base.onError).toHaveBeenCalled();
  });

  it('a picture without a size waits, hidden, behind a spinner; a later try asks again past any cache', () => {
    const tree = Slide({ ...base, size: undefined, first: false, attempt: 2 }) as Node;
    const img = only(tree, (node) => node.type === 'img');
    expect(img.props).toMatchObject({ 'data-loaded': 'false', decoding: 'async', src: '/v1/blob/blb_1?try=2', style: undefined });
    expect(only(tree, (node) => node.props.class === 'iv-loading').props).toMatchObject({ role: 'status', 'aria-label': 'Loading image' });
  });

  it('a failed picture says so with Try again', () => {
    const tree = Slide({ ...base, size: undefined, failed: true }) as Node;
    const alert = only(tree, (node) => node.props.role === 'alert');
    expect(text(alert.props.children)).toContain(LOAD_FAILED);
    fire(only(tree, (node) => node.type === 'button'), 'onClick');
    expect(base.onRetry).toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('decodedSize reads a decoded image only', () => {
    expect(decodedSize(decodedThumb(4, 3))).toEqual({ width: 4, height: 3 });
    expect(decodedSize({ complete: false, naturalWidth: 4, naturalHeight: 3 })).toBeUndefined();
    expect(decodedSize({ complete: true, naturalWidth: 0, naturalHeight: 0 })).toBeUndefined();
    expect(decodedSize(null)).toBeUndefined();
  });

  it('retryUrl adds a try counter, but leaves local URLs alone', () => {
    expect(retryUrl('/v1/blob/blb_1', 1)).toBe('/v1/blob/blb_1?try=1');
    expect(retryUrl('/v1/file?path=a.png', 2)).toBe('/v1/file?path=a.png&try=2');
    expect(retryUrl('blob:http://x/1', 1)).toBe('blob:http://x/1');
    expect(retryUrl('data:image/png;base64,AA', 1)).toBe('data:image/png;base64,AA');
  });

  it('fetchFile names the file and gives up quietly', async () => {
    const ok: ShareTarget = { fetch: async () => ({ ok: true, blob: async () => new Blob(['x']) }) };
    const file = await fetchFile(ok, { src: '/a', alt: 'a', name: 'board.png' }, 0);
    expect(file).toMatchObject({ name: 'board.png', type: 'image/png' });
    expect(await fetchFile({ fetch: async () => ({ ok: false, blob: async () => new Blob() }) }, images[0]!, 0)).toBeNull();
    expect(await fetchFile({ fetch: () => Promise.reject(new Error('offline')) }, images[0]!, 0)).toBeNull();
  });
});
