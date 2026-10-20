// Reads protocol/examples/*.json, the spec's fixtures (protocol/README.md), so the fake host and the
// tests speak exactly the shapes the protocol validator checks.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../protocol/examples/', import.meta.url));
const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

/** The whole example file (an envelope), minus the validator's `$expect` note. */
export function exampleEnvelope(prefix: string): Record<string, unknown> {
  const file = files.find((name) => name.startsWith(`${prefix}-`) || name === `${prefix}.json`);
  if (file === undefined) throw new Error(`no example ${prefix} in ${dir}`);
  const { $expect: _expect, ...envelope } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
  return envelope;
}

/** The JSON-RPC message inside an example envelope, deep-copied. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exampleMessage(prefix: string): any {
  const envelope = exampleEnvelope(prefix);
  if (!('message' in envelope)) throw new Error(`example ${prefix} carries no message`);
  return structuredClone(envelope.message);
}
