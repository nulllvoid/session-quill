// Runs named jobs on cron or interval schedules in the store time zone. Missed slots catch up once,
// each job runs one at a time, and every run is journaled as schedule-run events (ADR 0007).
import { uuid } from '../lib/ids.js';
import { toIso } from '../lib/time.js';
import { normalizeSchedules } from './config.js';
import { nextAfter } from './cron.js';
import { createJobs } from './jobs.js';
import { defaultProviders } from '../reconcile/providers/index.js';
import path from 'node:path';
import { normalizePublishers, destinationOf, KIND_LABELS } from '../publish/config.js';

const CATCH_UP_SLACK_MS = 60_000;
const SCHEDULED_REQUESTS = new Set(['refresh', 'run-job', 'publish']);

export function createSchedulerExtension(ctx, { providers, jobs, stopWaitMs = 5000, artifactClientFor } = {}) {
  const impl = jobs ?? createJobs({ providers: providers ?? defaultProviders(ctx.config, ctx.env), artifactClientFor });
  let worker0 = null;
  let schedules = [];
  let loadedFrom;
  let baselineMs = null;
  const running = new Map();
  const nextCache = new Map();
  // Schedules whose latest run was interrupted by a stop or crash: each reruns once, as a catch-up.
  const rerun = new Set();

  const tz = (worker) => worker.state.meta.timezone || 'UTC';

  function load(worker) {
    loadedFrom = worker.config.schedule;
    const { schedules: list, warnings } = normalizeSchedules(worker.config, { timeZone: tz(worker), now: worker.clock() });
    schedules = list;
    nextCache.clear();
    for (const w of warnings) {
      worker.log(`schedules: ${w}`);
      worker.recordHealthError({ kind: 'config-invalid', error: `schedules: ${w}` });
    }
  }

  function lastRef(worker, s) {
    const rec = worker.state.schedules.get(s.name);
    if (rec && rec.last_started_at) return Date.parse(rec.last_started_at);
    if (s.job === 'reconcile' && worker.state.lastSync) return Date.parse(worker.state.lastSync);
    return null;
  }

  // 0 means due now (an interval schedule that has never run).
  function nextDueMs(worker, s) {
    if (!s.enabled) return null;
    if (rerun.has(s.name)) return 0;
    const ref = lastRef(worker, s);
    if (s.interval_ms) return ref === null ? 0 : ref + s.interval_ms;
    const base = ref ?? baselineMs;
    const key = `${base}:${tz(worker)}`;
    const cached = nextCache.get(s.name);
    if (cached && cached.key === key) return cached.next;
    const next = nextAfter(s.spec, base, tz(worker));
    nextCache.set(s.name, { key, next });
    return next;
  }

  function scheduleForRequest(r) {
    if (r.kind === 'refresh') return schedules.find((s) => s.job === 'reconcile') ?? { name: 'reconcile', job: 'reconcile', enabled: false };
    // Publish now (ADR 0010): an ad hoc run of the publish job for one publisher, or all of them.
    if (r.kind === 'publish') {
      const publisher = r.payload && r.payload.publisher ? r.payload.publisher : null;
      if (publisher && !publishers(worker0).some((p) => p.name === publisher)) return null;
      return { name: `publish:${publisher ?? 'all'}`, job: 'publish', enabled: false, publisher, confirm: !!(r.payload && r.payload.confirm) };
    }
    return schedules.find((s) => s.name === (r.payload && r.payload.schedule)) ?? null;
  }

  function start(worker, s, trigger, requests, { dueMs = null } = {}) {
    const run_id = uuid();
    rerun.delete(s.name);
    for (const r of requests) worker.emit('request-tx', { request_id: r.id, outcome: 'applying' }, { source_identity: `request-tx:${r.id}:applying` });
    worker.emit('schedule-run', { schedule: s.name, job: s.job, run_id, phase: 'started', trigger }, { source_identity: `schedule-run:${run_id}:started` });
    const reason = trigger === 'refresh' ? 'refresh' : trigger === 'manual' ? 'manual' : 'scheduled';
    const promise = (async () => {
      let outcome = 'ok';
      let summary = null;
      let error = null;
      let result = {};
      try {
        result = (await impl[s.job](worker, { run_id, reason, schedule: s.name, settings: s, trigger, due_at: dueMs ? toIso(dueMs) : null })) ?? {};
        summary = result.summary ?? null;
      } catch (err) {
        outcome = 'failed';
        error = err.message;
        worker.log(`job ${s.job} (${s.name}) failed: ${err.stack ?? err.message}`);
      }
      worker.emit('schedule-run', { schedule: s.name, job: s.job, run_id, phase: 'finished', outcome, summary, error }, { source_identity: `schedule-run:${run_id}:finished` });
      // Publishers with on = ["reconcile"] follow every successful reconciliation (ADR 0010).
      if (s.job === 'reconcile' && outcome === 'ok' && !running.has('publish')) {
        const after = publishers(worker).filter((p) => p.after_reconcile).map((p) => p.name);
        if (after.length) start(worker, { name: 'publish:after-reconcile', job: 'publish', enabled: false, publishers: after }, 'after-reconcile', []);
      }
      for (const r of requests) {
        if (outcome === 'ok') {
          worker.emit('request-tx', { request_id: r.id, outcome: 'applied', result: { run_id, last_sync: result.last_sync ?? null }, mutation: { type: 'refresh' } }, { source_identity: `request-tx:${r.id}:applied` });
        } else {
          worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: s.job === 'reconcile' ? 'reconcile-failed' : 'job-failed', message: error, retryable: true, current_revision: null } }, { source_identity: `request-tx:${r.id}:failed` });
        }
      }
      worker.markGenerationDirty();
    })().finally(() => { running.delete(s.job); });
    running.set(s.job, { promise, run_id, schedule: s.name });
  }

  // Publishers from config, re-read when config changes; warnings go to the health log once per load.
  let publisherCache = { from: undefined, list: [] };
  function publishers(worker) {
    if (!worker) return [];
    if (publisherCache.from !== worker.config.publish) {
      const { publishers: list, warnings } = normalizePublishers(worker.config);
      publisherCache = { from: worker.config.publish, list };
      for (const w of warnings) {
        worker.log(`publish: ${w}`);
        worker.recordHealthError({ kind: 'config-invalid', error: `publish: ${w}` });
      }
    }
    return publisherCache.list;
  }

  function publishInfo(worker) {
    const job = running.get('publish');
    return publishers(worker).map((p) => {
      const rec = worker.state.publishers.get(p.name);
      const destination = destinationOf(p);
      const url = (rec && rec.url) || p.url || null;
      return {
        name: p.name, kind: p.kind, label: KIND_LABELS[p.kind], executor: p.executor, title: p.title, fields: p.fields, projects: p.projects, include_links: p.include_links, after_reconcile: p.after_reconcile,
        destination_label: p.kind === 'artifact' ? (url ?? 'a new claude.ai artifact') : path.basename(p.path), url,
        confirmed: !!(rec && rec.confirmed.includes(destination)), running: !!(job && (job.schedule === `publish:${p.name}` || job.schedule === 'publish:all' || job.schedule === 'publish:after-reconcile')),
        last_published_at: rec ? rec.last_published_at : null, last_outcome: rec ? rec.last_outcome : null, last_error: rec ? rec.last_error : null, last_summary: rec ? rec.last_summary : null,
        runs: rec ? rec.runs.slice(0, 5) : [],
      };
    });
  }

  function info(worker) {
    return schedules.map((s) => {
      const rec = worker.state.schedules.get(s.name);
      const next = nextDueMs(worker, s);
      const job = running.get(s.job);
      return {
        name: s.name, job: s.job, cron: s.cron, every: s.every, enabled: s.enabled, running: !!(job && job.schedule === s.name),
        next_due: next === null ? null : toIso(next === 0 ? worker.clock() : next),
        last_started_at: rec ? rec.last_started_at : null, last_finished_at: rec ? rec.last_finished_at : null, last_outcome: rec ? rec.last_outcome : null,
        last_error: rec ? rec.last_error : null, last_summary: rec ? rec.last_summary : null, runs: rec ? rec.runs.slice(0, 10) : [],
      };
    });
  }

  return {
    name: 'reconcile',
    get activeRunId() { const r = running.get('reconcile'); return r ? r.run_id : null; },
    // Waits for every run, including runs started by a run that just finished (publish after reconcile).
    async idle() { while (running.size) await Promise.all([...running.values()].map((r) => r.promise)); },
    async onStart(worker) {
      worker0 = worker;
      worker.publishInfo = () => publishInfo(worker);
      baselineMs = worker.clock();
      load(worker);
      worker.scheduleInfo = () => info(worker);
      for (const rec of worker.state.schedules.values()) {
        if (rec.running_run_id) {
          worker.emit('schedule-run', { schedule: rec.name, job: rec.job, run_id: rec.running_run_id, phase: 'finished', outcome: 'interrupted', error: 'the worker stopped before this run finished' }, { source_identity: `schedule-run:${rec.running_run_id}:interrupted` });
        }
        if (rec.last_outcome === 'interrupted') rerun.add(rec.name);
      }
      // Refresh and Run now requests that were joined to the interrupted run never got a result.
      for (const r of [...worker.state.requests.values()]) {
        if (!SCHEDULED_REQUESTS.has(r.kind) || r.state !== 'applying') continue;
        worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: 'interrupted', message: 'the worker stopped before this run finished; run it again', retryable: true, current_revision: null } }, { source_identity: `request-tx:${r.id}:interrupted` });
      }
    },
    tick(worker) {
      if (baselineMs === null) return;
      if (worker.config.schedule !== loadedFrom) load(worker);
      const nowMs = worker.clock();
      const nowIso = toIso(nowMs);
      const batches = new Map();
      for (const r of worker.state.requests.values()) {
        if (!SCHEDULED_REQUESTS.has(r.kind) || r.state !== 'pending' || (r.not_before ?? nowIso) > nowIso) continue;
        const s = scheduleForRequest(r);
        if (!s) {
          const what = r.kind === 'publish' ? ['publisher-unknown', `no publisher named ${r.payload && r.payload.publisher}`] : ['schedule-unknown', `no schedule named ${r.payload && r.payload.schedule}`];
          worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: what[0], message: what[1], retryable: false, current_revision: null } }, { source_identity: `request-tx:${r.id}:failed` });
          continue;
        }
        if (running.has(s.job)) continue;
        // Requests for the same job join one run; publish runs are per publisher and confirmation.
        const key = s.job === 'publish' ? `${s.name}:${s.confirm}` : s.job;
        if (!batches.has(key)) batches.set(key, { s, trigger: r.kind === 'refresh' ? 'refresh' : 'manual', requests: [] });
        batches.get(key).requests.push(r);
      }
      for (const b of batches.values()) if (!running.has(b.s.job)) start(worker, b.s, b.trigger, b.requests);
      for (const s of schedules) {
        if (!s.enabled || running.has(s.job)) continue;
        const next = nextDueMs(worker, s);
        if (next === null || nowMs < next) continue;
        start(worker, s, rerun.has(s.name) || (next !== 0 && nowMs - next > CATCH_UP_SLACK_MS) ? 'catch-up' : 'schedule', [], { dueMs: next || null });
      }
    },
    async onStop() {
      if (!running.size || stopWaitMs <= 0) return;
      await Promise.race([Promise.all([...running.values()].map((r) => r.promise)), new Promise((r) => setTimeout(r, stopWaitMs).unref())]);
    },
  };
}
