#!/usr/bin/env node
// The nano-host bin (host/package.json "bin"). Everything testable lives in commands.ts.
import { runCli } from './commands.js';

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`nano-host: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
