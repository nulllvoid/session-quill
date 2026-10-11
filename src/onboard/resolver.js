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
import { execFile } from 'node:child_process';
import { remoteKey, repoUrlFromLink, normalizeRemote } from './remotes.js';
import { NO_CODE_TAG } from '../core/reduce/tickets.js';

export { NO_CODE_TAG };
const MAX_SCAN_ENTRIES = 200;
export const ORIGIN_CONCURRENCY = 4;

// What changes when a clone's origin can: its .git/config (or the .git file of a worktree).
function originStamp(dir) {
  for (const f of [path.join(dir, '.git', 'config'), path.join(dir, '.git')]) {
    try { const st = fs.statSync(f); if (st.isFile()) return `${st.mtimeMs}:${st.size}`; } catch { /* next */ }
  }
  return null;
}

const originCache = new Map();

// `git remote get-url origin` without blocking the worker's thread, cached by folder until its git
// config changes.
export async function originUrl(dir) {
  const stamp = originStamp(dir);
  const cached = originCache.get(dir);
  if (stamp && cached && cached.stamp === stamp) return cached.url;
  const url = await new Promise((resolve) => {
    execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
  if (stamp) originCache.set(dir, { stamp, url });
  if (originCache.size > 2000) originCache.delete(originCache.keys().next().value);
  return url;
}

// Runs fn over items, at most `limit` at a time.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function keyOf(originOf, dir) {
  try { return remoteKey(await originOf(dir)); } catch { return null; }
}

// Remote key → registered repository id, and remote key → clone folder in auto_clone_dir or beside
// a registered repository. Origins are read concurrently (a few at a time) before any lookup, so
// the lookups themselves are synchronous.
export async function createOriginIndex({ repos = {}, autoCloneDir = null, originOf = originUrl, scan = true } = {}) {
  const registered = new Map();
  const roots = new Set();
  const entries = Object.entries(repos).filter(([, r]) => r && r.canonical_path);
  for (const [, r] of entries) roots.add(path.dirname(path.resolve(r.canonical_path)));
  const keys = await pool(entries, ORIGIN_CONCURRENCY, ([, r]) => keyOf(originOf, r.canonical_path));
  entries.forEach(([id], i) => { if (keys[i] && !registered.has(keys[i])) registered.set(keys[i], id); });
  const clones = new Map();
  if (scan) {
    const dirs = [];
    for (const dir of [autoCloneDir, ...roots].filter(Boolean)) {
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of list.filter((x) => x.isDirectory() && !x.name.startsWith('.')).slice(0, MAX_SCAN_ENTRIES)) {
        const sub = path.join(dir, e.name);
        if (fs.existsSync(path.join(sub, '.git'))) dirs.push(sub);
      }
    }
    const found = await pool(dirs, ORIGIN_CONCURRENCY, (d) => keyOf(originOf, d));
    dirs.forEach((d, i) => { if (found[i] && !clones.has(found[i])) clones.set(found[i], d); });
  }
  return {
    registered: (key) => registered.get(key) ?? null,
    clone: (key) => clones.get(key) ?? null,
    originKey: (dir) => keyOf(originOf, dir),
  };
}

function linkHosts(settings, tracker) {
  const hosts = [...settings.clone_hosts];
  if (tracker && tracker.system === 'github') {
    try { hosts.push(new URL(tracker.domain || 'https://github.com').hostname.toLowerCase()); } catch { /* default hosts only */ }
  }
  return hosts;
}

function fromRemote(raw, key, index, rule, via) {
  const url = normalizeRemote(raw) ?? raw;
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
