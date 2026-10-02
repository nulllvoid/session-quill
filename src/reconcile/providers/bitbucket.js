// Bitbucket Cloud and Bitbucket Server/Data Center pull requests over REST (ADR 0007). The token
// comes from an environment variable named in config and is sent only to api.bitbucket.org or to
// the configured server base URL, never to a host taken from a PR link.
import { TrackerError } from '../../lib/errors.js';
import { toIso } from '../../lib/time.js';

const CLOUD_PATH_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull-requests\/(\d+)(?:\/[a-z-]*)?\/?$/;
const SERVER_PATH_RE = /^\/projects\/([A-Za-z0-9_~-]+)\/repos\/([A-Za-z0-9_.-]+)\/pull-requests\/(\d+)(?:\/[a-z-]*)?\/?$/;
const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function fail(message) {
  return new TrackerError('provider-error', message);
}

function iso(value) {
  if (value === undefined || value === null || value === '') return null;
  try { return toIso(value); } catch { return null; }
}

function mapState(raw, draft, closedStates) {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'OPEN') return draft === true ? 'draft' : 'open';
  if (closedStates.includes(s)) return 'closed';
  return 'unknown';
}

// Bitbucket Cloud has no merge timestamp; the last update of a merged PR is the closest record.
export function mapCloudPr(json) {
  const state = mapState(json.state, json.draft, ['DECLINED', 'SUPERSEDED']);
  return { state, opened_at: iso(json.created_on), merged_at: state === 'merged' ? iso(json.updated_on) : null, base_branch: json.destination?.branch?.name ?? null, head_branch: json.source?.branch?.name ?? null };
}

export function mapServerPr(json) {
  const state = mapState(json.state, json.draft, ['DECLINED']);
  return { state, opened_at: iso(json.createdDate), merged_at: state === 'merged' ? iso(json.closedDate ?? json.updatedDate) : null, base_branch: json.toRef?.displayId ?? null, head_branch: json.fromRef?.displayId ?? null };
}

function serverBase(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { throw fail(`provider_url "${baseUrl}" is not a URL`); }
  const loopback = u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  if (u.protocol !== 'https:' && !loopback) throw fail(`provider_url must use https (got ${u.protocol}//${u.host})`);
  if (u.search || u.hash || u.username || u.password) throw fail('provider_url must not contain credentials, a query or a fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function apiUrlFor(prUrl, base) {
  let u;
  try { u = new URL(prUrl); } catch { throw fail(`unsupported Bitbucket PR link ${prUrl}`); }
  if (base) {
    const root = new URL(base);
    const prefix = root.pathname.replace(/\/+$/, '');
    const m = u.origin === root.origin && u.pathname.startsWith(`${prefix}/`) ? SERVER_PATH_RE.exec(u.pathname.slice(prefix.length)) : null;
    if (!m) throw fail(`this repository is configured for ${base}; ${u.origin} links are not polled`);
    return `${base}/rest/api/1.0/projects/${m[1]}/repos/${m[2]}/pull-requests/${m[3]}`;
  }
  const m = u.protocol === 'https:' && u.hostname === 'bitbucket.org' && !u.port ? CLOUD_PATH_RE.exec(u.pathname) : null;
  if (!m) throw fail(`not a Bitbucket Cloud PR link (set provider_url for Bitbucket Server): ${u.origin}`);
  return `https://api.bitbucket.org/2.0/repositories/${m[1]}/${m[2]}/pullrequests/${m[3]}`;
}

export function createBitbucketProvider({ baseUrl = null, tokenEnv = 'BITBUCKET_TOKEN', usernameEnv = null, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let base = null;
  let configError = null;
  try { base = baseUrl ? serverBase(baseUrl) : null; } catch (err) { configError = err; }
  return {
    name: 'bitbucket',
    async fetchPr(url) {
      if (configError) throw configError;
      const target = apiUrlFor(url, base);
      const token = env[tokenEnv];
      if (!token) throw fail(`set ${tokenEnv} to a Bitbucket ${base ? 'HTTP access token' : 'access token or app password'} to poll pull requests`);
      const user = usernameEnv ? env[usernameEnv] : null;
      const authorization = user ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` : `Bearer ${token}`;
      let res;
      // A ref'd timer, not AbortSignal.timeout(): that one is unref'd, so with nothing else
      // pending the process can exit before it fires and the request never settles.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        res = await fetchImpl(target, { headers: { accept: 'application/json', authorization }, redirect: 'error', signal: controller.signal });
      } catch (err) {
        throw fail(`Bitbucket request failed: ${timedOut || (err && err.name === 'TimeoutError') ? 'timed out' : 'network error'}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw fail(`Bitbucket returned HTTP ${res.status}${res.status === 401 || res.status === 403 ? ` (check ${tokenEnv})` : ''}`);
      const text = await res.text();
      if (text.length > MAX_BODY) throw fail('Bitbucket response is too large');
      let json;
      try { json = JSON.parse(text); } catch { throw fail('Bitbucket returned malformed JSON'); }
      return base ? mapServerPr(json) : mapCloudPr(json);
    },
  };
}
