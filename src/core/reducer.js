// Pure reducer: journal events -> generated state. Replay never runs tools or remote requests;
// duplicate event IDs or source identities have exactly one effect (TRD §Durability).
import { deterministicId } from '../lib/ids.js';
import { sessionKey, refreshDerived, bumpRevision, repoFor } from './state.js';
import { stripMarkupTags } from '../lib/text.js';
import { hasValidDescription } from './description.js';
import { deriveStatusFromEvidence } from './transitions.js';
import { heuristicApprovalEligible } from './approval.js';
import { timelineEntry, touch } from './reduce/common.js';
import { getOrCreateSession, bindSession, recomputeUnpromoted, approveCheckpoint } from './reduce/sessions.js';
import { applyTicketFields, createTicket, bindExternal, relinkTicket } from './reduce/tickets.js';
import { applyTrackerSync, applyTrackerPush, applyArtifactComment, applyPublishRun, applyScheduleRun, applyRunProposal, lapseProposals } from './reduce/integrations.js';
import { resolveAttribution, sweepDeferred, handlePostTool, handleStop } from './reduce/capture.js';
import { handleRequest, handleRequestTx, handleHandoffTx } from './reduce/requests.js';
import { applyMemoryTx } from './reduce/memory.js';
import { applyCriticalProposal } from './reduce/critical.js';
import { applyWorktree } from './reduce/worktrees.js';
import { applySnapshotTx } from './reduce/snapshots.js';

export { SCHEDULE_HISTORY, PUBLISH_HISTORY } from './reduce/integrations.js';

// The shape and meaning of reduced state (ADR 0030). A state checkpoint written under another value
// is ignored and the journal replays in full, so bump it in any change that makes existing events
// reduce differently or adds, removes or reshapes a state field.
export const REDUCER_VERSION = 1;

function replayDeferred(state, key, toolCallId, result) {
  if (!state.deferredResults) return;
  const deferredKey = `${key}:${toolCallId}`;
  const pending = state.deferredResults.get(deferredKey);
  if (!pending) return;
  state.deferredResults.delete(deferredKey);
  const sub = applyEventInner(state, pending, { replayingDeferred: true });
  for (const id of sub.changed) result.changed.add(id);
}

// What reconciliation observed of the draft PR a run opened (ADR 0033): local to the run record,
// never exported. Only shas and times are kept; a failed poll keeps the last observation.
const SHA40 = /^[0-9a-f]{40}$/;
function applyRunPrObservation(state, upd, ev, result) {
  const h = state.handoffs.get(upd.handoff_id);
  if (!h || h.pr_url !== upd.url) return;
  const prev = h.pr_observed && typeof h.pr_observed === 'object' ? h.pr_observed : {};
  const iso = (v) => (typeof v === 'string' && v ? v : null);
  if (upd.error) {
    h.pr_observed = { ...prev, error: String(upd.error).slice(0, 300) };
  } else {
    const sha = (v) => (typeof v === 'string' && SHA40.test(v) ? v : null);
    const reverted = sha(upd.reverted_by);
    h.pr_observed = {
      state: typeof upd.state === 'string' ? upd.state : prev.state ?? 'unknown',
      merged_at: iso(upd.merged_at) ?? prev.merged_at ?? null,
      merge_commit: sha(upd.merge_commit) ?? prev.merge_commit ?? null,
      reverted_by: reverted ?? prev.reverted_by ?? null,
      reverted_at: (reverted ? iso(upd.reverted_at) : null) ?? prev.reverted_at ?? null,
      revert_checked_at: iso(upd.revert_checked_at) ?? prev.revert_checked_at ?? null,
      observed_at: iso(upd.observed_at) ?? ev.occurred_at,
      error: null,
    };
  }
  result.handoffsChanged.add(h.id);
}

export function applyEvent(state, ev) {
  return applyEventInner(state, ev, {});
}

