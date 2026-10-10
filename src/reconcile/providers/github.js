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
  };
}
