// Critical changes (spec §7.1–7.3, ADR 0028): a done run's critical_changes[i] becomes a local-only
// child ticket and a run proposal, through one `critical-proposal` event that only the worker
// emits. The reducer accepts it only when it names a done run whose stored result blob has entry
// `index` with the same action pin, and when its id is deterministicId(`<run>:critical:<index>`).
// A refused event records a problem in state.criticalProblems and changes nothing else. The child
// is built from the result blob, never from the event's text, so a forged payload cannot word it.
import { deterministicId } from '../../lib/ids.js';
import { SCOPE_NAME_RE } from '../../config/scopes.js';
import { pinOfChange } from '../../handoff/action-pin.js';
import { canonicalJson } from '../../handoff/grant.js';
import { createTicket } from './tickets.js';
import { timelineEntry } from './common.js';
import { pruneProposals } from './integrations.js';

export const CRITICAL_PROBLEM_CAP = 100;
export const CRITICAL_RECIPE = Object.freeze({ name: 'critical-change', source: 'builtin' });
export const CRITICAL_TAG = 'critical';
const RISKS = ['low', 'medium', 'high'];
const PERMISSION_KEYS = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
// C0/C1 controls and the invisible format characters (zero-width, bidi overrides, BOM).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]+/g;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Agent text as one plain line: controls stripped, whitespace collapsed, dash runs broken, capped. */
export function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, ' ').replace(/-{3,}/g, '–').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The command as one line, controls stripped and capped, but otherwise exact.
const cleanAction = (value) => (typeof value !== 'string' ? '' : value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 500));

/** The scope an entry names: `name:target` or `name` with its `target` field. */
export function changeScope(change) {
  const raw = isPlainObject(change) && typeof change.scope === 'string' ? change.scope.trim() : '';
  const colon = raw.indexOf(':');
  const name = colon < 0 ? raw : raw.slice(0, colon);
  const own = colon < 0 ? '' : raw.slice(colon + 1).trim();
  const field = isPlainObject(change) && typeof change.target === 'string' ? change.target.trim() : '';
  return { name, target: own || field || null };
}

/**
 * The child ticket of one critical change: title, a Goal/Context/Done-when description (ADR 0014)
 * and the local critical_spec. Every text comes from the run's result and is cleaned here.
 */
export function criticalChild(change, { run, parent, index, pin, scopes }) {
  const c = isPlainObject(change) ? change : {};
  const title = cleanLine(c.title, 200) || 'Critical change';
  const scope = scopes[0];
  const scopeText = `${scope.name}${scope.target ? `:${scope.target}` : ''}`;
  const why = cleanLine(c.why, 400);
  const evidence = cleanLine(c.evidence, 400);
  const verify = cleanLine(c.verify, 400);
  const rollback = cleanLine(c.rollback, 400);
  const action = cleanAction(c.action);
  const risk = RISKS.includes(c.risk) ? c.risk : 'high';
  const id8 = String(run.id).slice(0, 8);
  const description = [
    `**Goal:** Make the critical change "${title}" in scope ${scopeText}, exactly as proposed, once you approve it.`,
    '',
    `**Context:** Run ${id8} of ${parent.key} needed this write but its scopes did not allow it, so it proposed it instead. Why: ${why || 'not given'}. Evidence: ${evidence || 'none given'}. Risk: ${risk}. Rollback: ${rollback || 'not given'}. Action: ${action}`,
    '',
    '**Done when:**',
    `- ${verify || 'The change is checked as the proposing run describes'}`,
    '- An approved run of this ticket made the change exactly as pinned',
  ].join('\n');
  const critical_spec = {
    from_handoff_id: run.id, index, title, action, action_pin: pin, scope: scope.name, target: scope.target,
    scopes: scopes.map((s) => ({ name: s.name, target: s.target, fingerprint: s.fingerprint })), why, evidence, verify, rollback, risk,
  };
  return { title, description, critical_spec };
}

/** The `critical-proposal` payload the worker emits for critical_changes[index] of a done run. */
export function buildCriticalProposal({ run, parent, index, change, pin, scopes, key }) {
  return {
    id: deterministicId(`${run.id}:critical:${index}`), from_handoff_id: run.id, index, pin, scopes,
    child: { key, ...criticalChild(change, { run, parent, index, pin, scopes }) },
  };
}

function problem(state, ev, code) {
  const p = isPlainObject(ev.payload) ? ev.payload : {};
  if (!Array.isArray(state.criticalProblems)) state.criticalProblems = [];
  const list = state.criticalProblems;
  list.push({ at: ev.occurred_at, event_id: ev.event_id, producer: typeof ev.producer === 'string' ? ev.producer.slice(0, 40) : null, id: typeof p.id === 'string' ? p.id.slice(0, 64) : null, from_handoff_id: typeof p.from_handoff_id === 'string' ? p.from_handoff_id.slice(0, 64) : null, index: Number.isInteger(p.index) ? p.index : null, code });
  if (list.length > CRITICAL_PROBLEM_CAP) list.splice(0, list.length - CRITICAL_PROBLEM_CAP);
  return { rejected: code };
}

