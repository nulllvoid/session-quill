// Typed recipe outputs (ADR 0008) arrive as suggestions on the handoff. Nothing changes on the
// ticket until the owner accepts one through a revision-checked request; a comment draft is never
// posted anywhere, accepting it only records that it was used.
import { deterministicId, contentHash } from '../lib/ids.js';
import { CATEGORIES, PRIORITIES } from '../core/state.js';
import { TrackerError } from '../lib/errors.js';
import { descriptionProblems, normalizeDescription } from '../core/description.js';

export const SUGGESTION_TYPES = ['next-action', 'blocker', 'followup', 'deploy-evidence', 'comment-draft', 'description'];
export const DEPLOY_STATES = ['deployed', 'pending', 'n-a'];
export const FOLLOWUP_PROPOSALS_MAX = 20;

export function followupSourceFingerprint(finding, sources = []) {
  return contentHash(JSON.stringify([
    finding.title ?? '', normalizeDescription(finding.description), finding.next_action ?? '',
    finding.evidence ?? null, [...(Array.isArray(finding.sources) ? finding.sources : sources)].sort(),
  ]));
}

// Match the complete finding and its evidence, never a title alone. Run ids and suggestion
// positions deliberately do not participate: retrying the same finding keeps its identity.
export function findingKey(ticket, sug) {
  return contentHash(JSON.stringify([
    ticket.id, sug.title ?? '', normalizeDescription(sug.description), sug.next_action ?? '',
    sug.category ?? null, sug.priority ?? null, sug.source_fingerprint ?? followupSourceFingerprint(sug),
  ]));
}

function rootId(state, ticket) {
  const seen = new Set();
  let current = ticket;
  while (current?.parent_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = state.tickets.get(current.parent_id);
    if (!parent) break;
    current = parent;
  }
  return current?.id;
}

function matchingChild(state, ticket, key) {
  return [...state.tickets.values()].find((t) => t.parent_id === ticket.id && t.finding_key === key);
}

// This runs before journaling, so decisions and limits replay without reading future state.
// Deferred findings remain on the run and in its summary; they are not actionable proposals.
export function normalizeFollowupSuggestions(state, ticket, h, suggestions) {
  const root = rootId(state, ticket);
  const seen = new Map();
  let outstanding = 0;
  for (const run of state.handoffs.values()) {
    if (run.id === h.id) continue;
    const parent = state.tickets.get(run.ticket_id);
    if (!parent || rootId(state, parent) !== root) continue;
    for (const sug of run.suggestions ?? []) {
      if (sug.type !== 'followup') continue;
      if (sug.state === 'proposed') outstanding += 1;
      if (parent.id !== ticket.id || !['proposed', 'accepted', 'dismissed'].includes(sug.state)) continue;
      const key = sug.finding_key ?? findingKey(parent, { ...sug, source_fingerprint: sug.source_fingerprint ?? followupSourceFingerprint(sug, run.result_sources ?? []) });
      const prior = seen.get(key);
      if (!prior || prior.state === 'proposed') seen.set(key, { handoff_id: run.id, suggestion_id: sug.id, state: sug.state, child_id: sug.child_id ?? null });
    }
  }
  return suggestions.map((sug) => {
    if (sug.type !== 'followup') return sug;
    const key = findingKey(ticket, sug);
    const out = { ...sug, finding_key: key, source_run_id: h.id, source_suggestion_id: sug.id };
    const child = matchingChild(state, ticket, key);
    const prior = seen.get(key);
    if (child || prior) {
      out.state = 'suppressed';
      out.duplicate_of = prior ?? { handoff_id: child.source_run_id, suggestion_id: child.source_suggestion_id, state: 'accepted', child_id: child.id };
      if (child?.id || prior?.child_id) out.child_id = child?.id ?? prior.child_id;
    } else if (outstanding >= FOLLOWUP_PROPOSALS_MAX) {
      out.state = 'deferred';
      out.defer_reason = 'root-proposal-limit';
    } else {
      outstanding += 1;
      seen.set(key, { handoff_id: h.id, suggestion_id: sug.id, state: 'proposed', child_id: null });
    }
    return out;
  });
}

export function childKeys(state, parent, count) {
  const base = state.counters.childByParent.get(parent.id) ?? 0;
  const keys = [];
  let n = base;
  while (keys.length < count) {
    n += 1;
    const key = `${parent.key}.${n}`;
    if (!state.keyIndex.has(key)) keys.push(key);
  }
  return keys;
}

