import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mirrorSettings, writeMirror, readMirror, createExtension } from '../../src/mirror/mirror.js';
import { saveUserConfig } from '../../src/config/config.js';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';

const NOW = '2026-10-11T12:00:00Z';

test('mirror settings: off by default, folder defaults beside the store, interval has a floor', () => {
  assert.equal(mirrorSettings({ store_path: '/s' }).enabled, false);
  const s = mirrorSettings({ store_path: path.resolve('/s'), mirror: { enabled: true, interval_seconds: 1, projects: ['a'] } });
  assert.equal(s.enabled, true);
  assert.equal(s.dir, path.join(path.resolve('/s'), '.quill-mirror'));
  assert.equal(s.interval_ms, 30_000);
  assert.deepEqual(s.projects, ['a']);
  assert.equal(mirrorSettings({ mirror: { enabled: true } }).enabled, false, 'no folder, no mirror');
  assert.equal(mirrorSettings({ mirror: { enabled: true, path: '~/sync/m' } }).dir, path.join(os.homedir(), 'sync', 'm'));
});

test('the worker keeps a sanitized, read-only mirror that another machine can open', async () => {
  const fx = makeHome();
  fx.config.mirror = { enabled: true };
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  const ext = createExtension({ storeMeta: fx.meta });
  try {
    await cli(['ticket', 'create', '--description', DESC, 'Mirrored work', '--session', 'sess-M'], fx.env);
    w.worker.publishGeneration();
    ext.tick(w.worker);
    const dir = path.join(fx.storePath, '.quill-mirror');
    const m = readMirror(dir, { now: w.worker.now() });
    assert.ok(m && m.has_dashboard, 'mirror.json and dashboard.html exist');
    assert.equal(m.ticket_count, 1);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
    assert.equal(snap.capabilities.edit_tickets, false, 'read-only');
    assert.deepEqual(snap.checkpoints, [], 'no checkpoint text leaves the owner machine');
    assert.match(fs.readFileSync(path.join(dir, 'dashboard.html'), 'utf8'), /data-static="true"/);
    const before = m.written_at;
    ext.tick(w.worker);
    assert.equal(readMirror(dir, { now: w.worker.now() }).written_at, before, 'no rewrite inside the interval');
    // Another machine: a different QUILL_HOME, no store of its own, reading the synced folder.
    const other = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-other-')) };
    const status = await cli(['mirror', 'status', '--dir', dir], other);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /1 tickets, generation gen-/);
    const json = JSON.parse((await cli(['mirror', 'status', '--dir', dir, '--json'], other)).out);
    assert.equal(json.fresh, true);
    const missing = await cli(['mirror', 'status', '--dir', path.join(other.QUILL_HOME, 'nope')], other);
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /no mirror in/);
    const notOwner = await cli(['mirror', 'write'], other);
    assert.notEqual(notOwner.code, 0);
  } finally {
    await w.stop();
  }
});

test('mirror write refreshes the copy on the owner machine on demand', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    w.worker.publishGeneration();
    const r = await cli(['mirror', 'write'], fx.env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Mirror written to .*\.quill-mirror.*only with \[mirror\] enabled = true/);
    assert.ok(fs.existsSync(path.join(fx.storePath, '.quill-mirror', 'dashboard.html')));
  } finally {
    await w.stop();
  }
});

test('writeMirror projects filter limits what leaves the machine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mirror-'));
  const t = (id, project_id) => ({ id, key: id, title: id, project_id, status: 'todo', tags: [], timeline: [], prs: [], deployments: [], files_touched: [], plans: [], conclusions: [], aliases: [], children_ids: [], session_ids: [], handoff_ids: [], validation_issues: [] });
  const snapshot = { schema_version: 1, generation_id: 'gen-1', generated_at: NOW, tickets: [t('A-1', 'a'), t('B-1', 'b')], sessions: [], checkpoints: [], handoffs: [], picknext: [], blocked: [], deployments_outstanding: [], repos: [], meta: { timezone: 'UTC' } };
  const info = writeMirror(snapshot, { dir, projects: ['a'], include_links: false }, { now: NOW });
  assert.equal(info.ticket_count, 1);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  assert.deepEqual(out.tickets.map((x) => x.key), ['A-1']);
});
