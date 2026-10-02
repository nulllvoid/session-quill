import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from '../../src/worker/worker.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { createSchedulerExtension } from '../../src/schedule/extension.js';
import { submitRequest } from '../../src/server/requests.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath } from '../../src/lib/paths.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';

function fixture({ schedule, timezone = 'UTC', start = '2026-10-02T08:00:00Z' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sched-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const config = { ...defaultUserConfig(), store_path: storePath, timezone, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: {} };
  if (schedule) config.schedule = schedule;
  const env = { QUILL_HOME: home };
  saveUserConfig(config, env);
  let nowMs = Date.parse(start);
  return { home, meta, config, env, clock: () => nowMs, set: (iso) => { nowMs = Date.parse(iso); }, advance: (ms) => { nowMs += ms; } };
}

function fakeJobs() {
  const calls = [];
  let gate = null;
  return {
    calls,
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    jobs: { async reconcile(worker, { run_id, reason }) { calls.push({ run_id, reason }); if (gate) await gate; return { summary: `run ${calls.length}` }; } },
  };
}

async function boot(f, fake, extra = {}) {
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, ...extra });
  const ext = createSchedulerExtension({ env: f.env, config: f.config }, { jobs: fake.jobs, stopWaitMs: 0 });
  w.use(ext);
  await w.start();
  return { w, ext, tick: async () => { w.tick(); await ext.idle(); w.tick(); } };
}

test('a cron schedule runs at its slot in the store time zone, journals start and finish, and reports next and last runs', async () => {
  const f = fixture({ timezone: 'Asia/Kolkata', start: '2026-10-02T13:00:00Z', schedule: [{ name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5' }] });
  const fake = fakeJobs();
  const { w, tick } = await boot(f, fake);
  try {
    await tick();
    assert.equal(fake.calls.length, 0, '18:30 in Kolkata is before the slot');
    f.set('2026-10-02T14:00:00Z');
    await tick();
    assert.equal(fake.calls.length, 1);
    const rec = w.state.schedules.get('evening');
    assert.deepEqual([rec.last_outcome, rec.last_summary, rec.runs[0].trigger], ['ok', 'run 1', 'schedule']);
    const info = w.scheduleInfo().find((s) => s.name === 'evening');
    assert.equal(info.next_due, '2026-10-05T14:00:00Z', 'next weekday evening');
    assert.equal(w.snapshotOptions().next_sync_due, '2026-10-05T14:00:00Z');
    const j = new Journal(journalPath(f.env));
    j.open();
    assert.deepEqual([...j.read()].filter((e) => e.kind === 'schedule-run').map((e) => e.payload.phase), ['started', 'finished']);
    j.close();
  } finally { await w.stop(); }
});

test('missed slots while the worker was down catch up once on start, never repeatedly', async () => {
  const f = fixture({ start: '2026-10-02T07:59:00Z', schedule: [{ name: 'hourly', job: 'reconcile', cron: '0 * * * *' }] });
  const fake = fakeJobs();
  const first = await boot(f, fake);
  f.set('2026-10-02T08:00:00Z');
  await first.tick();
  assert.equal(fake.calls.length, 1);
  await first.w.stop();
  f.set('2026-10-02T13:30:00Z');
  const second = await boot(f, fake);
  try {
    await second.tick();
    await second.tick();
    assert.equal(fake.calls.length, 2, 'five missed slots, one catch-up run');
    assert.equal(second.w.state.schedules.get('hourly').runs[0].trigger, 'catch-up');
    assert.equal(second.w.scheduleInfo()[0].next_due, '2026-10-02T14:00:00Z');
  } finally { await second.w.stop(); }
});

test('one run per job at a time: Run now and Refresh queued during a run join the next run of that job', async () => {
  const f = fixture({ schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }] });
  const fake = fakeJobs();
  const release = fake.hold();
  const { w, ext, tick } = await boot(f, fake);
  try {
    w.tick();
    assert.equal(fake.calls.length, 1, 'never run: due at start');
    const manual = submitRequest(w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'reconcile' } }).request;
    assert.equal(manual.not_before, manual.created_at, 'Run now has no undo delay');
    const refresh = submitRequest(w, { id: randomUUID(), kind: 'refresh', target_id: null, expected_revision: null, payload: {} }).request;
    w.tick();
    assert.equal(fake.calls.length, 1, 'the job is still running');
    release();
    await ext.idle();
    await tick();
    assert.equal(fake.calls.length, 2);
    assert.deepEqual([w.state.requests.get(manual.id).state, w.state.requests.get(refresh.id).state], ['applied', 'applied']);
    assert.equal(w.state.requests.get(manual.id).result.run_id, w.state.requests.get(refresh.id).result.run_id);
    assert.throws(() => submitRequest(w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'nope' } }), (e) => e.code === 'schedule-unknown');
  } finally { await w.stop(); }
});

