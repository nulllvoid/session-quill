// Clone with consent (ADR 0024). A remote named by ticket data is cloned only after the owner
// confirms the preview (`quill repo clone <KEY> --confirm`, or the dashboard's Clone dialog), only
// over https or ssh from a host in [tracker] clone_hosts, only into a folder of auto_clone_dir, and
// never when a clone of that remote already exists: then that clone is linked or registered instead.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TrackerError } from '../lib/errors.js';
import { loadUserConfig, saveUserConfig } from '../config/config.js';
import { repoIdFromPath, samePath, isWithin, detectDefaultBranch } from '../config/repos.js';
import { killTree } from '../handoff/runner.js';
import { onboardSettings } from './settings.js';
import { checkCloneUrl, cloneFolderName, safeFolderName, remoteKey, parseRemote, normalizeRemote } from './remotes.js';
import { createOriginIndex, NO_CODE_TAG } from './resolver.js';

export const CLONE_TIMEOUT_MS = 10 * 60_000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PARTIAL_RE = /^\..+\.partial-\d+-\d+$/;

// What confirming would do for this ticket: { action: 'link'|'register'|'clone', remote, ... }.
// Throws a TrackerError naming the reason when nothing may be done.
export async function planClone({ config, ticket, url = null, originOf } = {}) {
  if (!ticket) throw new TrackerError('ticket-unknown', 'unknown ticket');
  if (ticket.repo_id) throw new TrackerError('repo-linked', `${ticket.key} already belongs to repository ${ticket.repo_id}`);
  if ((ticket.tags ?? []).includes(NO_CODE_TAG)) throw new TrackerError('no-code', `${ticket.key} is marked as needing no code; clear it with quill ticket set ${ticket.key} --no-code no`);
  const settings = onboardSettings(config.tracker);
  const given = typeof url === 'string' && url.trim() ? url.trim() : (ticket.repo_resolution && ticket.repo_resolution.remote) || null;
  if (!given) throw new TrackerError('remote-unknown', `no repository is known for ${ticket.key}; map its project in [tracker.repo_map], or pass --url <https or ssh remote>`);
  // Credentials are refused before anything else, even when a clone of the remote already exists.
  const parsedGiven = parseRemote(given);
  if (parsedGiven.error && parsedGiven.error.code === 'clone-credentials') throw new TrackerError(parsedGiven.error.code, parsedGiven.error.message);
  const remote = normalizeRemote(given) ?? given;
  const key = remoteKey(remote);
  const base = { ticket_id: ticket.id, ticket_key: ticket.key, project_id: ticket.project_id ?? null, remote, auto_clone_dir: settings.auto_clone_dir, clone_hosts: settings.clone_hosts };
  const index = await createOriginIndex({ repos: config.repos ?? {}, autoCloneDir: settings.auto_clone_dir, ...(originOf ? { originOf } : {}) });
  if (key) {
    const repoId = index.registered(key);
    if (repoId) return { ...base, action: 'link', repo_id: repoId, path: config.repos[repoId].canonical_path };
    const existing = index.clone(key);
    if (existing) return { ...base, action: 'register', path: existing };
  }
  const parsed = checkCloneUrl(remote, settings.clone_hosts);
  const folder = cloneFolderName(parsed);
  // The repository name, else owner-name when another repository of that name is already there.
  const candidates = [folder];
  try { candidates.push(safeFolderName(`${parsed.segments[parsed.segments.length - 2]}-${folder}`)); } catch { /* no usable owner name */ }
  let target = null;
  for (const name of candidates) {
    const p = path.join(settings.auto_clone_dir, name);
    if (!fs.existsSync(p)) { target = p; break; }
    // A folder of that name holding a clone of this very remote is registered, never cloned beside.
    if (fs.existsSync(path.join(p, '.git')) && key && (await index.originKey(p)) === key) return { ...base, action: 'register', path: p };
  }
  if (!target) throw new TrackerError('clone-target-exists', `${path.join(settings.auto_clone_dir, folder)} already exists and is not a clone of ${remote}; move it or clone by hand and register it with quill repo add`);
  if (!isWithin(settings.auto_clone_dir, target) || samePath(settings.auto_clone_dir, target) || !samePath(path.dirname(target), settings.auto_clone_dir)) throw new TrackerError('clone-target-invalid', 'the clone folder must be directly inside auto_clone_dir');
  return { ...base, action: 'clone', host: parsed.host, protocol: parsed.protocol, path: target };
}

