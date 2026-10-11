// Onboarding settings (ADR 0024), read only from the user's config.toml [tracker] table: a
// repository's .quill.toml can never turn on importing, add a clone host or move the clone folder.
import path from 'node:path';
import os from 'node:os';
import { normalizeHosts } from './remotes.js';

export const DEFAULT_CLONE_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
export const DEFAULT_CLONE_DIR = 'quill-repos';
// [tracker.repo_map] keys: a Jira project (PROJ), a project's component (PROJ/Payments) or a
// GitHub repository (owner/repo).
const MAP_KEY_RE = /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9 ._-]{1,100})?$/;

export function expandHome(p, home = os.homedir()) {
  const s = String(p).trim();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

export function onboardSettings(rawTracker, { home = os.homedir() } = {}) {
  const t = rawTracker && typeof rawTracker === 'object' && !Array.isArray(rawTracker) ? rawTracker : {};
  const warnings = [];
  let cloneHosts = DEFAULT_CLONE_HOSTS;
  if (t.clone_hosts !== undefined) {
    if (!Array.isArray(t.clone_hosts) || t.clone_hosts.some((h) => typeof h !== 'string')) warnings.push('tracker.clone_hosts must be a list of host names; using the default');
    else cloneHosts = normalizeHosts(t.clone_hosts);
  }
  let dir = path.join(home, DEFAULT_CLONE_DIR);
  if (t.auto_clone_dir !== undefined) {
    if (typeof t.auto_clone_dir !== 'string' || !t.auto_clone_dir.trim()) warnings.push('tracker.auto_clone_dir must be a folder path; using the default');
    else {
      const expanded = expandHome(t.auto_clone_dir, home);
      if (!path.isAbsolute(expanded)) warnings.push('tracker.auto_clone_dir must be an absolute path or start with ~; using the default');
      else dir = path.resolve(expanded);
    }
  }
  const repoMap = {};
  if (t.repo_map !== undefined) {
    if (!t.repo_map || typeof t.repo_map !== 'object' || Array.isArray(t.repo_map)) warnings.push('[tracker.repo_map] must be a table');
    else {
      for (const [k, v] of Object.entries(t.repo_map)) {
        if (!MAP_KEY_RE.test(k) || typeof v !== 'string' || !v.trim() || v.length > 300) { warnings.push(`tracker.repo_map entry "${k}" is not a project, component or owner/repo mapped to a repository id or remote; ignored`); continue; }
        repoMap[k.toLowerCase()] = v.trim();
      }
    }
  }
  return { import_assigned: t.import_assigned === true, auto_clone_dir: dir, clone_hosts: cloneHosts, repo_map: repoMap, warnings };
}
