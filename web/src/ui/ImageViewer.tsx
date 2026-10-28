// The in-app image viewer (docs/plan/file-viewer.md P1), a lazy chunk opened through image-viewer-launch.ts.
// A full-screen black layer (black in light and dark, like Photos) over the app: the picture grows out of the
// tapped thumbnail, pinch and double tap zoom (to 4x), one finger pans a zoomed picture, swipes between the
// message's pictures ("2 of 3" at the top) or drags down to shrink it back into its thumbnail. Close and Share
// at the top; Escape closes, the arrow keys step. The motion and gestures are in motion/viewer-motion.ts and
// their geometry in motion/zoom.ts; this file renders and wires the events.
//
// No layout shift: a picture is placed at its fit box, computed from its natural size. That size comes from the
// thumbnail (the same URL, already decoded) on the first frame, so the grow starts from the thumbnail's own
// pixels; a picture whose size is not known yet is hidden behind a spinner until it has loaded and then appears
// in its final box. A picture that fails says "Couldn't load this image" with Try again.
//
// Share hands the file to the system sheet (Save Image, Copy, AirDrop) through navigator.share; where that is
// missing or refused, it says to touch and hold the picture, which gives Safari's own Save menu.
// Styles: ImageViewer.css (in this chunk).
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { Icon } from './Icon';
import { shareName, type ViewerImage, type ViewerRequest } from './image-viewer-launch';
import { hapticTick } from './motion/haptic';
import { browserViewerEnv, SLIDE_GAP, ViewerMotion, type MotionElement, type Origin, type ViewerEnv } from './motion/viewer-motion';
import { fitRect, type Size } from './motion/zoom';
import './ImageViewer.css';

export interface ImageViewerProps {
  request: ViewerRequest;
  /** The close motion ended, showing picture `index`; the owner removes the viewer. */
  onClosed: (index: number) => void;
  /** Tests pass their own; the browser's by default. */
  env?: ViewerEnv;
  share?: ShareTarget;
}

/** The slice of `navigator` Share uses. */
export interface ShareTarget {
  share?: (data: { files: File[] }) => Promise<void>;
  canShare?: (data: { files: File[] }) => boolean;
  fetch: (url: string) => Promise<{ ok: boolean; blob(): Promise<Blob> }>;
}

/** What Share says when the system sheet is not available. */
export const SHARE_FALLBACK = 'Touch and hold the image to save it.';
export const LOAD_FAILED = "Couldn't load this image";

/** The natural size of a decoded `<img>`, if it has one. */
export function decodedSize(image: { complete: boolean; naturalWidth: number; naturalHeight: number } | null): Size | undefined {
  return image !== null && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : undefined;
}

