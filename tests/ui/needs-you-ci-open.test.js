// Review fix (ADR 0039): an open CI fix proposal is always in Needs you, as the CI item that carries
// it, whatever else the run needs (suggestions to decide, Ready to review) and however old or
// superseded the run is. Every item is counted once, so the groups still add up to the tab count
// and the attention dot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, EMPTY_FILTERS } from '../../ui/components.js';
import { runTabs, attentionGroups, needsYouCount } from '../../ui/lib/runs.js';
import { renderRuns } from '../../ui/views/runs.js';
import { snapshot, ticket, TID } from './fixtures.js';

const NOW = '2026-10-21T12:00:00Z';
const PR = 'https://github.com/acme/app/pull/12';
const SHA = 'a'.repeat(40);
const FIX = { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true };
let seq = 0;
const run = (extra = {}) => ({ id: `run-${String(++seq).padStart(2, '0')}`, ticket_id: TID(1), request_id: `req-${seq}`, mode: 'attempt-fix', recipe: { name: 'attempt-fix', source: 'builtin', hash: null }, permissions: FIX, repo_id: 'demo', state: 'done', requested_at: '2026-10-20T10:00:00Z', started_at: '2026-10-20T10:00:05Z', finished_at: '2026-10-20T10:05:00Z', error: null, suggestions: [], changed_files: ['src/a.js'], uncertain_effects: [], pr_url: PR, pushed_branch: 'quill/pmo-7', ci: { n: 1, pr_url: PR, head_sha: SHA, head_branch: 'quill/pmo-7', pr_state: 'open', state: 'failing', checks: [{ name: 't', state: 'failed' }], failing: ['t'], observed_at: '2026-10-20T11:00:00Z', since: '2026-10-20T11:00:00Z' }, ...extra });
const proposal = (h, extra = {}) => ({ id: `ci-${h.id}`, ticket_id: h.ticket_id, origin: 'ci', from_handoff_id: h.id, recipe: { name: 'attempt-fix', source: 'builtin', hash: null }, mode: 'attempt-fix', permissions: { ...FIX, open_draft_pr: false }, access: 'standard', ci: { pr_url: PR, head_sha: SHA, head_branch: 'quill/pmo-7', failing: ['t'], log_tail: null, log_withheld: 0 }, proposed_at: '2026-10-20T11:00:01Z', state: 'proposed', lapsed_at: null, lapse_reason: null, ...extra });
const snap = (handoffs, proposals) => { const base = snapshot(); return normalizeSnapshot({ ...base, tickets: [...base.tickets, ticket(8)], handoffs, run_proposals: proposals }); };

function check(s, wantCiFor) {
  const tabs = runTabs(s, EMPTY_FILTERS, NOW);
  const ci = tabs.needs.filter((x) => x.kind === 'ci');
  assert.deepEqual(ci.map((x) => [x.id, x.group, x.proposal && x.proposal.id]), wantCiFor.map((p) => [`ci:${p.from_handoff_id}`, 'tests', p.id]));
  assert.equal(tabs.needs.filter((x) => x.kind === 'proposal' && x.proposal.origin === 'ci').length, 0, 'never listed again on its own');
  const ids = tabs.needs.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'each item once');
  const groups = attentionGroups(tabs).filter((g) => g.counted);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), tabs.needs.length, 'the groups add up to the tab count');
  assert.equal(needsYouCount(s, NOW), tabs.needs.length, 'the dot counts the same set');
  return tabs;
}

test('a run with suggestions to decide still shows its open CI fix: its own row decides, the CI item carries the proposal', () => {
  const h = run({ suggestions: [{ id: 's1', type: 'next-action', text: 'x', state: 'proposed' }] });
  const p = proposal(h);
  const tabs = check(snap([h], [p]), [p]);
  assert.deepEqual(tabs.needs.filter((x) => x.kind === 'run').map((x) => [x.id, x.group]), [[h.id, 'decision']]);
  assert.match(renderRuns(snap([h], [p]), EMPTY_FILTERS, { now: NOW, tab: 'needs' }), /data-action="approve-run"[^>]*data-proposal="ci-run-/);
});

test('an open CI fix shows even when its run is past the 7-day window or superseded by a later run', () => {
  const old = run({ requested_at: '2026-10-13T09:00:00Z', started_at: '2026-10-13T09:00:05Z', finished_at: '2026-10-13T10:00:00Z' });
  const p1 = proposal(old);
  check(snap([old], [p1]), [p1]);
  const first = run({ ticket_id: TID(8), requested_at: '2026-10-20T08:00:00Z' });
  const later = run({ ticket_id: TID(8), requested_at: '2026-10-20T09:00:00Z', pr_url: null, ci: null, changed_files: [], permissions: {}, mode: 'analyse' });
  const p2 = proposal(first, { ticket_id: TID(8) });
  check(snap([first, later], [p2]), [p2]);
});

test('an open CI fix shows while CI reruns on its commit, and when its run is no longer in the snapshot', () => {
  const h = run({ ci: { ...run().ci, state: 'pending', failing: [] } });
  const p = proposal(h);
  const tabs = check(snap([h], [p]), [p]);
  assert.equal(tabs.needs.find((x) => x.kind === 'ci').run.id, h.id);
  const gone = proposal({ id: 'run-gone', ticket_id: TID(1) });
  const t2 = check(snap([], [gone]), [gone]);
  assert.equal(t2.needs[0].run, null);
  // A resolved or lapsed proposal brings nothing back.
  check(snap([run({ suggestions: [{ id: 's', type: 'next-action', text: 'x', state: 'proposed' }] })], [proposal({ id: 'x', ticket_id: TID(1) }, { state: 'expired' })]), []);
});
