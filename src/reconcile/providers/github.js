import { execFile } from 'node:child_process';
import { toIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const GITHUB_PR_PARTS = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
// ADR 0033: a revert counts against a merge only when it lands within this long of the merge.
export const REVERT_WINDOW_MS = 48 * 60 * 60 * 1000;
const sha = (v) => (typeof v === 'string' && SHA.test(v) ? v : null);

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
    // The default-branch commit the merge made (ADR 0033), for revert detection.
    merge_commit: json.state === 'MERGED' ? sha(json.mergeCommit && json.mergeCommit.oid) : null,
  };
}

const parse = (out) => { try { return JSON.parse(out); } catch { throw new TrackerError('provider-error', 'gh returned malformed JSON'); } };

const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A merged PR is the revert of PR <number> of <owner>/<repo> only when it names that PR the way
// GitHub's Revert button does: "Reverts <owner>/<repo>#<number>" in its body, or a head branch
// `revert-<number>-…`. A title is never enough: a bulk dispatch gives many runs' PRs one title.
export function namesRevertOf(pr, { owner, repo, number }) {
  if (!pr || typeof pr !== 'object') return false;
  const body = typeof pr.body === 'string' ? pr.body : '';
  const head = typeof pr.headRefName === 'string' ? pr.headRefName : '';
  const named = new RegExp(`(?:^|\\s)Reverts ${escapeRe(owner)}/${escapeRe(repo)}#${number}(?!\\d)`, 'i');
  return named.test(body) || head.startsWith(`revert-${number}-`);
}

// ADR 0033: the revert of a merged PR within REVERT_WINDOW_MS of its merge, if any: a commit on
// the default branch whose message says "This reverts commit <merge commit>", or a merged PR that
// names this one as the PR it reverts (namesRevertOf). Only shas and times are read from what
// GitHub returns.
export async function findGithubRevert(exec, { url, merged_at = null, merge_commit = null }) {
  const m = GITHUB_PR_PARTS.exec(url ?? '');
  if (!m) throw new TrackerError('provider-error', `unsupported GitHub PR URL ${url}`);
  const slug = `${m[1]}/${m[2]}`;
  const self = { owner: m[1], repo: m[2], number: m[3] };
  const view = parse(await exec('gh', ['pr', 'view', url, '--json', 'mergeCommit,mergedAt']));
  const merge = sha(merge_commit) ?? sha(view && view.mergeCommit && view.mergeCommit.oid);
  const mergedAt = merged_at ?? (view && view.mergedAt ? toIso(view.mergedAt) : null);
  if (!merge || !mergedAt) return { reverted_by: null, reverted_at: null, merge_commit: merge };
  const start = Date.parse(mergedAt);
  const within = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) && t >= start && t - start <= REVERT_WINDOW_MS; };
  const until = new Date(start + REVERT_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const commits = parse(await exec('gh', ['api', `repos/${slug}/commits?since=${encodeURIComponent(mergedAt)}&until=${encodeURIComponent(until)}&per_page=100`]));
  const marker = `This reverts commit ${merge}`;
  for (const c of Array.isArray(commits) ? commits : []) {
    const message = c && c.commit && typeof c.commit.message === 'string' ? c.commit.message : '';
    const at = c && c.commit && c.commit.committer ? c.commit.committer.date : null;
    if (sha(c && c.sha) && message.includes(marker) && within(at)) return { reverted_by: c.sha, reverted_at: toIso(at), merge_commit: merge };
  }
  const list = parse(await exec('gh', ['pr', 'list', '--repo', slug, '--state', 'merged', '--search', 'Revert in:title', '--limit', '50', '--json', 'title,body,headRefName,mergedAt,mergeCommit']));
  for (const p of Array.isArray(list) ? list : []) {
    const oid = sha(p && p.mergeCommit && p.mergeCommit.oid);
    if (oid && namesRevertOf(p, self) && within(p.mergedAt)) return { reverted_by: oid, reverted_at: toIso(p.mergedAt), merge_commit: merge };
  }
  return { reverted_by: null, reverted_at: null, merge_commit: merge };
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
      const out = await exec('gh', ['pr', 'view', url, '--json', 'state,isDraft,createdAt,mergedAt,baseRefName,headRefName,mergeCommit']);
      let json;
      try { json = JSON.parse(out); } catch { throw new TrackerError('provider-error', 'gh returned malformed JSON'); }
      return mapGithubPr(json);
    },
    findRevert(opts) { return findGithubRevert(exec, opts); },
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
