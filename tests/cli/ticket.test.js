import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHome, startWorker, cli, DESC } from './helpers.js';
import { readJsonIfExists } from '../../src/lib/atomic-fs.js';
import { saveUserConfig } from '../../src/config/config.js';
import { isTrackerCliCommand } from '../../src/gate/decide.js';

test('parallel sessions can work on the same internal task, then switch independently', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    assert.equal(isTrackerCliCommand('node "C:/plugin/bin/quill.js" ticket work "Fix login" --session one'), true);
    const results = await Promise.all(['one', 'two'].map((session) => cli(['ticket', 'work', '--description', DESC, 'Fix login', '--category', 'bugfix', '--session', session], fx.env)));
    for (const r of results) { assert.equal(r.code, 0, r.err); assert.match(r.out, /FIX-1/); }
    let tickets = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    assert.equal(tickets.length, 1);
    const next = await cli(['ticket', 'work', '--description', DESC, 'Add search', '--category', 'feature', '--session', 'one'], fx.env);
    assert.equal(next.code, 0, next.err);
    assert.match(next.out, /FEAT-1/);
    const one = JSON.parse((await cli(['ticket', 'show', '--session', 'one', '--json'], fx.env)).out);
    const two = JSON.parse((await cli(['ticket', 'show', '--session', 'two', '--json'], fx.env)).out);
    assert.equal(one.binding.ticket_key, 'FEAT-1');
    assert.equal(two.binding.ticket_key, 'FIX-1');
    assert.equal((await cli(['ticket', 'work', '--description', DESC, 'Fix login', '--session', 'one'], fx.env)).code, 0);
    tickets = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    assert.equal(tickets.length, 2);
  } finally { await w.stop(); }
});

test('relink --external renders the tracker link; --jira stays an alias; bad keys and links are refused', async () => {
  const fx = makeHome();
  fx.config.tracker = { system: 'linear', domain: 'https://linear.app/acme' };
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  try {
    const a = await cli(['ticket', 'create', '--description', DESC, 'Linear work', '--session', 'sess-E'], fx.env);
    const akey = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(a.out)[1];
    const r = await cli(['ticket', 'relink', akey, '--external', 'ENG-12', '--session', 'sess-E'], fx.env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ENG-12/);
    assert.match(r.out, /linear/);
    const rows = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    const eng = rows.find((t) => t.key === 'ENG-12');
    assert.equal(eng.external.url, 'https://linear.app/acme/issue/ENG-12');
    assert.equal(eng.jira, null);
    const b = await cli(['ticket', 'create', '--description', DESC, 'Jira work', '--session', 'sess-E'], fx.env);
    const bkey = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(b.out)[1];
    const bad = await cli(['ticket', 'relink', bkey, '--external', 'eng 12', '--session', 'sess-E'], fx.env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /external key/);
    const badUrl = await cli(['ticket', 'relink', bkey, '--external', 'PMLA-9', '--url', 'http://x.example/PMLA-9', '--session', 'sess-E'], fx.env);
    assert.notEqual(badUrl.code, 0);
    assert.match(badUrl.err, /https/);
    const j = await cli(['ticket', 'relink', bkey, '--jira', 'PMLA-9', '--session', 'sess-E'], fx.env);
    assert.equal(j.code, 0, j.err);
    const pm = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((t) => t.key === 'PMLA-9');
    assert.deepEqual([pm.external.system, pm.jira.key], ['jira', 'PMLA-9']);
  } finally {
    await w.stop();
  }
});

test('ticket create --bind allocates a key, waits for the worker and publishes the binding snapshot', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const r = await cli(['ticket', 'create', '--description', DESC, 'Preserve session checkpoints', '--bind', '--session', 'sess-A', '--category', 'feature'], fx.env);
    assert.equal(r.code, 0, r.err);
    const key = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(r.out)?.[1];
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
    const parent = await cli(['ticket', 'create', '--description', DESC, 'Parent work', '--session', 'sess-D'], fx.env);
    const pkey = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(parent.out)[1];
    const child = await cli(['ticket', 'create', '--description', DESC, 'Child one', '--parent', pkey, '--session', 'sess-D'], fx.env);
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
  const r = await cli(['ticket', 'create', '--description', DESC, 'x', '--category', 'party', '--session', 's'], fx.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /category/);
  const r2 = await cli(['ticket', 'bind', '../etc', '--session', 's'], fx.env);
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /invalid ticket key/);
});

