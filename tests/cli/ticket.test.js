import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHome, startWorker, cli } from './helpers.js';
import { readJsonIfExists } from '../../src/lib/atomic-fs.js';

test('ticket create --bind allocates a key, waits for the worker and publishes the binding snapshot', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const r = await cli(['ticket', 'create', 'Preserve session checkpoints', '--bind', '--session', 'sess-A', '--category', 'feature'], fx.env);
    assert.equal(r.code, 0, r.err);
    const key = /(LOCAL-preserve-session-checkpoints-[0-9a-f]{8})/.exec(r.out)?.[1];
    assert.ok(key, r.out);
    const snap = readJsonIfExists(path.join(fx.home, 'state', 'bindings', 'sess-A.json'));
    assert.equal(snap.ticket_key, key);
    assert.equal(snap.binding_revision, 1);
    const show = await cli(['ticket', 'show', '--session', 'sess-A'], fx.env);
    assert.match(show.out, new RegExp(key));
    assert.match(show.out, /revision 1/);
    const json = await cli(['ticket', 'show', '--session', 'sess-A', '--json'], fx.env);
    assert.equal(JSON.parse(json.out).binding.ticket_key, key);
  } finally {
    await w.stop();
  }
});

test('ticket bind to an unknown key fails with a worker-confirmed error and leaves the session unbound', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const r = await cli(['ticket', 'bind', 'LOCAL-nope-00000000', '--session', 'sess-B'], fx.env);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /unknown ticket key/i);
    assert.equal(fs.existsSync(path.join(fx.home, 'state', 'bindings', 'sess-B.json')), false);
  } finally {
    await w.stop();
  }
});

test('ticket off writes an audited gate-off and ticket on restores it', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const off = await cli(['ticket', 'off', '--session', 'sess-C'], fx.env);
    assert.equal(off.code, 0, off.err);
    assert.equal(readJsonIfExists(path.join(fx.home, 'state', 'bindings', 'sess-C.json')).gate_enabled, false);
    const on = await cli(['ticket', 'on', '--session', 'sess-C'], fx.env);
    assert.equal(on.code, 0, on.err);
    assert.equal(readJsonIfExists(path.join(fx.home, 'state', 'bindings', 'sess-C.json')).gate_enabled, true);
  } finally {
    await w.stop();
  }
});

test('child tickets, relink with Jira pending validation, list and children', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const parent = await cli(['ticket', 'create', 'Parent work', '--session', 'sess-D'], fx.env);
    const pkey = /(LOCAL-parent-work-[0-9a-f]{8})/.exec(parent.out)[1];
    const child = await cli(['ticket', 'create', 'Child one', '--parent', pkey, '--session', 'sess-D'], fx.env);
    assert.match(child.out, new RegExp(`${pkey}\\.1`));
    const relink = await cli(['ticket', 'relink', pkey, '--jira', 'PMLA-42', '--session', 'sess-D'], fx.env);
    assert.equal(relink.code, 0, relink.err);
    assert.match(relink.out, /pending/);
    const list = await cli(['ticket', 'list', '--json'], fx.env);
    const rows = JSON.parse(list.out);
    const relinked = rows.find((t) => t.key === 'PMLA-42');
    assert.ok(relinked);
    assert.deepEqual(relinked.aliases, [pkey]);
    const children = await cli(['ticket', 'children', 'PMLA-42'], fx.env);
    assert.match(children.out, /Child one/);
    const collide = await cli(['ticket', 'relink', `${pkey}.1`, '--jira', 'PMLA-42', '--session', 'sess-D'], fx.env);
    assert.notEqual(collide.code, 0);
    assert.match(collide.err, /collision/i);
  } finally {
    await w.stop();
  }
});

test('ticket create rejects invalid category/priority and traversal keys locally', async () => {
  const fx = makeHome();
  const r = await cli(['ticket', 'create', 'x', '--category', 'party', '--session', 's'], fx.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /category/);
  const r2 = await cli(['ticket', 'bind', '../etc', '--session', 's'], fx.env);
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /invalid ticket key/);
});

test('commands that change state fail clearly when no worker confirms them', async () => {
  const fx = makeHome();
  const r = await cli(['ticket', 'create', 'No worker', '--session', 's', '--timeout', '300'], fx.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /worker/i);
  assert.match(r.err, /tracker doctor|tracker worker start/);
});
