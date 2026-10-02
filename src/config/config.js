import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseToml, stringifyToml } from './toml.js';
import { configPath } from '../lib/paths.js';
import { readTextIfExists, writeFileAtomic } from '../lib/atomic-fs.js';
import { normalizeTracker } from '../core/external-keys.js';

export const CATEGORIES = ['feature', 'bugfix', 'vuln', 'infra', 'research', 'analysis'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const APPROVAL_PHRASES = ['approved', 'lgtm', 'go ahead', 'ship it'];

// Fields that only the user config may set. Repository config can never weaken them
// (TRD §Configuration and packaging).
const USER_ONLY_FIELDS = new Set([
  'store_path', 'store_name', 'owner_machine_id', 'machine_name', 'gate_enabled',
  'approval_phrases_enabled', 'handoff_permissions', 'repos', 'projects', 'key_prefix',
]);

export function defaultUserConfig() {
  return {
    store_path: '',
    store_name: 'Quill',
    machine_name: os.hostname(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    key_prefix: 'LOCAL',
    default_category: 'research',
    default_project: '',
    gate_enabled: true,
    approval_phrases_enabled: false,
    sync_interval_hours: 2,
    stale_days: 5,
    ui_port: 0,
    gate: { allow_tools: [], mode: 'nudge' },
    projects: {},
    repos: {},
  };
}

function mergeDefaults(base, loaded) {
  const out = { ...base };
  for (const [k, v] of Object.entries(loaded)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && !['projects', 'repos'].includes(k)) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadUserConfig(env = process.env) {
  const text = readTextIfExists(configPath(env));
  const defaults = defaultUserConfig();
  if (text === null) return defaults;
  return mergeDefaults(defaults, parseToml(text));
}

export function saveUserConfig(cfg, env = process.env) {
  const file = configPath(env);
  const previous = readTextIfExists(file) ?? '# Session Quill user configuration\n# Secrets never belong here; use your credential store or environment.\n';
  writeFileAtomic(file, stringifyToml(cfg, { preserve: previous }));
  return file;
}

export function loadRepoConfig(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, '.quill.toml');
    if (fs.existsSync(file)) {
      const parsed = parseToml(fs.readFileSync(file, 'utf8'));
      const safe = {};
      for (const [k, v] of Object.entries(parsed)) if (!USER_ONLY_FIELDS.has(k)) safe[k] = v;
      return safe;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function saveRepoConfig(repoDir, cfg) {
  const file = path.join(repoDir, '.quill.toml');
  const previous = readTextIfExists(file) ?? '# Session Quill repository defaults (safe to commit; no secrets, no ownership)\n';
  writeFileAtomic(file, stringifyToml(cfg, { preserve: previous }));
  return file;
}

export function resolveConfig({ cli = {}, session = {}, repo = {}, user = {} } = {}) {
  const safeRepo = {};
  for (const [k, v] of Object.entries(repo || {})) if (!USER_ONLY_FIELDS.has(k)) safeRepo[k] = v;
  const pick = (k) => cli[k] ?? session[k] ?? safeRepo[k] ?? user[k];
  return {
    project_id: pick('project_id') ?? user.default_project ?? undefined,
    category: pick('category') ?? user.default_category ?? 'research',
    repo_id: pick('repo_id'),
    priority: pick('priority') ?? 'P2',
    key_prefix: user.key_prefix ?? 'LOCAL',
    timezone: user.timezone ?? 'UTC',
  };
}

export const GATE_MODES = ['off', 'nudge', 'strict'];
const GATE_RANK = { off: 0, nudge: 1, strict: 2 };

// Effective gate mode (ADR 0005). The user picks off, nudge or strict (legacy gate_enabled = false
// means off). A repository may only tighten it; an unrecognized value fails closed to strict.
export function resolveGateMode(user = {}, repo = null) {
  const warnings = [];
  const read = (cfg, where) => {
    const mode = cfg && cfg.gate && cfg.gate.mode;
    if (mode === undefined || mode === null) return null;
    if (!GATE_MODES.includes(mode)) {
      warnings.push(`${where} gate.mode "${mode}" is not one of ${GATE_MODES.join(', ')}; using strict`);
      return 'strict';
    }
    return mode;
  };
  let mode = user && user.gate_enabled === false ? 'off' : (read(user, 'user config') ?? 'nudge');
  const repoMode = read(repo, '.quill.toml');
  if (repoMode && GATE_RANK[repoMode] > GATE_RANK[mode]) mode = repoMode;
  return { mode, warnings };
}

// Repository [tracker] values override user values field by field; the result is validated. When
// the user has a prefix allowlist, a repository may only narrow it: an empty or missing repo list
// keeps the user's, and a list with no shared prefix disables auto-binding instead of widening it.
export function resolveTracker(user = {}, repo = null, { warnings = [] } = {}) {
  const u = user && user.tracker;
  const r = repo && repo.tracker;
  if (!u && !r) return null;
  const merged = normalizeTracker({ ...(u ?? {}), ...(r ?? {}) });
  const userPrefixes = u ? normalizeTracker(u).prefixes : [];
  if (userPrefixes.length) {
    const repoPrefixes = r && Array.isArray(r.prefixes) ? merged.prefixes : [];
    if (!repoPrefixes.length) {
      merged.prefixes = userPrefixes;
    } else {
      merged.prefixes = repoPrefixes.filter((p) => userPrefixes.includes(p));
      if (!merged.prefixes.length) {
        merged.prefixes = userPrefixes;
        merged.sources = [];
        warnings.push('.quill.toml tracker.prefixes share no prefix with the user allowlist; auto-binding disabled');
      }
    }
  }
  return merged;
}

export function findRepoByPath(cfg, cwd) {
  const resolved = path.resolve(cwd).toLowerCase();
  for (const [id, repo] of Object.entries(cfg.repos || {})) {
    if (!repo.canonical_path) continue;
    const canon = path.resolve(repo.canonical_path).toLowerCase();
    if (resolved === canon || resolved.startsWith(canon + path.sep)) return { id, ...repo };
  }
  return null;
}
