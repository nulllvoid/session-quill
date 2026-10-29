import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, ticket, TID } from './fixtures.js';
import { runTabs, needsYouCount } from '../../ui/lib/runs.js';
import { renderRuns } from '../../ui/views/runs.js';
import { renderDetail } from '../../ui/views/detail.js';
import * as dialogs from '../../ui/views/dialogs.js';

const NOW = '2026-10-02T12:30:00Z';
const item = { ticket_id: TID(1), key: 'LOCAL-1', title: '<script>task</script>', status: 'review', kind: 'review', reason: 'Missing <attribution>', blockers: ['A required child is open'], closable: false };
const snap = (extra = {}) => snapshot({ handoffs: [], reconciliation: { items: [item], coverage: null }, ...extra });

test('reconciliation joins the same filtered Needs you set and attention count, with an escaped Open ticket action', () => {
  const s = snap();
  assert.equal(runTabs(s, {}, NOW).needs.length, 1);
  assert.equal(needsYouCount(s, NOW), 1);
  assert.equal(runTabs(s, { project: 'other' }, NOW).needs.length, 0);
  const html = renderRuns(s, {}, { now: NOW, tab: 'needs' });
  assert.match(html, /Closure review/);
  assert.match(html, /Missing &lt;attribution&gt;/);
  assert.match(html, /A required child is open/);
  assert.match(html, new RegExp(`data-open="${TID(1)}"[^>]*>Open ticket`));
  assert.doesNotMatch(html, /<script>/);
  assert.equal(renderRuns(s, {}, { now: NOW, tab: 'needs' }), html, 'unchanged facts have unchanged markup');
});

test('reconciliation is owner-only even when a read-only or static snapshot accidentally carries it', () => {
  for (const s of [snap({ capabilities: { read: true } }), snap({ meta: { ...snapshot().meta, exported_at: NOW } })]) {
    assert.equal(needsYouCount(s, NOW), 0);
    assert.doesNotMatch(renderRuns(s, {}, { now: NOW, tab: 'needs' }), /Missing &lt;attribution&gt;|Closure review/);
    assert.doesNotMatch(renderDetail(s.tickets[0], s, { now: NOW }), /data-action="completion-settings"|data-action="resolve-ticket"|Missing &lt;attribution&gt;/);
  }
});

test('ticket overview exposes recorded closure blockers and explicit completion controls; pending edits prevent duplicates', () => {
  const s = snap();
  const html = renderDetail(s.tickets[0], s, { now: NOW });
  assert.match(html, /data-action="completion-settings"/);
  assert.match(html, /data-action="resolve-ticket"/);
  assert.match(html, /Missing &lt;attribution&gt;/);
  const busy = renderDetail(s.tickets[0], s, { now: NOW, pending: [{ kind: 'set-completion', target_id: TID(1), state: 'pending' }] });
  assert.match(busy, /data-action="completion-settings"[^>]*disabled/);
});

test('completion settings explicitly distinguish grouping-only and unknown child relationships', () => {
  assert.equal(typeof dialogs.renderCompletionDialog, 'function');
  const html = dialogs.renderCompletionDialog(ticket(7, { parent_id: TID(1), blocks_parent: null }));
  assert.match(html, /value="evidence"/);
  assert.match(html, /value="children"[^>]*>Grouping only/);
  assert.match(html, /name="blocks_parent"/);
  assert.match(html, /value="unknown" selected/);
  assert.match(html, /data-revision="1"/);
});

test('resolution form retains deployment choice and uses existing tickets for duplicate or superseded links', () => {
  const s = snap();
  const html = dialogs.renderStatusDialog(s.tickets[5], 'done', { snapshot: s, resolve: true });
  for (const kind of ['completed', 'duplicate', 'superseded', 'abandoned']) assert.match(html, new RegExp(`value="${kind}"`));
  assert.match(html, /name="resolution_reason"[^>]*required[^>]*maxlength="500"/);
  assert.doesNotMatch(html, /unless completed/);
  assert.match(html, /<select[^>]*name="related_ticket_id"/);
  assert.doesNotMatch(html, new RegExp(`<option value="${TID(6)}"`));
  assert.match(html, /name="deployment_choice" value="leave" required/);
  assert.doesNotMatch(html, /name="deployment_choice"[^>]*checked/);
});