export function ImageViewer({ request, onClosed, env, share }: ImageViewerProps) {
  const { images } = request;
  const [index, setIndex] = useState(request.index);
  const [chrome, setChrome] = useState(true);
  const [sizes, setSizes] = useState<(Size | undefined)[]>(() => images.map((_, i) => decodedSize(request.origin(i))));
  const [failed, setFailed] = useState<readonly number[]>([]);
  const [attempts, setAttempts] = useState<readonly number[]>(() => images.map(() => 0));
  const [viewport, setViewport] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [notice, setNotice] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const live = useRef({ sizes, onClosed });
  live.current = { sizes, onClosed };
  const shareTarget = share ?? browserShare();
  const files = useRef(new Map<string, Promise<File | null>>());

  const motion = useMemo(() => {
    const element = (selector: string) => (track.current?.querySelector(selector) ?? null) as MotionElement | null;
    return new ViewerMotion(
      {
        count: images.length,
        backdrop: () => backdrop.current,
        track: () => track.current,
        chrome: () => bar.current,
        slide: (i) => element(`.iv-slide[data-index="${i}"]`),
        image: (i) => element(`.iv-slide[data-index="${i}"] .iv-image`),
        size: (i) => live.current.sizes[i],
        origin: (i) => originOf(request.origin(i)),
        onIndex: setIndex,
        onTap: () => setChrome((shown) => !shown),
        onClosed: () => live.current.onClosed(motion.current),
      },
      env ?? browserViewerEnv(() => layer.current, () => hapticTick()),
      request.index,
    );
    // One controller for the viewer's life; the request does not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    motion.open();
    closeButton.current?.focus({ preventScroll: true });
    return () => motion.dispose();
  }, [motion]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (motion.key(event.key)) event.preventDefault();
    };
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      motion.resize();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [motion]);

  // The file behind the picture shown, fetched ahead, so Share can hand it over inside the tap.
  const fileOf = (i: number): Promise<File | null> => {
    const image = images[i]!;
    let file = files.current.get(image.src);
    if (file === undefined) {
      file = fetchFile(shareTarget, image, i);
      files.current.set(image.src, file);
    }
    return file;
  };
  useEffect(() => {
    if (shareTarget.share !== undefined) void fileOf(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const onShare = async () => {
    const file = await fileOf(index);
    const can = file !== null && shareTarget.share !== undefined && (shareTarget.canShare?.({ files: [file] }) ?? true);
    if (!can) {
      setNotice(SHARE_FALLBACK);
      return;
    }
    try {
      await shareTarget.share!({ files: [file!] });
    } catch (error) {
      // Closing the sheet without picking anything is no failure.
      if (!(error instanceof Error && error.name === 'AbortError')) setNotice(SHARE_FALLBACK);
    }
  };

  const loaded = (i: number, image: HTMLImageElement) => {
    const size = decodedSize(image);
    if (size === undefined) return;
    setSizes((all) => (all[i]?.width === size.width && all[i]?.height === size.height ? all : all.map((s, j) => (j === i ? size : s))));
  };
  const retry = (i: number) => {
    setFailed((all) => all.filter((j) => j !== i));
    setAttempts((all) => all.map((n, j) => (j === i ? n + 1 : n)));
  };

  const pointer = (handler: (event: PointerEvent) => void) => (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    // Buttons inside a slide (Try again) take their own taps.
    if ((event.target as Element | null)?.closest?.('button')) return;
    handler(event as unknown as PointerEvent);
  };
  const step = viewport.width + SLIDE_GAP;
  const shown = images.map((image, i) => ({ image, i })).filter(({ i }) => Math.abs(i - index) <= 1);

  return (
    <div ref={layer} class={chrome ? 'iv' : 'iv iv-bare'} role="dialog" aria-modal="true" aria-label={images.length > 1 ? `Image ${index + 1} of ${images.length}` : 'Image'}>
      <div ref={backdrop} class="iv-backdrop" aria-hidden="true" />
      <div
        class="iv-stage"
        onPointerDown={pointer((event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          try {
            (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
          } catch {
            // A pointer the browser no longer tracks; the moves still arrive while it stays over the layer.
          }
          motion.pointerDown(event.pointerId, event.clientX, event.clientY, event.timeStamp);
        })}
        onPointerMove={pointer((event) => motion.pointerMove(event.pointerId, event.clientX, event.clientY, event.timeStamp))}
        onPointerUp={pointer((event) => motion.pointerUp(event.pointerId, event.timeStamp))}
        onPointerCancel={pointer((event) => motion.pointerUp(event.pointerId, event.timeStamp, true))}
        onWheel={(event) => event.preventDefault()}
      >
        <div ref={track} class="iv-track">
          {shown.map(({ image, i }) => (
            <Slide
              key={i}
              image={image}
              index={i}
              left={i * step}
              viewport={viewport}
              size={sizes[i]}
              failed={failed.includes(i)}
              attempt={attempts[i] ?? 0}
              first={i === request.index}
              onLoad={(element) => loaded(i, element)}
              onError={() => setFailed((all) => (all.includes(i) ? all : [...all, i]))}
              onRetry={() => retry(i)}
            />
          ))}
        </div>
      </div>
      <div ref={bar} class="iv-chrome">
        <div class="iv-bar">
          <button ref={closeButton} type="button" class="iv-button" aria-label="Close" onClick={() => motion.close()}>
            <Icon name="x" size={22} />
          </button>
          {images.length > 1 ? (
            <p class="iv-count" aria-hidden="true">
              {index + 1} of {images.length}
            </p>
          ) : (
            <span />
          )}
          <button type="button" class="iv-button" aria-label="Share" onClick={() => void onShare()}>
            <Icon name="share" size={22} />
          </button>
        </div>
        {notice !== null && (
          <p class="iv-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

interface SlideProps {
  image: ViewerImage;
  index: number;
  left: number;
  viewport: Size;
  size: Size | undefined;
  failed: boolean;
  attempt: number;
  /** The tapped picture: decoded at once, so the first frame already has it. */
  first: boolean;
  onLoad: (image: HTMLImageElement) => void;
  onError: () => void;
  onRetry: () => void;
}

export function Slide({ image, index, left, viewport, size, failed, attempt, first, onLoad, onError, onRetry }: SlideProps) {
  const fit = size === undefined ? undefined : fitRect(size, viewport);
  return (
    <div class="iv-slide" data-index={index} style={{ left: `${left}px`, width: `${viewport.width}px`, height: `${viewport.height}px` }}>
      {failed ? (
        <div class="iv-failed" role="alert">
          <Icon name="image" size={28} />
          <p>{LOAD_FAILED}</p>
          <button type="button" class="iv-retry" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {fit === undefined && (
            <span class="iv-loading" role="status" aria-label="Loading image">
              <Icon name="spinner" size={24} class="iv-spin" />
            </span>
          )}
          <img
            key={attempt}
            class="iv-image"
            src={attempt === 0 ? image.src : retryUrl(image.src, attempt)}
            alt={image.alt}
            draggable={false}
            decoding={first ? 'sync' : 'async'}
            data-loaded={fit !== undefined ? 'true' : 'false'}
            style={fit === undefined ? undefined : { left: `${fit.left}px`, top: `${fit.top}px`, width: `${fit.width}px`, height: `${fit.height}px` }}
            onLoad={(event) => onLoad(event.currentTarget)}
            onError={onError}
          />
        </>
      )}
    </div>
  );
}

/** A URL for another try that no cache answers with the failure (local `blob:` URLs are left alone). */
export function retryUrl(src: string, attempt: number): string {
  if (src.startsWith('blob:') || src.startsWith('data:')) return src;
  return `${src}${src.includes('?') ? '&' : '?'}try=${attempt}`;
}

/** The thumbnail's box and corner radius, for the grow and the shrink. */
function originOf(image: HTMLImageElement | null): Origin | null {
  if (image === null || !image.isConnected) return null;
  const rect = image.getBoundingClientRect();
  const radius = Number.parseFloat(getComputedStyle(image).borderTopLeftRadius) || 0;
  return { element: image, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, radius };
}

function browserShare(): ShareTarget {
  const nav = navigator as Navigator & Partial<Pick<ShareTarget, 'share' | 'canShare'>>;
  return {
    share: typeof nav.share === 'function' ? (data) => nav.share!(data) : undefined,
    canShare: typeof nav.canShare === 'function' ? (data) => nav.canShare!(data) : undefined,
    fetch: (url) => window.fetch(url, { credentials: 'same-origin' }),
  };
}

/** The picture as a File for the share sheet; null when it cannot be fetched. */
export async function fetchFile(target: ShareTarget, image: ViewerImage, index: number): Promise<File | null> {
  try {
    const response = await target.fetch(image.src);
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], shareName(image, blob.type, index), { type: blob.type || 'image/png' });
  } catch {
    return null;
  }
}
