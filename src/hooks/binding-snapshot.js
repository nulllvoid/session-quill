import path from 'node:path';
import { bindingsDir, heartbeatPath, stateDir, configPath } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic, readTextIfExists } from '../lib/atomic-fs.js';
import { ageMs } from '../lib/time.js';
import { parseToml } from '../config/toml.js';

export const HEARTBEAT_MAX_AGE_MS = 15_000;

export function snapshotFileName(sessionKey) {
  return `${String(sessionKey).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

export function bindingSnapshotPath(sessionKey, env = process.env) {
  return path.join(bindingsDir(env), snapshotFileName(sessionKey));
}

export function readBindingSnapshot(sessionKey, env = process.env) {
  try {
    return readJsonIfExists(bindingSnapshotPath(sessionKey, env));
  } catch {
    return null;
  }
}

export function writeBindingSnapshot(sessionKey, snapshot, env = process.env) {
  writeJsonAtomic(bindingSnapshotPath(sessionKey, env), { schema_version: 1, session_key: sessionKey, ...snapshot });
}

export function writeHeartbeat(record, env = process.env) {
  writeJsonAtomic(heartbeatPath(env), record);
}

export function readHeartbeat(env = process.env, now) {
  let hb = null;
  try {
    hb = readJsonIfExists(heartbeatPath(env));
  } catch {
    hb = null;
  }
  if (!hb || !hb.at) return { healthy: false, heartbeat: null, ageMs: null };
  let age;
  try {
    age = ageMs(hb.at, now);
  } catch {
    return { healthy: false, heartbeat: hb, ageMs: null };
  }
  return { healthy: age >= -HEARTBEAT_MAX_AGE_MS && age <= HEARTBEAT_MAX_AGE_MS, heartbeat: hb, ageMs: age };
}

export function identityPath(env = process.env) {
  return path.join(stateDir(env), 'identity.json');
}

// The worker publishes one small identity file so hooks never parse config or scan the journal.
export function writeRuntimeIdentity(identity, env = process.env) {
  writeJsonAtomic(identityPath(env), { schema_version: 1, ...identity });
}

export function readRuntimeIdentity(env = process.env) {
  try {
    const id = readJsonIfExists(identityPath(env));
    if (id && id.store_id && id.machine_id) return id;
  } catch { /* fall through */ }
  // Fallback for a configured tracker whose worker has not yet published identity.
  const cfgText = readTextIfExists(configPath(env));
  if (!cfgText) return null;
  let cfg;
  try {
    cfg = parseToml(cfgText);
  } catch {
    return null;
  }
  if (!cfg.store_path) return null;
  const meta = readJsonIfExists(path.join(cfg.store_path, 'store.json'));
  const machine = readJsonIfExists(path.join(stateDir(env), '..', 'machine.json'));
  if (!meta || !machine) return null;
  return {
    store_id: meta.store_id,
    machine_id: machine.machine_id,
    store_path: cfg.store_path,
    gate_enabled: cfg.gate_enabled !== false,
    approval_phrases_enabled: cfg.approval_phrases_enabled === true,
    allow_tools: (cfg.gate && Array.isArray(cfg.gate.allow_tools)) ? cfg.gate.allow_tools : [],
  };
}

export function planClaimPath(sessionKey, env = process.env) {
  return path.join(stateDir(env), 'plan-paths', snapshotFileName(sessionKey));
}

export function readPlanClaim(sessionKey, env = process.env) {
  try {
    return readJsonIfExists(planClaimPath(sessionKey, env));
  } catch {
    return null;
  }
}

export function writePlanClaim(sessionKey, planPath, env = process.env) {
  writeJsonAtomic(planClaimPath(sessionKey, env), { schema_version: 1, session_key: sessionKey, plan_path: planPath });
}
