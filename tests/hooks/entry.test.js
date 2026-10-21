import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ADR 0034: SessionStart's readiness check loads the worker module only to launch a worker. A
// paused store never launches one, so its SessionStart hook must not pay for the worker's graph.
test('a SessionStart that does not launch the worker never loads the worker module', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-entry-ss-'));
  const MACHINE = '22222222-2222-4222-8222-222222222222';
  const store = path.join(home, 'Quill');
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'store.json'), JSON.stringify({ schema_version: 1, store_id: '33333333-3333-4333-8333-333333333333', store_name: 'Quill', owner_machine_id: MACHINE }));
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  fs.writeFileSync(path.join(home, 'config.toml'), `config_version = 1\nstore_path = ${JSON.stringify(store)}\n`);
  fs.mkdirSync(path.join(home, 'run'));
  fs.writeFileSync(path.join(home, 'run', 'worker-paused.json'), '{}');
  const trace = path.join(home, 'loaded.txt');
  const hooks = path.join(home, 'trace.mjs');
  fs.writeFileSync(hooks, `import { registerHooks } from 'node:module';\nimport fs from 'node:fs';\nregisterHooks({ load(url, ctx, next) { if (url.startsWith('file:')) fs.appendFileSync(${JSON.stringify(trace)}, url + '\\n'); return next(url, ctx); } });\n`);
  try {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(hooks).href, bin('quill-hook.js'), 'SessionStart'], { input: JSON.stringify({ session_id: 's1', source: 'startup' }), env: { ...process.env, QUILL_HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /paused/);
    const loaded = fs.readFileSync(trace, 'utf8');
    assert.match(loaded, /\/src\/runtime\/readiness\.js/, 'the readiness check ran');
    assert.doesNotMatch(loaded, /\/src\/worker\/worker\.js|\/src\/cli\/commands\/worker\.js/);
    assert.ok(!fs.existsSync(path.join(home, 'run', 'worker-start-attempt.json')), 'no launch was attempted');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
