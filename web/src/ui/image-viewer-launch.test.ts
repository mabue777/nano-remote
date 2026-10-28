import { describe, expect, it, vi } from 'vitest';

import { ImageViewerLauncher, once, preloadImageViewer, shareName, type ViewerRequest } from './image-viewer-launch';

const request = (count: number, index: number): ViewerRequest => ({
  images: Array.from({ length: count }, (_, i) => ({ src: `/v1/blob/blb_${i}`, alt: `Attached image ${i + 1}` })),
  index,
  origin: () => null,
});

describe('ImageViewerLauncher', () => {
  it('tells its listeners about an open and a close, with the index held inside the pictures', () => {
    const launcher = new ImageViewerLauncher();
    const seen: (number | null)[] = [];
    const stop = launcher.subscribe((r) => seen.push(r === null ? null : r.index));
    launcher.open(request(3, 7));
    expect(launcher.current?.index).toBe(2);
    launcher.open(request(3, -1));
    launcher.closed();
    expect(launcher.current).toBeNull();
    stop();
    launcher.open(request(1, 0));
    expect(seen).toEqual([2, 0, null]);
  });

  it('ignores a request without pictures', () => {
    const launcher = new ImageViewerLauncher();
    launcher.open(request(0, 0));
    expect(launcher.current).toBeNull();
  });
});

describe('once and preload', () => {
  it('loads once, and again after a failure', async () => {
    let calls = 0;
    const load = once(async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return 'chunk';
    });
    await expect(load()).rejects.toThrow('offline');
    expect(await load()).toBe('chunk');
    expect(await load()).toBe('chunk');
    expect(calls).toBe(2);
  });

  it('preload swallows a failed load', async () => {
    const load = vi.fn(() => Promise.reject(new Error('offline')));
    preloadImageViewer(load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('shareName', () => {
  it('keeps a given name and otherwise names the file from its type', () => {
    expect(shareName({ src: 'x', alt: 'a', name: 'whiteboard.png' }, 'image/png', 0)).toBe('whiteboard.png');
    expect(shareName({ src: 'x', alt: 'a', name: '' }, 'image/jpeg', 1)).toBe('image-2.jpg');
    expect(shareName({ src: 'x', alt: 'a' }, 'image/svg+xml', 0)).toBe('image-1.svg');
    expect(shareName({ src: 'x', alt: 'a' }, 'image/webp', 2)).toBe('image-3.webp');
    expect(shareName({ src: 'x', alt: 'a' }, '', 0)).toBe('image-1.png');
  });
});
