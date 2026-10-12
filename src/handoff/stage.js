// The stage a run reached according to facts the worker observed itself (spec §5.3). The agent's
// own `stage_reached` is only a claim; run detail shows this value and flags a higher claim as
// "not recorded". A requested branch is not a push: only `pushed_branch`, set after a push
// succeeded, counts.
export const STAGES = ['investigated', 'planned', 'changed', 'tested', 'committed', 'pushed', 'pr_opened', 'ci_checked', 'deployed', 'verified'];

export function recordedStage(h) {
  const r = h && typeof h === 'object' ? h : {};
  if (r.pr_url) return 'pr_opened';
  if (r.pushed_branch) return 'pushed';
  if (r.commit_sha) return 'committed';
  if (r.test_gate && r.test_gate.status === 'passed') return 'tested';
  return 'investigated';
}
