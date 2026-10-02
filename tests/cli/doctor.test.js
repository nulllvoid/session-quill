import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeHome, startWorker, cli } from './helpers.js';

test('doctor without a worker reports it unavailable and exits non-zero; with a worker it is healthy', async () => {
  const fx = makeHome();
  const r = await cli(['doctor'], fx.env);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /worker: unavailable/i);
  assert.match(r.out, /node: \d+\.\d+/);
  const w = await startWorker(fx);
  try {
    const ok = await cli(['doctor'], fx.env);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(ok.out, /worker: healthy/i);
    assert.match(ok.out, /ownership: this machine/i);
    assert.match(ok.out, /commands: \/session-quill:ticket/);
  } finally {
    await w.stop();
  }
});

test('doctor flags a read-only copy owned by another machine', async () => {
  const fx = makeHome();
  const meta = JSON.parse(fs.readFileSync(path.join(fx.storePath, 'store.json'), 'utf8'));
  meta.owner_machine_id = '99999999-9999-4999-8999-999999999999';
  fs.writeFileSync(path.join(fx.storePath, 'store.json'), JSON.stringify(meta));
  const r = await cli(['doctor'], fx.env);
  assert.match(r.out, /ownership: another machine/i);
  assert.match(r.out, /read-only/i);
});

test('status --json and --statusline reflect the binding', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const un = await cli(['status', '--statusline'], fx.env, { stdin: JSON.stringify({ session_id: 'sess-S' }) });
    assert.match(un.out, /unbound/);
    const c = await cli(['ticket', 'create', 'Status demo', '--bind', '--session', 'sess-S'], fx.env);
    const key = /(LOCAL-status-demo-[0-9a-f]{8})/.exec(c.out)[1];
    const sl = await cli(['status', '--statusline'], fx.env, { stdin: JSON.stringify({ session_id: 'sess-S', cwd: os.tmpdir() }) });
    assert.match(sl.out, new RegExp(`${key} Status demo`));
    const js = await cli(['status', '--json', '--session', 'sess-S'], fx.env);
    const parsed = JSON.parse(js.out);
    assert.equal(parsed.binding.ticket_key, key);
    assert.equal(parsed.worker.healthy, true);
    assert.equal(typeof parsed.backlog, 'number');
  } finally {
    await w.stop();
  }
});

test('approve promotes the latest checkpoint once and dismiss clears the unpromoted flag', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    await cli(['ticket', 'create', 'Approve demo', '--bind', '--session', 'sess-P'], fx.env);
    const none = await cli(['approve', '--session', 'sess-P'], fx.env);
    assert.notEqual(none.code, 0);
    assert.match(none.err, /no complete checkpoint/i);
    const { runHook } = await import('../../src/hooks/adapter.js');
    runHook('Stop', { session_id: 'sess-P', hook_event_name: 'Stop', last_assistant_message: 'Plan: do the thing' }, { env: fx.env });
    await new Promise((r) => setTimeout(r, 150));
    const ok = await cli(['approve', '--session', 'sess-P'], fx.env);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /approved/i);
    const again = await cli(['approve', '--session', 'sess-P'], fx.env);
    assert.equal(again.code, 0);
    assert.match(again.out, /already approved/i);
    runHook('Stop', { session_id: 'sess-P', hook_event_name: 'Stop', last_assistant_message: 'Another checkpoint' }, { env: fx.env });
    await new Promise((r) => setTimeout(r, 150));
    const dis = await cli(['dismiss', '--session', 'sess-P'], fx.env);
    assert.equal(dis.code, 0, dis.err);
    const st = await cli(['status', '--json', '--session', 'sess-P'], fx.env);
    assert.equal(JSON.parse(st.out).session.unpromoted, false);
  } finally {
    await w.stop();
  }
});

test('replay --into renders a staging store from the journal without touching the live store', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const c = await cli(['ticket', 'create', 'Replay me', '--session', 'sess-R'], fx.env);
    const key = /(LOCAL-replay-me-[0-9a-f]{8})/.exec(c.out)[1];
    const staging = path.join(fx.home, 'staging');
    const r = await cli(['replay', '--into', staging], fx.env);
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(staging, 'tickets', `${key}.md`)));
    assert.match(r.out, /tickets: 1/);
  } finally {
    await w.stop();
  }
});

test('import turns supported frontmatter changes into events', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const c = await cli(['ticket', 'create', 'Import me', '--session', 'sess-I'], fx.env);
    const key = /(LOCAL-import-me-[0-9a-f]{8})/.exec(c.out)[1];
    await cli(['sync', '--notes'], fx.env);
    const note = path.join(fx.storePath, 'tickets', `${key}.md`);
    assert.ok(fs.existsSync(note));
    const text = fs.readFileSync(note, 'utf8').replace('priority: P2', 'priority: P1').replace("next_action: ''", 'next_action: Ship it tomorrow').replace('next_action: ""', 'next_action: Ship it tomorrow');
    fs.writeFileSync(note, text);
    const imp = await cli(['import', note], fx.env);
    assert.equal(imp.code, 0, imp.err);
    assert.match(imp.out, /priority/);
    const list = await cli(['ticket', 'list', '--json'], fx.env);
    const t = JSON.parse(list.out).find((x) => x.key === key);
    assert.equal(t.priority, 'P1');
    assert.equal(t.next_action, 'Ship it tomorrow');
  } finally {
    await w.stop();
  }
});
