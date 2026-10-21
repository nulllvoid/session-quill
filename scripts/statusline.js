#!/usr/bin/env node
// Status line segment: reads Claude Code status-line JSON on stdin and prints the binding.
// Compose with an existing status line by running your own script first and this one after.
//
// A lean entry: it prints exactly what `quill status --statusline` prints (trimmed), but loads only
// the status-line module, not the CLI's command table. The host runs it on every status refresh,
// so module loading is most of its cost (ADR 0034).
import { loadContext } from '../src/cli/context.js';
import { statusLine, parseStatusInput } from '../src/cli/statusline.js';
import { TrackerError } from '../src/lib/errors.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  let out = '';
  try {
    out = statusLine(loadContext(process.env, { requireStore: false }), parseStatusInput(input));
  } catch (err) {
    // `quill status` reports a TrackerError (an unreadable store) on stderr and prints nothing.
    out = err instanceof TrackerError ? '' : '⌁ quill: unavailable';
  }
  process.stdout.write(out.trim());
});