function storedResult(state, h) {
  if (typeof h.result_ref !== 'string' || typeof state.readBlob !== 'function') return null;
  try {
    const parsed = JSON.parse(state.readBlob(h.result_ref));
    return isPlainObject(parsed) ? parsed : null;
  } catch { return null; }
}

// Exactly the entry's one scope, with a fingerprint; the target is the entry's, or none.
function validScopes(list, change) {
  if (!Array.isArray(list) || list.length !== 1 || !isPlainObject(list[0])) return null;
  const s = list[0];
  const want = changeScope(change);
  if (typeof s.name !== 'string' || !SCOPE_NAME_RE.test(s.name) || s.name.startsWith('git.') || s.name !== want.name) return null;
  if (typeof s.fingerprint !== 'string' || !FINGERPRINT_RE.test(s.fingerprint)) return null;
  if (s.target !== null && (typeof s.target !== 'string' || s.target !== want.target)) return null;
  return [{ name: s.name, target: s.target, fingerprint: s.fingerprint }];
}

export function applyCriticalProposal(state, ev, result) {
  // Only the worker emits this kind (spec §7.2): page ingress and the CLI cannot produce it.
  if (ev.producer !== 'worker') return problem(state, ev, 'critical-proposal-source');
  const p = ev.payload;
  if (!isPlainObject(p) || typeof p.id !== 'string' || typeof p.from_handoff_id !== 'string' || !Number.isInteger(p.index) || p.index < 0 || !isPlainObject(p.child) || typeof p.child.key !== 'string') return problem(state, ev, 'critical-proposal-invalid');
  if (p.id !== deterministicId(`${p.from_handoff_id}:critical:${p.index}`)) return problem(state, ev, 'critical-id-mismatch');
  const childId = deterministicId(`${p.id}:child`);
  if (state.runProposals.has(p.id) || state.tickets.has(childId)) return { duplicate: true };
  const h = state.handoffs.get(p.from_handoff_id);
  if (!h) return problem(state, ev, 'critical-run-unknown');
  if (h.state !== 'done') return problem(state, ev, 'critical-run-not-done');
  const parent = state.tickets.get(h.ticket_id);
  if (!parent) return problem(state, ev, 'ticket-unknown');
  const stored = storedResult(state, h);
  if (!stored) return problem(state, ev, 'critical-result-unavailable');
  const changes = Array.isArray(stored.critical_changes) ? stored.critical_changes : [];
  if (p.index >= changes.length) return problem(state, ev, 'critical-index-invalid');
  const change = changes[p.index];
  const pin = pinOfChange(change);
  if (!pin || !isPlainObject(p.pin) || p.pin.normalized !== pin.normalized || p.pin.guard !== pin.guard || canonicalJson(p.pin) !== canonicalJson(pin)) return problem(state, ev, 'critical-pin-mismatch');
  const scopes = validScopes(p.scopes, change);
  if (!scopes) return problem(state, ev, 'critical-scope-invalid');
  const child = criticalChild(change, { run: h, parent, index: p.index, pin, scopes });
  const created = createTicket(state, ev, {
    id: childId, key: p.child.key, title: child.title, project_id: parent.project_id, project_name: parent.project_name, category: parent.category, priority: parent.priority,
    parent_id: parent.id, repo_id: parent.repo_id ?? null, summary: child.description, next_action: 'Approve or dismiss the proposed critical change in Runs → Needs you',
    created_via: `critical change proposed by run ${String(h.id).slice(0, 8)}`,
  }, 'manual', result);
  if (created.rejected) return problem(state, ev, created.rejected);
  const ticket = state.tickets.get(childId);
  // Local only (spec §9.2): never exported, mirrored, published or pushed to a tracker.
  ticket.local_only = true;
  ticket.tags = [CRITICAL_TAG];
  ticket.critical_spec = child.critical_spec;
  pruneProposals(state, ev.occurred_at);
  state.runProposals.set(p.id, {
    id: p.id, ticket_id: childId, origin: 'run', from_handoff_id: h.id, publisher: null, editor: null, edited_at: null,
    recipe: { ...CRITICAL_RECIPE, hash: null }, mode: null, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])), access: 'autonomous', read_only: false,
    scopes, action_pin: pin, expected_revision: null, proposed_at: ev.occurred_at, lapsed_at: null, state: 'proposed', resolved_at: null, resolved_by: null, request_id: null, handoff_id: null,
  });
  ticket.timeline.push(timelineEntry(ev, 'proposal', `Critical change proposed by run ${String(h.id).slice(0, 8)} of ${parent.key}; it waits for your approval`));
  result.changed.add(childId);
  return {};
}
