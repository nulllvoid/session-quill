import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseToml, stringifyToml } from './toml.js';
import { configPath } from '../lib/paths.js';
import { readTextIfExists, writeFileAtomic } from '../lib/atomic-fs.js';
import { normalizeTracker } from '../core/external-keys.js';

export const CATEGORIES = ['feature', 'bugfix', 'vuln', 'infra', 'research', 'analysis'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
// The dashboard's preferred loopback port (ADR 0022); 0 asks for a random port each start.
export const DEFAULT_UI_PORT = 47321;
export const APPROVAL_PHRASES = ['approved', 'lgtm', 'go ahead', 'ship it'];

// Fields that only the user config may set. Repository config can never weaken them
// (TRD §Configuration and packaging).
const USER_ONLY_FIELDS = new Set([
  'store_path', 'store_name', 'owner_machine_id', 'machine_name', 'gate_enabled',
  'approval_phrases_enabled', 'handoff_permissions', 'repos', 'projects', 'key_prefix',
  // Run credentials and limits (spec §4.4): a repository must never widen what a run can reach.
  'handoff', 'prod', 'mcp_policy', 'scopes', 'memory',
  // 2.0.0: which files reach a ticket worktree and when it goes (ADR 0036).
  'worktree',
  // ADR 0031: whether an approved critical run must dry-run its pinned writes first.
  'critical',
]);

// `[worktree]` (ADR 0036), user config only: `auto` makes `ticket work|bind` mount a ticket worktree
// without `--worktree`; `copy` lists repository-relative ignored files copied into a new one;
// `keep_days` is how long a done ticket's clean worktree stays. Invalid values keep the default.
export function worktreeConfig(config = {}) {
  const w = config && config.worktree && typeof config.worktree === 'object' && !Array.isArray(config.worktree) ? config.worktree : {};
  return {
    auto: w.auto === true,
    copy: Array.isArray(w.copy) ? w.copy.filter((x) => typeof x === 'string' && x.trim()).slice(0, 50) : ['.env', '.env.local'],
    keep_days: Number.isInteger(w.keep_days) && w.keep_days >= 1 ? w.keep_days : 7,
  };
}

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
    ui_port: DEFAULT_UI_PORT,
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

// Written into every saved user config. A file without it predates the stable dashboard port:
// those releases saved every default, so their `ui_port = 0` was the old default, not a choice.
export const CONFIG_VERSION = 1;

// One-time migration of a pre-marker file (ADR 0022): drop a stored `ui_port = 0` so the fixed
// port applies, and stamp the marker so a 0 the user sets later is kept. Only keys already in the
// file are written back. A file that cannot be rewritten is still migrated in memory.
function migrate(parsed, text, file) {
  if (parsed.config_version !== undefined) return parsed;
  const out = { config_version: CONFIG_VERSION, ...parsed };
  if (out.ui_port === 0) delete out.ui_port;
  try { writeFileAtomic(file, stringifyToml(out, { preserve: text })); } catch { /* read-only home */ }
  return out;
}

export function loadUserConfig(env = process.env) {
  const file = configPath(env);
  const text = readTextIfExists(file);
  const defaults = defaultUserConfig();
  if (text === null) return defaults;
  return mergeDefaults(defaults, migrate(parseToml(text), text, file));
}

export function saveUserConfig(cfg, env = process.env) {
  const file = configPath(env);
  const existing = readTextIfExists(file);
  const previous = existing ?? '# Session Quill user configuration\n# Secrets never belong here; use your credential store or environment.\n';
  const { config_version: _version, ...rest } = cfg;
  const out = { config_version: CONFIG_VERSION, ...rest };
  // An untouched default port is not pinned, so a later release can move the default.
  let wroteBefore = false;
  try { wroteBefore = existing !== null && parseToml(existing).ui_port !== undefined; } catch { /* unparsable: rewrite */ }
  if (out.ui_port === DEFAULT_UI_PORT && !wroteBefore) delete out.ui_port;
  writeFileAtomic(file, stringifyToml(out, { preserve: previous }));
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

/**
 * `[critical]` (ADR 0031): `require_dry_run` (default true) makes an approved critical run's pinned
 * k8s.write or db.write action wait for its server-side dry run. Only an explicit `false` turns it
 * off; any other value keeps it on. User config only.
 */
export function criticalSettings(config = {}) {
  const c = config && typeof config.critical === 'object' && config.critical !== null ? config.critical : {};
  return { requireDryRun: c.require_dry_run !== false };
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
// `environments` is deployment config, not key recognition (ADR 0009): a table holding only it is no tracker.
function bindingTable(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return t ?? null;
  // Onboarding settings (ADR 0024) are not key recognition either.
  const { environments, sync_token_env, sync_username_env, import_assigned, auto_clone_dir, clone_hosts, repo_map, ...rest } = t;
  return Object.keys(rest).length ? rest : null;
}

export function resolveTracker(user = {}, repo = null, { warnings = [] } = {}) {
  const u = bindingTable(user && user.tracker);
  const r = bindingTable(repo && repo.tracker);
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

// `[repos.<id>] critical_paths` and `config_globs` (ADR 0033): glob lists that only count a run's
// changed files on its evidence receipt. A value that is not a list of non-empty strings is
// ignored: `critical_paths` then means "none configured" and `config_globs` the built-in list.
export const MAX_CHANGE_GLOBS = 100;
export function changeGlobs(repo) {
  const list = (v) => (Array.isArray(v) && v.length && v.every((g) => typeof g === 'string' && g.trim() && g.length <= 300) ? v.slice(0, MAX_CHANGE_GLOBS).map((g) => g.trim()) : null);
  return { critical_paths: list(repo && repo.critical_paths), config_globs: list(repo && repo.config_globs) };
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
