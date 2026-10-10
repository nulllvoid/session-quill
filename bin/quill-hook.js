#!/usr/bin/env node
// Hook entry point: `quill-hook <EventName>` behaves exactly like `quill hook <EventName>` but loads
// only the hook path, not the CLI's command table and configuration modules. The host starts a
// fresh process for every tool call, so module loading is most of a hook's latency.
import { run } from '../src/cli/commands/hook.js';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
}

const io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  error: (s) => process.stderr.write(`${s}\n`),
  readStdin: async () => {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  },
};

run({ args: process.argv.slice(2), io, env: process.env }).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    // A hook never fails the host's tool call; report and exit cleanly (TRD §Durability 8).
    process.stderr.write(`Session Quill: hook failure (${err && err.message ? err.message : String(err)})\n`);
    process.exitCode = 0;
  },
);
