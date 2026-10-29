// Plans are owner artifacts; reviewed execution freezes their content and semantic context.
import { execFileSync } from 'node:child_process';
import { contentHash } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';
import { putBlob, getBlob } from '../core/blobs.js';
import { canonicalJson as encode } from './grant.js';

export const PLAN_TEXT_MAX = 20000;
const pick = (value, keys) => Object.fromEntries(keys.map(k => [k, value?.[k] ?? null]));
const sorted = values => values.sort((a,b) => encode(a).localeCompare(encode(b)));

export function semanticPlanContext(state, ticket, repoId = ticket.repo_id ?? null) {
  // Traverse required and unclassified descendants; an independent follow-up cannot invalidate scope.
  const children = new Map();
  for (const t of state.tickets.values()) if (t.parent_id && t.blocks_parent !== false) {
    if (!children.has(t.parent_id)) children.set(t.parent_id, []);
    children.get(t.parent_id).push(t);
  }
  const related = [], seen = new Set([ticket.id]), pending = [...(children.get(ticket.id) ?? [])];
  while (pending.length) {
    const t = pending.pop(); if (seen.has(t.id)) continue; seen.add(t.id);
    related.push(pick(t,['id','parent_id','blocks_parent','status','resolution','completion_mode','completion_conflict']));
    pending.push(...(children.get(t.id) ?? []));
  }
  return {
    ticket: pick(ticket,['id','title','summary','user_notes','next_action','blocker','status','completion_mode','resolution','parent_id','blocks_parent']),
    repo_id: repoId,
    parent: ticket.parent_id ? pick(state.tickets.get(ticket.parent_id),['id','status','completion_mode','resolution']) : null,
    required_descendants: sorted(related),
    accepted_plans: sorted((ticket.plans ?? []).map(p => pick(p,['id','checkpoint_id','content_ref']))),
    prs: sorted((ticket.prs ?? []).map(p => pick(p,['id','url','state','evidence_id','head_sha','merge_commit_sha','merged_at','reverted_at']))),
    run_pr_evidence: sorted([...(state.handoffs?.values() ?? [])].filter(h => seen.has(h.ticket_id) && h.pr_observed).map(h => ({ id:h.id, ticket_id:h.ticket_id, pr_url:h.pr_url, ...pick(h.pr_observed,['state','merge_commit','reverted_by']) }))),
    deployments: sorted((ticket.deployments ?? []).map(d => pick(d,['id','pr_id','environment','state','evidence_id','commit_sha']))),
  };
}

export function capturePlanContext(state, ticket, { repoId = ticket.repo_id ?? null, baseCommit = null, env = process.env } = {}) {
  const text = encode(semanticPlanContext(state,ticket,repoId));
  return { ticket_revision: ticket.revision, source_sequence: state.lastSequence ?? 0, repo_id: repoId, base_commit: baseCommit, fingerprint: contentHash(text), manifest_ref: putBlob(text,env).hash };
}

