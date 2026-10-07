// Repository registration helpers shared by `quill repo` and `quill init` (issue #5).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function isGitWorkTree(dir) {
  if (!fs.existsSync(dir)) return false;
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== null) return inside === 'true';
  return fs.existsSync(path.join(dir, '.git')); // git itself is missing
}

// origin's HEAD, then main or master if present, then the checked-out branch, then main.
export function detectDefaultBranch(dir) {
  const origin = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (origin) return origin.replace(/^origin\//, '');
  for (const name of ['main', 'master']) if (git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]) !== null) return name;
  return git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || 'main';
}

export function repoIdFromPath(dir) {
  return String(path.basename(path.resolve(dir))).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'repo';
}

// One spelling per directory: symlinks (macOS /var is /private/var) and Windows short names
// (RUNNER~1) resolve to the form git reports, so a repository registered from `git rev-parse`
// matches a cwd given another way. For a path that does not exist yet, its nearest existing
// ancestor is resolved and the rest kept as given.
export function canonicalPath(p) {
  const resolved = path.resolve(p);
  let dir = resolved;
  const rest = [];
  let out = resolved;
  for (;;) {
    try { out = path.join(fs.realpathSync.native(dir), ...rest); break; } catch { /* try the parent */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  return canonicalPath(a) === canonicalPath(b);
}

// True when `child` is `parent` or inside it, comparing canonical paths.
export function isWithin(parent, child) {
  const p = canonicalPath(parent);
  const c = canonicalPath(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function repoStatus(repo) {
  if (!repo || !repo.canonical_path) return 'no-path';
  if (!fs.existsSync(repo.canonical_path)) return 'missing';
  return isGitWorkTree(repo.canonical_path) ? 'ok' : 'not-git';
}

export const REPO_STATUS_TEXT = { ok: 'ok', 'no-path': 'no path recorded', missing: 'path no longer exists', 'not-git': 'not a git work tree' };