// Builds the suggestion list from a parsed agent result, keeping only the outputs the recipe declared.
export function buildSuggestions(outputs = [], parsed = {}, createdAt) {
  const out = [];
  const add = (type, data) => out.push({ id: `s${out.length + 1}`, type, state: 'proposed', created_at: createdAt, resolved_at: null, ...data });
  if (outputs.includes('next_action') && parsed.next_action) add('next-action', { text: parsed.next_action });
  if (outputs.includes('blocker') && parsed.blocker) add('blocker', { text: parsed.blocker });
  if (outputs.includes('followups')) {
    for (const c of parsed.children ?? []) add('followup', {
      title: c.title, category: c.category ?? null, priority: c.priority ?? null,
      next_action: c.next_action ?? '', description: c.description ?? '',
      source_fingerprint: c.source_fingerprint ?? followupSourceFingerprint(c, parsed.sources ?? []),
    });
  }
  if (outputs.includes('deploy_evidence') && (parsed.deploy_evidence ?? []).length) add('deploy-evidence', { items: parsed.deploy_evidence });
  if (outputs.includes('comment_draft') && parsed.comment_draft) add('comment-draft', { text: parsed.comment_draft });
  if (outputs.includes('description') && parsed.description) add('description', { text: parsed.description });
  return out;
}

// The request-tx mutation for accepting or dismissing one suggestion. Computed when the request is
// applied (journaled with its outcome), so replay never re-reads current ticket state.
export function suggestionMutation(state, ticket, h, sug, decision, options = {}) {
  const mutation = { type: 'suggestion', handoff_id: h.id, suggestion_id: sug.id, ticket_id: ticket.id, state: decision };
  if (decision !== 'accepted') return mutation;
  if (sug.type === 'next-action') mutation.fields = { next_action: sug.text };
  else if (sug.type === 'blocker') mutation.fields = { status: 'blocked', blocker: String(sug.text).slice(0, 500) };
  else if (sug.type === 'description') mutation.fields = { summary: String(sug.text) };
  else if (sug.type === 'followup') {
    if (typeof options.blocks_parent !== 'boolean') throw new TrackerError('followup-relationship-required', 'choose whether this follow-up is required to finish the parent or independent work');
    const description = normalizeDescription(options.description ?? sug.description);
    const problems = descriptionProblems(description);
    if (problems.length) throw new TrackerError('description-invalid', `the follow-up needs a valid Goal, Context and Done when: ${problems.join('; ')}`);
    const keyIdentity = sug.finding_key ?? findingKey(ticket, sug);
    const existing = matchingChild(state, ticket, keyIdentity);
    if (existing) {
      mutation.child_id = existing.id;
      if (ticket.local_only === true) mutation.child_local_only = true;
      return mutation;
    }
    const [key] = childKeys(state, ticket, 1);
    mutation.child = {
      id: deterministicId(`${h.id}:suggestion:${sug.id}`), key, title: sug.title,
      category: CATEGORIES.includes(sug.category) ? sug.category : ticket.category, priority: PRIORITIES.includes(sug.priority) ? sug.priority : ticket.priority, next_action: sug.next_action ?? '', summary: description,
      blocks_parent: options.blocks_parent, source_run_id: h.id, source_suggestion_id: sug.id, finding_key: keyIdentity,
      ...(ticket.local_only === true ? { local_only: true } : {}),
    };
  } else if (sug.type === 'deploy-evidence') {
    const items = [];
    const prMatches = (d, pr) => d.pr_id === pr || (ticket.prs ?? []).some((p) => p.id === d.pr_id && p.url === pr);
    for (const item of sug.items ?? []) {
      let candidates = ticket.deployments.filter((x) => x.environment === item.environment && x.state === 'pending');
      // Evidence is per PR: an item naming no PR may only settle an environment with one PR pending.
      if (item.pr) candidates = candidates.filter((d) => prMatches(d, item.pr));
      else if (new Set(candidates.map((d) => d.pr_id)).size > 1 && item.state !== 'pending') {
        throw new TrackerError('evidence-ambiguous', `the evidence for ${item.environment} names no PR, and several PRs are pending there; record it per PR instead`);
      }
      for (const d of candidates) {
        if (item.state === 'deployed') items.push({ pr_id: d.pr_id, environment: d.environment, state: 'deployed', deployed_at: item.deployed_at ?? sug.created_at, evidence: item.evidence ? String(item.evidence).slice(0, 500) : null, evidence_kind: 'agent' });
        else if (item.state === 'n-a') items.push({ pr_id: d.pr_id, environment: d.environment, state: 'waived', waiver_reason: `not applicable: ${item.evidence ?? 'reported by the agent'}`.slice(0, 500) });
      }
    }
    if (items.length) mutation.fields = { deployments: items };
  }
  return mutation;
}
