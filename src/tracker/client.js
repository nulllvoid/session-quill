// Read-only tracker clients for the tracker-sync job (ADR 0011): one issue per call, from the host
// the owner configured (or the tracker's fixed API host), with a token from a named environment
// variable. Nothing here writes to a tracker; Linear's API is GraphQL, so it is a POST of a query.
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
    try { return JSON.parse(text); } catch { throw fail(`${system} returned malformed JSON`); }
  }

  return {
    system,
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
  };
}
