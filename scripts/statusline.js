#!/usr/bin/env node
// Status line segment: reads Claude Code status-line JSON on stdin and prints the binding.
// Compose with an existing status line by running your own script first and this one after.
import { main } from '../src/cli/main.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const input = Buffer.concat(chunks).toString('utf8');
  let out = '';
  try {
    await main(['status', '--statusline'], { stdout: (s) => { out += s; }, stderr: () => {}, stdin: async () => input });
  } catch {
    out = '⌁ quill: unavailable';
  }
  process.stdout.write(out.trim());
});
