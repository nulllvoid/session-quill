// Proposed runs on the dashboard (ADR 0025): Today and ticket detail list them with editor, recipe
// and access, and Approve / Dismiss; a new one is announced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, openProposals, proposalItem, EMPTY_FILTERS } from '../../ui/components.js';
import { renderToday } from '../../ui/views/today.js';
import { renderDetail } from '../../ui/views/detail.js';
import { freshProposals, proposalNotice } from '../../ui/lib/proposals.js';
import { snapshot, ticket } from './fixtures.js';

const NOW = '2026-10-02T12:30:00Z';
const t1 = ticket(1);
const proposal = (n, extra = {}) => ({
  id: `4444444${n}-0000-4000-8000-000000000000`, ticket_id: t1.id, ticket_key: t1.key, publisher: 'team', editor: 'u_<b>editor</b>', edited_at: '2026-10-02T12:00:00Z', recipe: { name: 'analyse', source: 'builtin', hash: 'h' }, mode: 'analyse',
  permissions: { read_source: true }, access: 'standard', read_only: true, auto: false, proposed_at: '2026-10-02T12:05:00Z', state: 'proposed', resolved_at: null, resolved_by: null, handoff_id: null, ...extra,
});
const snap = (proposals, extra = {}) => normalizeSnapshot({ ...snapshot(), run_proposals: proposals, today: { generated_for: '2026-10-02', days: [] }, ...extra });

test('a proposed run shows its editor (escaped), recipe and access, with Approve and Dismiss', () => {
  const s = snap([proposal(1)]);
  const html = proposalItem(s.run_proposals[0], s, { now: NOW });
  assert.match(html, /<strong>analyse<\/strong>/);
  assert.match(html, /Standard access/);
  assert.match(html, /Read-only/);
  assert.match(html, /proposed on the team page by <code>u_&lt;b&gt;editor&lt;\/b&gt;<\/code>/);
  assert.match(html, /data-action="approve-run" data-ticket="[^"]+" data-proposal="44444441-[^"]+" aria-label="Approve the analyse run on [^"]+">Approve<\/button>/);
  assert.match(html, /data-action="dismiss-run"[^>]*>Dismiss<\/button>/);
  const fix = proposalItem(proposal(2, { recipe: { name: 'attempt-fix' }, read_only: false, permissions: { read_source: true, edit_source: true } }), s, { now: NOW });
  assert.match(fix, /<span class="chip warning small">Edits source<\/span>/);
  const readOnly = normalizeSnapshot({ ...snapshot(), capabilities: { read: true }, run_proposals: [proposal(1)] });
  assert.doesNotMatch(proposalItem(readOnly.run_proposals[0], readOnly, { now: NOW }), /approve-run|dismiss-run/, 'a read-only copy cannot approve');
});

test('an approval or dismissal on its way hides the buttons', () => {
  const s = snap([proposal(1)]);
  const pending = [{ id: 'r1', kind: 'approve-run', target_id: t1.id, state: 'pending', payload: { proposal_id: proposal(1).id } }];
  const html = proposalItem(s.run_proposals[0], s, { now: NOW, pending });
  assert.doesNotMatch(html, /data-action="approve-run"/);
  assert.match(html, /Approval sent/);
});

test('Today lists open proposals above the days; lapsed and resolved ones are not listed', () => {
  const s = snap([proposal(1), proposal(2, { state: 'expired' }), proposal(3, { state: 'approved' })]);
  assert.deepEqual(openProposals(s).map((p) => p.id), [proposal(1).id]);
  const html = renderToday(s, EMPTY_FILTERS, { now: NOW });
  assert.match(html, /<section class="proposals" aria-labelledby="proposals-title"><div class="section-head"><h2 id="proposals-title">Proposed runs<\/h2><span class="section-count">1 waiting for you<\/span>/);
  assert.match(html, /data-open="[^"]+"/, 'each names its ticket');
  assert.equal((html.match(/data-action="approve-run"/g) ?? []).length, 1);
  assert.doesNotMatch(renderToday(snap([]), EMPTY_FILTERS, { now: NOW }), /Proposed runs/);
});

test('ticket detail lists the ticket\'s open proposals and says when a run is already active', () => {
  const s = snap([proposal(1)], { handoffs: [{ id: 'h1', ticket_id: t1.id, state: 'running', mode: 'analyse', requested_at: NOW }] });
  const html = renderDetail(s.tickets[0], s, { now: NOW });
  assert.match(html, /<section class="detail-section proposals"><h3>Proposed runs <span class="count">1<\/span><\/h3>/);
  assert.match(html, /A run is already queued or running on this ticket/);
  assert.doesNotMatch(renderDetail(snap([]).tickets[0], snap([]), { now: NOW }), /Proposed runs/);
});

test('a new proposal is announced once; the first poll only learns what is there', () => {
  const first = freshProposals(null, snap([proposal(1)]));
  assert.deepEqual(first.fresh, []);
  const second = freshProposals(first.seen, snap([proposal(1), proposal(2)]));
  assert.deepEqual(second.fresh.map((p) => p.id), [proposal(2).id]);
  assert.deepEqual(freshProposals(second.seen, snap([proposal(1), proposal(2)])).fresh, []);
  assert.deepEqual(freshProposals(second.seen, snap([proposal(5, { state: 'approved' })])).fresh, [], 'only open proposals are news');
  assert.equal(proposalNotice(proposal(2)), `Run of analyse proposed on ${t1.key} from the team page by u_<b>editor</b>; approve or dismiss it in Today`);
});
