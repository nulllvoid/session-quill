import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestions, suggestionMutation, normalizeFollowupSuggestions, FOLLOWUP_PROPOSALS_MAX } from '../../src/agents/suggestions.js';
import { recordResult } from '../../src/handoff/results.js';
import { parseAgentResult } from '../../src/handoff/runner.js';
import { newState, createTicket, ev } from '../core/helpers.js';

const at = '2026-10-30T08:00:00Z';
const description = '**Goal:** Repair the retry handling.\n\n**Context:** The provider may time out.\n\n**Done when:**\n- Retry tests pass.';
const finding = { title: 'Repair retry handling', description, next_action: 'Add a retry test' };
function setup() {
  const state = newState();
  const ticket = createTicket(state);
  const h = { id: 'run-1', ticket_id: ticket.id, state: 'running', mode: 'analyse-followups', legacy: false, outputs: ['followups'], suggestions: [] };
  state.handoffs.set(h.id, h);
  return { state, ticket, h };
}
const suggestions = (children = [finding], sources = []) => buildSuggestions(['followups'], { children, sources }, at);
function accept(state, ticket, h, sug, requestId) {
  const mutation = suggestionMutation(state, ticket, h, sug, 'accepted', { blocks_parent: true });
  ev(state, 'request', { id: requestId, kind: 'accept-suggestion', target_id: ticket.id });
  ev(state, 'request-tx', { request_id: requestId, outcome: 'applied', mutation });
  return mutation;
}

test('accepted followups require explicit dependency and a checkable description', () => {
  const { state, ticket, h } = setup();
  const [sug] = suggestions();
  assert.throws(() => suggestionMutation(state, ticket, h, sug, 'accepted'), (e) => e.code === 'followup-relationship-required');
  assert.throws(() => suggestionMutation(state, ticket, h, { ...sug, description: '**Goal:** Fix retry handling.\n**Context:** Tests fail.' }, 'accepted', { blocks_parent: false }), (e) => e.code === 'description-invalid');
  const m = suggestionMutation(state, ticket, h, sug, 'accepted', { blocks_parent: false });
  assert.equal(m.child.blocks_parent, false);
  assert.equal(m.child.source_run_id, h.id);
  assert.equal(m.child.source_suggestion_id, sug.id);
  assert.match(m.child.finding_key, /^[a-f0-9]{64}$/);
});

test('two proposals for the same finding accept into one child, and replay links it', () => {
  const { state, ticket, h } = setup();
  h.suggestions = suggestions();
  const m1 = accept(state, ticket, h, h.suggestions[0], 'accept-one');
  const other = { ...h, id: 'run-2', suggestions: suggestions() };
  state.handoffs.set(other.id, other);
  const m2 = accept(state, ticket, other, other.suggestions[0], 'accept-two');
  assert.equal(m2.child, undefined);
  assert.equal(m2.child_id, m1.child.id);
  assert.equal(state.tickets.size, 2);
  assert.equal(other.suggestions[0].child_id, m1.child.id);
  assert.deepEqual(other.children_ids, [m1.child.id]);
});

test('exact retries preserve dismissed or accepted decisions; changed evidence and similar titles remain distinct', () => {
  const { state, ticket, h } = setup();
  h.suggestions = normalizeFollowupSuggestions(state, ticket, h, suggestions([finding], ['src/retry.js@abc']));
  h.suggestions[0].state = 'dismissed';
  const next = { ...h, id: 'run-2' };
  const [repeat] = normalizeFollowupSuggestions(state, ticket, next, suggestions([finding], ['src/retry.js@abc']));
  assert.equal(repeat.state, 'suppressed');
  assert.equal(repeat.duplicate_of.handoff_id, h.id);
  assert.equal(repeat.duplicate_of.state, 'dismissed');
  assert.equal(normalizeFollowupSuggestions(state, ticket, next, suggestions([finding], ['src/retry.js@def']))[0].state, 'proposed');
  assert.equal(normalizeFollowupSuggestions(state, ticket, next, suggestions([{ ...finding, title: `${finding.title} safely` }], ['src/retry.js@abc']))[0].state, 'proposed');
});

test('the outstanding cap includes descendants and preserves excess findings for run review', () => {
  const { state, ticket, h } = setup();
  h.suggestions = normalizeFollowupSuggestions(state, ticket, h, suggestions(Array.from({ length: FOLLOWUP_PROPOSALS_MAX }, (_, i) => ({ ...finding, title: `Finding ${i}` }))));
  const child = createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: `${ticket.key}.1`, parent_id: ticket.id });
  const next = { ...h, id: 'run-2', ticket_id: child.id, suggestions: [] };
  const [excess] = normalizeFollowupSuggestions(state, child, next, suggestions());
  assert.equal(excess.state, 'deferred');
  assert.equal(excess.title, finding.title);
  assert.equal(excess.description, description);
});

