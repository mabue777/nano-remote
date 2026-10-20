// Renders the app icons from the single source SVG (web/icons/icon.svg) into the PNG sizes the home
// screen needs. resvg runs as WebAssembly, so there is no native dependency and nothing to compile.
// The Vite build calls renderIcons (web/build/pwa.ts); run it by hand to look at the output:
//   node scripts/icons.mjs <out-dir>
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initWasm, Resvg } from '@resvg/resvg-wasm';

/** The source SVG every icon is rendered from. */
export const ICON_SOURCE = fileURLToPath(new URL('../icons/icon.svg', import.meta.url));

/**
 * Every PNG the app ships, by file name. 180 is the iOS apple-touch-icon; 192 and 512 are the manifest
 * icons Chromium and iOS 16.4+ read (512 doubles as the maskable icon and the splash source).
 */
export const ICON_SIZES = Object.freeze({
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
});

let ready;
function init() {
  ready ??= readFile(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')).then((wasm) => initWasm(wasm));
  return ready;
}

/** Renders `svg` once per entry of `sizes`; resolves to file name -> PNG bytes. */
export async function renderIcons(svg, sizes = ICON_SIZES) {
  await init();
  const out = new Map();
  for (const [name, size] of Object.entries(sizes)) {
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    const image = resvg.render();
    out.set(name, Buffer.from(image.asPng()));
    image.free();
    resvg.free();
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/icons.mjs <out-dir>');
    process.exit(2);
  }
  await mkdir(dir, { recursive: true });
  for (const [name, png] of await renderIcons(await readFile(ICON_SOURCE, 'utf8'))) {
    await writeFile(path.join(dir, name), png);
    console.log(`${name} ${png.length} bytes`);
  }
}