test('an unfinished run is marked interrupted on the next start; a failing job records its error and fails its request', async () => {
  const f = fixture({ schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }] });
  const stuck = fakeJobs();
  stuck.hold();
  const first = await boot(f, stuck);
  first.w.tick();
  await first.w.stop();
  const failing = { calls: [], jobs: { async reconcile() { throw new Error('gh: offline'); } } };
  const second = await boot(f, failing);
  try {
    const rec = second.w.state.schedules.get('reconcile');
    assert.equal(rec.runs.find((r) => r.outcome === 'interrupted').error, 'the worker stopped before this run finished');
    const req = submitRequest(second.w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'reconcile' } }).request;
    await second.tick();
    assert.deepEqual([rec.last_outcome, rec.last_error], ['failed', 'gh: offline']);
    const failed = second.w.state.requests.get(req.id);
    assert.deepEqual([failed.state, failed.error.retryable], ['failed', true]);
  } finally { await second.w.stop(); }
});

test('invalid schedules are reported as health warnings; editing [[schedule]] applies without a restart', async () => {
  const f = fixture({ schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }, { name: 'publish', job: 'publish', cron: '30 19 * * *' }] });
  const fake = fakeJobs();
  const { w } = await boot(f, fake, { identityCheckMs: 0 });
  try {
    assert.match(fs.readFileSync(path.join(f.home, 'state', 'health-errors.jsonl'), 'utf8'), /publish.*later release/);
    assert.deepEqual(w.scheduleInfo().map((s) => s.name), ['reconcile']);
    saveUserConfig({ ...f.config, schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }, { name: 'evening', job: 'reconcile', cron: '0 19 * * *' }] }, f.env);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(f.home, 'config.toml'), later, later);
    w.tick();
    assert.deepEqual(w.scheduleInfo().map((s) => s.name), ['reconcile', 'evening']);
  } finally { await w.stop(); }
});

test('review: a crash mid-run fails its Run now request as interrupted and reruns the schedule once on restart', async () => {
  const f = fixture({ start: '2026-10-02T19:29:00Z', schedule: [{ name: 'evening', job: 'reconcile', cron: '30 19 * * *' }] });
  const stuck = fakeJobs();
  stuck.hold();
  const first = await boot(f, stuck);
  f.set('2026-10-02T19:30:00Z');
  const req = submitRequest(first.w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'evening' } }).request;
  first.w.tick();
  assert.equal(first.w.state.requests.get(req.id).state, 'applying');
  await first.w.stop();
  f.set('2026-10-02T19:31:00Z');
  const fake = fakeJobs();
  const second = await boot(f, fake);
  try {
    const r = second.w.state.requests.get(req.id);
    assert.deepEqual([r.state, r.error.code, r.error.retryable], ['failed', 'interrupted', true]);
    await second.tick();
    await second.tick();
    assert.equal(fake.calls.length, 1, 'one rerun, not one per tick');
    const rec = second.w.state.schedules.get('evening');
    assert.deepEqual([rec.runs[0].trigger, rec.last_outcome], ['catch-up', 'ok']);
    assert.equal(second.w.scheduleInfo()[0].next_due, '2026-10-03T19:30:00Z');
  } finally { await second.w.stop(); }
});
