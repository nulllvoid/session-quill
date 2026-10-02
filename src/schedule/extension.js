// Runs named jobs on cron or interval schedules in the store time zone. Missed slots catch up once,
// each job runs one at a time, and every run is journaled as schedule-run events (ADR 0007).
import { uuid } from '../lib/ids.js';
import { toIso } from '../lib/time.js';
import { normalizeSchedules } from './config.js';
import { nextAfter } from './cron.js';
import { createJobs } from './jobs.js';
import { defaultProviders } from '../reconcile/providers/index.js';

const CATCH_UP_SLACK_MS = 60_000;

export function createSchedulerExtension(ctx, { providers, jobs, stopWaitMs = 5000 } = {}) {
  const impl = jobs ?? createJobs({ providers: providers ?? defaultProviders(ctx.config, ctx.env) });
  let schedules = [];
  let loadedFrom;
  let baselineMs = null;
  const running = new Map();
  const nextCache = new Map();

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
    return schedules.find((s) => s.name === (r.payload && r.payload.schedule)) ?? null;
  }

  function start(worker, s, trigger, requests) {
    const run_id = uuid();
    for (const r of requests) worker.emit('request-tx', { request_id: r.id, outcome: 'applying' }, { source_identity: `request-tx:${r.id}:applying` });
    worker.emit('schedule-run', { schedule: s.name, job: s.job, run_id, phase: 'started', trigger }, { source_identity: `schedule-run:${run_id}:started` });
    const reason = trigger === 'refresh' ? 'refresh' : trigger === 'manual' ? 'manual' : 'scheduled';
    const promise = (async () => {
      let outcome = 'ok';
      let summary = null;
      let error = null;
      let result = {};
      try {
        result = (await impl[s.job](worker, { run_id, reason, schedule: s.name })) ?? {};
        summary = result.summary ?? null;
      } catch (err) {
        outcome = 'failed';
        error = err.message;
        worker.log(`job ${s.job} (${s.name}) failed: ${err.stack ?? err.message}`);
      }
      worker.emit('schedule-run', { schedule: s.name, job: s.job, run_id, phase: 'finished', outcome, summary, error }, { source_identity: `schedule-run:${run_id}:finished` });
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
    idle: () => Promise.all([...running.values()].map((r) => r.promise)).then(() => {}),
    async onStart(worker) {
      baselineMs = worker.clock();
      load(worker);
      worker.scheduleInfo = () => info(worker);
      for (const rec of worker.state.schedules.values()) {
        if (rec.running_run_id) {
          worker.emit('schedule-run', { schedule: rec.name, job: rec.job, run_id: rec.running_run_id, phase: 'finished', outcome: 'interrupted', error: 'the worker stopped before this run finished' }, { source_identity: `schedule-run:${rec.running_run_id}:interrupted` });
        }
      }
    },
    tick(worker) {
      if (baselineMs === null) return;
      if (worker.config.schedule !== loadedFrom) load(worker);
      const nowMs = worker.clock();
      const nowIso = toIso(nowMs);
      const batches = new Map();
      for (const r of worker.state.requests.values()) {
        if ((r.kind !== 'refresh' && r.kind !== 'run-job') || r.state !== 'pending' || (r.not_before ?? nowIso) > nowIso) continue;
        const s = scheduleForRequest(r);
        if (!s) {
          worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: 'schedule-unknown', message: `no schedule named ${r.payload && r.payload.schedule}`, retryable: false, current_revision: null } }, { source_identity: `request-tx:${r.id}:failed` });
          continue;
        }
        if (running.has(s.job)) continue;
        if (!batches.has(s.job)) batches.set(s.job, { s, trigger: r.kind === 'refresh' ? 'refresh' : 'manual', requests: [] });
        batches.get(s.job).requests.push(r);
      }
      for (const b of batches.values()) start(worker, b.s, b.trigger, b.requests);
      for (const s of schedules) {
        if (!s.enabled || running.has(s.job)) continue;
        const next = nextDueMs(worker, s);
        if (next === null || nowMs < next) continue;
        start(worker, s, next !== 0 && nowMs - next > CATCH_UP_SLACK_MS ? 'catch-up' : 'schedule', []);
      }
    },
    async onStop() {
      if (!running.size || stopWaitMs <= 0) return;
      await Promise.race([Promise.all([...running.values()].map((r) => r.promise)), new Promise((r) => setTimeout(r, stopWaitMs).unref())]);
    },
  };
}
