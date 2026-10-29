// Tickets: creation, field edits, external keys and relinking.
import { deterministicId } from '../../lib/ids.js';
import { newTicket, refreshDerived, projectName, repoFor, TICKET_STATUSES, CATEGORIES, PRIORITIES, PR_STATES, indexChild } from '../state.js';
import { isIsoZ } from '../../lib/time.js';
import { stripMarkupTags } from '../../lib/text.js';
import { TrackerError } from '../../lib/errors.js';
import { validateKey, validateParent, allocateInternalKey } from '../keys.js';
import { externalTicketId } from '../external-keys.js';
import { applyStatusChange, deriveStatusFromEvidence, recordDeployment } from '../transitions.js';
import { timelineEntry, touch } from './common.js';
import { closureContext, validateCompletionFields, validateClosureAcknowledgement } from '../closure.js';
import { bindSession } from './sessions.js';

// Reserved quill/ tags the owner may set and clear through ticket-update (ADR 0024).
export const NO_CODE_TAG = 'quill/no-code';
const OWNER_TAGS = new Set([NO_CODE_TAG]);

export function applyTicketFields(state, ticket, fields, ev, source, result) {
  // Validate before mutating so a rejected update leaves the ticket untouched.
  validateCompletionFields(state, ticket, fields);
  if (fields.repo_id !== undefined && fields.repo_id !== null && !state.meta.repos[fields.repo_id]) throw new TrackerError('repo-unknown', `repository ${fields.repo_id} is not registered`);
  if (fields.parent_id !== undefined) validateParent(state, ticket.id, fields.parent_id);
  if (fields.status !== undefined && !TICKET_STATUSES.includes(fields.status)) throw new TrackerError('status-invalid', 'invalid ticket status');
  if (fields.status === 'blocked' && !(typeof (fields.blocker ?? ticket.blocker) === 'string' && (fields.blocker ?? ticket.blocker).trim())) throw new TrackerError('blocker-required', 'blocked requires blocker text');
  // Validate the whole deployment batch before changing completion policy or status.
  if (Array.isArray(fields.deployments)) {
    const preview = { deployments: (ticket.deployments ?? []).map(d => ({ ...d })) };
    for (const item of fields.deployments) recordDeployment(preview, item);
  }
  const review = fields.closure_review ? validateClosureAcknowledgement(state, ticket, fields.closure_review.evidence_version, ev.occurred_at) : null;
  const seq = ev.sequence ?? 0;
  if (fields.completion_mode !== undefined && fields.completion_mode !== ticket.completion_mode) { ticket.completion_mode = fields.completion_mode; ticket.completion_policy_seq = seq; }
  if (review) ticket.closure_review = review;
  if (fields.blocks_parent !== undefined) ticket.blocks_parent = fields.blocks_parent;
  if (fields.status !== undefined) {
    applyStatusChange(ticket, { status: fields.status, source, seq, blocker: fields.blocker ?? ticket.blocker, evidence_id: fields.status_evidence_id ?? null });
    ticket.timeline.push(timelineEntry(ev, 'status', `Status set to ${fields.status} (${source})`));
  } else if (fields.blocker !== undefined && ticket.status === 'blocked') {
    ticket.blocker = fields.blocker;
  }
  if (fields.resolution) ticket.resolution = { kind: fields.resolution.kind, reason: fields.resolution.reason.trim(), ...(['duplicate', 'superseded'].includes(fields.resolution.kind) ? { related_ticket_id: fields.resolution.related_ticket_id } : {}) };
  if (fields.next_action !== undefined) ticket.next_action = String(fields.next_action ?? '');
  if (fields.title !== undefined && fields.title) ticket.title = String(fields.title);
  if (fields.priority !== undefined && PRIORITIES.includes(fields.priority)) ticket.priority = fields.priority;
  if (fields.category !== undefined && CATEGORIES.includes(fields.category)) ticket.category = fields.category;
  if (fields.due !== undefined) ticket.due = fields.due;
  if (fields.repo_id !== undefined) ticket.repo_id = fields.repo_id;
  if (fields.parent_id !== undefined) {
    validateParent(state, ticket.id, fields.parent_id);
    const oldParent = ticket.parent_id ? state.tickets.get(ticket.parent_id) : null;
    const previousParentId = ticket.parent_id;
    ticket.parent_id = fields.parent_id;
    indexChild(state, ticket, previousParentId);
    if (oldParent) { refreshDerived(state, oldParent); result.changed.add(oldParent.id); }
  }
  if (fields.summary !== undefined) ticket.summary = String(fields.summary);
  if (fields.user_notes !== undefined) ticket.user_notes = String(fields.user_notes);
  if (fields.tags !== undefined && Array.isArray(fields.tags)) {
    // Reserved tags stay; quill/no-code can be added here but only `no_code: false` clears it, so
    // a tag list that merely omits it (an older client, a page edit) never drops it.
    const explicit = fields.tags.filter((t) => typeof t === 'string' && (!t.startsWith('quill/') || OWNER_TAGS.has(t)));
    const kept = ticket.tags.filter((t) => t.startsWith('quill/'));
    ticket.tags = [...new Set([...kept, ...explicit])];
  }
  // quill/no-code (ADR 0024): the owner says this ticket has no repository, so the resolver skips it.
  if (typeof fields.no_code === 'boolean' && fields.no_code !== ticket.tags.includes(NO_CODE_TAG)) {
    ticket.tags = fields.no_code ? [...ticket.tags, NO_CODE_TAG] : ticket.tags.filter((t) => t !== NO_CODE_TAG);
    ticket.timeline.push(timelineEntry(ev, 'status', fields.no_code ? 'Marked as needing no code' : 'No longer marked as needing no code'));
  }
  if (fields.validation_issues !== undefined) ticket.validation_issues = fields.validation_issues;
  if (Array.isArray(fields.deployments)) {
    for (const item of fields.deployments) recordDeployment(ticket, item);
    deriveStatusFromEvidence(ticket, { type: 'obligations-cleared', seq, evidence_id: ev.event_id }, repoFor(state, ticket.repo_id), closureContext(state, ev.occurred_at));
    ticket.timeline.push(timelineEntry(ev, 'deployment', `Deployment evidence recorded for ${fields.deployments.length} obligation(s)`));
  }
  touch(state, ticket, ev, result);
}

