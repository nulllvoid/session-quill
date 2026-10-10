import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = (name) => fileURLToPath(new URL(`../../bin/${name}`, import.meta.url));

// The plugin's hooks run bin/quill-hook.js; it must answer exactly as `quill hook` does.
test('quill-hook <Event> and quill hook <Event> give the same answer', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-entry-'));
  const env = { ...process.env, QUILL_HOME: home };
  const cases = [
    ['PreToolUse', '{not json'],
    ['PreToolUse', JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'a' } })],
    ['UnknownEvent', '{}'],
  ];
  for (const [event, input] of cases) {
    const full = spawnSync(process.execPath, [bin('quill.js'), 'hook', event], { input, env, encoding: 'utf8' });
    const thin = spawnSync(process.execPath, [bin('quill-hook.js'), event], { input, env, encoding: 'utf8' });
    assert.equal(thin.status, full.status, `${event} exit code`);
    assert.equal(thin.stdout, full.stdout, `${event} stdout`);
    assert.equal(thin.stderr, full.stderr, `${event} stderr`);
  }
  const denied = spawnSync(process.execPath, [bin('quill-hook.js'), 'PreToolUse'], { input: '{not json', env, encoding: 'utf8' });
  assert.match(denied.stdout, /"permissionDecision":"deny"/, 'malformed input still fails closed');
});
