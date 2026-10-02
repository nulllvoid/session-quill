// Typed recipe outputs (ADR 0008) arrive as suggestions on the handoff. Nothing changes on the
// ticket until the owner accepts one through a revision-checked request; a comment draft is never
// posted anywhere, accepting it only records that it was used.
import { deterministicId } from '../lib/ids.js';
import { CATEGORIES, PRIORITIES } from '../core/state.js';

export const SUGGESTION_TYPES = ['next-action', 'blocker', 'followup', 'deploy-evidence', 'comment-draft'];
export const DEPLOY_STATES = ['deployed', 'pending', 'n-a'];

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
    for (const c of parsed.children ?? []) add('followup', { title: c.title, category: c.category ?? null, priority: c.priority ?? null, next_action: c.next_action ?? '' });
  }
  if (outputs.includes('deploy_evidence') && (parsed.deploy_evidence ?? []).length) add('deploy-evidence', { items: parsed.deploy_evidence });
  if (outputs.includes('comment_draft') && parsed.comment_draft) add('comment-draft', { text: parsed.comment_draft });
  return out;
}

// The request-tx mutation for accepting or dismissing one suggestion. Computed when the request is
// applied (journaled with its outcome), so replay never re-reads current ticket state.
export function suggestionMutation(state, ticket, h, sug, decision) {
  const mutation = { type: 'suggestion', handoff_id: h.id, suggestion_id: sug.id, ticket_id: ticket.id, state: decision };
  if (decision !== 'accepted') return mutation;
  if (sug.type === 'next-action') mutation.fields = { next_action: sug.text };
  else if (sug.type === 'blocker') mutation.fields = { status: 'blocked', blocker: String(sug.text).slice(0, 500) };
  else if (sug.type === 'followup') {
    const [key] = childKeys(state, ticket, 1);
    mutation.child = {
      id: deterministicId(`${h.id}:suggestion:${sug.id}`), key, title: sug.title,
      category: CATEGORIES.includes(sug.category) ? sug.category : ticket.category, priority: PRIORITIES.includes(sug.priority) ? sug.priority : ticket.priority, next_action: sug.next_action ?? '',
    };
  } else if (sug.type === 'deploy-evidence') {
    const items = [];
    for (const item of sug.items ?? []) {
      for (const d of ticket.deployments.filter((x) => x.environment === item.environment && x.state === 'pending')) {
        if (item.state === 'deployed') items.push({ pr_id: d.pr_id, environment: d.environment, state: 'deployed', deployed_at: item.deployed_at ?? sug.created_at, evidence: item.evidence ? String(item.evidence).slice(0, 500) : null });
        else if (item.state === 'n-a') items.push({ pr_id: d.pr_id, environment: d.environment, state: 'waived', waiver_reason: `not applicable: ${item.evidence ?? 'reported by the agent'}`.slice(0, 500) });
      }
    }
    if (items.length) mutation.fields = { deployments: items };
  }
  return mutation;
}