export function createTicket(state, ev, t, source, result) {
  if (t?.allocate_internal_key) t = { ...t, key: allocateInternalKey(state, { prefix: t.key_prefix, category: t.category, parent_id: t.parent_id }) };
  if (!t || !t.id || !t.key || !t.title) return { rejected: 'ticket-invalid' };
  if (state.tickets.has(t.id)) return { rejected: 'ticket-exists' };
  try {
    validateKey(t.key);
  } catch { return { rejected: 'key-invalid' }; }
  if (state.keyIndex.has(t.key)) return { rejected: 'key-collision' };
  if (!CATEGORIES.includes(t.category ?? 'research')) return { rejected: 'category-invalid' };
  if (!PRIORITIES.includes(t.priority ?? 'P2')) return { rejected: 'priority-invalid' };
  try { validateCompletionFields(state, t, t); } catch (err) { return { rejected: err.code }; }
  try {
    validateParent(state, t.id, t.parent_id ?? null);
  } catch {
    return { rejected: 'parent-invalid' };
  }
  const ticket = newTicket(state, {
    id: t.id, key: t.key, title: t.title, project_id: t.project_id, project_name: t.project_name ?? projectName(state, t.project_id),
    category: t.category ?? 'research', priority: t.priority ?? 'P2', parent_id: t.parent_id ?? null, repo_id: t.repo_id ?? null,
    due: t.due ?? null, jira: t.jira ?? null, external: t.external ?? null, created_at: ev.occurred_at, status_source: source,
  });
  for (const key of ['completion_mode', 'blocks_parent', 'source_run_id', 'source_suggestion_id', 'finding_key']) if (t[key] !== undefined) ticket[key] = t[key];
  if (t.completion_mode) ticket.completion_policy_seq = ev.sequence ?? 0;
  if (t.status && TICKET_STATUSES.includes(t.status) && t.status !== 'todo') {
    applyStatusChange(ticket, { status: t.status, source, seq: ev.sequence ?? 0, blocker: t.blocker });
  }
  if (t.next_action) ticket.next_action = String(t.next_action);
  if (t.summary) ticket.summary = String(t.summary);
  if (t.user_notes) ticket.user_notes = String(t.user_notes);
  if (Array.isArray(t.aliases)) {
    for (const alias of t.aliases) if (!state.keyIndex.has(alias)) { ticket.aliases.push(alias); state.keyIndex.set(alias, ticket.id); }
  }
  if (Array.isArray(t.validation_issues)) ticket.validation_issues = [...t.validation_issues];
  // Imported evidence (migration): PR records, deployment obligations and historical activity.
  if (Array.isArray(t.prs)) {
    ticket.prs = t.prs.filter((p) => p && typeof p.url === 'string').map((p) => ({
      id: p.id ?? deterministicId(`${ev.event_id}:pr:${p.url}`), provider: p.provider ?? 'unknown', url: p.url, state: PR_STATES.includes(p.state) ? p.state : 'unknown',
      opened_at: p.opened_at ?? null, merged_at: p.merged_at ?? null, base_branch: p.base_branch ?? null, head_branch: p.head_branch ?? null, observed_at: p.observed_at ?? null, error: p.error ?? null, evidence_id: p.evidence_id ?? null,
    }));
  }
  if (Array.isArray(t.deployments)) {
    ticket.deployments = t.deployments.filter((d) => d && d.pr_id && d.environment).map((d) => ({
      id: d.id ?? deterministicId(`${ev.event_id}:dep:${d.pr_id}:${d.environment}`), pr_id: d.pr_id, environment: d.environment, state: ['pending', 'deployed', 'waived'].includes(d.state) ? d.state : 'pending',
      merged_at: d.merged_at ?? ev.occurred_at, deployed_at: d.deployed_at ?? null, evidence: d.evidence ?? null, waiver_reason: d.waiver_reason ?? null, source_event_id: ev.event_id,
    }));
  }
  if (typeof t.last_activity === 'string' && isIsoZ(t.last_activity)) ticket.last_activity = t.last_activity;
  if (typeof t.created_at === 'string' && isIsoZ(t.created_at)) ticket.created_at = t.created_at;
  state.tickets.set(ticket.id, ticket);
  if (t.allocate_internal_key) result.ticket = { id: ticket.id, key: ticket.key };
  indexChild(state, ticket);
  state.keyIndex.set(ticket.key, ticket.id);
  if (ticket.parent_id) {
    const m = /\.(\d+)$/.exec(ticket.key);
    if (m) state.counters.childByParent.set(ticket.parent_id, Math.max(state.counters.childByParent.get(ticket.parent_id) ?? 0, Number(m[1])));
  }
  ticket.timeline.push(timelineEntry(ev, 'status', `Created (${t.created_via ?? source})`));
  ticket.revision = 0;
  const importedActivity = ticket.last_activity;
  touch(state, ticket, ev, result);
  // Imports carry historical activity; the import itself is not new work.
  if (source === 'migration' && importedActivity && importedActivity < ticket.last_activity) ticket.last_activity = importedActivity;
  return {};
}

