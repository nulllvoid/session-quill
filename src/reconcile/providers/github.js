import { execFile } from 'node:child_process';
import { toIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const GITHUB_PR_PARTS = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/\d+$/;
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

// ADR 0033: the revert of a merged PR within REVERT_WINDOW_MS of its merge, if any: a commit on
// the default branch whose message says "This reverts commit <merge commit>", or a merged PR
// titled `Revert "<title>"`. Only shas and times are read from what GitHub returns.
export async function findGithubRevert(exec, { url, merged_at = null, merge_commit = null }) {
  const m = GITHUB_PR_PARTS.exec(url ?? '');
  if (!m) throw new TrackerError('provider-error', `unsupported GitHub PR URL ${url}`);
  const slug = `${m[1]}/${m[2]}`;
  const view = parse(await exec('gh', ['pr', 'view', url, '--json', 'title,mergeCommit,mergedAt']));
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
  const title = view && typeof view.title === 'string' ? view.title : null;
  if (title) {
    const list = parse(await exec('gh', ['pr', 'list', '--repo', slug, '--state', 'merged', '--search', 'Revert in:title', '--limit', '30', '--json', 'title,mergedAt,mergeCommit']));
    for (const p of Array.isArray(list) ? list : []) {
      const oid = sha(p && p.mergeCommit && p.mergeCommit.oid);
      if (oid && p.title === `Revert "${title}"` && within(p.mergedAt)) return { reverted_by: oid, reverted_at: toIso(p.mergedAt), merge_commit: merge };
    }
  }
  return { reverted_by: null, reverted_at: null, merge_commit: merge };
}

function run(cmd, args, { timeoutMs = 15_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new TrackerError('provider-error', (stderr || err.message || 'gh failed').trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
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
  };
}