function applyEventInner(state, ev, { replayingDeferred = false }) {
  const result = { changed: new Set(), bindingChanged: new Set(), requestsChanged: new Set(), handoffsChanged: new Set(), effects: [] };
  if (!replayingDeferred) {
    if (state.appliedEvents.has(ev.event_id) || (ev.source_identity && state.appliedSources.has(ev.source_identity))) {
      result.duplicate = true;
      return result;
    }
    state.appliedEvents.add(ev.event_id);
    if (ev.source_identity) state.appliedSources.add(ev.source_identity);
  }
  if (Number.isInteger(ev.sequence) && ev.sequence > state.lastSequence) state.lastSequence = ev.sequence;
  if (!['reconcile', 'notify', 'request', 'request-tx', 'memory-tx'].includes(ev.kind) && ev.producer !== 'worker') {
    if (!state.lastCaptureAt || ev.occurred_at > state.lastCaptureAt) state.lastCaptureAt = ev.occurred_at;
  }

  switch (ev.kind) {
    case 'session-start': {
      const s = getOrCreateSession(state, ev, { source: ev.payload.source, cwd: ev.payload.cwd ?? null });
      if (ev.payload.machine_name) s.machine_name = ev.payload.machine_name;
      result.bindingChanged.add(sessionKey(ev));
      break;
    }
    case 'subagent-start': {
      const parentKey = sessionKey({ session_id: ev.payload.parent_session_id ?? ev.session_id });
      const parent = state.sessions.get(parentKey);
      const sub = getOrCreateSession(state, ev, { parent_session_id: parent ? parent.id : null });
      sub.agent_type = ev.payload.agent_type ?? null;
      if (parent && sub.bindings.length === 0) {
        sub.gate_enabled = parent.gate_enabled;
        bindSession(state, sub, ev, { ticket_id: parent.current_ticket_id, project_id: parent.project_ids[parent.project_ids.length - 1] ?? null }, result);
      }
      result.bindingChanged.add(sessionKey(ev));
      break;
    }
    case 'prompt': {
      const seen = state.sessions.has(sessionKey(ev));
      const s = getOrCreateSession(state, ev);
      // A session first seen through a prompt (started before `quill init`) gets a snapshot now.
      if (!seen) result.bindingChanged.add(sessionKey(ev));
      if (!s.title && ev.payload.title_candidate) s.title = stripMarkupTags(ev.payload.title_candidate).replace(/\s+/g, ' ').trim().slice(0, 80) || null;
      if (ev.payload.approval_candidate === true) {
        const cp = heuristicApprovalEligible(state, s, ev.occurred_at);
        if (cp) approveCheckpoint(state, ev, { checkpoint_id: cp.id, ticket_id: cp.ticket_id, provenance: 'heuristic' }, result);
      }
      s.events_since_checkpoint += 1;
      break;
    }
    case 'pre-tool': {
      const s = getOrCreateSession(state, ev);
      s.events_since_checkpoint += 1;
      if (ev.tool_call_id) {
        // A provisional hook binding can name a ticket id the worker resolved differently (the key
        // belonged to an existing ticket); the session's own confirmed binding is authoritative then.
        const unknownTicket = !!ev.ticket_id && !state.tickets.has(ev.ticket_id);
        const ticket_id = unknownTicket ? s.current_ticket_id : (ev.ticket_id ?? s.current_ticket_id);
        const binding_revision = unknownTicket ? s.current_binding_revision : (ev.binding_revision ?? s.current_binding_revision);
        state.pendingToolCalls.set(`${sessionKey(ev)}:${ev.tool_call_id}`, { session_key: sessionKey(ev), ticket_id, binding_revision, tool_name: ev.payload.tool_name, sequence: ev.sequence, at: ev.occurred_at, denied: ev.payload.denied === true });
        replayDeferred(state, sessionKey(ev), ev.tool_call_id, result);
      }
      break;
    }
    case 'post-tool':
      handlePostTool(state, ev, result);
      break;
    case 'tool-failure': {
      const s = getOrCreateSession(state, ev);
      s.events_since_checkpoint += 1;
      const attribution = resolveAttribution(state, ev, result);
      if (attribution) {
        state.pendingToolCalls.delete(`${sessionKey(ev)}:${ev.tool_call_id}`);
        s.change_coverage = 'partial';
        const ticket = attribution.ticket_id ? state.tickets.get(attribution.ticket_id) : null;
        if (ticket) {
          ticket.timeline.push(timelineEntry(ev, 'tool', `failed: ${ev.payload.tool_name ?? 'tool'}${ev.payload.error ? ` — ${String(ev.payload.error).slice(0, 120)}` : ''}`, { coverage: 'partial' }));
          touch(state, ticket, ev, result);
        }
      }
      break;
    }
    case 'stop':
    case 'subagent-stop':
      handleStop(state, ev, result);
      break;
    case 'pre-compact': {
      const s = getOrCreateSession(state, ev);
      const ticket = s.current_ticket_id ? state.tickets.get(s.current_ticket_id) : null;
      if (ticket) {
        ticket.timeline.push(timelineEntry(ev, 'conclusion', `Pre-compaction recovery summary saved (${ev.payload.trigger ?? 'auto'})`, { content_ref: ev.payload.summary_ref ?? null }));
        touch(state, ticket, ev, result);
      }
      result.effects.push({ type: 'recovery-summary', session_key: sessionKey(ev) });
      break;
    }
    case 'session-end': {
      const s = getOrCreateSession(state, ev);
      s.ended_at = ev.occurred_at;
      s.state = 'ended';
      result.bindingChanged.add(sessionKey(ev));
      result.effects.push({ type: 'flush' });
      break;
    }
    case 'bind': {
      const s = getOrCreateSession(state, ev);
      // Always republish: a rejected bind must replace any provisional snapshot the hook wrote.
      result.bindingChanged.add(sessionKey(ev));
      if (ev.payload.external) { Object.assign(result, bindExternal(state, s, ev, result)); break; }
      const ticket = ev.payload.ticket_id ? state.tickets.get(ev.payload.ticket_id) : null;
      if (ev.payload.ticket_id && !ticket) { result.rejected = 'ticket-unknown'; break; }
      bindSession(state, s, ev, { ticket_id: ev.payload.ticket_id ?? null, project_id: ev.payload.project_id ?? (ticket ? ticket.project_id : null) }, result);
      break;
    }
    case 'gate-off':
    case 'gate-on': {
      const s = getOrCreateSession(state, ev);
      s.gate_enabled = ev.kind === 'gate-on';
      const ticket = s.current_ticket_id ? state.tickets.get(s.current_ticket_id) : null;
      if (ticket) {
        ticket.timeline.push(timelineEntry(ev, 'status', `Ticket gate ${ev.kind === 'gate-on' ? 'on' : 'off'} for session ${s.host_session_id}`));
        touch(state, ticket, ev, result);
      }
      result.bindingChanged.add(sessionKey(ev));
      break;
    }
    case 'ticket-create':
    case 'migration':
    case 'import': {
      const source = ev.kind === 'ticket-create' ? 'manual' : ev.kind;
      if (ev.payload.ticket) {
        if (ev.kind === 'ticket-create' && ev.payload.reuse_task === true) {
          if (!ev.session_id) { result.rejected = 'session-required'; break; }
          const incoming = ev.payload.ticket;
          const normalized = (title) => String(title ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
          const matches = [...state.tickets.values()].filter((t) => t.status !== 'done' &&
            t.project_id === incoming.project_id && (t.repo_id ?? null) === (incoming.repo_id ?? null) &&
            (t.parent_id ?? null) === (incoming.parent_id ?? null) && normalized(t.title) === normalized(incoming.title));
          if (matches.length > 1) { result.rejected = 'task-ambiguous'; break; }
          let ticket = matches[0];
          // A reused task without a valid description takes the one this call brings (ADR 0014);
          // a valid one already there is never replaced.
          if (ticket && typeof incoming.summary === 'string' && incoming.summary.trim() && !hasValidDescription(ticket)) {
            applyTicketFields(state, ticket, { summary: incoming.summary }, ev, 'manual', result);
          }
          if (!ticket) {
            Object.assign(result, createTicket(state, ev, incoming, source, result));
            if (result.rejected) break;
            ticket = state.tickets.get(incoming.id);
          }
          const s = getOrCreateSession(state, ev);
          if (s.current_ticket_id !== ticket.id) bindSession(state, s, ev, { ticket_id: ticket.id, project_id: ticket.project_id }, result);
          result.ticket = Object.fromEntries(['id', 'key', 'title', 'category', 'priority', 'project_id', 'project_name', 'parent_id', 'repo_id', 'due', 'jira'].map((key) => [key, ticket[key]]));
          result.ticket.reused = matches.length === 1;
          break;
        }
        Object.assign(result, createTicket(state, ev, ev.payload.ticket, source, result));
      } else if (ev.payload.ticket_id && ev.payload.fields) {
        const ticket = state.tickets.get(ev.payload.ticket_id);
        if (!ticket) result.rejected = 'ticket-unknown';
        else applyTicketFields(state, ticket, ev.payload.fields, ev, source, result);
      }
      break;
    }
    case 'ticket-update': {
      const ticket = state.tickets.get(ev.payload.ticket_id);
      if (!ticket) { result.rejected = 'ticket-unknown'; break; }
      // Optional: callers that decided from a snapshot (ticket stale --apply) refuse to overwrite a
      // ticket that changed since. Events without it keep their original meaning on replay.
      if (Number.isInteger(ev.payload.expected_revision) && ev.payload.expected_revision !== ticket.revision) { result.rejected = 'revision-conflict'; break; }
      try {
        applyTicketFields(state, ticket, ev.payload.fields ?? {}, ev, ev.payload.source ?? 'manual', result);
      } catch (err) {
        result.rejected = err.code ?? 'update-invalid';
      }
      break;
    }
    case 'relink': {
      const ticket = state.tickets.get(ev.payload.ticket_id);
      if (!ticket) { result.rejected = 'ticket-unknown'; break; }
      const r = relinkTicket(state, ticket, ev, ev.payload, result);
      if (r.rejected) result.rejected = r.rejected;
      break;
    }
    case 'approve':
      Object.assign(result, approveCheckpoint(state, ev, ev.payload, result));
      break;
    case 'dismiss': {
      const cp = state.checkpoints.get(ev.payload.checkpoint_id);
      if (!cp) { result.rejected = 'no-checkpoint'; break; }
      cp.dismissed_at = ev.occurred_at;
      const session = state.sessionsById.get(cp.session_id);
      if (session) recomputeUnpromoted(state, session);
      break;
    }
    case 'request':
      Object.assign(result, handleRequest(state, ev, result));
      break;
    case 'request-tx':
      Object.assign(result, handleRequestTx(state, ev, result));
      break;
    case 'handoff-tx':
      Object.assign(result, handleHandoffTx(state, ev, result));
      break;
    case 'publish-run': Object.assign(result, applyPublishRun(state, ev)); break;
    case 'tracker-sync': Object.assign(result, applyTrackerSync(state, ev, result)); break;
    case 'tracker-push': Object.assign(result, applyTrackerPush(state, ev, result)); break;
    case 'artifact-comment': Object.assign(result, applyArtifactComment(state, ev, result)); break;
    case 'run-proposal': Object.assign(result, applyRunProposal(state, ev, result)); break;
    case 'memory-tx': Object.assign(result, applyMemoryTx(state, ev)); break;
    case 'critical-proposal': Object.assign(result, applyCriticalProposal(state, ev, result)); break;
    // 2.0.0 kinds reserved as no-ops; each task replaces its own line with its handler.
    case 'worktree': Object.assign(result, applyWorktree(state, ev, result)); break;
    case 'snapshot-tx': Object.assign(result, applySnapshotTx(state, ev, result)); break;
    case 'ci-observation': break;
    case 'ci-proposal': break;
    case 'schedule-run':
      Object.assign(result, applyScheduleRun(state, ev));
      break;
    case 'notify':
      state.notified.add(ev.payload.checkpoint_id);
      break;
    case 'reconcile': {
      const p = ev.payload;
      sweepDeferred(state, ev);
      if (p.last_sync) state.lastSync = p.last_sync;
      if (Array.isArray(p.provider_health)) state.providerHealth = p.provider_health;
      for (const upd of Array.isArray(p.pr_updates) ? p.pr_updates : []) {
        // A run's own draft PR (ADR 0033) is observed on the run, never as ticket evidence.
        if (upd && typeof upd.handoff_id === 'string') { applyRunPrObservation(state, upd, ev, result); continue; }
        const ticket = state.tickets.get(upd.ticket_id);
        if (!ticket) continue;
        let pr = ticket.prs.find((x) => x.id === upd.pr_id || x.url === upd.url);
        // A PR found from the branch the ticket's work landed on (ADR 0021).
        if (!pr && upd.link === true && typeof upd.url === 'string' && !upd.error) {
          pr = { id: deterministicId(`${ev.event_id}:pr:${ticket.id}:${upd.url}`), provider: upd.provider ?? 'unknown', url: upd.url, state: 'unknown', opened_at: upd.opened_at ?? null, merged_at: null, base_branch: null, head_branch: upd.head_branch ?? null, observed_at: ev.occurred_at, error: null, evidence_id: null };
          ticket.prs.push(pr);
          ticket.timeline.push(timelineEntry(ev, 'pr', `PR ${upd.url} linked from branch ${upd.head_branch ?? ''}`.trim()));
        }
        if (!pr) continue;
        if (upd.error) {
          // Failed poll: keep last known evidence and its age; only record the provider error.
          if (pr.error !== upd.error) { pr.error = upd.error; bumpRevision(ticket, ev.occurred_at); result.changed.add(ticket.id); }
          continue;
        }
        const before = `${pr.state}:${pr.merged_at}`;
        Object.assign(pr, { state: upd.state ?? pr.state, merged_at: upd.merged_at ?? pr.merged_at, opened_at: upd.opened_at ?? pr.opened_at, base_branch: upd.base_branch ?? pr.base_branch, head_branch: upd.head_branch ?? pr.head_branch, observed_at: upd.observed_at ?? ev.occurred_at, error: upd.error ?? null });
        const evidenceId = upd.evidence_id ?? `${pr.url}:${pr.state}:${pr.merged_at ?? ''}`;
        const changedEvidence = pr.evidence_id !== evidenceId;
        pr.evidence_id = evidenceId;
        const repo = repoFor(state, ticket.repo_id);
        if (changedEvidence || before !== `${pr.state}:${pr.merged_at}`) {
          if (pr.state === 'merged') deriveStatusFromEvidence(ticket, { type: 'pr-merged', seq: ev.sequence ?? 0, evidence_id: evidenceId, pr_id: pr.id, merged_at: pr.merged_at ?? ev.occurred_at, source_event_id: ev.event_id, environments: Array.isArray(upd.environments) ? upd.environments : null, deploy_on: upd.deploy_on === 'merge' ? 'merge' : null }, repo);
          else if (pr.state === 'open') deriveStatusFromEvidence(ticket, { type: 'pr-open', seq: ev.sequence ?? 0, evidence_id: evidenceId }, repo);
          else if (pr.state === 'draft') deriveStatusFromEvidence(ticket, { type: 'pr-draft', seq: ev.sequence ?? 0, evidence_id: evidenceId }, repo);
          ticket.timeline.push(timelineEntry(ev, 'pr', `PR ${pr.url} observed ${pr.state}`));
          bumpRevision(ticket, ev.occurred_at);
          refreshDerived(state, ticket);
          result.changed.add(ticket.id);
        }
      }
      break;
    }
    default:
      result.rejected = 'kind-unknown';
  }
  if (result.changed.size) lapseProposals(state, ev, result);
  return result;
}