// The environment of a clone: no prompts, only https and ssh transports, no Git LFS downloads.
export function cloneEnv(base = process.env) {
  return { ...base, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' };
}

// git with cloneEnv; resolves { code, stdout, stderr }. A timeout or cancellation kills the whole
// process tree (git spawns remote helpers and ssh), not just git itself.
export function runGit(args, { cwd = undefined, timeoutMs = CLONE_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: cloneEnv() });
    let stdout = '';
    let stderr = '';
    const cap = (s, chunk) => (s + chunk).slice(-8192);
    child.stdout.on('data', (c) => { stdout = cap(stdout, c.toString()); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c.toString()); });
    const timer = setTimeout(() => { stderr = cap(stderr, '\n(timed out)'); killTree(child); }, timeoutMs);
    const abort = () => { stderr = cap(stderr, '\n(cancelled)'); killTree(child); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

// The git arguments of a clone: no file or ext transports, no submodules, no Git LFS filters, no
// redirects to another host, and `--` before the remote.
export function cloneArgs(remote, target) {
  return [
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false',
    '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'http.followRedirects=false',
    'clone', '--no-recurse-submodules', '--', remote, target,
  ];
}

// Removes partial clones left in auto_clone_dir by a stopped or crashed worker or CLI.
export function sweepPartials(dir) {
  let removed = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isDirectory() || !PARTIAL_RE.test(e.name)) continue;
    try { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); removed += 1; } catch { /* in use; next start */ }
  }
  return removed;
}

export async function executeClone(plan, { git = runGit, signal = null, timeoutMs = CLONE_TIMEOUT_MS } = {}) {
  if (plan.action !== 'clone') return plan.path;
  // Re-checked at the moment of cloning: the plan may be older than the folder.
  checkCloneUrl(plan.remote, plan.clone_hosts);
  if (fs.existsSync(plan.path)) throw new TrackerError('clone-target-exists', `${plan.path} appeared before the clone started`);
  fs.mkdirSync(plan.auto_clone_dir, { recursive: true });
  // Cloned under a hidden name and renamed when complete, so an interrupted clone is never taken
  // for a finished one (the resolver's scan skips hidden folders, and sweepPartials removes them).
  const partial = path.join(plan.auto_clone_dir, `.${path.basename(plan.path)}.partial-${process.pid}-${Date.now()}`);
  const r = await git(cloneArgs(plan.remote, partial), { cwd: plan.auto_clone_dir, timeoutMs, signal });
  const discard = () => { try { fs.rmSync(partial, { recursive: true, force: true }); } catch { /* hidden, so harmless */ } };
  if (r.code !== 0) {
    discard();
    const reason = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300);
    throw new TrackerError('clone-failed', `git clone of ${plan.remote} failed${reason ? `: ${reason}` : ''}`);
  }
  if (!fs.existsSync(path.join(partial, '.git'))) { discard(); throw new TrackerError('clone-failed', `git clone of ${plan.remote} left no repository`); }
  if (fs.existsSync(plan.path)) { discard(); throw new TrackerError('clone-target-exists', `${plan.path} appeared while cloning`); }
  fs.renameSync(partial, plan.path);
  return plan.path;
}

// Registers a clone in the user config like `quill repo add`; returns its repository id. A folder
// already registered keeps its id. The config is read again immediately before the atomic write
// and only this repository is added to it, so a `quill repo add` that ran meanwhile is kept.
export function registerClone(env, dir, { projectId = null } = {}) {
  const already = (cfg) => Object.entries(cfg.repos ?? {}).find(([, r]) => r && r.canonical_path && samePath(r.canonical_path, dir));
  const first = already(loadUserConfig(env));
  if (first) return first[0];
  // The slow part (git) runs before the config is read for writing.
  const branch = detectDefaultBranch(dir);
  const cfg = loadUserConfig(env);
  const found = already(cfg);
  if (found) return found[0];
  const project = projectId && cfg.projects?.[projectId] ? projectId : cfg.default_project && cfg.projects?.[cfg.default_project] ? cfg.default_project : Object.keys(cfg.projects ?? {})[0];
  if (!project) throw new TrackerError('project-unknown', 'no project is configured; run quill init first');
  const base = repoIdFromPath(dir);
  let id = base;
  for (let n = 2; cfg.repos?.[id] && n < 100; n += 1) id = `${base.slice(0, 60)}-${n}`;
  if (!ID_RE.test(id) || cfg.repos?.[id]) throw new TrackerError('repo-id-taken', `no free repository id for ${dir}; register it with quill repo add ${dir} --id <id>`);
  cfg.repos = { ...cfg.repos, [id]: { project_id: project, display_name: path.basename(dir), canonical_path: path.resolve(dir), default_branch: branch } };
  if (!cfg.projects[project].repo_id) cfg.projects[project] = { ...cfg.projects[project], repo_id: id };
  saveUserConfig(cfg, env);
  return id;
}
