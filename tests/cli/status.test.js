// `quill status` and the status line: plan drift (ADR 0037).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { makeHome, startWorker, cli, DESC } from './helpers.js';
import { runHook } from '../../src/hooks/adapter.js';
import { readBindingSnapshot } from '../../src/hooks/binding-snapshot.js';

const settle = async (check, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return check();
};

test('writes outside the plan\'s files show as " ⚠ drift N" in the status line once the worker has seen them', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  const cwd = path.join(os.tmpdir(), 'drift-repo');
  const hook = (name, extra) => runHook(name, { session_id: 'sess-D', cwd, hook_event_name: name, ...extra }, { env: fx.env });
  const call = (id, tool_name, tool_input, tool_response = {}) => {
    hook('PreToolUse', { tool_name, tool_use_id: id, tool_input });
    hook('PostToolUse', { tool_name, tool_use_id: id, tool_input, tool_response });
  };
  const line = async () => (await cli(['status', '--statusline'], fx.env, { stdin: JSON.stringify({ session_id: 'sess-D' }) })).out;
  try {
    const c = await cli(['ticket', 'create', '--description', DESC, 'Drift demo', '--bind', '--session', 'sess-D'], fx.env);
    assert.equal(c.code, 0, c.err);
    call('p1', 'ExitPlanMode', { plan: '# Plan\n1. Edit `src/a.js`' }, 'User has approved your plan.');
    call('w1', 'Write', { file_path: path.join(cwd, 'src', 'a.js'), content: 'x' });
    assert.ok(await settle(() => (readBindingSnapshot('sess-D', fx.env) ?? {}).ticket_key && readBindingSnapshot('sess-D', fx.env).drift_count === 0));
    assert.doesNotMatch(await line(), /drift/, 'a write inside the plan is not drift');
    call('w2', 'Write', { file_path: path.join(cwd, 'src', 'b.js'), content: 'x' });
    call('w3', 'Edit', { file_path: path.join(cwd, 'docs', 'c.md'), old_string: 'a', new_string: 'b' });
    assert.ok(await settle(() => (readBindingSnapshot('sess-D', fx.env) ?? {}).drift_count === 2), JSON.stringify(readBindingSnapshot('sess-D', fx.env)));
    assert.match(await line(), /Drift demo ⚠ drift 2/);
    const human = await cli(['status', '--session', 'sess-D'], fx.env);
    assert.match(human.out, /Plan drift: 2 writes outside the files the latest plan names \(observed, nothing was blocked\)/);
    const js = JSON.parse((await cli(['status', '--json', '--session', 'sess-D'], fx.env)).out);
    assert.deepEqual(js.session.drift, { count: 2, last_path: 'docs/c.md', at: js.session.drift.at });
    assert.deepEqual(js.session.planned_paths, ['src/a.js']);
  } finally {
    await w.stop();
  }
});

test('the status line has no drift segment without a binding snapshot count', async () => {
  const fx = makeHome();
  const out = (await cli(['status', '--statusline'], fx.env, { stdin: JSON.stringify({ session_id: 'nobody' }) })).out;
  assert.doesNotMatch(out, /drift/);
});
