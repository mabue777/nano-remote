// Where the image viewer appears: mounted once beside the app (main.tsx, its own root on document.body, so no
// page's transform or stacking holds it). It listens to the launcher (image-viewer-launch.ts), loads the
// viewer's lazy chunk on the first open, and on close gives the focus back to the thumbnail it shrank into.
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { imageViewer, loadImageViewer, type ImageViewerLauncher, type ViewerRequest } from './image-viewer-launch';
import type { ImageViewerProps } from './ImageViewer';

export interface ImageViewerLayerProps {
  launcher?: ImageViewerLauncher;
  load?: () => Promise<{ ImageViewer: ComponentType<ImageViewerProps> }>;
}

interface Shown {
  request: ViewerRequest;
  /** A new key per open, so a second open starts fresh. */
  key: number;
}

let opens = 0;

export function ImageViewerLayer({ launcher = imageViewer, load = loadImageViewer }: ImageViewerLayerProps) {
  const [shown, setShown] = useState<Shown | null>(() => (launcher.current === null ? null : { request: launcher.current, key: ++opens }));
  const [Viewer, setViewer] = useState<ComponentType<ImageViewerProps> | null>(null);
  useEffect(() => launcher.subscribe((request) => setShown(request === null ? null : { request, key: ++opens })), [launcher]);
  useEffect(() => {
    if (shown === null || Viewer !== null) return;
    let live = true;
    load().then(
      (module) => live && setViewer(() => module.ImageViewer),
      // The chunk did not load (offline after an update): nothing opens, and the next tap tries again.
      () => live && launcher.closed(),
    );
    return () => {
      live = false;
    };
  }, [shown, Viewer, load, launcher]);
  if (shown === null || Viewer === null) return null;
  const { request } = shown;
  return (
    <Viewer
      key={shown.key}
      request={request}
      onClosed={(index) => {
        launcher.closed();
        focusThumbnail(request.origin(index));
      }}
    />
  );
}

/** Focus back on the thumbnail's button (keyboard and screen-reader users land where they were). */
export function focusThumbnail(image: { closest(selector: string): { focus(options?: FocusOptions): void } | null } | null): void {
  image?.closest('button')?.focus({ preventScroll: true });
}
