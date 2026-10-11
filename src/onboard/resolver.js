// Rule-based repository resolver (ADR 0024). Deterministic worker logic, never an agent: the first
// rule that matches wins.
//   a. [tracker.repo_map]: a Jira component (PROJ/Component), then its project (PROJ), or a GitHub
//      repository (owner/repo), mapped to a registered repository id or a remote address.
//   b. A repository the issue links to (GitHub: the issue's own repository; Jira: remote links on an
//      allowed forge) whose remote is the origin of a registered repository.
//   c. A clone of that remote already on disk, in auto_clone_dir or beside a registered repository.
// The result is `linked` (a registered repository), `needs-clone` (a remote, maybe with a clone on
// disk to register) or `none`. Nothing is cloned or registered here.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { remoteKey, repoUrlFromLink } from './remotes.js';
import { NO_CODE_TAG } from '../core/reduce/tickets.js';

export { NO_CODE_TAG };
const MAX_SCAN_ENTRIES = 200;

export function originUrl(dir) {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Remote key → registered repository id, and (scanned on first use) remote key → clone folder.
export function createOriginIndex({ repos = {}, autoCloneDir = null, originOf = originUrl }) {
  const registered = new Map();
  const roots = new Set();
  for (const [id, r] of Object.entries(repos)) {
    if (!r || !r.canonical_path) continue;
    roots.add(path.dirname(path.resolve(r.canonical_path)));
    let key = null;
    try { key = remoteKey(originOf(r.canonical_path)); } catch { key = null; }
    if (key && !registered.has(key)) registered.set(key, id);
  }
  let clones = null;
  function scan() {
    clones = new Map();
    for (const dir of [autoCloneDir, ...roots].filter(Boolean)) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).slice(0, MAX_SCAN_ENTRIES)) {
        const sub = path.join(dir, e.name);
        if (!fs.existsSync(path.join(sub, '.git'))) continue;
        let key = null;
        try { key = remoteKey(originOf(sub)); } catch { key = null; }
        if (key && !clones.has(key)) clones.set(key, sub);
      }
    }
  }
  return {
    registered: (key) => registered.get(key) ?? null,
    clone: (key) => { if (!clones) scan(); return clones.get(key) ?? null; },
  };
}

function linkHosts(settings, tracker) {
  const hosts = [...settings.clone_hosts];
  if (tracker && tracker.system === 'github') {
    try { hosts.push(new URL(tracker.domain || 'https://github.com').hostname.toLowerCase()); } catch { /* default hosts only */ }
  }
  return hosts;
}

function fromRemote(url, key, index, rule, via) {
  const id = index.registered(key);
  if (id) return { state: 'linked', repo_id: id, rule, via };
  const existing = index.clone(key);
  return { state: 'needs-clone', remote: url, existing_path: existing, rule: existing ? 'scan' : rule, via };
}

export function resolveRepo({ ticket, hints, settings, repos = {}, index, tracker }) {
  if ((ticket.tags ?? []).includes(NO_CODE_TAG)) return { state: 'no-code' };
  const h = hints ?? {};
  const mapKeys = [];
  if (h.project) {
    for (const c of h.components ?? []) mapKeys.push(`${h.project}/${c}`);
    mapKeys.push(h.project);
  }
  if (h.github_repo) mapKeys.push(h.github_repo);
  for (const k of mapKeys) {
    const value = settings.repo_map[k.toLowerCase()];
    if (!value) continue;
    if (Object.hasOwn(repos, value)) return { state: 'linked', repo_id: value, rule: 'repo_map', via: k };
    const key = remoteKey(value);
    if (key) return fromRemote(value, key, index, 'repo_map', k);
  }
  const hosts = linkHosts(settings, tracker);
  const candidates = [];
  for (const link of h.links ?? []) {
    const url = repoUrlFromLink(link, hosts);
    const key = url && remoteKey(url);
    if (key && !candidates.some((c) => c.key === key)) candidates.push({ url, key, link });
  }
  for (const c of candidates) {
    const id = index.registered(c.key);
    if (id) return { state: 'linked', repo_id: id, rule: 'issue', via: c.link };
  }
  for (const c of candidates) {
    const existing = index.clone(c.key);
    if (existing) return { state: 'needs-clone', remote: c.url, existing_path: existing, rule: 'scan', via: c.link };
  }
  if (candidates.length) return { state: 'needs-clone', remote: candidates[0].url, existing_path: null, rule: 'issue', via: candidates[0].link };
  return { state: 'none' };
}
