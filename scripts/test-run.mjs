#!/usr/bin/env node
// Runs `node --test` with a private temp root and removes it afterwards. Many test files create
// mkdtemp directories they never delete; without this a few full runs fill the system temp dir.
// Usage: node scripts/test-run.mjs [node --test arguments…]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-test-run-'));
const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root };
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...(args.length ? args : ['tests/**/*.test.js'])], { env, stdio: 'inherit' });
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
} catch (err) {
  // A test that left a file open (Windows) must not turn a green run red; say where the rest is.
  process.stderr.write(`test-run: could not remove every file under ${root}: ${err.code ?? err.message}\n`);
}
if (result.error) {
  process.stderr.write(`test-run: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
