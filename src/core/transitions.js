// Ticket status transitions and deployment obligations (DATA-CONTRACT §Ticket transitions,
// TRD §Workflow and deployments).
import { TrackerError } from '../lib/errors.js';
import { TICKET_STATUSES } from './state.js';
import { deterministicId } from '../lib/ids.js';

export function applyStatusChange(ticket, { status, source = 'manual', seq = 0, blocker, evidence_id = null }) {
  if (!TICKET_STATUSES.includes(status)) throw new TrackerError('status-invalid', `unknown status ${status}`);
  if (status === 'blocked' && !(typeof blocker === 'string' && blocker.trim())) {
    throw new TrackerError('blocker-required', 'blocked requires blocker text');
  }
  const changed = ticket.status !== status;
  ticket.status = status;
  ticket.status_source = source;
  ticket.status_evidence_id = evidence_id;
  if (status === 'blocked') ticket.blocker = blocker.trim();
  else if (ticket.blocker !== null && status !== 'blocked') ticket.blocker = null;
  if (source === 'manual' || source === 'migration') {
    ticket.manual_status_evidence_floor = Math.max(ticket.manual_status_evidence_floor ?? 0, seq);
  }
  return { changed };
}

export function outstandingObligations(ticket) {
  return ticket.deployments.filter((d) => d.state === 'pending');
}

function ensureObligations(ticket, { pr_id, merged_at, source_event_id }, repo) {
  const environments = (repo && Array.isArray(repo.deployment_environments) && repo.deployment_environments.length)
    ? repo.deployment_environments : ['production'];
  let created = 0;
  for (const environment of environments) {
    if (ticket.deployments.some((d) => d.pr_id === pr_id && d.environment === environment)) continue;
    ticket.deployments.push({
      id: deterministicId(`${source_event_id}:deployment:${pr_id}:${environment}`), pr_id, environment, state: 'pending', merged_at, deployed_at: null, evidence: null, waiver_reason: null, source_event_id,
    });
    created += 1;
  }
  return created;
}

// Evidence may propose/derive statuses but never overrides blocked, explicit done, or a manual
// decision at or below the recorded evidence floor.
export function deriveStatusFromEvidence(ticket, evidence, repo) {
  const { type, seq, evidence_id } = evidence;
  const floor = ticket.manual_status_evidence_floor ?? 0;
  const aboveFloor = seq > floor;
  const from = ticket.status;
  let target = null;

  if (type === 'write') {
    if (from === 'todo') target = 'active';
  } else if (type === 'pr-open' || type === 'pr-draft') {
    if (from === 'todo' || from === 'active') target = 'review';
  } else if (type === 'pr-merged') {
    ensureObligations(ticket, evidence, repo);
    if (['todo', 'active', 'review'].includes(from) && outstandingObligations(ticket).length) target = 'deploy-pending';
  } else if (type === 'obligations-cleared') {
    if (from === 'deploy-pending' && ticket.deployments.length && outstandingObligations(ticket).length === 0) target = 'done';
  } else {
    throw new TrackerError('evidence-invalid', `unknown evidence type ${type}`);
  }

  if (!target || !aboveFloor || from === 'blocked' || (from === 'done' && target !== 'done')) {
    return { changed: false };
  }
  ticket.status = target;
  ticket.status_source = 'evidence';
  ticket.status_evidence_id = evidence_id ?? null;
  return { changed: true };
}

export function recordDeployment(ticket, { pr_id, environment, deployed_at = null, evidence = null, waiver_reason = null, state }) {
  const obligation = ticket.deployments.find((d) => d.pr_id === pr_id && d.environment === environment);
  if (!obligation) throw new TrackerError('obligation-missing', `no deployment obligation for ${pr_id}/${environment}`);
  if (state === 'waived') {
    if (!(typeof waiver_reason === 'string' && waiver_reason.trim())) throw new TrackerError('waiver-reason-required', 'a waived deployment requires a reason');
    obligation.state = 'waived';
    obligation.waiver_reason = waiver_reason.trim();
  } else if (state === 'deployed') {
    if (!deployed_at) throw new TrackerError('deployed-at-required', 'mark deployed requires a timestamp');
    obligation.state = 'deployed';
    obligation.deployed_at = deployed_at;
    obligation.evidence = evidence;
  } else {
    throw new TrackerError('deployment-state-invalid', `unknown deployment state ${state}`);
  }
  return obligation;
}
