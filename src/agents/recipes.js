// Agent recipes (ADR 0008): Markdown files with frontmatter and a prompt template, in a
// repository's `.quill/agents/`, the personal `~/.claude/quill/agents/`, or the plugin's own
// `recipes/`. Repository recipes win over personal ones, which win over built-ins. Frontmatter
// permissions are a ceiling: a run may be granted less, never more.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.js';
import { MODES } from '../handoff/permissions.js';
import { allowedToolsFor, toolPermitted } from '../handoff/runner.js';
import { quillHome } from '../lib/paths.js';

export const BUILTIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'recipes');
export const PERMISSION_KEYS = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr'];
const PERMISSION_ALIASES = { push: 'push_branch', draft_pr: 'open_draft_pr' };
export const INPUTS = ['ticket', 'notes', 'prs', 'deployments'];
export const OUTPUTS = ['summary', 'next_action', 'blocker', 'followups', 'deploy_evidence', 'comment_draft', 'test_results', 'changed_files'];
export const PLACEHOLDERS = ['ticket.key', 'ticket.url', 'ticket.title', 'ticket.status', 'ticket.next_action', 'note', 'prs', 'deployments', 'environments'];
export const MAX_TIMEOUT_MIN = 20;
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_FILE_BYTES = 32 * 1024;
const PLACEHOLDER_RE = /\{\{\s*([a-z_.]+)\s*\}\}/g;
const SOURCES = ['builtin', 'personal', 'repo'];

function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function list(value, field, allowed, fallback) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  for (const v of value) if (!allowed.includes(v)) throw new Error(`unknown ${field.replace(/s$/, '')} "${v}"; use ${allowed.join(', ')}`);
  return [...new Set(value)];
}

function permissionsFrom(raw, mode) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('permissions must be a map such as { read_source: true }');
  const out = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = PERMISSION_ALIASES[k] ?? k;
    if (!PERMISSION_KEYS.includes(key)) throw new Error(`unknown permission "${k}"; use ${PERMISSION_KEYS.join(', ')}`);
    if (typeof v !== 'boolean') throw new Error(`permission ${k} must be true or false`);
    out[key] = out[key] || v;
  }
  if (out.edit_source && !out.read_source) throw new Error('edit_source requires read_source');
  if (out.edit_source && mode !== 'attempt-fix') throw new Error('edit_source requires mode attempt-fix');
  if (out.commit && !out.edit_source) throw new Error('commit requires edit_source');
  if (out.push_branch && !out.commit) throw new Error('push_branch requires commit');
  if (out.open_draft_pr && !out.push_branch) throw new Error('open_draft_pr requires push_branch');
  if (mode === 'attempt-fix' && !(out.read_source && out.edit_source)) throw new Error('mode attempt-fix requires read_source and edit_source');
  return out;
}

export function normalizeRecipe({ name, text, source, path: filePath = null }) {
  const base = { name, source, path: filePath, hash: hashOf(String(text)), error: null };
  try {
    if (!SOURCES.includes(source)) throw new Error(`unknown recipe source ${source}`);
    if (!NAME_RE.test(name)) throw new Error('recipe file names use lowercase letters, digits and dashes');
    const { data, body } = parseFrontmatter(text);
    if (data.name !== name) throw new Error(`name "${data.name ?? ''}" must match the file name "${name}"`);
    if (typeof data.description !== 'string' || !data.description.trim()) throw new Error('description is required');
    const mode = data.mode ?? 'analyse';
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    const permissions = permissionsFrom(data.permissions, mode);
    let tools = null;
    if (data.tools !== undefined && data.tools !== null) {
      if (!Array.isArray(data.tools) || data.tools.some((t) => typeof t !== 'string')) throw new Error('tools must be a list of tool names');
      for (const t of data.tools) if (!toolPermitted(t, { mode, permissions })) throw new Error(`tool "${t}" needs more than this recipe's permissions allow`);
      tools = [...data.tools];
    }
    const timeout = data.timeout_min ?? MAX_TIMEOUT_MIN;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MIN) throw new Error(`timeout_min must be a whole number from 1 to ${MAX_TIMEOUT_MIN}`);
    const inputs = list(data.inputs, 'inputs', INPUTS, INPUTS);
    const outputs = list(data.outputs, 'outputs', OUTPUTS, ['summary', 'next_action']);
    if (!body.trim()) throw new Error('the prompt body is empty');
    for (const m of body.matchAll(PLACEHOLDER_RE)) if (!PLACEHOLDERS.includes(m[1])) throw new Error(`unknown placeholder {{${m[1]}}}; use ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`);
    return {
      ...base, description: data.description.trim().slice(0, 300), mode, permissions, tools, timeout_min: timeout, inputs, outputs, body: body.trim(),
      // Only Quill's own handoff modes keep applying results directly; every other recipe suggests.
      legacy: source === 'builtin' && MODES.includes(name),
      schedulable: mode !== 'attempt-fix',
    };
  } catch (err) {
    return { ...base, description: '', mode: null, permissions: null, tools: null, timeout_min: null, inputs: [], outputs: [], body: '', legacy: false, schedulable: false, error: err.message };
  }
}

