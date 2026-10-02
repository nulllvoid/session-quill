// The runtime identity the worker publishes for hooks: gate mode, tracker and per-repository
// scopes resolved from user config and each registered repository's .quill.toml, so hooks never
// parse TOML (ADR 0005).
import fs from 'node:fs';
import path from 'node:path';
import { loadRepoConfig, resolveGateMode, resolveTracker } from './config.js';
import { configPath } from '../lib/paths.js';
import { environmentsFromTracker } from '../deploy/environments.js';

// In strict mode an auto-binding unlocks writes, so it requires a prefix allowlist; without one the
// tracker still renders links but nothing binds automatically.
function strictGuard(tracker, mode, where, warnings) {
  if (!tracker || mode !== 'strict' || tracker.prefixes.length || !tracker.sources.length) return tracker;
  warnings.push(`${where}: strict gate mode auto-binds only with tracker.prefixes; auto-binding disabled`);
  return { ...tracker, sources: [] };
}

export function buildRuntimeIdentity({ storeMeta, config }) {
  const warnings = [];
  const user = resolveGateMode(config, null);
  warnings.push(...user.warnings);
  let tracker = null;
  try {
    tracker = strictGuard(resolveTracker(config, null), user.mode, 'user config', warnings);
  } catch (err) {
    warnings.push(`user config: ${err.message}`);
  }
  let environments = null;
  let environmentsError = null;
  try { environments = environmentsFromTracker(config.tracker); } catch (err) { environmentsError = `user config: ${err.message}`; warnings.push(environmentsError); }
  const repos = [];
  for (const [repo_id, r] of Object.entries(config.repos ?? {})) {
    if (!r || !r.canonical_path) continue;
    let repoCfg = null;
    let broken = false;
    try {
      repoCfg = loadRepoConfig(r.canonical_path);
    } catch (err) {
      // An unreadable repository config fails closed: strict, and no tracker until it is fixed.
      broken = true;
      warnings.push(`${repo_id} .quill.toml: ${err.message}; treating the repository as strict`);
    }
    const gate = broken ? { mode: 'strict', warnings: [] } : resolveGateMode(config, repoCfg);
    warnings.push(...gate.warnings.map((w) => `${repo_id}: ${w}`));
    let repoTracker = null;
    if (!broken) {
      try {
        const local = [];
        repoTracker = strictGuard(resolveTracker(config, repoCfg, { warnings: local }), gate.mode, repo_id, warnings);
        warnings.push(...local.map((w) => `${repo_id}: ${w}`));
      } catch (err) {
        warnings.push(`${repo_id}: ${err.message}`);
      }
    }
    // Environments the repository cannot report (unreadable .quill.toml, invalid list) are unresolved,
    // never silently replaced by the user's list (ADR 0009).
    let repoEnvironments = environments;
    let repoEnvironmentsError = environmentsError;
    if (broken) { repoEnvironments = null; repoEnvironmentsError = `${repo_id} .quill.toml could not be read`; } else {
      try { repoEnvironments = environmentsFromTracker(repoCfg && repoCfg.tracker) ?? environments; } catch (err) { repoEnvironments = null; repoEnvironmentsError = `${repo_id}: ${err.message}`; warnings.push(repoEnvironmentsError); }
    }
    repos.push({ repo_id, path: path.resolve(r.canonical_path), project_id: (repoCfg && repoCfg.project_id) || r.project_id || null, gate_mode: gate.mode, tracker: repoTracker, environments: repoEnvironments, environments_error: repoEnvironmentsError });
  }
  const identity = {
    store_id: storeMeta.store_id,
    machine_id: storeMeta.owner_machine_id,
    store_path: config.store_path,
    gate_enabled: config.gate_enabled !== false,
    gate_mode: user.mode,
    approval_phrases_enabled: config.approval_phrases_enabled === true,
    allow_tools: (config.gate && Array.isArray(config.gate.allow_tools)) ? config.gate.allow_tools : [],
    tracker,
    environments,
    environments_error: environmentsError,
    default_project_id: config.default_project || Object.keys(config.projects ?? {})[0] || null,
    repos,
  };
  return { identity, warnings };
}

// Changes to these files republish the identity without restarting the worker.
export function identityStamp(config, env) {
  const files = [configPath(env), ...Object.values(config.repos ?? {}).filter((r) => r && r.canonical_path).map((r) => path.join(r.canonical_path, '.quill.toml'))];
  return files.map((f) => {
    try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:-`; }
  }).join('|');
}
