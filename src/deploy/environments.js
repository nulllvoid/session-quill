// Deployment environments per repository and the per-environment status of a ticket (ADR 0009).
export const ENV_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_ENVIRONMENTS = 10;
// How a deployment was evidenced: the merge itself, a values-file or manifest tag bump, an ArgoCD
// sync, a release tag, the owner's word, or an accepted agent suggestion.
export const EVIDENCE_KINDS = ['merge', 'tag', 'argocd', 'release', 'manual', 'agent'];

// A repository's own deployment_environments win, then the tracker's environments, then production.
export function effectiveEnvironments(repo, tracker) {
  if (repo && Array.isArray(repo.deployment_environments) && repo.deployment_environments.length) return [...repo.deployment_environments];
  if (tracker && Array.isArray(tracker.environments) && tracker.environments.length) return [...tracker.environments];
  return ['production'];
}

// One entry per configured environment (in order), then any environment that only appears on an
// obligation (for example one removed from config), so nothing outstanding disappears.
export function environmentStatus(ticket, environments = []) {
  const deployments = ticket.deployments ?? [];
  const names = [...environments];
  for (const d of deployments) if (!names.includes(d.environment)) names.push(d.environment);
  return names.map((environment) => {
    const items = deployments.filter((d) => d.environment === environment);
    const pending = items.filter((d) => d.state === 'pending').length;
    const deployed = items.filter((d) => d.state === 'deployed').sort((a, b) => (a.deployed_at < b.deployed_at ? 1 : -1));
    const waived = items.filter((d) => d.state === 'waived');
    const state = pending ? 'pending' : deployed.length ? 'done' : waived.length ? 'n-a' : 'none';
    const latest = deployed[0] ?? null;
    return {
      environment, state, pending, obligations: items.length,
      merged_at: items.length ? items.reduce((m, d) => (d.merged_at && (!m || d.merged_at < m) ? d.merged_at : m), null) : null,
      deployed_at: latest ? latest.deployed_at : null, evidence: latest ? latest.evidence ?? null : null, evidence_kind: latest ? latest.evidence_kind ?? 'manual' : null,
      waiver_reason: state === 'n-a' ? waived[0].waiver_reason ?? null : null,
    };
  });
}
