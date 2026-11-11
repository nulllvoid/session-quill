#!/usr/bin/env node
// Checked before anything else is loaded: on an older Node the modules below fail to parse, and
// the error names a syntax problem instead of the cause.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(`quill: Session Quill needs Node 22 or newer; this is Node ${process.versions.node}. Install a current LTS from https://nodejs.org and run the command again.\n`);
  process.exit(1);
}
const { main } = await import('../src/cli/main.js');

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