test('new live legacy results propose children; historical child transactions still replay', () => {
  const { state, ticket, h } = setup();
  h.legacy = true;
  let payload;
  const worker = { state, now: () => at, emit: (_kind, p) => { payload = p; }, env: {} };
  recordResult(worker, h.id, { children: [finding] });
  assert.equal(payload.result_items.some((x) => x.type === 'child'), false);
  assert.equal(payload.update.suggestions[0].type, 'followup');
  ev(state, 'handoff-tx', { handoff_id: h.id, result_items: [{ type: 'child', title: 'Historical child', key: `${ticket.key}.1` }] });
  assert.equal(state.tickets.size, 2);
});

test('parser retains all findings and their own evidence for proposal consolidation', () => {
  const children = Array.from({ length: 23 }, (_, i) => ({ ...finding, title: `Finding ${i}`, evidence: `retry.js:${i}` }));
  const parsed = parseAgentResult({ text: '```json\n' + JSON.stringify({ summary: 'Review findings', children }) + '\n```' });
  assert.equal(parsed.children.length, 23);
  assert.equal(parsed.children[0].evidence, 'retry.js:0');
});

test('a resolved child keeps its source identity and suppresses unchanged findings', () => {
  const { state, ticket, h } = setup();
  h.suggestions = normalizeFollowupSuggestions(state, ticket, h, suggestions());
  const m = accept(state, ticket, h, h.suggestions[0], 'accept-closed');
  const child = state.tickets.get(m.child.id);
  assert.deepEqual([child.source_run_id, child.source_suggestion_id, child.finding_key, child.blocks_parent], [h.id, 's1', m.child.finding_key, true]);
  ev(state, 'ticket-update', { ticket_id: child.id, fields: { status: 'done' }, source: 'manual' });
  const [repeat] = normalizeFollowupSuggestions(state, ticket, { ...h, id: 'retry' }, suggestions());
  assert.equal(repeat.state, 'suppressed');
  assert.equal(repeat.child_id, child.id);
});

test('overflow is readable in the run summary and becomes proposable when capacity is available', () => {
  const { state, ticket, h } = setup();
  h.suggestions = normalizeFollowupSuggestions(state, ticket, h, suggestions(Array.from({ length: FOLLOWUP_PROPOSALS_MAX }, (_, i) => ({ ...finding, title: `Finding ${i}` }))));
  const next = { ...h, id: 'run-overflow', suggestions: [] };
  state.handoffs.set(next.id, next);
  let payload;
  recordResult({ state, now: () => at, emit: (_kind, p) => { payload = p; }, env: {} }, next.id, { children: [finding] });
  assert.match(payload.update.result_summary, /1 additional finding/);
  assert.ok(payload.update.result_summary.includes(description));
  next.suggestions = payload.update.suggestions;
  h.suggestions[0].state = 'dismissed';
  assert.equal(normalizeFollowupSuggestions(state, ticket, { ...next, id: 'after-review' }, suggestions())[0].state, 'proposed');
});

test('a failed or timed-out live result cannot create followup proposals or children', () => {
  for (const outcome of ['failed', 'timed-out']) {
    const { state, h } = setup();
    h.legacy = true;
    let payload;
    recordResult({ state, now: () => at, emit: (_kind, p) => { payload = p; }, env: {} }, h.id, { children: [finding] }, { state: outcome });
    assert.equal(payload.update.suggestions, undefined);
    assert.deepEqual(payload.result_items, []);
  }
});

test('parser keeps description attached to its finding after rejecting a malformed item', () => {
  const parsed = parseAgentResult({ text: '```json\n' + JSON.stringify({ summary: 'Review', children: [{ title: '' }, finding] }) + '\n```' });
  assert.equal(parsed.children.length, 1);
  assert.equal(parsed.children[0].description, description);
});

test('display truncation does not conflate different findings', () => {
  const { state, ticket, h } = setup();
  const children = ['A', 'B'].map((suffix) => ({ ...finding, title: 'x'.repeat(200) + suffix }));
  const parsed = parseAgentResult({ text: '```json\n' + JSON.stringify({ summary: 'Review', children }) + '\n```' });
  const result = normalizeFollowupSuggestions(state, ticket, h, buildSuggestions(['followups'], parsed, at));
  assert.equal(result[0].title, result[1].title);
  assert.notEqual(result[0].finding_key, result[1].finding_key);
  assert.deepEqual(result.map((x) => x.state), ['proposed', 'proposed']);
});

test('a followup of local-only work remains local-only after acceptance', () => {
  const { state, ticket, h } = setup();
  ticket.local_only = true;
  h.suggestions = suggestions();
  const m = accept(state, ticket, h, h.suggestions[0], 'accept-private');
  assert.equal(m.child.local_only, true, 'the privacy decision is journaled');
  assert.equal(state.tickets.get(m.child.id).local_only, true);
});

test('accepting an exact repeat on a private parent also protects an existing visible child', () => {
  const { state, ticket, h } = setup();
  h.suggestions = suggestions();
  const first = accept(state, ticket, h, h.suggestions[0], 'accept-visible');
  ticket.local_only = true;
  const next = { ...h, id: 'run-private', suggestions: suggestions() };
  state.handoffs.set(next.id, next);
  const second = accept(state, ticket, next, next.suggestions[0], 'accept-private-repeat');
  assert.equal(second.child_id, first.child.id);
  assert.equal(state.tickets.size, 2);
  assert.equal(state.tickets.get(first.child.id).local_only, true);
});
