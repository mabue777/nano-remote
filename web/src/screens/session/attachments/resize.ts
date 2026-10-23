// Photos are downscaled on the phone before they are uploaded (spec 8.1): at most 2048 px on the long
// edge. JPEG stays JPEG and PNG stays PNG; any other image the browser can decode (HEIC, WebP, GIF) becomes
// a JPEG, because every agent's image input takes JPEG. Re-encoding also drops the photo's metadata (EXIF,
// location). A PNG already small enough is sent as it is (screenshots stay lossless). An image the browser
// cannot decode is not an image to the app: it goes as a file.
//
// The browser parts (createImageBitmap, a canvas) are injected, so the rules are tested without a DOM.

/** Longest edge of an uploaded photo, in pixels. */
export const MAX_IMAGE_EDGE = 2048;

/** JPEG quality of re-encoded photos. */
export const JPEG_QUALITY = 0.9;

/** The size an image of `width` x `height` gets so that neither edge exceeds `max` (never upscaled). */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The type an image is uploaded as: PNG stays PNG, everything else becomes JPEG. */
export function outputType(type: string): 'image/png' | 'image/jpeg' {
  return type.toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg';
}

/** `IMG_0001.HEIC` -> `IMG_0001.jpg` when the type changed; the name stays otherwise. */
export function renamed(name: string, from: string, to: string): string {
  if (from.toLowerCase() === to || (from.toLowerCase() === 'image/jpg' && to === 'image/jpeg')) return name;
  const extension = to === 'image/png' ? '.png' : '.jpg';
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}${extension}`;
}

/** A decoded image the canvas can draw. */
export interface Decoded {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

export interface ResizeDeps {
  /** createImageBitmap with the photo's orientation applied; rejects when the browser cannot decode it. */
  decode: (blob: Blob) => Promise<Decoded>;
  /** Draws the image at width x height and encodes it as `type`. */
  encode: (image: Decoded, width: number, height: number, type: string, quality: number) => Promise<Blob>;
}

/** What the composer uploads for a picked image. */
export interface PreparedImage {
  blob: Blob;
  name: string;
  type: string;
  width: number;
  height: number;
}

/**
 * Prepares a picked image for upload; undefined when the browser cannot decode it (the caller sends it as
 * a file).
 */
export async function prepareImage(file: Blob & { name: string }, deps: ResizeDeps): Promise<PreparedImage | undefined> {
  let image: Decoded;
  try {
    image = await deps.decode(file);
  } catch {
    return undefined;
  }
  try {
    const size = fitWithin(image.width, image.height);
    const type = outputType(file.type);
    const unchanged = size.width === image.width && size.height === image.height;
    if (unchanged && file.type.toLowerCase() === 'image/png') {
      return { blob: file, name: file.name, type, ...size };
    }
    const blob = await deps.encode(image, size.width, size.height, type, JPEG_QUALITY);
    return { blob, name: renamed(file.name, file.type, type), type, ...size };
  } finally {
    image.close?.();
  }
}

/** The browser's decoder and canvas (not unit-tested: the Playwright smoke uploads a large PNG through them). */
export const browserResize: ResizeDeps = {
  decode: (blob) => createImageBitmap(blob, { imageOrientation: 'from-image' }),
  encode: (image, width, height, type, quality) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return Promise.reject(new Error('no 2d canvas'));
    context.drawImage(image as ImageBitmap, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob === null ? reject(new Error('the image could not be encoded')) : resolve(blob)), type, quality),
    );
  },
};
