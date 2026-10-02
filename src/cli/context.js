import fs from 'node:fs';
import path from 'node:path';
import { loadUserConfig, loadRepoConfig, resolveConfig } from '../config/config.js';
import { loadStoreMeta, ensureMachineId } from '../config/store.js';
import { makeEvent } from '../core/events.js';
import { writeIngress } from '../core/ingress.js';
import { stateDir, projectionsDir } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic, ensureDir } from '../lib/atomic-fs.js';
import { readHeartbeat } from '../hooks/binding-snapshot.js';
import { TrackerError } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';

export const COMMAND_NAMESPACE = 'session-tracker';

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export class Io {
  constructor({ stdout, stderr, stdin } = {}) {
    this.out = stdout ?? ((s) => process.stdout.write(s));
    this.err = stderr ?? ((s) => process.stderr.write(s));
    this.readStdin = stdin ?? (async () => {
      if (process.stdin.isTTY) return '';
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    });
  }

  println(s = '') { this.out(`${s}\n`); }

  error(s) { this.err(`${s}\n`); }

  json(obj) { this.out(`${JSON.stringify(obj, null, 2)}\n`); }
}

export function loadContext(env = process.env, { requireStore = true } = {}) {
  const config = loadUserConfig(env);
  const machineId = ensureMachineId(env);
  let storeMeta = null;
  if (config.store_path) {
    try {
      storeMeta = loadStoreMeta(config.store_path);
    } catch (err) {
      throw new TrackerError('store-unreadable', `cannot read store at ${config.store_path}: ${err.message}`);
    }
  }
  if (requireStore && !storeMeta) {
    throw new TrackerError('not-initialized', 'Session Tracker is not initialized. Run `tracker init` first.');
  }
  return { env, config, machineId, storeMeta, initialized: !!storeMeta };
}

export function sessionFromFlags(flags, env = process.env) {
  const session_id = flags.session ?? env.TRACKER_SESSION_ID ?? null;
  const agent_id = flags.agent ?? null;
  if (!session_id || typeof session_id !== 'string') {
    throw new TrackerError('session-required', 'a session id is required: pass --session <id> (the SessionStart hook injects "Session Tracker session: <id>" into context).');
  }
  return { session_id, agent_id: agent_id || null };
}

export function workerStatus(ctx) {
  const hb = readHeartbeat(ctx.env, nowIso());
  return { healthy: hb.healthy, heartbeat_at: hb.heartbeat ? hb.heartbeat.at : null, age_ms: hb.ageMs, pid: hb.heartbeat ? hb.heartbeat.pid : null };
}

export function cliEvent(ctx, { kind, payload, session, ticket_id = null, source_identity }) {
  return makeEvent({
    kind, payload, store_id: ctx.storeMeta.store_id, machine_id: ctx.machineId, producer: 'cli',
    session_id: session ? session.session_id : null, agent_id: session ? session.agent_id : null, ticket_id, source_identity, occurred_at: nowIso(),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bind/create/relink wait for a worker-confirmed result; an offline command never pretends the
// change happened (TRD §Durability 7).
export async function submitAndWait(ctx, ev, { timeoutMs = 10_000 } = {}) {
  const ackFile = path.join(stateDir(ctx.env), 'acks', `${ev.event_id}.json`);
  writeIngress(ev, ctx.env);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ack = readJsonIfExists(ackFile);
    if (ack) {
      try { fs.unlinkSync(ackFile); } catch { /* ignore */ }
      return ack;
    }
    await sleep(40);
  }
  const ws = workerStatus(ctx);
  throw new TrackerError('worker-unavailable', `the tracker worker did not confirm the change within ${timeoutMs} ms (worker ${ws.healthy ? 'is running but slow' : 'is not running'}). The event is persisted in ingress and will apply when the worker runs. Start it with \`tracker worker start\` and check \`tracker doctor\`.`);
}

export function writeControl(ctx, name, payload = {}) {
  const dir = path.join(stateDir(ctx.env), 'control');
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, name), { at: nowIso(), ...payload });
}

export function latestSnapshot(ctx) {
  const manifest = readJsonIfExists(path.join(projectionsDir(ctx.env), 'MANIFEST.json'));
  if (!manifest) return null;
  return readJsonIfExists(path.join(projectionsDir(ctx.env), manifest.path, 'snapshot.json'));
}

export function latestTicketDetail(ctx, ticketId) {
  const manifest = readJsonIfExists(path.join(projectionsDir(ctx.env), 'MANIFEST.json'));
  if (!manifest) return null;
  return readJsonIfExists(path.join(projectionsDir(ctx.env), manifest.path, 'tickets', `${ticketId}.json`));
}

export function findTicketByKey(ctx, key) {
  const snap = latestSnapshot(ctx);
  if (!snap) return null;
  return snap.tickets.find((t) => t.key === key || (t.aliases ?? []).includes(key)) ?? null;
}

export function effectiveDefaults(ctx, cwd, flags) {
  const repo = loadRepoConfig(cwd);
  return resolveConfig({ cli: { category: flags.category, project_id: flags.project, repo_id: flags.repo, priority: flags.priority }, repo: repo ?? {}, user: ctx.config });
}

export function commandName(name) {
  return `/${COMMAND_NAMESPACE}:${name}`;
}
