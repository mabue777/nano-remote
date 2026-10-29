import { describe, expect, it, vi } from 'vitest';

import { FakeUploader, fakeObjectUrls, fakeResize, picked } from '../../../../test/attachment-doubles';
import { settle } from '../../../../test/replica-doubles';
import { ComposerAttachments, MAX_ATTACHMENTS, type AttachmentRules, type MarkedPhoto, type Markup } from './composer';
import type { PreparedImage } from './resize';

const RULES: AttachmentRules = { images: true, files: true, maxBytes: 20 * 1024 * 1024 };

function rig(options: { encodedBytes?: number; failEncode?: boolean } = {}) {
  const uploader = new FakeUploader();
  const resize = fakeResize(options);
  const urls = fakeObjectUrls();
  const onChange = vi.fn();
  const tray = new ComposerAttachments({ sessionId: 'ses_1', uploader: uploader.upload, resize: resize.deps, objectUrls: urls.urls, onChange });
  return { tray, uploader, resize, urls, onChange };
}

describe('ComposerAttachments (spec 8.1)', () => {
  it('a photo is prepared, previewed, uploaded with progress, then ready as an image part', async () => {
    const { tray, uploader, urls, onChange } = rig();
    tray.add([picked('IMG@4032x3024.jpg', 'image/jpeg', 3_000_000)], RULES);
    expect(tray.entries[0]).toMatchObject({ kind: 'image', state: 'preparing', progress: 0 });
    expect(tray.busy).toBe(true);
    expect(tray.ready).toBe(false);
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'uploading', previewUrl: 'blob:preview-1', size: 1000, mediaType: 'image/jpeg' });
    expect(uploader.last).toMatchObject({ sessionId: 'ses_1', name: 'IMG@4032x3024.jpg', type: 'image/jpeg', size: 1000 });
    uploader.last.progress(0.5);
    expect(tray.entries[0]!.progress).toBe(0.5);
    uploader.last.resolve();
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'ready', progress: 1 });
    expect(tray.ready).toBe(true);
    expect(tray.busy).toBe(false);
    expect(tray.parts()).toEqual([{ type: 'image', url: `/v1/blob/blb_${'1'.padStart(22, '0')}` }]);
    expect(urls.created).toEqual(['blob:preview-1']);
    expect(onChange).toHaveBeenCalled();
  });

  it('a file uploads as it is and becomes a file part with the host name and type', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('report.pdf', 'application/pdf', 500)], RULES);
    expect(tray.entries[0]).toMatchObject({ kind: 'file', state: 'uploading' });
    expect(uploader.last).toMatchObject({ name: 'report.pdf', type: 'application/pdf', size: 500 });
    uploader.last.resolve({ name: 'report.pdf', mediaType: 'application/pdf' });
    await settle();
    expect(tray.parts()).toEqual([{ type: 'file', url: `/v1/blob/blb_${'1'.padStart(22, '0')}`, name: 'report.pdf', mediaType: 'application/pdf' }]);
    tray.add([picked('blob', '', 1)], RULES);
    expect(tray.entries[1]).toMatchObject({ kind: 'file', mediaType: 'application/octet-stream' });
  });

  it('refuses up front: more than ten, files for an images-only agent, a file over the limit', () => {
    const { tray, uploader } = rig();
    tray.add(Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => picked(`f${i}.txt`, 'text/plain')), RULES);
    expect(tray.entries).toHaveLength(MAX_ATTACHMENTS);
    expect(tray.notice).toBe('At most 10 attachments go with one message.');
    tray.clear();
    tray.add([picked('a.txt', 'text/plain')], { ...RULES, files: false });
    expect(tray.entries).toEqual([]);
    expect(tray.notice).toBe('This agent takes images only; a.txt was not added.');
    tray.add([picked('big.zip', 'application/zip', 30)], { ...RULES, maxBytes: 20 });
    expect(tray.notice).toBe('big.zip is larger than 0 MB.');
    expect(uploader.uploads).toHaveLength(MAX_ATTACHMENTS);
  });

  it('remove aborts a running upload and frees the thumbnail; removing twice is harmless', async () => {
    const { tray, uploader, urls } = rig();
    tray.add([picked('a@100x100.png', 'image/png')], RULES);
    await settle();
    const id = tray.entries[0]!.id;
    tray.remove(id);
    expect(uploader.last.aborted).toBe(true);
    expect(urls.revoked).toEqual(['blob:preview-1']);
    expect(tray.entries).toEqual([]);
    tray.remove(id);
    await settle();
    expect(tray.failed).toBe(false);
  });

  it('a removed photo still being prepared never uploads', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('a@100x100.png', 'image/png')], RULES);
    tray.remove(tray.entries[0]!.id);
    await settle();
    expect(uploader.uploads).toEqual([]);
  });

  it('a failed upload shows its sentence and can be retried', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('a.txt', 'text/plain')], RULES);
    uploader.last.reject('Upload failed: the host did not answer.');
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'failed', error: 'Upload failed: the host did not answer.' });
    expect(tray.failed).toBe(true);
    tray.retry(tray.entries[0]!.id, RULES);
    expect(tray.entries[0]).toMatchObject({ state: 'uploading', progress: 0 });
    expect(tray.entries[0]!.error).toBeUndefined();
    expect(uploader.uploads).toHaveLength(2);
    uploader.last.resolve();
    await settle();
    expect(tray.ready).toBe(true);
    tray.retry(tray.entries[0]!.id, RULES); // not failed: nothing
    tray.retry('att-none', RULES);
    expect(uploader.uploads).toHaveLength(2);
  });

  it('a photo the browser cannot read goes as a file, or fails for an images-only agent', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('IMG.heic', 'image/heic', 50)], RULES);
    await settle();
    expect(tray.entries[0]).toMatchObject({ kind: 'file', state: 'uploading' });
    expect(uploader.last).toMatchObject({ name: 'IMG.heic', type: 'image/heic', size: 50 });
    tray.add([picked('IMG2.heic', 'image/heic', 50)], { ...RULES, files: false });
    await settle();
    expect(tray.entries[1]).toMatchObject({ state: 'failed', error: 'This image cannot be read on this phone.' });
    // Retrying an image that never got a preview prepares it again.
    tray.retry(tray.entries[1]!.id, { ...RULES, files: false });
    expect(tray.entries[1]!.state).toBe('preparing');
  });

  it('a photo still too large after downscaling, or one that cannot be encoded, fails', async () => {
    const big = rig({ encodedBytes: 50 });
    big.tray.add([picked('a@3000x3000.jpg', 'image/jpeg')], { ...RULES, maxBytes: 20 });
    await settle();
    expect(big.tray.entries[0]).toMatchObject({ state: 'failed', error: 'a@3000x3000.jpg is larger than 0 MB.' });
    expect(big.uploader.uploads).toEqual([]);
    const broken = rig({ failEncode: true });
    broken.tray.add([picked('a@3000x3000.jpg', 'image/jpeg')], RULES);
    await settle();
    expect(broken.tray.entries[0]).toMatchObject({ state: 'failed', error: 'The image could not be prepared: no 2d canvas' });
  });

  it('clear aborts every upload and frees every thumbnail; results arriving later are ignored', async () => {
    const { tray, uploader, urls } = rig();
    tray.add([picked('a@10x10.png', 'image/png'), picked('b.txt', 'text/plain')], RULES);
    await settle();
    const [photo, file] = uploader.uploads;
    tray.clear();
    expect(photo!.aborted && file!.aborted).toBe(true);
    expect(urls.revoked).toEqual(['blob:preview-1']);
    expect(tray.entries).toEqual([]);
    expect(tray.parts()).toEqual([]);
  });

  it('a late answer or progress for a removed entry changes nothing', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('b.txt', 'text/plain')], RULES);
    const upload = uploader.last;
    // Removing without the abort reaching the upload (the request already finished on the wire).
    tray.entries = [];
    upload.progress(0.7);
    upload.resolve();
    await settle();
    const other = rig();
    other.tray.add([picked('c.txt', 'text/plain')], RULES);
    const failing = other.uploader.last;
    other.tray.entries = [];
    failing.reject('late');
    await settle();
    expect(tray.entries).toEqual([]);
    expect(other.tray.entries).toEqual([]);
  });
});

