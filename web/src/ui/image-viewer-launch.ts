// Opening the image viewer (ui/ImageViewer.tsx) from anywhere: a sent message's thumbnails, a steer's, the
// composer tray. This file is in the main bundle and stays small; the viewer itself is a lazy chunk, loaded
// the first time a thumbnail is shown (preload) so the first tap does not wait for it. ImageViewerLayer.tsx
// (mounted once, beside the app) listens here and shows the viewer.

/** One picture the viewer can show. */
export interface ViewerImage {
  /** Its URL (`/v1/blob/<id>` or a local `blob:` preview); the thumbnail shows the same URL. */
  src: string;
  /** Its text alternative, e.g. "Attached image 2". */
  alt: string;
  /** The file name Share offers; made up from the media type when missing. */
  name?: string;
}

export interface ViewerRequest {
  images: readonly ViewerImage[];
  /** The picture tapped. */
  index: number;
  /** The thumbnail `<img>` of picture `index`, if it is still on the page (grow from it, shrink back into it). */
  origin(index: number): HTMLImageElement | null;
}

type Listener = (request: ViewerRequest | null) => void;

/** The open request, if any, and who listens. One per app. */
export class ImageViewerLauncher {
  private request: ViewerRequest | null = null;
  private readonly listeners = new Set<Listener>();

  get current(): ViewerRequest | null {
    return this.request;
  }

  /** Shows the viewer at `request.index`; a request with no pictures is ignored. */
  open(request: ViewerRequest): void {
    if (request.images.length === 0) return;
    const index = Math.max(0, Math.min(request.images.length - 1, request.index));
    this.set({ ...request, index });
  }

  /** The viewer finished closing. */
  closed(): void {
    this.set(null);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(request: ViewerRequest | null): void {
    this.request = request;
    for (const listener of this.listeners) listener(request);
  }
}

export const imageViewer = new ImageViewerLauncher();

type Loader<T> = () => Promise<T>;

/** Loads once and hands every later caller the same promise; a failed load is tried again next time. */
export function once<T>(load: Loader<T>): Loader<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/** The viewer's chunk (its component and styles). */
export const loadImageViewer = once(() => import('./ImageViewer'));

/** Starts loading the chunk without waiting for it (a thumbnail is on screen). */
export function preloadImageViewer(load: Loader<unknown> = loadImageViewer): void {
  load().catch(() => undefined);
}

/** A file name for Share: the given one, or "image.<ext>" from the media type. */
export function shareName(image: ViewerImage, mediaType: string, index: number): string {
  if (image.name !== undefined && image.name !== '') return image.name;
  const subtype = /^image\/([a-z0-9.+-]+)/i.exec(mediaType)?.[1]?.toLowerCase();
  const ext = subtype === undefined ? 'png' : subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype;
  return `image-${index + 1}.${ext}`;
}
