// `quill repo add|list|remove` (issue #5): register repositories without re-running init or touching the worker.
import path from 'node:path';
import { loadUserConfig, saveUserConfig, loadRepoConfig, saveRepoConfig } from '../../config/config.js';
import { isGitWorkTree, detectDefaultBranch, repoIdFromPath, samePath, repoStatus, REPO_STATUS_TEXT } from '../../config/repos.js';
import { loadContext, latestSnapshot } from '../context.js';
import { TrackerError } from '../../lib/errors.js';
import fs from 'node:fs';

const USAGE = 'usage: repo add <path> [--id <id>] [--project <id>] [--repo-file] | repo list [--json] | repo remove <id>';
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function add(io, args, flags, env) {
  const [target] = args;
  if (!target) throw new TrackerError('usage', USAGE);
  const dir = path.resolve(target);
  if (!fs.existsSync(dir)) throw new TrackerError('repo-path-missing', `${dir} does not exist`);
  if (!isGitWorkTree(dir)) throw new TrackerError('repo-not-git', `${dir} is not a git work tree; register a clone of the repository`);
  const cfg = loadUserConfig(env);
  const projectId = typeof flags.project === 'string' ? flags.project : cfg.default_project || Object.keys(cfg.projects ?? {})[0];
  if (!projectId || !cfg.projects?.[projectId]) throw new TrackerError('project-unknown', `unknown project ${projectId ?? '(none)'}; known: ${Object.keys(cfg.projects ?? {}).join(', ') || 'none'} (create one with quill init)`);
  const id = typeof flags.id === 'string' ? flags.id : repoIdFromPath(dir);
  if (!ID_RE.test(id)) throw new TrackerError('repo-id-invalid', `repository id ${id} must be lowercase letters, digits, dots, dashes or underscores`);
  const existing = cfg.repos?.[id];
  if (existing && existing.canonical_path && !samePath(existing.canonical_path, dir)) {
    throw new TrackerError('repo-id-taken', `repository id ${id} is already registered for ${existing.canonical_path}; pass --id <another-id>`);
  }
  const branch = detectDefaultBranch(dir);
  cfg.repos = { ...cfg.repos, [id]: { ...(existing ?? {}), project_id: projectId, display_name: path.basename(dir), canonical_path: dir, default_branch: branch } };
  if (!cfg.projects[projectId].repo_id) cfg.projects[projectId] = { ...cfg.projects[projectId], repo_id: id };
  saveUserConfig(cfg, env);
  io.println(`${existing ? 'Updated' : 'Registered'} repository ${id} → ${dir} (project ${projectId}, default branch ${branch})`);
  if (flags['repo-file'] === true) {
    const f = saveRepoConfig(dir, { ...(loadRepoConfig(dir) ?? {}), project_id: projectId, project_name: cfg.projects[projectId].name ?? projectId, repo_id: id });
    io.println(`wrote repository defaults ${f}`);
  }
  return 0;
}

function list(io, flags, env) {
  const cfg = loadUserConfig(env);
  const rows = Object.entries(cfg.repos ?? {}).map(([id, r]) => ({ id, project_id: r.project_id ?? null, path: r.canonical_path ?? null, default_branch: r.default_branch ?? 'main', status: repoStatus(r) }));
  if (flags.json) { io.json(rows); return 0; }
  if (!rows.length) { io.println('No repositories registered. Add one with quill repo add <path>.'); return 0; }
  for (const r of rows) io.println(`${r.id.padEnd(24)} ${String(r.project_id ?? '-').padEnd(16)} ${r.default_branch.padEnd(10)} ${r.path ?? '-'}${r.status === 'ok' ? '' : `  (${REPO_STATUS_TEXT[r.status]})`}`);
  return 0;
}

function remove(io, args, env) {
  const [id] = args;
  if (!id) throw new TrackerError('usage', USAGE);
  const cfg = loadUserConfig(env);
  if (!cfg.repos?.[id]) throw new TrackerError('repo-unknown', `unknown repository ${id}`);
  const { [id]: _removed, ...rest } = cfg.repos;
  cfg.repos = rest;
  for (const [pid, p] of Object.entries(cfg.projects ?? {})) {
    if (p.repo_id === id) {
      const next = Object.entries(rest).find(([, r]) => r.project_id === pid);
      const { repo_id: _old, ...without } = p;
      cfg.projects[pid] = next ? { ...without, repo_id: next[0] } : without;
    }
  }
  saveUserConfig(cfg, env);
  let using = 0;
  try { using = (latestSnapshot(loadContext(env, { requireStore: false }))?.tickets ?? []).filter((t) => t.repo_id === id).length; } catch { using = 0; }
  io.println(`Removed repository ${id}.${using ? ` ${using} ticket(s) still name it; reassign with quill ticket set <KEY> --repo <id>|none.` : ''}`);
  return 0;
}

export async function run({ args, flags, io, env }) {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'add': return add(io, rest, flags, env);
    case 'list': return list(io, flags, env);
    case 'remove': return remove(io, rest, env);
    default: throw new TrackerError('usage', USAGE);
  }
}