test('commands that change state fail clearly when no worker confirms them', async () => {
  const fx = makeHome();
  const r = await cli(['ticket', 'create', '--description', DESC, 'No worker', '--session', 's', '--timeout', '300'], fx.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /worker/i);
  assert.match(r.err, /quill doctor|quill worker start/);
});

test('review: relink --external normalizes tracker keys to uppercase', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const a = await cli(['ticket', 'create', '--description', DESC, 'Case work', '--session', 'sess-F'], fx.env);
    const akey = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(a.out)[1];
    const r = await cli(['ticket', 'relink', akey, '--external', 'eng-13', '--session', 'sess-F'], fx.env);
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    assert.ok(rows.some((t) => t.key === 'ENG-13'));
  } finally {
    await w.stop();
  }
});

test('issue #4: ticket set edits title, status, next action, priority, due and repository in one event', async () => {
  const fx = makeHome();
  fx.config.repos.api = { project_id: 'demo', display_name: 'api', default_branch: 'main', deployment_environments: ['production'] };
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  try {
    const a = await cli(['ticket', 'create', '--description', DESC, 'Imported work', '--session', 'sess-S'], fx.env);
    const key = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(a.out)[1];
    const before = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((t) => t.key === key);
    const r = await cli(['ticket', 'set', key, '--title', 'Fixed title', '--status', 'active', '--next', 'Write the test', '--priority', 'P1', '--due', '2026-11-01', '--repo', 'api'], fx.env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Updated/);
    const t = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((x) => x.key === key);
    assert.deepEqual([t.title, t.status, t.next_action, t.priority, t.due, t.repo_id], ['Fixed title', 'active', 'Write the test', 'P1', '2026-11-01', 'api']);
    assert.equal(t.revision, before.revision + 1, 'one ticket-update event');
    const blocked = await cli(['ticket', 'set', key, '--status', 'blocked', '--blocker', 'Waiting on infra'], fx.env);
    assert.equal(blocked.code, 0, blocked.err);
    const cleared = await cli(['ticket', 'set', key, '--repo', 'none', '--due', 'none'], fx.env);
    assert.equal(cleared.code, 0, cleared.err);
    const t2 = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((x) => x.key === key);
    assert.deepEqual([t2.status, t2.blocker, t2.repo_id, t2.due], ['blocked', 'Waiting on infra', null, null]);
  } finally {
    await w.stop();
  }
});

test('issue #4: ticket set validates locally before submitting', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const a = await cli(['ticket', 'create', '--description', DESC, 'Validate me', '--session', 'sess-V'], fx.env);
    const key = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(a.out)[1];
    const cases = [
      [[], /nothing to change/],
      [['--repo', 'nope'], /unknown repository nope/],
      [['--status', 'shipping'], /status must be one of/],
      [['--status', 'blocked'], /blocker/],
      [['--blocker', 'x'], /--status blocked/],
      [['--priority', 'P9'], /priority/],
      [['--due', 'tomorrow'], /YYYY-MM-DD/],
      [['--parent', 'LOCAL-missing-00000000'], /unknown parent/],
    ];
    for (const [flags, re] of cases) {
      const r = await cli(['ticket', 'set', key, ...flags], fx.env);
      assert.notEqual(r.code, 0, flags.join(' '));
      assert.match(r.err, re, flags.join(' '));
    }
    const unknown = await cli(['ticket', 'set', 'LOCAL-missing-00000000', '--title', 'x'], fx.env);
    assert.match(unknown.err, /unknown ticket key/);
  } finally {
    await w.stop();
  }
});