// Zero-command binding (ADR 0005): a ticket key seen in a prompt or branch binds the session,
// creating the ticket under that key (with a deterministic id) when the store has none.
export function bindExternal(state, session, ev, result) {
  const p = ev.payload;
  const ext = p.external;
  if (!ext || typeof ext.key !== 'string') return { rejected: 'external-invalid' };
  try { validateKey(ext.key); } catch { return { rejected: 'key-invalid' }; }
  let ticketId = state.keyIndex.get(ext.key) ?? null;
  if (!ticketId) {
    const project_id = p.project_id ?? Object.keys(state.meta.projects)[0] ?? null;
    if (!project_id) return { rejected: 'project-required' };
    const external = { system: ext.system ?? 'custom', key: ext.key, url: ext.url ?? null, validation: 'pending', validated_at: null, error: ext.error ?? null };
    const id = externalTicketId(state.meta.store_id, ext.key);
    // Hints journalled before hooks stripped prompt markup are cleaned on replay too.
    const hint = typeof p.title_hint === 'string' ? stripMarkupTags(p.title_hint).replace(/\s+/g, ' ').trim() : '';
    const title = hint ? hint.slice(0, 200) : ext.key;
    const created = createTicket(state, ev, {
      id, key: ext.key, title, project_id, category: 'research', priority: 'P2', repo_id: p.repo_id ?? null, external,
      jira: external.system === 'jira' ? { key: ext.key, url: external.url, validation: 'pending', validated_at: null, error: external.error } : null,
      created_via: `auto from ${p.source ?? 'prompt'}`,
    }, 'evidence', result);
    if (created.rejected) return created;
    ticketId = id;
  }
  const ticket = state.tickets.get(ticketId);
  if (p.ensure_only === true) {
    ticket.timeline.push(timelineEntry(ev, 'status', `Mentioned in session ${session.host_session_id} (${p.source ?? 'prompt'})`));
    touch(state, ticket, ev, result);
    return {};
  }
  if (session.current_ticket_id === ticketId) return {};
  bindSession(state, session, ev, { ticket_id: ticketId, project_id: ticket.project_id }, result);
  return {};
}

// Shared by `ticket relink` and the dashboard's "Link to external" request.
export function relinkTicket(state, ticket, ev, p, result) {
  const newKey = p.new_key;
  if (newKey && newKey !== ticket.key) {
    try { validateKey(newKey); } catch { return { rejected: 'key-invalid' }; }
    const owner = state.keyIndex.get(newKey);
    if (owner && owner !== ticket.id) return { rejected: 'key-collision' };
    if (!ticket.aliases.includes(ticket.key)) ticket.aliases.push(ticket.key);
    ticket.key = newKey;
    state.keyIndex.set(newKey, ticket.id);
  }
  if (p.jira !== undefined) ticket.jira = p.jira;
  if (p.external !== undefined) ticket.external = p.external;
  const link = ticket.external ? ` (${ticket.external.system} ${ticket.external.key}, validation ${ticket.external.validation})` : ticket.jira ? ` (Jira ${ticket.jira.key}, validation ${ticket.jira.validation})` : '';
  ticket.timeline.push(timelineEntry(ev, 'status', `Relinked to ${ticket.key}${link}`));
  touch(state, ticket, ev, result);
  return {};
}