function readDir(dir, source) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const file of names.sort()) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    const name = file.slice(0, -3);
    let text;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) { out.push({ ...normalizeRecipe({ name, text: '', source, path: full }), error: `recipe file exceeds ${MAX_FILE_BYTES / 1024} KiB` }); continue; }
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      out.push({ ...normalizeRecipe({ name, text: '', source, path: full }), error: `could not read the recipe: ${err.message}` });
      continue;
    }
    out.push(normalizeRecipe({ name, text, source, path: full }));
  }
  return out;
}

export function personalRecipesDir(env) {
  return path.join(quillHome(env), 'agents');
}

export function repoRecipesDir(repoPath) {
  return path.join(repoPath, '.quill', 'agents');
}

export function loadRecipes({ env = process.env, repoPath = null, builtinDir = BUILTIN_DIR } = {}) {
  const layers = [readDir(builtinDir, 'builtin'), readDir(personalRecipesDir(env), 'personal'), repoPath ? readDir(repoRecipesDir(repoPath), 'repo') : []];
  const effective = new Map();
  const all = [];
  for (const layer of layers) {
    for (const r of layer) {
      const prev = effective.get(r.name);
      if (prev) prev.overridden_by = r.source;
      effective.set(r.name, r);
      all.push(r);
    }
  }
  return { effective, all };
}

export function permissionsBeyond(requested = {}, ceiling = {}) {
  return PERMISSION_KEYS.filter((k) => requested[k] === true && ceiling[k] !== true);
}

export function recipeTools(recipe, permissions) {
  return allowedToolsFor({ mode: recipe.mode, permissions, tools: recipe.tools });
}

export function recipeRef(recipe) {
  return { name: recipe.name, source: recipe.source, hash: recipe.hash };
}

function bullets(lines) {
  return lines.length ? `\n${lines.map((l) => `- ${l}\n`).join('')}` : '(none)';
}

export function renderRecipe(recipe, { ticket = {}, url = null, note = '', prs = [], deployments = [], environments = [] } = {}) {
  const values = {
    'ticket.key': ticket.key ?? '',
    'ticket.url': url ?? 'no tracker link',
    'ticket.title': ticket.title ?? '',
    'ticket.status': ticket.status ?? '',
    'ticket.next_action': ticket.next_action || '(none)',
    note: note || '(none)',
    prs: bullets(prs.map((p) => `${p.url} (${p.state === 'merged' && p.merged_at ? `merged ${p.merged_at}` : p.state})`)),
    deployments: bullets(deployments.map((d) => `${d.environment}: ${d.state}${d.deployed_at ? ` ${d.deployed_at}` : ''}${d.pr_id ? ` (PR ${d.pr_id})` : ''}`)),
    environments: environments.length ? environments.join(', ') : '(none configured)',
  };
  return recipe.body.replace(PLACEHOLDER_RE, (_, name) => values[name] ?? '');
}

function publicEntry(r, repoId) {
  return {
    name: r.name, description: r.description, source: r.source, repo_id: repoId, hash: r.hash, error: r.error, mode: r.mode, permissions: r.permissions,
    tools: r.tools, timeout_min: r.timeout_min, inputs: r.inputs, outputs: r.outputs, legacy: r.legacy, schedulable: r.schedulable,
    overridden_by: r.overridden_by ?? null, preview: r.body ? r.body.slice(0, 600) : '',
  };
}

// Cached view the worker, request validation and the snapshot share. `fresh` re-reads the files,
// which dispatch uses to confirm the recipe still has the hash that was queued.
export function createRecipeCatalog({ env = process.env, config = {}, clock = Date.now, ttlMs = 10_000, builtinDir = BUILTIN_DIR } = {}) {
  const cache = new Map();
  const cfg = () => (typeof config === 'function' ? config() : config) ?? {};
  function repoPath(repoId) {
    const repo = repoId ? (cfg().repos ?? {})[repoId] : null;
    return repo && repo.canonical_path && fs.existsSync(repo.canonical_path) ? repo.canonical_path : null;
  }
  function forRepo(repoId = null, { fresh = false } = {}) {
    const key = repoId ?? '';
    const hit = cache.get(key);
    const now = clock();
    if (!fresh && hit && now - hit.at < ttlMs) return hit.value;
    const value = loadRecipes({ env, repoPath: repoPath(repoId), builtinDir });
    cache.set(key, { at: now, value });
    return value;
  }
  return {
    forRepo,
    get(name, repoId = null, opts = {}) {
      return forRepo(repoId, opts).effective.get(name) ?? null;
    },
    list() {
      const out = [...forRepo(null).effective.values()].map((r) => publicEntry(r, null));
      for (const repoId of Object.keys(cfg().repos ?? {})) {
        if (!repoPath(repoId)) continue;
        for (const r of forRepo(repoId).effective.values()) if (r.source === 'repo') out.push(publicEntry(r, repoId));
      }
      return out;
    },
  };
}

// One catalog per worker, shared by request validation, dispatch and the snapshot.
export function catalogFor(worker) {
  if (!worker.recipeCatalog) {
    worker.recipeCatalog = createRecipeCatalog({ env: worker.env, config: () => worker.config, clock: () => (typeof worker.clock === 'function' ? worker.clock() : Date.now()) });
  }
  return worker.recipeCatalog;
}
