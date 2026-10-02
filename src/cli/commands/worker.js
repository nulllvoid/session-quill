import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, workerStatus, writeControl } from '../context.js';
import { Worker } from '../../worker/worker.js';
import { isLocked } from '../../worker/lock.js';
import { logsDir } from '../../lib/paths.js';
import { ensureDir } from '../../lib/atomic-fs.js';
import { TrackerError } from '../../lib/errors.js';
import fs from 'node:fs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'tracker.js');

export async function buildWorker(ctx, { log } = {}) {
  const { derive } = await import('../../reconcile/derive.js');
  const w = new Worker({ config: ctx.config, storeMeta: ctx.storeMeta, env: ctx.env, log: log ?? (() => {}), derive });
  await attachExtensions(w, ctx);
  return w;
}

async function attachExtensions(w, ctx) {
  // Later tasks register reconciliation, request transport and handoff extensions here.
  for (const spec of ['../../reconcile/extension.js', '../../server/extension.js', '../../handoff/extension.js']) {
    try {
      const mod = await import(spec);
      if (mod.createExtension) w.use(mod.createExtension(ctx));
    } catch (err) {
      if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
  }
}

export async function runForeground(ctx, io) {
  ensureDir(logsDir(ctx.env));
  const logFile = path.join(logsDir(ctx.env), 'worker.log');
  const log = (msg) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } };
  const w = await buildWorker(ctx, { log });
  await w.start();
  io.println(`worker running for store ${ctx.storeMeta.store_name} (pid ${process.pid}); log: ${logFile}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await w.stop();
    io.println('worker stopped');
  };
  const timer = setInterval(() => {
    try {
      w.tick();
      if (w.stopRequested) stop().then(() => process.exit(0));
    } catch (err) {
      log(`tick error: ${err.stack ?? err.message}`);
    }
  }, 500);
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => stop().then(() => process.exit(0)));
  return new Promise(() => {});
}

export function startDetached(ctx) {
  ensureDir(logsDir(ctx.env));
  const out = fs.openSync(path.join(logsDir(ctx.env), 'worker.out.log'), 'a');
  const child = spawn(process.execPath, [BIN, 'worker', 'run'], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, ...ctx.env },
  });
  child.unref();
  return child.pid;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitHealthy(ctx, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (workerStatus(ctx).healthy) return true;
    await sleep(200);
  }
  return false;
}

export async function run({ args, flags, io, env }) {
  const ctx = loadContext(env);
  const [verb] = args;
  switch (verb) {
    case 'run':
      return runForeground(ctx, io);
    case 'start': {
      if (await isLocked(ctx.storeMeta.store_id, ctx.storeMeta.owner_machine_id, env)) {
        io.println('worker already running');
        return 0;
      }
      if (ctx.storeMeta.owner_machine_id !== ctx.machineId) throw new TrackerError('not-owner', 'this machine does not own the store; copies are read-only until ownership is explicitly transferred');
      const pid = startDetached(ctx);
      const ok = await waitHealthy(ctx, flags.timeout ? Number(flags.timeout) : 10_000);
      io.println(ok ? `worker started (pid ${pid})` : `worker spawned (pid ${pid}) but no heartbeat yet; check ${path.join(logsDir(env), 'worker.out.log')}`);
      return ok ? 0 : 1;
    }
    case 'stop': {
      writeControl(ctx, 'stop.json');
      const started = Date.now();
      while (Date.now() - started < 5000) {
        if (!(await isLocked(ctx.storeMeta.store_id, ctx.storeMeta.owner_machine_id, env))) { io.println('worker stopped'); return 0; }
        await sleep(200);
      }
      io.println('stop requested; worker has not released ownership yet');
      return 1;
    }
    case 'status': {
      const locked = await isLocked(ctx.storeMeta.store_id, ctx.storeMeta.owner_machine_id, env);
      const ws = workerStatus(ctx);
      if (flags.json) { io.json({ locked, ...ws }); return 0; }
      io.println(`ownership lock: ${locked ? 'held' : 'free'}; heartbeat: ${ws.healthy ? 'healthy' : 'stale/none'}${ws.heartbeat_at ? ` (${ws.heartbeat_at})` : ''}`);
      return 0;
    }
    default:
      throw new TrackerError('usage', 'usage: worker run|start|stop|status');
  }
}
