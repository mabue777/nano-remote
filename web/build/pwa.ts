// Home-screen install (ADR 0004): after `vite build` has written host/public, this plugin adds the app
// icons (rendered from web/icons/icon.svg by web/scripts/icons.mjs), manifest.webmanifest, and /sw.js.
// sw.js carries the build version, a hash of every shipped file, so any change to the app makes a new
// service worker, which is what lets the page offer a reload.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite';

import { ICON_SIZES, ICON_SOURCE, renderIcons } from '../scripts/icons.mjs';

const SW_TEMPLATE = fileURLToPath(new URL('./service-worker.js', import.meta.url));

/** Light theme background (web/src/styles/tokens.css --bg): the splash and the standalone window color. */
export const THEME_COLOR = '#f6f6f4';
export const DARK_THEME_COLOR = '#121211';
export const MANIFEST_FILE = 'manifest.webmanifest';
export const SERVICE_WORKER_FILE = 'sw.js';

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  orientation: 'any';
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: 'image/png'; purpose: 'any' | 'maskable' }[];
}

export function webManifest(): WebManifest {
  return {
    id: '/',
    name: 'Nano Remote',
    short_name: 'Nano Remote',
    description: 'Chat with LLMs and drive the coding agents on your computer.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // The source keeps its glyph inside the maskable safe zone, so the same PNG serves both.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** Shipped files that belong in the shell cache: everything but source maps and the worker itself. */
export function isShellFile(relative: string): boolean {
  return !relative.endsWith('.map') && relative !== SERVICE_WORKER_FILE && !relative.split('/').some((part) => part.startsWith('.'));
}

/** Build version: sha256 over each shell file's path and bytes, in path order; 16 hex characters. */
export function buildVersion(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    hash.update(name).update('\0').update(files.get(name)!).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** sw.js from the template: the config lines replaced by the version and the shell's URL paths. */
export function renderServiceWorker(template: string, version: string, shell: readonly string[]): string {
  const config = /^const VERSION = '__VERSION__';\nconst SHELL = \[\];$/m;
  if (!config.test(template)) throw new Error('service-worker.js template has no config lines to replace');
  return template.replace(config, () => `const VERSION = ${JSON.stringify(version)};\nconst SHELL = ${JSON.stringify(shell)};`);
}

async function listFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/** Writes the icons, the manifest and sw.js into `outDir`, which already holds the Vite build. */
export async function writeInstallableShell(outDir: string): Promise<{ version: string; shell: string[] }> {
  for (const [name, png] of await renderIcons(await readFile(ICON_SOURCE, 'utf8'), ICON_SIZES)) {
    await writeFile(path.join(outDir, name), png);
  }
  await writeFile(path.join(outDir, MANIFEST_FILE), `${JSON.stringify(webManifest(), null, 2)}\n`);

  const files = new Map<string, Uint8Array>();
  for (const relative of (await listFiles(outDir)).filter(isShellFile)) {
    files.set(relative, await readFile(path.join(outDir, relative)));
  }
  const version = buildVersion(files);
  const shell = [...files.keys()].sort().map((relative) => `/${relative}`);
  await writeFile(path.join(outDir, SERVICE_WORKER_FILE), renderServiceWorker(await readFile(SW_TEMPLATE, 'utf8'), version, shell));
  return { version, shell };
}

export function installableShell(): Plugin {
  let outDir = '';
  let log: (message: string) => void = () => {};
  return {
    name: 'nano-remote:installable-shell',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      log = (message) => config.logger.info(message);
    },
    async closeBundle() {
      const { version, shell } = await writeInstallableShell(outDir);
      log(`installable shell: sw.js version ${version}, ${shell.length} shell files`);
    },
  };
}
