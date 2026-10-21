import { execFile } from 'node:child_process';
import { toIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

export function mapGithubPr(json) {
  let state = 'unknown';
  if (json.state === 'MERGED') state = 'merged';
  else if (json.state === 'OPEN') state = json.isDraft ? 'draft' : 'open';
  else if (json.state === 'CLOSED') state = 'closed';
  return {
    state,
    opened_at: json.createdAt ? toIso(json.createdAt) : null,
    merged_at: json.mergedAt ? toIso(json.mergedAt) : null,
    base_branch: json.baseRefName ?? null,
    head_branch: json.headRefName ?? null,
  };
}

function run(cmd, args, { timeoutMs = 15_000, cwd, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd, windowsHide: true, encoding: 'utf8', maxBuffer }, (err, stdout, stderr) => {
      if (err) reject(new TrackerError('provider-error', (stderr || err.message || 'gh failed').trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

// CI checks of a pull request (ADR 0039), one word per check: failed, pending, passed or skipped.
// A cancelled or stale check is neither a pass nor a failure of the code, so it counts as skipped.
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR']);
const SKIPPED = new Set(['NEUTRAL', 'SKIPPED', 'CANCELLED', 'STALE']);
const ACTIONS_JOB = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d{1,20})(?:\/job\/(\d{1,20}))?/;

export function mapCheck(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.__typename === 'StatusContext' || (c.context !== undefined && c.status === undefined)) {
    const st = String(c.state ?? '').toUpperCase();
    return { name: String(c.context ?? 'status'), state: st === 'SUCCESS' ? 'passed' : FAILED.has(st) ? 'failed' : 'pending', run_id: null, job_id: null };
  }
  const status = String(c.status ?? '').toUpperCase();
  const conclusion = String(c.conclusion ?? '').toUpperCase();
  const m = ACTIONS_JOB.exec(String(c.detailsUrl ?? ''));
  const name = [c.workflowName, c.name].filter((x) => typeof x === 'string' && x).join(' / ') || 'check';
  const state = status && status !== 'COMPLETED' ? 'pending' : conclusion === 'SUCCESS' ? 'passed' : FAILED.has(conclusion) ? 'failed' : SKIPPED.has(conclusion) ? 'skipped' : 'pending';
  return { name, state, run_id: m ? m[1] : null, job_id: m && m[2] ? m[2] : null };
}

// failing when any check failed, else pending while any runs, passing when one passed, else none.
export function rollupState(checks) {
  if (checks.some((c) => c.state === 'failed')) return 'failing';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  if (checks.some((c) => c.state === 'passed')) return 'passing';
  return 'none';
}

// Uses the authenticated GitHub CLI; credentials never pass through the quill.
export function createGithubProvider({ exec = run } = {}) {
  return {
    name: 'github',
    async fetchPr(url) {
      if (!GITHUB_PR_URL.test(url)) throw new TrackerError('provider-error', `unsupported GitHub PR URL ${url}`);
      const out = await exec('gh', ['pr', 'view', url, '--json', 'state,isDraft,createdAt,mergedAt,baseRefName,headRefName']);
      let json;
      try { json = JSON.parse(out); } catch { throw new TrackerError('provider-error', 'gh returned malformed JSON'); }
      return mapGithubPr(json);
    },
    // PRs whose head is `branch`, in the repository checked out at `cwd` (gh reads its remote).
    async findPrs(branch, { cwd }) {
      if (typeof branch !== 'string' || !/^[A-Za-z0-9._/+-]{1,255}$/.test(branch) || branch.startsWith('-')) throw new TrackerError('provider-error', `unsupported branch name ${branch}`);
      const out = await exec('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', 'url,state,isDraft,createdAt,mergedAt,baseRefName,headRefName'], { cwd });
      let list;
      try { list = JSON.parse(out); } catch { throw new TrackerError('provider-error', 'gh returned malformed JSON'); }
      return (Array.isArray(list) ? list : [])
        .filter((x) => typeof x.url === 'string' && GITHUB_PR_URL.test(x.url) && x.headRefName === branch)
        .map((x) => ({ url: x.url, ...mapGithubPr(x) }));
    },
    // The head commit, branch, state and CI checks of a pull request (ADR 0039).
    async fetchChecks(url) {
      if (!GITHUB_PR_URL.test(url)) throw new TrackerError('provider-error', `unsupported GitHub PR URL ${url}`);
      const out = await exec('gh', ['pr', 'view', url, '--json', 'state,isDraft,headRefName,headRefOid,statusCheckRollup']);
      let json;
      try { json = JSON.parse(out); } catch { throw new TrackerError('provider-error', 'gh returned malformed JSON'); }
      if (!json || typeof json.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(json.headRefOid)) throw new TrackerError('provider-error', 'gh returned no head commit for the pull request');
      const checks = (Array.isArray(json.statusCheckRollup) ? json.statusCheckRollup : []).map(mapCheck).filter(Boolean).slice(0, 30);
      return { head_sha: json.headRefOid, head_branch: json.headRefName ?? null, pr_state: mapGithubPr(json).state, checks, state: rollupState(checks) };
    },
    // The failed steps' log of one GitHub Actions run (or one of its jobs), raw: the caller redacts
    // and caps it. Null when the check is not an Actions run.
    async fetchFailedLog(url, check) {
      const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+$/.exec(url);
      if (!m) throw new TrackerError('provider-error', `unsupported GitHub PR URL ${url}`);
      if (!check || !/^\d{1,20}$/.test(String(check.run_id ?? ''))) return null;
      const args = ['run', 'view', ...(check.job_id && /^\d{1,20}$/.test(String(check.job_id)) ? ['--job', String(check.job_id)] : [String(check.run_id)]), '--repo', `${m[1]}/${m[2]}`, '--log-failed'];
      return exec('gh', args, { timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 });
    },
  };
}
