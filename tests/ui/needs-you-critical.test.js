// Runs → Needs you, critical change item (spec §7.4, §8; design system §5/§6): what the change is,
// which run proposed it, its scopes as warning chips (words, not colour alone), the exact action as
// escaped code, verify and rollback, and Approve and queue (scopes: …) / Dismiss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, proposalItem, openProposals } from '../../ui/components.js';
import { renderRuns } from '../../ui/views/runs.js';
import { renderDetail } from '../../ui/views/detail.js';
import { renderRunAgentDialog } from '../../ui/views/run-dialog.js';
import { renderRecipeRunDialog } from '../../ui/views/agents.js';
import { snapshot, ticket } from './fixtures.js';

const NOW = '2026-10-02T12:30:00Z';
const RUN = '1a2b3c4d-0000-4000-8000-000000000001';
const parent = ticket(1, { key: 'PMO-7', title: 'Payments' });
const ACTION = 'argocd app sync pay-stg --prune <script>alert(1)</script>';
const spec = { from_handoff_id: RUN, index: 0, title: 'Sync payments to staging', action: ACTION, action_pin: { kind: 'bash', normalized: 'n', guard: ACTION }, scope: 'argo.sync', target: 'pay-stg', scopes: [{ name: 'argo.sync', target: 'pay-stg', fingerprint: 'f'.repeat(64) }], why: 'the run needed it', evidence: 'e', verify: 'argocd app get pay-stg shows <b>Synced</b>', rollback: 'argocd app rollback pay-stg <i>1</i>', risk: 'medium' };
const child = ticket(9, { key: 'PMO-12', title: 'Sync payments to staging', parent_id: parent.id, local_only: true, tags: ['critical'], critical_spec: spec });
const proposal = {
  id: '55555555-0000-4000-8000-000000000009', ticket_id: child.id, ticket_key: 'PMO-12', origin: 'run', from_handoff_id: RUN, publisher: null, editor: null, edited_at: null,
  recipe: { name: 'critical-change', source: 'builtin', hash: null }, mode: null, permissions: {}, access: 'autonomous', read_only: false,
  scopes: spec.scopes, action_pin: spec.action_pin, proposed_at: '2026-10-02T12:05:00Z', state: 'proposed', resolved_at: null, resolved_by: null, handoff_id: null,
};
const run = { id: RUN, ticket_id: parent.id, state: 'done', mode: 'analyse', recipe: { name: 'analyse', source: 'builtin', hash: null }, requested_at: '2026-10-02T12:00:00Z', finished_at: '2026-10-02T12:04:00Z', critical_count: 1 };
const snap = (extra = {}) => {
  const base = snapshot();
  return normalizeSnapshot({ ...base, tickets: [...base.tickets.filter((t) => t.id !== parent.id), parent, child], handoffs: [run], run_proposals: [proposal], ...extra });
};
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('a critical change item names the child, the proposing run and its parent, and offers Approve and queue with its scopes', () => {
  const s = snap();
  const html = proposalItem(s.run_proposals[0], s, { now: NOW, withTicket: true });
  assert.match(text(html), /Critical change · PMO-12 Sync payments to staging · proposed by run 1a2b3c4d of PMO-7/);
  // Scopes are warning chips with words in them.
  assert.match(html, /<span class="chip warning small"[^>]*>[^<]*(?:<svg[^]*?<\/svg>)?Write scope argo\.sync:pay-stg<\/span>/);
  // The exact action as code, escaped: the script tag shows as text.
  assert.ok(html.includes('<code class="critical-action">argocd app sync pay-stg --prune &lt;script&gt;alert(1)&lt;/script&gt;</code>'), html);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Verify: argocd app get pay-stg shows &lt;b&gt;Synced&lt;\/b&gt;/);
  assert.match(html, /Rollback: argocd app rollback pay-stg &lt;i&gt;1&lt;\/i&gt;/);
  assert.match(html, /data-action="approve-run" data-ticket="[^"]+" data-proposal="55555555-[^"]+"[^>]*>Approve and queue \(scopes: argo\.sync:pay-stg\)<\/button>/);
  assert.match(html, /data-action="dismiss-run"[^>]*>Dismiss<\/button>/);
  assert.doesNotMatch(html, /proposed on the/, 'no page wording for a run-origin proposal');
  // A read-only copy cannot approve.
  const ro = normalizeSnapshot({ ...s, capabilities: { read: true } });
  assert.doesNotMatch(proposalItem(ro.run_proposals[0], ro, { now: NOW }), /approve-run/);
});

test('Runs → Needs you lists the critical change; ticket detail shows it under Proposed runs', () => {
  const s = snap();
  assert.equal(openProposals(s).length, 1);
  const runs = renderRuns(s, {}, { now: NOW, tab: 'needs' });
  assert.match(text(runs), /Critical change · PMO-12 Sync payments to staging · proposed by run 1a2b3c4d of PMO-7/);
  assert.match(runs, /Approve and queue \(scopes: argo\.sync:pay-stg\)/);
  const detail = renderDetail(child, s, { now: NOW });
  assert.match(detail, /Approve and queue \(scopes: argo\.sync:pay-stg\)/);
});

test('without the proposing run in view, the parent comes from the child; missing verify or rollback is omitted, not empty', () => {
  const bare = { ...child, critical_spec: { ...spec, verify: '', rollback: '' } };
  const base = snapshot();
  const s = normalizeSnapshot({ ...base, tickets: [...base.tickets.filter((t) => t.id !== parent.id), parent, bare], handoffs: [], run_proposals: [proposal] });
  const html = proposalItem(s.run_proposals[0], s, { now: NOW, withTicket: true });
  assert.match(text(html), /proposed by run 1a2b3c4d of PMO-7/);
  assert.doesNotMatch(html, /Verify:|Rollback:/);
});

test('spec §7.6: on a critical child, the Run dialog says write scopes are a scope grant without a pinned action, and critical-change is not offered', () => {
  const recipes = [
    { name: 'analyse', description: 'a', source: 'builtin', repo_id: null, mode: 'analyse', permissions: { read_source: true }, outputs: ['summary'], legacy: true, error: null, requires: [] },
    { name: 'critical-change', description: 'c', source: 'builtin', repo_id: null, mode: 'analyse', permissions: {}, outputs: ['summary'], legacy: false, error: null, requires: ['action_pin', 'scopes'] },
  ];
  const s = snap({ recipes, meta: { ...snapshot().meta, autonomy: { scopes: [{ name: 'argo.sync', label: 'Argo CD', permits: 'p', takes_target: true }] } } });
  const step1 = renderRunAgentDialog(child, s);
  assert.doesNotMatch(step1, /data-recipe="critical-change"/);
  assert.match(step1, /data-recipe="analyse"/);
  const form = renderRecipeRunDialog(recipes[0], child, s);
  assert.match(form, /scope grant without a pinned action/);
  assert.doesNotMatch(renderRecipeRunDialog(recipes[0], parent, s), /scope grant without a pinned action/, 'only on a critical child');
});
