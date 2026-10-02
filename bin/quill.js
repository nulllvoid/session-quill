#!/usr/bin/env node
import { main } from '../src/cli/main.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    process.stderr.write(`quill: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
