// Tracker clients: one issue per call, from the host the owner configured (or the tracker's fixed
// API host), with a token from a named environment variable. The tracker-sync job only reads
// (ADR 0011). The write methods exist for `quill tracker push`, which the owner opts into and
// confirms per ticket (ADR 0018); nothing calls them on a schedule.
import { TrackerError } from '../lib/errors.js';

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const MAX_BODY = 1024 * 1024;
const DEFAULT_TOKEN_ENV = { jira: 'JIRA_TOKEN', github: 'GITHUB_TOKEN', linear: 'LINEAR_API_KEY' };

const fail = (message, code = 'tracker-error') => new TrackerError(code, message);

function origin(domain) {
  let u;
  try { u = new URL(domain); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.origin;
}

export function syncSettings(rawTracker = {}) {
  const t = rawTracker && typeof rawTracker === 'object' ? rawTracker : {};
  return { token_env: typeof t.sync_token_env === 'string' && t.sync_token_env ? t.sync_token_env : null, username_env: typeof t.sync_username_env === 'string' && t.sync_username_env ? t.sync_username_env : null };
}

// Remote status names a Quill status maps to when no --to is given. Statuses without a default
// (blocked, deploy-pending) need an explicit target; [tracker.status_map] overrides these.
export const DEFAULT_STATUS_MAP = {
  jira: { todo: 'To Do', active: 'In Progress', review: 'In Review', done: 'Done' },
  linear: { todo: 'Todo', active: 'In Progress', review: 'In Review', done: 'Done' },
  github: { todo: 'open', active: 'open', review: 'open', 'deploy-pending': 'open', blocked: 'open', done: 'closed' },
};

// Write-back is read only from the user's config.toml (ADR 0018): a repository's .quill.toml
// cannot turn it on or change where a status goes.
export function writeSettings(rawTracker = {}) {
  const t = rawTracker && typeof rawTracker === 'object' ? rawTracker : {};
  const map = {};
  if (t.status_map && typeof t.status_map === 'object' && !Array.isArray(t.status_map)) {
    for (const [k, v] of Object.entries(t.status_map)) if (typeof v === 'string' && v.trim() && v.length <= 80) map[k] = v.trim();
  }
  return { enabled: t.write_back === true, status_map: map };
}

export function targetStatus(system, quillStatus, settings) {
  return (settings.status_map && settings.status_map[quillStatus]) ?? (DEFAULT_STATUS_MAP[system] ?? {})[quillStatus] ?? null;
}

// Whether tracker-sync may read this ticket's issue: an open ticket whose key belongs to the user's
// tracker and whose link, if any, is on its host. A GitHub key is only a number, so its link must
// name the configured repository and that number; otherwise another repository's issue would be read.
export function syncable(ticket, tracker) {
  return !!ticket && ticket.status !== 'done' && linkedTo(ticket, tracker);
}

// Whether the ticket's external key is an issue on this tracker (any status).
export function linkedTo(ticket, tracker) {
  const ext = ticket && ticket.external;
  if (!ext || !ext.key || !tracker || ext.system !== tracker.system) return false;
  let link = null;
  if (ext.url) { try { link = new URL(ext.url); } catch { return false; } }
  if (tracker.system === 'github') {
    const base = origin(tracker.domain || 'https://github.com');
    const number = /(\d+)$/.exec(ext.key);
    if (!link || !base || link.origin !== base || !number || typeof tracker.repo !== 'string') return false;
    return link.pathname.replace(/\/+$/, '').toLowerCase() === `/${tracker.repo}/issues/${number[1]}`.toLowerCase();
  }
  if (!link) return true;
  const host = (() => { try { return new URL(tracker.domain).host; } catch { return null; } })();
  return !host || link.host === host;
}

export function createTrackerClient({ tracker, settings = {}, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const system = tracker && tracker.system;
  const tokenEnv = settings.token_env || DEFAULT_TOKEN_ENV[system] || null;

  async function request(url, init) {
    const token = tokenEnv ? env[tokenEnv] : null;
    if (!token) throw fail(`set ${tokenEnv ?? 'a token environment variable (tracker.sync_token_env)'} to read ${system} issues`);
    const user = settings.username_env ? env[settings.username_env] : null;
    const authorization = system === 'linear' ? token : user ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` : `Bearer ${token}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', authorization, ...(init.headers ?? {}) }, redirect: 'error', signal: controller.signal });
    } catch {
      throw fail(`${system} request failed: ${timedOut ? 'timed out' : 'network error'}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) throw fail(`${system} has no such issue`, 'not-found');
    if (!res.ok) throw fail(`${system} returned HTTP ${res.status}${res.status === 401 || res.status === 403 ? ` (check ${tokenEnv})` : ''}`);
    const text = await res.text();
    if (text.length > MAX_BODY) throw fail(`${system} response is too large`);
    if (!text) return null; // e.g. Jira's 204 after a transition
    try { return JSON.parse(text); } catch { throw fail(`${system} returned malformed JSON`); }
  }

  function githubIssueUrl(key) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(tracker.repo ?? '')) throw fail('tracker.repo must be owner/name for GitHub issues');
    const base = origin(tracker.domain || 'https://github.com');
    if (!base) throw fail('tracker.domain must be an https:// address');
    const api = base === 'https://github.com' ? 'https://api.github.com' : `${base}/api/v3`;
    return `${api}/repos/${tracker.repo}/issues/${/(\d+)$/.exec(key)[1]}`;
  }

  function jiraBase() {
    const base = origin(tracker.domain);
    if (!base) throw fail('tracker.domain must be the https:// address of your Jira site');
    return base;
  }

  async function linear(query, variables) {
    const json = await request('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (json && Array.isArray(json.errors) && json.errors.length) throw fail(`linear refused the request: ${String(json.errors[0].message ?? 'unknown error').slice(0, 200)}`);
    return json && json.data;
  }

  const checkKey = (key) => { if (typeof key !== 'string' || !KEY_RE.test(key)) throw fail(`${key} is not a tracker key`); };
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

  // Write-back (ADR 0018): only called for one ticket the owner confirmed. Each method changes
  // exactly one thing on one issue and reports what the issue looked like before.
  const writer = {
    // The remote states this issue can move to, by name; null means "any name is accepted".
    async targets(key) {
      checkKey(key);
      if (system === 'jira') {
        const json = await request(`${jiraBase()}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { method: 'GET' });
        return (json && json.transitions ? json.transitions : []).map((t) => ({ id: String(t.id), name: (t.to && t.to.name) ?? t.name }));
      }
      if (system === 'github') return [{ id: 'open', name: 'open' }, { id: 'closed', name: 'closed' }];
      if (system === 'linear') {
        const data = await linear('query States($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }', { id: key });
        const issue = data && data.issue;
        if (!issue) throw fail('linear has no such issue', 'not-found');
        return ((issue.team && issue.team.states && issue.team.states.nodes) ?? []).map((s) => ({ id: s.id, name: s.name, issue_id: issue.id }));
      }
      throw fail(`write-back does not support ${system ?? 'this'} trackers; use jira, github or linear`);
    },

    async setStatus(key, target) {
      checkKey(key);
      const options = await writer.targets(key);
      const match = options.find((o) => same(o.name, target));
      if (!match) throw fail(`${key} cannot move to "${target}" on ${system}; available: ${options.map((o) => o.name).join(', ') || 'none'}`, 'transition-unavailable');
      if (system === 'jira') await request(`${jiraBase()}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transition: { id: match.id } }) });
      else if (system === 'github') await request(githubIssueUrl(key), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: match.id }) });
      else if (system === 'linear') {
        const data = await linear('mutation Move($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }', { id: match.issue_id, state: match.id });
        if (!(data && data.issueUpdate && data.issueUpdate.success)) throw fail('linear did not confirm the state change');
      }
      return { status: match.name };
    },

    async addComment(key, body) {
      checkKey(key);
      const text = String(body ?? '').slice(0, 4000);
      if (!text.trim()) throw fail('a comment needs text');
      if (system === 'jira') await request(`${jiraBase()}/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text }) });
      else if (system === 'github') await request(`${githubIssueUrl(key)}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text }) });
      else if (system === 'linear') {
        const options = await writer.targets(key);
        const data = await linear('mutation Note($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }', { id: options[0] ? options[0].issue_id : key, body: text });
        if (!(data && data.commentCreate && data.commentCreate.success)) throw fail('linear did not confirm the comment');
      } else throw fail(`write-back does not support ${system ?? 'this'} trackers`);
      return { commented: true };
    },
  };

  return {
    system,
    ...writer,
    async fetchIssue(key) {
      if (typeof key !== 'string' || !KEY_RE.test(key)) throw fail(`${key} is not a tracker key`);
      if (system === 'jira') {
        const base = origin(tracker.domain);
        if (!base) throw fail('tracker.domain must be the https:// address of your Jira site to sync issues');
        const json = await request(`${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,fixVersions`, { method: 'GET' });
        const f = json.fields ?? {};
        return { title: f.summary ?? null, status: (f.status && f.status.name) ?? null, assignee: (f.assignee && (f.assignee.displayName ?? f.assignee.name)) ?? null, fix_versions: (f.fixVersions ?? []).map((v) => v.name).filter(Boolean) };
      }
      if (system === 'github') {
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(tracker.repo ?? '')) throw fail('tracker.repo must be owner/name to sync GitHub issues');
        const base = origin(tracker.domain || 'https://github.com');
        if (!base) throw fail('tracker.domain must be an https:// address');
        const api = base === 'https://github.com' ? 'https://api.github.com' : `${base}/api/v3`;
        const number = /(\d+)$/.exec(key)[1];
        const json = await request(`${api}/repos/${tracker.repo}/issues/${number}`, { method: 'GET' });
        return { title: json.title ?? null, status: json.state ?? null, assignee: (json.assignee && json.assignee.login) ?? null, fix_versions: json.milestone && json.milestone.title ? [json.milestone.title] : [] };
      }
      if (system === 'linear') {
        const json = await request('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query Issue($id: String!) { issue(id: $id) { title state { name } assignee { name } cycle { name } } }', variables: { id: key } }) });
        const issue = json.data && json.data.issue;
        if (!issue) throw fail('linear has no such issue', 'not-found');
        return { title: issue.title ?? null, status: (issue.state && issue.state.name) ?? null, assignee: (issue.assignee && issue.assignee.name) ?? null, fix_versions: issue.cycle && issue.cycle.name ? [issue.cycle.name] : [] };
      }
      throw fail(`tracker-sync does not support ${system ?? 'this'} trackers; use jira, github or linear`);
    },

    // Open issues assigned to the token's user (ADR 0024), newest first, at most `limit`. Read only.
    async searchAssigned({ limit = 50 } = {}) {
      const max = Math.max(1, Math.min(100, Number(limit) || 50));
      if (system === 'jira') {
        const base = jiraBase();
        const qs = `jql=${encodeURIComponent('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')}&fields=summary,status,assignee,fixVersions,components,project&maxResults=${max}`;
        let json;
        // Jira Cloud serves search at /search/jql; Data Center and older sites only at /search.
        try { json = await request(`${base}/rest/api/2/search/jql?${qs}`, { method: 'GET' }); } catch (err) {
          if (err.code !== 'not-found' && !/HTTP 410/.test(err.message)) throw err;
          json = await request(`${base}/rest/api/2/search?${qs}`, { method: 'GET' });
        }
        return ((json && json.issues) ?? []).filter((i) => i && typeof i.key === 'string' && KEY_RE.test(i.key)).slice(0, max).map((i) => {
          const f = i.fields ?? {};
          return {
            key: i.key.toUpperCase(), url: `${base}/browse/${i.key.toUpperCase()}`, title: f.summary ?? null, status: (f.status && f.status.name) ?? null,
            assignee: (f.assignee && (f.assignee.displayName ?? f.assignee.name)) ?? null, fix_versions: (f.fixVersions ?? []).map((v) => v.name).filter(Boolean),
            project: (f.project && f.project.key) ?? i.key.split('-')[0], components: (f.components ?? []).map((c) => c.name).filter((n) => typeof n === 'string'),
          };
        });
      }
      if (system === 'github') {
        githubIssueUrl('X-1'); // validates repo and domain
        const base = origin(tracker.domain || 'https://github.com');
        const api = base === 'https://github.com' ? 'https://api.github.com' : `${base}/api/v3`;
        const q = `repo:${tracker.repo} is:issue is:open assignee:@me`;
        const json = await request(`${api}/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${max}`, { method: 'GET' });
        return ((json && json.items) ?? []).filter((i) => i && Number.isInteger(i.number) && !i.pull_request).slice(0, max).map((i) => ({
          number: i.number, url: `${base}/${tracker.repo}/issues/${i.number}`, title: i.title ?? null, status: i.state ?? null, assignee: (i.assignee && i.assignee.login) ?? null,
          fix_versions: i.milestone && i.milestone.title ? [i.milestone.title] : [], repo: tracker.repo,
        }));
      }
      throw fail(`importing assigned issues supports jira and github trackers, not ${system ?? 'this one'}`, 'import-unsupported');
    },

    // What the issue says about its code (ADR 0024): Jira's project, components and remote links;
    // a GitHub issue's own repository. Read only, used by the repository resolver.
    async repoHints(key) {
      checkKey(key);
      if (system === 'jira') {
        const base = jiraBase();
        const json = await request(`${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=project,components`, { method: 'GET' });
        const f = (json && json.fields) ?? {};
        let links = [];
        try {
          const remote = await request(`${base}/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`, { method: 'GET' });
          links = (Array.isArray(remote) ? remote : []).map((l) => l && l.object && l.object.url).filter((u) => typeof u === 'string').slice(0, 50);
        } catch (err) {
          if (err.code !== 'not-found') throw err;
        }
        return { project: (f.project && f.project.key) ?? key.split('-')[0], components: (f.components ?? []).map((c) => c.name).filter((n) => typeof n === 'string'), github_repo: null, links };
      }
      if (system === 'github') {
        githubIssueUrl(key);
        const base = origin(tracker.domain || 'https://github.com');
        return { project: null, components: [], github_repo: tracker.repo, links: [`${base}/${tracker.repo}`] };
      }
      return { project: null, components: [], github_repo: null, links: [] };
    },
  };
}
