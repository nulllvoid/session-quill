import { execFile } from 'node:child_process';
import { toIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

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

function run(cmd, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new TrackerError('provider-error', (stderr || err.message || 'gh failed').trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

// Uses the authenticated GitHub CLI; credentials never pass through the tracker.
export function createGithubProvider({ exec = run } = {}) {
  return {
    name: 'github',
    async fetchPr(url) {
      if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url)) throw new TrackerError('provider-error', `unsupported GitHub PR URL ${url}`);
      const out = await exec('gh', ['pr', 'view', url, '--json', 'state,isDraft,createdAt,mergedAt,baseRefName,headRefName']);
      let json;
      try { json = JSON.parse(out); } catch { throw new TrackerError('provider-error', 'gh returned malformed JSON'); }
      return mapGithubPr(json);
    },
  };
}
