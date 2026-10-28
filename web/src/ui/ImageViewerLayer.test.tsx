import type { ComponentType } from 'preact';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import type { Node } from '../../test/vnode';
import { ImageViewerLauncher, type ViewerRequest } from './image-viewer-launch';
import type { ImageViewerProps } from './ImageViewer';
import { focusThumbnail, ImageViewerLayer } from './ImageViewerLayer';

vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);

const FakeViewer: ComponentType<ImageViewerProps> = () => null;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function request(origin: ViewerRequest['origin'] = () => null): ViewerRequest {
  return { images: [{ src: '/v1/blob/blb_1', alt: 'Attached image 1' }, { src: '/v1/blob/blb_2', alt: 'Attached image 2' }], index: 0, origin };
}

describe('ImageViewerLayer', () => {
  it('shows nothing until a request comes, then loads the chunk once and shows the viewer', async () => {
    const launcher = new ImageViewerLauncher();
    const load = vi.fn(async () => ({ ImageViewer: FakeViewer }));
    const host = renderHook(() => ImageViewerLayer({ launcher, load }) as Node | null);
    expect(host.value).toBeNull();
    expect(load).not.toHaveBeenCalled();

    const focus = vi.fn();
    launcher.open(request((i) => (i === 1 ? ({ closest: () => ({ focus }) } as unknown as HTMLImageElement) : null)));
    expect(host.value).toBeNull(); // the chunk is on its way
    await flush();
    const shown = host.value!;
    expect(shown.type).toBe(FakeViewer);
    expect((shown.props as unknown as ImageViewerProps).request.images).toHaveLength(2);

    // Closed showing picture 2: the request goes, the focus returns to that thumbnail's button.
    (shown.props as unknown as ImageViewerProps).onClosed(1);
    expect(launcher.current).toBeNull();
    expect(host.value).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    // A second open uses the loaded chunk, under a new key.
    launcher.open(request());
    expect(host.value!.type).toBe(FakeViewer);
    expect(host.value!.key).not.toBe(shown.key);
    expect(load).toHaveBeenCalledTimes(1);
    host.unmount();
  });

  it('a request already open when it mounts is shown', async () => {
    const launcher = new ImageViewerLauncher();
    launcher.open(request());
    const host = renderHook(() => ImageViewerLayer({ launcher, load: async () => ({ ImageViewer: FakeViewer }) }) as Node | null);
    await flush();
    expect(host.value!.type).toBe(FakeViewer);
  });

  it('a chunk that does not load closes the request, so the next tap tries again', async () => {
    const launcher = new ImageViewerLauncher();
    renderHook(() => ImageViewerLayer({ launcher, load: () => Promise.reject(new Error('offline')) }));
    launcher.open(request());
    await flush();
    expect(launcher.current).toBeNull();
  });

  it('a load that ends after unmounting changes nothing', async () => {
    const launcher = new ImageViewerLauncher();
    let finish!: (value: { ImageViewer: ComponentType<ImageViewerProps> }) => void;
    let fail!: (error: Error) => void;
    const host = renderHook(() =>
      ImageViewerLayer({
        launcher,
        load: () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      }),
    );
    launcher.open(request());
    host.unmount();
    finish({ ImageViewer: FakeViewer });
    fail(new Error('late'));
    await flush();
    expect(launcher.current).not.toBeNull();
  });
});

describe('focusThumbnail', () => {
  it('focuses the button around the thumbnail, if there is one', () => {
    const focus = vi.fn();
    focusThumbnail({ closest: () => ({ focus }) });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(() => focusThumbnail(null)).not.toThrow();
    expect(() => focusThumbnail({ closest: () => null })).not.toThrow();
  });
});
