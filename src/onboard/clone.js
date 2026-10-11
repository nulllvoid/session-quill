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
import { onboardSettings } from './settings.js';
import { checkCloneUrl, cloneFolderName, remoteKey } from './remotes.js';
import { createOriginIndex, NO_CODE_TAG } from './resolver.js';

export const CLONE_TIMEOUT_MS = 10 * 60_000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// What confirming would do for this ticket: { action: 'link'|'register'|'clone', remote, ... }.
// Throws a TrackerError naming the reason when nothing may be done.
export function planClone({ config, ticket, url = null, originOf } = {}) {
  if (!ticket) throw new TrackerError('ticket-unknown', 'unknown ticket');
  if (ticket.repo_id) throw new TrackerError('repo-linked', `${ticket.key} already belongs to repository ${ticket.repo_id}`);
  if ((ticket.tags ?? []).includes(NO_CODE_TAG)) throw new TrackerError('no-code', `${ticket.key} is marked as needing no code; clear it with quill ticket set ${ticket.key} --no-code no`);
  const settings = onboardSettings(config.tracker);
  const remote = typeof url === 'string' && url.trim() ? url.trim() : (ticket.repo_resolution && ticket.repo_resolution.remote) || null;
  if (!remote) throw new TrackerError('remote-unknown', `no repository is known for ${ticket.key}; map its project in [tracker.repo_map], or pass --url <https or ssh remote>`);
  const key = remoteKey(remote);
  const base = { ticket_id: ticket.id, ticket_key: ticket.key, project_id: ticket.project_id ?? null, remote, auto_clone_dir: settings.auto_clone_dir, clone_hosts: settings.clone_hosts };
  const index = createOriginIndex({ repos: config.repos ?? {}, autoCloneDir: settings.auto_clone_dir, ...(originOf ? { originOf } : {}) });
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
  try { candidates.push(`${cloneFolderName({ name: parsed.segments[parsed.segments.length - 2] })}-${folder}`.slice(0, 64)); } catch { /* no usable owner name */ }
  const target = candidates.map((name) => path.join(settings.auto_clone_dir, name)).find((p) => !fs.existsSync(p));
  if (!target) throw new TrackerError('clone-target-exists', `${path.join(settings.auto_clone_dir, folder)} already exists and is not a clone of ${remote}; move it or clone by hand and register it with quill repo add`);
  if (!isWithin(settings.auto_clone_dir, target) || samePath(settings.auto_clone_dir, target) || !samePath(path.dirname(target), settings.auto_clone_dir)) throw new TrackerError('clone-target-invalid', 'the clone folder must be directly inside auto_clone_dir');
  return { ...base, action: 'clone', host: parsed.host, protocol: parsed.protocol, path: target };
}

// git with no prompts and only https and ssh transports; resolves { code, stdout, stderr }.
export function runGit(args, { cwd = undefined, timeoutMs = CLONE_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh', GCM_INTERACTIVE: 'never' } });
    let stdout = '';
    let stderr = '';
    const cap = (s, chunk) => (s + chunk).slice(-8192);
    child.stdout.on('data', (c) => { stdout = cap(stdout, c.toString()); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c.toString()); });
    const timer = setTimeout(() => { stderr = cap(stderr, '\n(timed out)'); child.kill(); }, timeoutMs);
    const abort = () => { stderr = cap(stderr, '\n(cancelled)'); child.kill(); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

// The git arguments of a clone: no file or ext transports, no submodules, `--` before the remote.
export function cloneArgs(remote, target) {
  return ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', 'clone', '--no-recurse-submodules', '--', remote, target];
}

export async function executeClone(plan, { git = runGit, signal = null, timeoutMs = CLONE_TIMEOUT_MS } = {}) {
  if (plan.action !== 'clone') return plan.path;
  // Re-checked at the moment of cloning: the plan may be older than the folder.
  checkCloneUrl(plan.remote, plan.clone_hosts);
  if (fs.existsSync(plan.path)) throw new TrackerError('clone-target-exists', `${plan.path} appeared before the clone started`);
  fs.mkdirSync(plan.auto_clone_dir, { recursive: true });
  // Cloned under a hidden name and renamed when complete, so an interrupted clone is never taken
  // for a finished one (the resolver's scan skips hidden folders).
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
// already registered keeps its id.
export function registerClone(env, dir, { projectId = null } = {}) {
  const cfg = loadUserConfig(env);
  for (const [id, r] of Object.entries(cfg.repos ?? {})) if (r && r.canonical_path && samePath(r.canonical_path, dir)) return id;
  const project = projectId && cfg.projects?.[projectId] ? projectId : cfg.default_project && cfg.projects?.[cfg.default_project] ? cfg.default_project : Object.keys(cfg.projects ?? {})[0];
  if (!project) throw new TrackerError('project-unknown', 'no project is configured; run quill init first');
  const base = repoIdFromPath(dir);
  let id = base;
  for (let n = 2; cfg.repos?.[id] && n < 100; n += 1) id = `${base.slice(0, 60)}-${n}`;
  if (!ID_RE.test(id) || cfg.repos?.[id]) throw new TrackerError('repo-id-taken', `no free repository id for ${dir}; register it with quill repo add ${dir} --id <id>`);
  cfg.repos = { ...cfg.repos, [id]: { project_id: project, display_name: path.basename(dir), canonical_path: path.resolve(dir), default_branch: detectDefaultBranch(dir) } };
  if (!cfg.projects[project].repo_id) cfg.projects[project] = { ...cfg.projects[project], repo_id: id };
  saveUserConfig(cfg, env);
  return id;
}
