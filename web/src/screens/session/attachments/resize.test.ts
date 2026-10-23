import { describe, expect, it } from 'vitest';

import { fakeResize, picked } from '../../../../test/attachment-doubles';
import { JPEG_QUALITY, MAX_IMAGE_EDGE, fitWithin, outputType, prepareImage, renamed } from './resize';

describe('photo downscaling (spec 8.1)', () => {
  it('fitWithin caps the long edge at 2048 px, keeps the aspect ratio, never upscales', () => {
    expect(MAX_IMAGE_EDGE).toBe(2048);
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(fitWithin(2048, 2048)).toEqual({ width: 2048, height: 2048 });
    expect(fitWithin(100_000, 1)).toEqual({ width: 2048, height: 1 });
  });

  it('PNG stays PNG; JPEG and everything else become JPEG; names follow the type', () => {
    expect(outputType('image/png')).toBe('image/png');
    expect(outputType('IMAGE/PNG')).toBe('image/png');
    expect(outputType('image/jpeg')).toBe('image/jpeg');
    expect(outputType('image/heic')).toBe('image/jpeg');
    expect(renamed('IMG_0001.HEIC', 'image/heic', 'image/jpeg')).toBe('IMG_0001.jpg');
    expect(renamed('photo.jpg', 'image/jpeg', 'image/jpeg')).toBe('photo.jpg');
    expect(renamed('photo.jpg', 'image/jpg', 'image/jpeg')).toBe('photo.jpg');
    expect(renamed('noext', 'image/webp', 'image/jpeg')).toBe('noext.jpg');
    expect(renamed('anim.gif', 'image/gif', 'image/png')).toBe('anim.png');
  });

  it('a large JPEG is re-encoded at 2048 px as JPEG; the decoded image is released', async () => {
    const resize = fakeResize();
    const prepared = await prepareImage(picked('IMG@4032x3024.jpg', 'image/jpeg'), resize.deps);
    expect(prepared).toMatchObject({ name: 'IMG@4032x3024.jpg', type: 'image/jpeg', width: 2048, height: 1536 });
    expect(prepared!.blob.size).toBe(1000);
    expect(resize.calls).toEqual([{ width: 2048, height: 1536, type: 'image/jpeg', quality: JPEG_QUALITY }]);
    expect(resize.closed).toHaveLength(1);
  });

  it('a small JPEG is re-encoded too (its metadata goes); a small PNG is sent as it is', async () => {
    const resize = fakeResize();
    expect(await prepareImage(picked('a@800x600.jpg', 'image/jpeg'), resize.deps)).toMatchObject({ width: 800, height: 600, type: 'image/jpeg' });
    const png = picked('shot@1170x2532.png', 'image/png', 77);
    const large = await prepareImage(png, resize.deps);
    expect(large).toMatchObject({ type: 'image/png', width: 946, height: 2048 });
    const small = picked('shot@300x200.png', 'image/png', 77);
    const kept = await prepareImage(small, resize.deps);
    expect(kept).toEqual({ blob: small, name: 'shot@300x200.png', type: 'image/png', width: 300, height: 200 });
    expect(resize.calls.map((c) => c.type)).toEqual(['image/jpeg', 'image/png']);
  });

  it('a HEIC becomes a .jpg JPEG; an image the browser cannot decode is no image (undefined)', async () => {
    const resize = fakeResize();
    expect(await prepareImage(picked('IMG_1@3000x4000.HEIC', 'image/heic'), resize.deps)).toMatchObject({ name: 'IMG_1@3000x4000.jpg', type: 'image/jpeg' });
    expect(await prepareImage(picked('broken.heic', 'image/heic'), resize.deps)).toBeUndefined();
  });

  it('an encoding failure rejects and still releases the decoded image', async () => {
    const resize = fakeResize({ failEncode: true });
    await expect(prepareImage(picked('a@4000x10.jpg', 'image/jpeg'), resize.deps)).rejects.toThrow(/no 2d canvas/);
    expect(resize.closed).toHaveLength(1);
  });
});