describe('ComposerAttachments: a marked photo (image markup, ticket 4)', () => {
  const marked = (bytes = 2000): PreparedImage => ({ blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name: 'shot.png', type: 'image/png', width: 100, height: 100 });
  const markup = (comments: string[]): Markup => ({
    marks: comments.map((comment, i) => ({ kind: 'pin', id: `p${i}`, x: 1, y: 1, comment })),
    comments: comments.length,
    lines: (index, count) => [`Marks on image ${index} of ${count}:`, ...comments.map((c, i) => `${i + 1}. ${c}`)],
  });
  const done = (image: PreparedImage, record: Markup): Promise<MarkedPhoto> => Promise.resolve({ image, markup: record });

  it('Done while the first upload runs: it is aborted, the entry waits for the marked picture, which then goes up', async () => {
    const { tray, uploader, urls } = rig();
    tray.add([picked('shot@100x100.png', 'image/png')], RULES);
    await settle();
    const id = tray.entries[0]!.id;
    const first = uploader.last;
    expect(tray.original(id)).toMatchObject({ url: 'blob:preview-1', image: { name: 'shot@100x100.png', width: 100 } });
    let draw!: (value: MarkedPhoto) => void;
    tray.replace(id, new Promise((resolve) => (draw = resolve)), RULES);
    expect(first.aborted).toBe(true);
    // Until the marks are drawn the entry is busy, so Send cannot take the unmarked picture.
    expect(tray.entries[0]).toMatchObject({ state: 'preparing', previewUrl: 'blob:preview-1' });
    expect(tray.busy).toBe(true);
    first.resolve(); // a late answer of the replaced upload changes nothing
    await settle();
    expect(tray.entries[0]!.state).toBe('preparing');
    draw({ image: marked(), markup: markup(['too tight']) });
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'uploading', progress: 0, previewUrl: 'blob:preview-2', size: 2000, markup: { comments: 1 } });
    expect(uploader.last).toMatchObject({ name: 'shot.png', type: 'image/png', size: 2000 });
    expect(urls.revoked).toEqual([]);
    uploader.last.progress(0.4);
    expect(tray.entries[0]!.progress).toBe(0.4);
    uploader.last.resolve();
    await settle();
    expect(tray.parts()).toEqual([{ type: 'image', url: `/v1/blob/blb_${'2'.padStart(22, '0')}` }]);
    expect(tray.notes()).toBe('Marks on image 1 of 1:\n1. too tight');
  });

  it('marking again replaces the marked picture; Done without marks puts the original back', async () => {
    const { tray, uploader, urls } = rig();
    tray.add([picked('shot@100x100.png', 'image/png')], RULES);
    await settle();
    const id = tray.entries[0]!.id;
    uploader.last.resolve();
    await settle();
    tray.replace(id, undefined, RULES); // an unmarked photo left unmarked: nothing to do
    expect(uploader.uploads).toHaveLength(1);
    expect(tray.entries[0]!.state).toBe('ready');
    tray.replace(id, done(marked(), markup(['a'])), RULES);
    expect(tray.entries[0]!.uploaded).toBeUndefined();
    expect(tray.ready).toBe(false);
    await settle();
    tray.replace(id, done(marked(3000), markup(['a', 'b'])), RULES);
    await settle();
    expect(urls.revoked).toEqual(['blob:preview-2']);
    expect(tray.entries[0]).toMatchObject({ previewUrl: 'blob:preview-3', size: 3000, markup: { comments: 2 } });
    tray.replace(id, undefined, RULES);
    await settle();
    expect(urls.revoked).toEqual(['blob:preview-2', 'blob:preview-3']);
    expect(tray.entries[0]).toMatchObject({ previewUrl: 'blob:preview-1', size: 10, name: 'shot@100x100.png' });
    expect(tray.entries[0]!.markup).toBeUndefined();
    expect(uploader.last).toMatchObject({ name: 'shot@100x100.png', size: 10 });
    uploader.last.resolve();
    await settle();
    expect(tray.notes()).toBe('');
    tray.remove(id);
    expect(urls.revoked).toEqual(['blob:preview-2', 'blob:preview-3', 'blob:preview-1']);
  });

  it('a failed replacement retries the marked picture; one too large fails at once; marks that cannot be drawn fail', async () => {
    const { tray, uploader, resize } = rig();
    tray.add([picked('shot@100x100.png', 'image/png')], RULES);
    await settle();
    const id = tray.entries[0]!.id;
    tray.replace(id, done(marked(), markup(['x'])), RULES);
    await settle();
    uploader.last.reject('Upload failed: the host did not answer.');
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'failed', error: 'Upload failed: the host did not answer.' });
    tray.retry(id, RULES);
    expect(tray.entries[0]).toMatchObject({ state: 'uploading' });
    expect(uploader.last).toMatchObject({ name: 'shot.png', size: 2000 });
    expect(resize.calls).toEqual([]); // not prepared again
    tray.replace(id, done(marked(50), markup(['x'])), { ...RULES, maxBytes: 20 });
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'failed', error: 'shot.png is larger than 0 MB.' });
    expect(uploader.uploads).toHaveLength(3);
    tray.replace(id, Promise.reject(new Error('no 2d canvas')), RULES);
    await settle();
    expect(tray.entries[0]).toMatchObject({ state: 'failed', error: 'The marks could not be added: no 2d canvas' });
  });

  it('a newer Done or a remove makes a pending one stale', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('shot@100x100.png', 'image/png')], RULES);
    await settle();
    const id = tray.entries[0]!.id;
    let slow!: (value: MarkedPhoto) => void;
    tray.replace(id, new Promise((resolve) => (slow = resolve)), RULES);
    tray.replace(id, done(marked(3000), markup(['new'])), RULES);
    await settle();
    slow({ image: marked(1), markup: markup(['old']) });
    await settle();
    expect(tray.entries[0]).toMatchObject({ size: 3000, markup: { comments: 1 } });
    expect(tray.entries[0]!.markup!.lines(1, 1)).toEqual(['Marks on image 1 of 1:', '1. new']);
    const uploads = uploader.uploads.length;
    let late!: (value: MarkedPhoto) => void;
    tray.replace(id, new Promise((resolve) => (late = resolve)), RULES);
    tray.remove(id);
    late({ image: marked(), markup: markup(['x']) });
    await settle();
    expect(uploader.uploads).toHaveLength(uploads);
  });

  it('notes count the images in send order and skip files and photos without comments', async () => {
    const { tray, uploader } = rig();
    tray.add([picked('a@10x10.png', 'image/png'), picked('b.txt', 'text/plain'), picked('c@10x10.png', 'image/png'), picked('d@10x10.png', 'image/png')], RULES);
    await settle();
    const [a, , c, d] = tray.entries.map((e) => e.id);
    tray.replace(a!, done(marked(), markup(['first'])), RULES);
    tray.replace(c!, done(marked(), { marks: [{ kind: 'pen', id: 'm', color: 'red', points: [] }], comments: 0, lines: () => [] }), RULES);
    tray.replace(d!, done(marked(), markup(['third'])), RULES);
    await settle();
    expect(tray.notes()).toBe(''); // nothing ready yet
    for (const upload of uploader.uploads) if (!upload.aborted) upload.resolve();
    await settle();
    expect(tray.ready).toBe(true);
    expect(tray.notes()).toBe('Marks on image 1 of 3:\n1. first\n\nMarks on image 3 of 3:\n1. third');
    expect(tray.original(tray.entries[1]!.id)).toBeUndefined(); // a file is not markable
  });

  it('a photo the browser cannot read is not markable', async () => {
    const { tray } = rig();
    tray.add([picked('IMG.heic', 'image/heic', 50)], RULES);
    await settle();
    const id = tray.entries[0]!.id;
    expect(tray.original(id)).toBeUndefined();
    tray.replace(id, done(marked(), markup(['x'])), RULES);
    await settle();
    expect(tray.entries[0]!.markup).toBeUndefined();
  });

  it('clear frees the original and the marked thumbnail', async () => {
    const { tray, urls } = rig();
    tray.add([picked('a@10x10.png', 'image/png')], RULES);
    await settle();
    tray.replace(tray.entries[0]!.id, done(marked(), markup(['x'])), RULES);
    await settle();
    tray.clear();
    expect(urls.revoked.sort()).toEqual(['blob:preview-1', 'blob:preview-2']);
  });
});
