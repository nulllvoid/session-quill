// Critical changes (spec §7.2–7.3, ADR 0028; ruling R44): a `critical-proposal` event creates a
// local-only child ticket and a run proposal. The worker validated everything when it emitted the
// event (src/handoff/critical-changes.js: action pin, scopes and fingerprints, the child's text)
// and journaled the result; this reducer only checks what replay can check the same way forever:
// the event's structure and size caps, its deterministic id, that the worker produced it, and that
// the run exists and is done. It never re-pins an action, reads a blob or imports the guard's
// parser, so an accepted event stays accepted whatever later releases change there.
// A refused event changes nothing and is recorded in state.criticalProblems (the worker also
// records it as a health error).
import { deterministicId } from '../../lib/ids.js';
import { createTicket } from './tickets.js';
import { timelineEntry } from './common.js';
import { pruneProposals } from './integrations.js';

export const CRITICAL_PROBLEM_CAP = 100;
export const CRITICAL_RECIPE = Object.freeze({ name: 'critical-change', source: 'builtin' });
export const CRITICAL_TAG = 'critical';
// Frozen here on purpose (same text as config/scopes.js SCOPE_NAME_RE when this was written).
const SCOPE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}(\.[a-z0-9_-]{1,31}){0,3}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const LIMITS = Object.freeze({ id: 64, index: 100, key: 120, title: 200, description: 4000, pinText: 8000, pinJson: 16000, specJson: 32000, scopes: 5, target: 300, payloadJson: 64000 });
const PERMISSION_KEYS = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const jsonSize = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };
const copy = (v) => JSON.parse(JSON.stringify(v));

function problem(state, ev, code) {
  const p = isPlainObject(ev.payload) ? ev.payload : {};
  if (!Array.isArray(state.criticalProblems)) state.criticalProblems = [];
  const list = state.criticalProblems;
  list.push({ at: ev.occurred_at, event_id: ev.event_id, producer: typeof ev.producer === 'string' ? ev.producer.slice(0, 40) : null, id: typeof p.id === 'string' ? p.id.slice(0, 64) : null, from_handoff_id: typeof p.from_handoff_id === 'string' ? p.from_handoff_id.slice(0, 64) : null, index: Number.isInteger(p.index) ? p.index : null, code });
  if (list.length > CRITICAL_PROBLEM_CAP) list.splice(0, list.length - CRITICAL_PROBLEM_CAP);
  return { rejected: code };
}

function validPin(pin) {
  return isPlainObject(pin) && (pin.kind === 'bash' || pin.kind === 'mcp') && text(pin.normalized, LIMITS.pinText) && text(pin.guard, LIMITS.pinText) && jsonSize(pin) <= LIMITS.pinJson;
}

function validScopes(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.scopes) return null;
  const out = [];
  for (const s of list) {
    if (!isPlainObject(s) || typeof s.name !== 'string' || !SCOPE_NAME_RE.test(s.name) || s.name.startsWith('git.')) return null;
    if (typeof s.fingerprint !== 'string' || !FINGERPRINT_RE.test(s.fingerprint)) return null;
    if (s.target !== null && !text(s.target, LIMITS.target)) return null;
    out.push({ name: s.name, target: s.target, fingerprint: s.fingerprint });
  }
  return out;
}

function validChild(c) {
  return isPlainObject(c) && text(c.key, LIMITS.key) && text(c.title, LIMITS.title) && text(c.description, LIMITS.description) && isPlainObject(c.critical_spec) && jsonSize(c.critical_spec) <= LIMITS.specJson;
}

export function applyCriticalProposal(state, ev, result) {
  // Only the worker emits this kind (spec §7.2): page ingress and the CLI cannot produce it.
  if (ev.producer !== 'worker') return problem(state, ev, 'critical-proposal-source');
  const p = ev.payload;
  if (!isPlainObject(p) || jsonSize(p) > LIMITS.payloadJson || !text(p.id, LIMITS.id) || !text(p.from_handoff_id, LIMITS.id) || !Number.isInteger(p.index) || p.index < 0 || p.index >= LIMITS.index) return problem(state, ev, 'critical-proposal-invalid');
  if (p.id !== deterministicId(`${p.from_handoff_id}:critical:${p.index}`)) return problem(state, ev, 'critical-id-mismatch');
  const childId = deterministicId(`${p.id}:child`);
  if (state.runProposals.has(p.id) || state.tickets.has(childId)) return { duplicate: true };
  if (!validPin(p.pin)) return problem(state, ev, 'critical-pin-invalid');
  const scopes = validScopes(p.scopes);
  if (!scopes) return problem(state, ev, 'critical-scope-invalid');
  if (!validChild(p.child)) return problem(state, ev, 'critical-child-invalid');
  // The built-in recipe's hash when proposed (optional): approval notes a newer text (ADR 0028).
  if (p.recipe_hash !== undefined && p.recipe_hash !== null && !(typeof p.recipe_hash === 'string' && FINGERPRINT_RE.test(p.recipe_hash))) return problem(state, ev, 'critical-proposal-invalid');
  const h = state.handoffs.get(p.from_handoff_id);
  if (!h) return problem(state, ev, 'critical-run-unknown');
  if (h.state !== 'done') return problem(state, ev, 'critical-run-not-done');
  const parent = state.tickets.get(h.ticket_id);
  if (!parent) return problem(state, ev, 'ticket-unknown');
  const id8 = String(h.id).slice(0, 8);
  const created = createTicket(state, ev, {
    id: childId, key: p.child.key, title: p.child.title, project_id: parent.project_id, project_name: parent.project_name, category: parent.category, priority: parent.priority,
    parent_id: parent.id, repo_id: parent.repo_id ?? null, summary: p.child.description, next_action: 'Approve or dismiss the proposed critical change in Runs → Needs you',
    created_via: `critical change proposed by run ${id8}`,
  }, 'manual', result);
  if (created.rejected) return problem(state, ev, created.rejected);
  const ticket = state.tickets.get(childId);
  // Local only (spec §9.2, R46): never exported, mirrored, published, pushed or written to a vault note.
  ticket.local_only = true;
  ticket.tags = [CRITICAL_TAG];
  ticket.critical_spec = copy(p.child.critical_spec);
  pruneProposals(state, ev.occurred_at);
  state.runProposals.set(p.id, {
    id: p.id, ticket_id: childId, origin: 'run', from_handoff_id: h.id, publisher: null, editor: null, edited_at: null,
    recipe: { ...CRITICAL_RECIPE, hash: typeof p.recipe_hash === 'string' ? p.recipe_hash : null }, mode: null, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])), access: 'autonomous', read_only: false,
    scopes, action_pin: copy(p.pin), expected_revision: null, proposed_at: ev.occurred_at, lapsed_at: null, state: 'proposed', resolved_at: null, resolved_by: null, request_id: null, handoff_id: null,
  });
  ticket.timeline.push(timelineEntry(ev, 'proposal', `Critical change proposed by run ${id8} of ${parent.key}; it waits for your approval`));
  result.changed.add(childId);
  return {};
}
