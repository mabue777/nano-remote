// The host's version: `version` of host/package.json, read once. The path works from src/cli (vitest) and
// dist/cli (the built bin), both two levels below host/.
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const HOST_VERSION = readVersion();
