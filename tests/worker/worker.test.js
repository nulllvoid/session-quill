import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress, listIngress } from '../../src/core/ingress.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath, projectionsDir, bindingsDir } from '../../src/lib/paths.js';
import { readJsonIfExists } from '../../src/lib/atomic-fs.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worker-'));
  const storePath = path.join(home, 'Tracker');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Tracker', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] } } };
  const env = { TRACKER_HOME: home };
  let nowMs = Date.parse('2026-10-02T08:00:00Z');
  const clock = () => nowMs;
  const advance = (ms) => { nowMs += ms; };
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), ...extra });
  const ticketEvent = () => mk('ticket-create', { ticket: { id: T1, key: 'LOCAL-demo-00000001', title: 'Demo', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } });
  return { home, storePath, meta, config, env, clock, advance, mk, ticketEvent };
}

test('worker ingests a complete ingress file into the journal and removes it', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  writeIngress(f.ticketEvent(), f.env);
  const n = w.ingestOnce();
  assert.equal(n, 1);
  assert.equal(listIngress(f.env).length, 0);
  const j = new Journal(journalPath(f.env));
  assert.equal(j.open().lastSequence, 1);
  j.close();
  assert.equal(w.state.tickets.get(T1).key, 'LOCAL-demo-00000001');
  await w.stop();
});

test('binding snapshots publish immediately after ingest, independent of the note timer', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  writeIngress(f.ticketEvent(), f.env);
  writeIngress(f.mk('session-start', { source: 'startup' }, { session_id: 'host-1' }), f.env);
  writeIngress(f.mk('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'host-1' }), f.env);
  w.tick();
  const snap = readJsonIfExists(path.join(bindingsDir(f.env), 'host-1.json'));
  assert.equal(snap.ticket_id, T1);
  assert.equal(snap.ticket_key, 'LOCAL-demo-00000001');
  assert.equal(snap.binding_revision, 1);
  assert.equal(fs.existsSync(path.join(f.storePath, 'tickets', 'LOCAL-demo-00000001.md')), false, 'notes not yet materialized');
  await w.stop();
});

test('notes materialize 30 s after the first pending event; later events cannot postpone the deadline', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  writeIngress(f.ticketEvent(), f.env);
  w.tick();
  const note = path.join(f.storePath, 'tickets', 'LOCAL-demo-00000001.md');
  f.advance(20_000);
  writeIngress(f.mk('ticket-update', { ticket_id: T1, fields: { next_action: 'later' }, source: 'manual' }), f.env);
  w.tick();
  assert.equal(fs.existsSync(note), false);
  f.advance(10_000);
  w.tick();
  assert.equal(fs.existsSync(note), true);
  assert.match(fs.readFileSync(note, 'utf8'), /next_action: later/);
  await w.stop();
});

test('Stop and SessionEnd request an early flush', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  writeIngress(f.ticketEvent(), f.env);
  writeIngress(f.mk('session-start', { source: 'startup' }, { session_id: 'host-1' }), f.env);
  writeIngress(f.mk('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'host-1' }), f.env);
  w.tick();
  writeIngress(f.mk('session-end', { reason: 'other' }, { session_id: 'host-1' }), f.env);
  w.tick();
  assert.equal(fs.existsSync(path.join(f.storePath, 'tickets', 'LOCAL-demo-00000001.md')), true);
  assert.ok(fs.readdirSync(path.join(f.storePath, 'sessions')).length >= 1);
  await w.stop();
});

test('a worker stopped without flushing recovers identical state on restart with no duplicate effects', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  writeIngress(f.ticketEvent(), f.env);
  writeIngress(f.mk('session-start', { source: 'startup' }, { session_id: 'host-1' }), f.env);
  writeIngress(f.mk('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'host-1' }), f.env);
  writeIngress(f.mk('pre-tool', { tool_name: 'Edit' }, { session_id: 'host-1', tool_call_id: 't1', source_identity: 'pre-tool:host-1:t1' }), f.env);
  writeIngress(f.mk('post-tool', { tool_name: 'Edit', write_paths: ['src/a.js'], repo_id: 'demo', success: true }, { session_id: 'host-1', tool_call_id: 't1', source_identity: 'post-tool:host-1:t1' }), f.env);
  w.tick();
  const before = JSON.stringify(w.state.tickets.get(T1));
  await w.stop({ flush: false });
  const w2 = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w2.start();
  assert.equal(JSON.stringify(w2.state.tickets.get(T1)), before);
  assert.equal(w2.state.tickets.get(T1).files_touched_count, 1);
  assert.equal(w2.state.tickets.get(T1).timeline.filter((e) => e.kind === 'write').length, 1);
  w2.flushNotes();
  assert.equal(fs.existsSync(path.join(f.storePath, 'tickets', 'LOCAL-demo-00000001.md')), true);
  await w2.stop();
});

test('redelivered ingress after a crash between journal append and cleanup is harmless', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  const ev = f.ticketEvent();
  writeIngress(ev, f.env);
  w.ingestOnce();
  writeIngress(ev, f.env); // simulate redelivery of the same file
  const n = w.ingestOnce();
  assert.equal(n, 0);
  assert.equal(listIngress(f.env).length, 0);
  const j = new Journal(journalPath(f.env));
  assert.equal(j.open().lastSequence, 1);
  j.close();
  await w.stop();
});

test('MANIFEST only points at a completely written generation and snapshot carries contract collections', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  writeIngress(f.ticketEvent(), f.env);
  w.tick();
  const manifest = readJsonIfExists(path.join(projectionsDir(f.env), 'MANIFEST.json'));
  assert.ok(manifest.generation_id);
  const snapshot = readJsonIfExists(path.join(projectionsDir(f.env), manifest.path, 'snapshot.json'));
  assert.equal(snapshot.generation_id, manifest.generation_id);
  for (const k of ['tickets', 'sessions', 'checkpoints', 'handoffs', 'requests', 'picknext', 'meta', 'capabilities']) assert.ok(k in snapshot, k);
  assert.equal(snapshot.tickets.length, 1);
  assert.equal(snapshot.meta.store_id, f.meta.store_id);
  assert.equal(snapshot.meta.last_sync, null);
  assert.equal(snapshot.capabilities.edit_tickets, true);
  assert.ok(fs.existsSync(path.join(projectionsDir(f.env), 'tickets', `${T1}.json`)));
  assert.equal(readJsonIfExists(path.join(projectionsDir(f.env), 'tickets', `${T1}.json`)).generation_id, manifest.generation_id);
  const live = w.getSnapshot();
  assert.equal(live.generation_id, manifest.generation_id);
  await w.stop();
});

test('heartbeat is refreshed on tick and identity is published for hooks', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  const hb = readJsonIfExists(path.join(f.home, 'state', 'heartbeat.json'));
  assert.equal(hb.store_id, f.meta.store_id);
  const id = readJsonIfExists(path.join(f.home, 'state', 'identity.json'));
  assert.equal(id.machine_id, MACHINE);
  f.advance(6_000);
  w.tick();
  const hb2 = readJsonIfExists(path.join(f.home, 'state', 'heartbeat.json'));
  assert.notEqual(hb2.at, hb.at);
  await w.stop();
});
