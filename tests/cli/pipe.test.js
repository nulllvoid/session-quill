import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/quill.js', import.meta.url));

// `quill ticket list --json | head` closes the pipe early; the CLI must not crash with EPIPE.
test('a reader that closes stdout early does not crash the CLI', async () => {
  const child = spawn(process.execPath, [bin, 'help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.doesNotMatch(err, /EPIPE|Unhandled 'error' event/);
  assert.equal(code, 0, err);
});
