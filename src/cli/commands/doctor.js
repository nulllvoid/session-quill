import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadContext, workerStatus, commandName } from '../context.js';
import { isLocked } from '../../worker/lock.js';
import { Journal } from '../../core/journal.js';
import { journalPath, ingressDir } from '../../lib/paths.js';
import { countIngress } from '../../core/ingress.js';
import { readHealthErrors } from '../../worker/health.js';
import { repoStatus, REPO_STATUS_TEXT } from '../../config/repos.js';

export const MIN_NODE_MAJOR = 22;

function version(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

export async function collect(env) {
  const ctx = loadContext(env, { requireStore: false });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const report = { ok: true, items: [] };
  const add = (level, label, detail) => {
    report.items.push({ level, label, detail });
    if (level === 'error') report.ok = false;
  };
  add(nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'error', 'node', `${process.versions.node}${nodeMajor >= MIN_NODE_MAJOR ? '' : ` (requires >= ${MIN_NODE_MAJOR} LTS; Node is not bundled with Claude Code)`}`);
  const git = version('git', ['--version']);
  add(git ? 'ok' : 'warn', 'git', git ?? 'not found (required for handoff fixes)');
  const claude = version(process.platform === 'win32' ? 'claude.exe' : 'claude', ['--version']) ?? version('claude', ['--version']);
  add(claude ? 'ok' : 'warn', 'claude', claude ?? 'not found (required for handoffs)');
  add('ok', 'platform', `${process.platform} ${process.arch}`);
  add('ok', 'commands', `${commandName('ticket')}, ${commandName('approve')}, ${commandName('status')}, ${commandName('handoff')}`);
  if (!ctx.initialized) {
    add('error', 'store', 'not enabled — run /session-quill:start (or quill start)');
    return { ctx, report };
  }
  const owner = ctx.storeMeta.owner_machine_id === ctx.machineId;
  add(owner ? 'ok' : 'warn', 'ownership', owner ? 'this machine' : `another machine (${ctx.storeMeta.owner_machine_id}); this copy is read-only until explicitly transferred`);
  add('ok', 'store', `${ctx.storeMeta.store_name} at ${ctx.config.store_path} (store ${ctx.storeMeta.store_id})`);
  const locked = await isLocked(ctx.storeMeta.store_id, ctx.storeMeta.owner_machine_id, env);
  const ws = workerStatus(ctx);
  if (ws.healthy && locked) add('ok', 'worker', `healthy (pid ${ws.pid}, heartbeat ${ws.heartbeat_at})`);
  else if (locked) add('warn', 'worker', `lock held but heartbeat stale (${ws.age_ms ?? 'none'} ms)`);
  else add(owner ? 'error' : 'warn', 'worker', `unavailable — start with \`quill worker start\`${ws.heartbeat_at ? ` (last heartbeat ${ws.heartbeat_at})` : ''}`);
  const backlog = countIngress(env);
  add(backlog > 100 ? 'warn' : 'ok', 'ingress backlog', `${backlog} pending event(s) in ${ingressDir(env)}`);
  const j = new Journal(journalPath(env));
  let info;
  try {
    info = fs.existsSync(journalPath(env)) ? j.open() : { lastSequence: 0, quarantined: false, corrupt: false };
    j.close();
  } catch (err) {
    info = { corrupt: true, error: err.message };
  }
  add(info.corrupt ? 'error' : 'ok', 'journal', info.corrupt ? 'mid-log corruption: recovery required (restore from backup; ingress is retained)' : `${info.lastSequence} event(s)${info.quarantined ? ', torn tail quarantined' : ''}`);
  const errors = readHealthErrors(env, { limit: 10 });
  const gaps = errors.filter((e) => e.kind === 'capture-gap');
  add(gaps.length ? 'warn' : 'ok', 'capture', gaps.length ? `${gaps.length} recent capture gap(s); last: ${gaps[gaps.length - 1].error}` : 'no recent capture gaps');
  for (const [id, repo] of Object.entries(ctx.config.repos ?? {})) {
    const status = repoStatus(repo);
    if (status !== 'ok') add('warn', `repo ${id}`, `${repo.canonical_path ?? ''} ${REPO_STATUS_TEXT[status]} (fix the path with quill repo add, or quill repo remove ${id})`.trim());
  }
  return { ctx, report };
}

export async function run({ flags, io, env }) {
  const { report } = await collect(env);
  if (flags.json) { io.json(report); return report.ok ? 0 : 1; }
  for (const item of report.items) {
    const mark = item.level === 'ok' ? '✓' : item.level === 'warn' ? '!' : '✗';
    io.println(`${mark} ${item.label}: ${item.detail}`);
  }
  io.println(report.ok ? 'doctor: OK' : 'doctor: problems found');
  return report.ok ? 0 : 1;
}
