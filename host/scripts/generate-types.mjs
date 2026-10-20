#!/usr/bin/env node
// Generate TypeScript types for host/ and web/ from protocol/schema/*.json (JSON Schema 2020-12).
//
// The schemas are the single source of truth for message shapes. The output directories
// (host/src/generated and web/src/generated) are gitignored and rebuilt by every verify run,
// so there are no hand-written protocol types anywhere and nothing can drift.
//
// Run from anywhere:  node host/scripts/generate-types.mjs
// Also run by:        pnpm -C host verify   and   pnpm -C web verify
import { compileFromFile } from 'json-schema-to-typescript';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const schemaDir = path.join(repoRoot, 'protocol', 'schema');
const targets = [
  path.join(repoRoot, 'host', 'src', 'generated'),
  path.join(repoRoot, 'web', 'src', 'generated'),
];

const banner = (source) =>
  [
    '/* eslint-disable */',
    '/**',
    ` * GENERATED from protocol/schema/${source} by host/scripts/generate-types.mjs.`,
    ' * Do not edit. Change the schema and run `node host/scripts/generate-types.mjs`.',
    ' */',
  ].join('\n');

const schemaFiles = (await readdir(schemaDir)).filter((name) => name.endsWith('.json')).sort();
if (schemaFiles.length === 0) {
  throw new Error(`no schemas found in ${schemaDir}`);
}

/** @type {Map<string, string>} file name -> TypeScript source */
const outputs = new Map();
for (const file of schemaFiles) {
  const base = path.basename(file, '.json');
  const source = await compileFromFile(path.join(schemaDir, file), {
    cwd: schemaDir,
    bannerComment: banner(file),
    // methods.json and events.json keep everything under $defs with no root shape:
    // emit every definition, not only the ones reachable from the root.
    unreachableDefinitions: true,
    declareExternallyReferenced: true,
    // Protocol section 12: unknown fields are ignored, so objects stay open.
    additionalProperties: true,
  });
  if (!source.includes('export ')) {
    throw new Error(`generator produced no exports for ${file}`);
  }
  outputs.set(`${base}.ts`, source);
}

// One namespace per schema file keeps names like `Turn` (declared in more than one output
// because each file is self-contained) from colliding in a flat re-export.
const indexSource =
  [
    banner('*.json'),
    ...schemaFiles.map((file) => {
      const base = path.basename(file, '.json');
      return `export type * as ${base} from './${base}.js';`;
    }),
  ].join('\n') + '\n';
outputs.set('index.ts', indexSource);

for (const dir of targets) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, source] of outputs) {
    await writeFile(path.join(dir, name), source, 'utf8');
  }
  console.log(`generated ${outputs.size} files in ${path.relative(repoRoot, dir)}`);
}