test('follow-up acceptance requires explicit relationship and an editable Done when description', () => {
  assert.equal(typeof dialogs.renderFollowupDialog, 'function');
  const html = dialogs.renderFollowupDialog(ticket(1), { id: 'h1' }, { id: 's1', title: '<followup>', description: '' });
  assert.match(html, /&lt;followup&gt;/);
  assert.match(html, /name="blocks_parent" value="true" required/);
  assert.match(html, /name="blocks_parent" value="false" required/);
  assert.doesNotMatch(html, /name="blocks_parent"[^>]*checked/);
  assert.match(html, /name="description"[^>]*required/);
  assert.match(html, /Done when/);
});

test('legacy runs still present follow-ups for acceptance; suppressed and deferred findings are inert and labelled', async () => {
  const { renderRunDetail } = await import('../../ui/views/run-detail.js');
  const { suggestionItem, runSummary } = await import('../../ui/views/agents.js');
  const run = { id: 'legacy', ticket_id: TID(1), mode: 'analyse-followups', legacy: true, state: 'done', requested_at: NOW, suggestions: [{ id: 's1', type: 'followup', state: 'proposed', title: 'Follow-up' }] };
  const s = snap({ handoffs: [run] });
  assert.match(renderRunDetail(run, s, { now: NOW }), /data-action="accept-suggestion"/);
  for (const state of ['suppressed', 'deferred']) {
    const html = suggestionItem({ ...run.suggestions[0], state }, run, s.tickets[0], { canEdit: true, pending: [] });
    assert.match(html, new RegExp(state === 'suppressed' ? 'Suppressed' : 'Deferred'));
    assert.doesNotMatch(html, /data-action="accept-suggestion"|data-action="dismiss-suggestion"/);
  }
  assert.match(runSummary({ legacy: true, permissions: {} }, {}, null), /follow-ups need your acceptance/);
});

test('closure review shows recorded provider timing/failure and a revision-bound acknowledgement in Runs and detail', () => {
  const checked = { ...item, evidence_version: 'evidence-1', last_success_at: '2026-10-02T10:00:00Z', next_check_at: '2026-10-02T13:00:00Z', error: 'Provider <offline>' };
  const s = snap({ reconciliation: { items: [checked] } });
  for (const html of [renderRuns(s, {}, { now: NOW, tab: 'needs' }), renderDetail(s.tickets[0], s, { now: NOW })]) {
    assert.match(html, /Last successful check/);
    assert.match(html, /Next check/);
    assert.match(html, /Provider &lt;offline&gt;/);
    assert.match(html, /data-action="acknowledge-closure"[^>]*data-revision="1"[^>]*data-evidence-version="evidence-1"[^>]*>Reviewed — keep open/);
  }
  const pending = [{ id: 'ack', kind: 'acknowledge-closure', target_id: TID(1), state: 'pending', payload: { evidence_version: 'evidence-1' } }];
  for (const html of [renderRuns(s, {}, { now: NOW, tab: 'needs', pending }), renderDetail(s.tickets[0], s, { now: NOW, pending })]) {
    assert.match(html, /data-action="acknowledge-closure"[^>]*disabled/);
  }
  for (const opts of [{ capabilities: { read: true } }, { meta: { ...s.meta, exported_at: NOW } }]) {
    const ro = { ...s, ...opts };
    assert.doesNotMatch(renderRuns(ro, {}, { now: NOW, tab: 'needs' }) + renderDetail(ro.tickets[0], ro, { now: NOW }), /acknowledge-closure|Provider &lt;offline&gt;/);
  }
  const done = snap({ tickets: [ticket(1, { status: 'done' })], reconciliation: { items: [{ ...checked, status: 'done' }] } });
  assert.doesNotMatch(renderRuns(done, {}, { now: NOW, tab: 'needs' }) + renderDetail(done.tickets[0], done, { now: NOW }), /data-action="acknowledge-closure"/);
});
