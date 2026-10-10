#!/usr/bin/env node
import { main } from '../src/cli/main.js';

// A reader that stops early (`quill ticket list --json | head`) closes the pipe; the command
// still finishes its work, it just has no one left to print to.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    process.stderr.write(`quill: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