// Local refs only: a review/read-only run must not fetch or move the owner's repository refs.
export function planBaseCommit(ticket, repo) {
  if (!repo?.canonical_path) return null;
  const branches = [...(ticket.branches ?? [])].sort((a,b) => String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')));
  const name = branches[0]?.name;
  const refs = typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/@+-]{0,200}$/.test(name) && !name.includes('..') ? [`refs/heads/${name}`,`refs/remotes/origin/${name}`,'HEAD'] : ['HEAD'];
  for (const ref of refs) {
    try {
      return execFileSync('git',['rev-parse','--verify',`${ref}^{commit}`],{cwd:repo.canonical_path,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
    } catch { /* Try the next local ref; never fetch during review. */ }
  }
  throw new TrackerError('plan-base-unavailable','the selected repository has no available base commit');
}

function sourcePlan(ticket, run, env) {
  if (!run || run.ticket_id !== ticket.id || run.intent !== 'plan' || run.state !== 'done' || !run.plan_ref || !Number.isInteger(run.plan_revision)) throw new TrackerError('plan-unknown','the source must be a completed Plan run of this ticket');
  if (!getBlob(run.plan_ref,env)) throw new TrackerError('plan-content-missing','the saved plan content is unavailable; recover it before execution');
  if (!run.plan_context?.manifest_ref || !getBlob(run.plan_context.manifest_ref,env)) throw new TrackerError('plan-context-missing','the original plan context is unavailable; generate a new plan');
}

export function planReview(state,ticket,run,{repo = null,env = process.env} = {}) {
  sourcePlan(ticket,run,env);
  const current = capturePlanContext(state,ticket,{repoId:repo?.id ?? ticket.repo_id ?? null,baseCommit:planBaseCommit(ticket,repo),env});
  return { source_plan_run_id:run.id,source_plan_ref:run.plan_ref,source_plan_revision:run.plan_revision,
    reviewed_context_fingerprint:current.fingerprint,reviewed_base_commit:current.base_commit,
    current_context:current,original_context:run.plan_context,
    current_manifest:JSON.parse(getBlob(current.manifest_ref,env)),original_manifest:JSON.parse(getBlob(run.plan_context.manifest_ref,env)),
    context_changed:current.fingerprint !== run.plan_context.fingerprint,base_changed:current.base_commit !== run.plan_context.base_commit };
}

export function validatePlanExecution(state,ticket,payload,{repo = null,env = process.env} = {}) {
  const keys=['source_plan_run_id','source_plan_ref','source_plan_revision','reviewed_context_fingerprint','reviewed_base_commit'];
  if (!keys.some(k => Object.hasOwn(payload,k))) return {};
  if (!['auto','full'].includes(payload.intent)) throw new TrackerError('plan-execution-intent','executing a reviewed plan requires Auto or Full access');
  const run = state.handoffs.get(payload.source_plan_run_id);
  sourcePlan(ticket,run,env);
  if (payload.source_plan_ref !== run.plan_ref || payload.source_plan_revision !== run.plan_revision) throw new TrackerError('plan-revision-conflict','the plan was revised; review its current revision before running', {status:409});
  const review = planReview(state,ticket,run,{repo,env});
  if (payload.reviewed_context_fingerprint !== review.reviewed_context_fingerprint || payload.reviewed_base_commit !== review.reviewed_base_commit) throw new TrackerError('plan-context-changed','ticket context or repository base changed; review and run against current context', {status:409});
  return { ...Object.fromEntries(keys.map(k => [k,review[k]])),reviewed_context_ref:review.current_context.manifest_ref,reviewed_repo_id:review.current_context.repo_id };
}

export function validatePlanDispatch(state,ticket,run,{env = process.env} = {}) {
  if (!run.source_plan_ref) return;
  if (!getBlob(run.source_plan_ref,env) || !getBlob(run.reviewed_context_ref,env)) throw new TrackerError('plan-content-missing','the reviewed plan or context is unavailable');
  const fingerprint=contentHash(encode(semanticPlanContext(state,ticket,run.reviewed_repo_id)));
  if (fingerprint !== run.reviewed_context_fingerprint) throw new TrackerError('plan-context-changed','ticket context changed while this run was queued; review the plan again');
}

export function reviseRunPlan(state,ticket,payload,{env = process.env} = {}) {
  const run=state.handoffs.get(payload.handoff_id); sourcePlan(ticket,run,env);
  if (payload.expected_plan_revision !== run.plan_revision) throw new TrackerError('plan-revision-conflict','the plan was revised; reload it before saving', {status:409});
  if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > PLAN_TEXT_MAX) throw new TrackerError('plan-text-invalid',`plan text must contain 1 to ${PLAN_TEXT_MAX} characters`);
  return {plan_ref:putBlob(payload.text,env).hash,plan_revision:run.plan_revision+1};
}

export function planArtifact(result,handoff,ticket) {
  const steps=(result.plan ?? []).map((s,i) => `${i+1}. ${s}`).join('\n');
  return [`# Plan: ${ticket?.key ?? handoff.ticket_id}`,`Objective: ${handoff.instructions || ticket?.next_action || ticket?.title || ''}`,result.summary,steps ? `## Ordered steps\n${steps}` : null,result.blocker ? `## Dependencies and blockers\n${result.blocker}` : null,result.next_action ? `## Next action\n${result.next_action}` : null].filter(Boolean).join('\n\n').slice(0,PLAN_TEXT_MAX);
}
