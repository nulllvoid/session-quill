// The runtime identity the worker publishes for hooks: gate mode, tracker and per-repository
// scopes resolved from user config and each registered repository's .quill.toml, so hooks never
// parse TOML (ADR 0005).
import fs from 'node:fs';
import path from 'node:path';
import { loadRepoConfig, resolveGateMode, resolveTracker } from './config.js';
import { configPath } from '../lib/paths.js';

export function buildRuntimeIdentity({ storeMeta, config }) {
  const warnings = [];
  const user = resolveGateMode(config, null);
  warnings.push(...user.warnings);
  let tracker = null;
  try {
    tracker = resolveTracker(config, null);
  } catch (err) {
    warnings.push(`user config: ${err.message}`);
  }
  const repos = [];
  for (const [repo_id, r] of Object.entries(config.repos ?? {})) {
    if (!r || !r.canonical_path) continue;
    let repoCfg = null;
    try {
      repoCfg = loadRepoConfig(r.canonical_path);
    } catch (err) {
      warnings.push(`${repo_id} .quill.toml: ${err.message}`);
    }
    const gate = resolveGateMode(config, repoCfg);
    warnings.push(...gate.warnings.map((w) => `${repo_id}: ${w}`));
    let repoTracker = null;
    try {
      repoTracker = resolveTracker(config, repoCfg);
    } catch (err) {
      warnings.push(`${repo_id}: ${err.message}`);
    }
    repos.push({ repo_id, path: path.resolve(r.canonical_path), project_id: (repoCfg && repoCfg.project_id) || r.project_id || null, gate_mode: gate.mode, tracker: repoTracker });
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
