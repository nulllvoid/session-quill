import fs from 'node:fs';
import path from 'node:path';
import { loadContext, workerStatus } from '../cli/context.js';
import { startDetached } from '../cli/commands/worker.js';
import { acquireLock, isLocked } from '../worker/lock.js';
import { runDir, stateDir } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';
import { TrackerError } from '../lib/errors.js';

export const pausePath = (env) => path.join(runDir(env), 'worker-paused.json');
const attemptPath = (env) => path.join(runDir(env), 'worker-start-attempt.json');

// Both hook and interactive entry points share the same owner checks and crash backoff.
// The OS lock serializes launch decisions; the worker still takes its own lifetime lock.
export async function ensureReady(ctx = loadContext(), { wait = true, resume = false, dashboard = false, timeoutMs = 10000 } = {}) {
  if (!ctx.initialized && !ctx.storeMeta) throw new TrackerError('not-initialized', 'Enable Quill here with /session-quill:start (or quill start).');
  if (ctx.storeMeta.owner_machine_id !== ctx.machineId) throw new TrackerError('not-owner', 'This machine does not own the store; it belongs to another machine. Its local copy remains read-only.');
  const paused = () => fs.existsSync(pausePath(ctx.env));
  if (!resume && paused()) throw new TrackerError('worker-paused', 'Quill processing is paused. Run /session-quill:start (or quill start) to resume.');
  const locked = () => isLocked(ctx.storeMeta.store_id, ctx.machineId, ctx.env);
  const ready = async () => {
    if (!(await locked())) return false;
    const status = workerStatus(ctx);
    if (dashboard && readJsonIfExists(path.join(stateDir(ctx.env), 'ui-endpoint.json'))?.pid !== status.pid) return false;
    const attempt = readJsonIfExists(attemptPath(ctx.env));
    return status.healthy && (!attempt || attempt.store_id !== ctx.storeMeta.store_id ||
      (status.pid === attempt.pid || Date.parse(status.heartbeat_at) >= attempt.at));
  };
  const waitReady = async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await ready()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  if (!resume && await ready()) return { state: 'ready' };
  let lock;
  try {
    lock = await acquireLock(`${ctx.storeMeta.store_id}-startup`, ctx.machineId, ctx.env);
  } catch (err) {
    if (err.code !== 'lock-held') throw err;
    if (!wait) return { state: 'starting' };
    if (await waitReady()) return { state: 'ready' };
    throw new TrackerError('worker-starting', 'Quill is still starting. Try again shortly; use quill doctor if it keeps failing.');
  }
  try {
    if (resume) {
      if (paused()) fs.rmSync(attemptPath(ctx.env), { force: true });
      fs.rmSync(pausePath(ctx.env), { force: true });
      // A stopped worker may not have consumed its control message yet.
      fs.rmSync(path.join(stateDir(ctx.env), 'control', 'stop.json'), { force: true });
    } else if (paused()) {
      throw new TrackerError('worker-paused', 'Quill processing is paused. Run /session-quill:start to resume.');
    }
    if (await ready()) return { state: 'ready' };
    if (!(await locked())) {
      const last = readJsonIfExists(attemptPath(ctx.env));
      if (last?.store_id === ctx.storeMeta.store_id && Date.now() - last.at < 30000) {
        // Wait for a recent launch, but never launch a second copy during backoff.
        if (!wait) return { state: 'starting' };
      } else {
        const attempt = { store_id: ctx.storeMeta.store_id, at: Date.now() };
        writeJsonAtomic(attemptPath(ctx.env), attempt);
        const pid = await startDetached(ctx);
        writeJsonAtomic(attemptPath(ctx.env), { ...attempt, pid });
      }
    }
    if (!wait) return { state: 'starting' };
    // Heartbeats can outlive their process: require both health and a live owner lock.
    if (await waitReady()) return { state: 'ready' };
    throw new TrackerError('worker-unavailable', 'Quill could not get ready. Local activity already captured remains saved. Run quill doctor for details; automatic retries are limited to once every 30 seconds.');
  } finally {
    await lock.release();
  }
}
