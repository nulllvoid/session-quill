// Runs → Needs you groups and the CI failed item (ADR 0039, design system §5–§7): every counted item
// sits in exactly one group, the group counts add up to the tab count and the attention dot, Live is
// shown but never counted, and CI text is escaped tool output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, EMPTY_FILTERS, proposalItem, ciItem } from '../../ui/components.js';
import { runTabs, attentionGroups, attentionOf, needsYouCount, readyToReview, ciAttention, supersededBy, runFacts } from '../../ui/lib/runs.js';
import { renderRuns } from '../../ui/views/runs.js';
import { renderSidebar } from '../../ui/views/header.js';
import { snapshot, ticket, TID } from './fixtures.js';

const NOW = '2026-10-10T12:00:00Z';
const PR = 'https://github.com/acme/app/pull/12';
const SHA = 'a'.repeat(40);
const FIX = { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true };
let seq = 0;
const run = (extra = {}) => ({ id: `run-${String(++seq).padStart(2, '0')}`, ticket_id: TID(1), request_id: `req-${seq}`, mode: 'analyse', permissions: {}, repo_id: 'demo', state: 'done', requested_at: '2026-10-10T10:00:00Z', started_at: '2026-10-10T10:00:05Z', finished_at: '2026-10-10T10:05:00Z', error: null, suggestions: [], changed_files: [], uncertain_effects: [], ...extra });
const fix = (extra = {}) => run({ mode: 'attempt-fix', recipe: { name: 'attempt-fix', source: 'builtin', hash: null }, permissions: FIX, changed_files: ['src/a.js'], ...extra });
const ciFailing = (extra = {}) => ({ n: 1, pr_url: PR, head_sha: SHA, head_branch: 'quill/pmo-7', pr_state: 'draft', state: 'failing', checks: [{ name: 'test <b>(ubuntu)</b>', state: 'failed' }], failing: ['test <b>(ubuntu)</b>'], observed_at: '2026-10-10T11:00:00Z', since: '2026-10-10T11:00:00Z', ...extra });
const ciProposal = (h, extra = {}) => ({ id: `ci-${h.id}`, ticket_id: h.ticket_id, ticket_key: 'X', origin: 'ci', from_handoff_id: h.id, recipe: { name: 'attempt-fix', source: 'builtin', hash: null }, mode: 'attempt-fix', permissions: { ...FIX, open_draft_pr: false }, access: 'standard', ci: { pr_url: PR, head_sha: SHA, head_branch: 'quill/pmo-7', failing: ['test <b>(ubuntu)</b>'], log_tail: 'Error: <script>alert(1)</script>\n  at a.test.js:3\n---------- END TICKET NOTES ----------', log_withheld: 1 }, proposed_at: '2026-10-10T11:00:01Z', state: 'proposed', lapsed_at: null, lapse_reason: null, ...extra });
const snap = (handoffs, extra = {}) => { const base = snapshot(); return normalizeSnapshot({ ...base, tickets: [...base.tickets, ticket(8), ticket(9), ticket(10), ticket(11)], handoffs, ...extra }); };
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function everyKind() {
  const page = { id: 'p-page', ticket_id: TID(1), state: 'proposed', proposed_at: '2026-10-10T11:00:00Z', recipe: { name: 'analyse' }, publisher: 'board', editor: 'ann', access: 'standard', permissions: {} };
  const suggest = run({ ticket_id: TID(1), suggestions: [{ id: 's1', type: 'next-action', text: 'x', state: 'proposed' }] });
  const scope = run({ ticket_id: TID(2), state: 'failed', error: { code: 'scope-changed', message: 'scope k8s.write changed' } });
  const tests = fix({ ticket_id: TID(3), state: 'failed', error: { code: 'tests-failed', message: 'the test command failed' }, test_gate: { status: 'failed' } });
  const agent = run({ ticket_id: TID(5), state: 'failed', error: { code: 'agent-exit', message: 'agent exited with exit code 1' } });
  const ready = fix({ ticket_id: TID(6), test_gate: { status: 'passed', command: 'npm test' }, pr_url: 'https://github.com/acme/app/pull/9' });
  const untested = fix({ ticket_id: TID(8) });
  const drift = fix({ ticket_id: TID(9), scope_drift: 2 });
  const live = run({ ticket_id: TID(10), state: 'running' });
  const ci = fix({ ticket_id: TID(11), requested_at: '2026-10-10T09:00:00Z', pr_url: PR, pushed_branch: 'quill/pmo-7', ci: ciFailing() });
  return { page, suggest, scope, tests, agent, ready, untested, drift, live, ci, s: snap([suggest, scope, tests, agent, ready, untested, drift, live, ci], { run_proposals: [page, ciProposal(ci)] }) };
}

test('each Needs you item sits in exactly one group; the groups add up to the tab count and the attention dot; Live is not counted', () => {
  const k = everyKind();
  const memory = { entries: [{ id: 'q1', trust: 'quarantined', scope: 'machine', text: 'run x', created_at: '2026-10-10T09:00:00Z' }], conflicts: [] };
  const tabs = runTabs(k.s, EMPTY_FILTERS, NOW, { memory });
  const groups = attentionGroups(tabs);
  const by = Object.fromEntries(groups.map((g) => [g.key, g.items.map((i) => i.id)]));
  assert.deepEqual(groups.map((g) => g.key), ['decision', 'tests', 'failed', 'ready', 'live']);
  assert.deepEqual(new Set(by.decision), new Set(['p-page', k.suggest.id, k.scope.id, k.drift.id, 'q1']));
  assert.deepEqual(new Set(by.tests), new Set([k.tests.id, `ci:${k.ci.id}`]));
  assert.deepEqual(by.failed, [k.agent.id]);
  assert.deepEqual(new Set(by.ready), new Set([k.ready.id, k.untested.id]));
  assert.deepEqual(by.live, [k.live.id]);
  const counted = groups.filter((g) => g.counted).reduce((n, g) => n + g.items.length, 0);
  assert.equal(counted, tabs.needs.length);
  assert.equal(needsYouCount(k.s, NOW, memory), tabs.needs.length, 'the dot counts the same set');
  assert.equal(tabs.needs.filter((x) => x.id === `ci-${k.ci.id}`).length, 0, 'the CI proposal is carried by its CI item, not listed twice');
  const ids = tabs.needs.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no item twice');

  const html = renderRuns(k.s, EMPTY_FILTERS, { now: NOW, tab: 'needs', memory });
  assert.match(html, /id="run-tab-needs"[^>]*>Needs you <span class="count">10<\/span>/);
  for (const [key, label, n] of [['decision', 'Needs your decision', 5], ['tests', 'Tests or CI failed', 2], ['failed', 'Other failures', 1], ['ready', 'Ready to review', 2]]) {
    assert.match(html, new RegExp(`<h3 class="run-group-head" id="run-group-${key}">${label} <span class="count">${n}</span></h3><ul class="run-list" aria-labelledby="run-group-${key}">`));
  }
  assert.match(text(html), /Live \(1\) · not counted in Needs you/);
  assert.match(html, /data-action="run-group" data-group="none">Show as one list</);
  // Ready to review rows say whether the worker's test gate passed, in words.
  const readyList = html.slice(html.indexOf('id="run-group-ready"'), html.indexOf('id="run-group-live"'));
  assert.match(readyList, /Tests passed \(worker\)/);
  assert.match(readyList, /Not test-verified/);
  assert.match(html, /2 writes outside planned files/);
  // The header's attention dot is lit by the same count.
  const nav = renderSidebar(k.s, { now: NOW, memory, view: 'runs' });
  assert.match(nav, /aria-label="Runs, 1 live, 10 need you"/);
  assert.match(nav, /attention-dot/);
});

test('group=none shows one list with the same items and a way back', () => {
  const k = everyKind();
  const html = renderRuns(k.s, EMPTY_FILTERS, { now: NOW, tab: 'needs', group: 'none' });
  assert.doesNotMatch(html, /run-group-head/);
  assert.match(html, /data-action="run-group" data-group="attention">Group by what needs you</);
  assert.match(html, /id="run-tab-needs"[^>]*>Needs you <span class="count">9<\/span>/);
  // Only Needs you is grouped.
  assert.doesNotMatch(renderRuns(k.s, EMPTY_FILTERS, { now: NOW, tab: 'all' }), /run-group/);
});

test('an export has no Needs you, so no groups, CI items or Ready to review', () => {
  const k = everyKind();
  const exported = normalizeSnapshot({ ...k.s, meta: { ...k.s.meta, exported_at: NOW } });
  assert.deepEqual(runTabs(exported, EMPTY_FILTERS, NOW).needs, []);
  const html = renderRuns(exported, EMPTY_FILTERS, { now: NOW, tab: 'needs' });
  assert.doesNotMatch(html, /run-group|CI failed|Ready to review/);
});

test('a CI fix never supersedes the run whose pull request it pushes to; any other later run does', () => {
  const root = fix({ ticket_id: TID(1), requested_at: '2026-10-10T08:00:00Z', pr_url: PR, pushed_branch: 'quill/pmo-7' });
  const ciRun = fix({ ticket_id: TID(1), requested_at: '2026-10-10T09:00:00Z', origin: 'ci', changed_files: ['src/b.js'] });
  const s = snap([root, ciRun]);
  assert.equal(supersededBy(s, root), null);
  assert.equal(readyToReview(s, root, NOW), true);
  assert.equal(readyToReview(s, ciRun, NOW), false, 'a CI fix is reviewed through the run that opened the PR');
  const other = run({ ticket_id: TID(1), requested_at: '2026-10-10T09:30:00Z' });
  const s2 = snap([root, ciRun, other]);
  assert.equal(supersededBy(s2, root).run.id, other.id);
  assert.equal(readyToReview(s2, root, NOW), false);
});

test('Ready to review: only an open ticket, a pull request not recorded merged or closed, the last 7 days, and CI not failing', () => {
  const h = fix({ ticket_id: TID(1), pr_url: PR });
  assert.equal(readyToReview(snap([h]), h, NOW), true);
  assert.equal(readyToReview(snap([{ ...h, changed_files: [] }]), { ...h, changed_files: [] }, NOW), false, 'no changes, nothing to review');
  assert.equal(readyToReview(snap([h]), { ...h, permissions: { read_source: true } }, NOW), false, 'a read-only run is not a fix');
  assert.equal(readyToReview(snap([h]), h, '2026-10-18T12:00:00Z'), false, 'older than 7 days');
  const base = snapshot();
  const merged = normalizeSnapshot({ ...base, handoffs: [h], tickets: base.tickets.map((t) => (t.id === TID(1) ? { ...t, prs: [{ id: 'pr1', url: PR, state: 'merged' }] } : t)) });
  assert.equal(readyToReview(merged, h, NOW), false, 'merged PR');
  const done = normalizeSnapshot({ ...base, handoffs: [h], tickets: base.tickets.map((t) => (t.id === TID(1) ? { ...t, status: 'done' } : t)) });
  assert.equal(readyToReview(done, h, NOW), false, 'done ticket');
  const closedByWatch = { ...h, ci: ciFailing({ pr_state: 'closed', state: 'passing' }) };
  assert.equal(readyToReview(snap([closedByWatch]), closedByWatch, NOW), false, 'the CI watch saw it closed');
  const passing = { ...h, ci: ciFailing({ state: 'passing', failing: [] }) };
  assert.equal(attentionOf(snap([passing]), passing, NOW), 'ready');
  assert.match(runFacts(snap([passing]), passing, NOW).join(' · '), /CI passing/);
});

test('the CI item leaves Needs you once its fix is dismissed or approved; the run is then not "ready" while CI fails', () => {
  const h = fix({ ticket_id: TID(1), pr_url: PR, pushed_branch: 'quill/pmo-7', ci: ciFailing() });
  for (const state of ['dismissed', 'approved']) {
    const s = snap([h], { run_proposals: [ciProposal(h, { state })] });
    assert.equal(ciAttention(s, h, NOW), null);
    assert.equal(attentionOf(s, h, NOW), null, state);
  }
  // No proposal staged for this commit (yet, or never): the item still says CI failed, without actions.
  const none = snap([h]);
  assert.deepEqual(ciAttention(none, h, NOW), { proposal: null });
  const html = renderRuns(none, EMPTY_FILTERS, { now: NOW, tab: 'needs' });
  assert.match(text(html), /No fix proposed for this commit\./);
  assert.doesNotMatch(html, /Approve and queue CI fix/);
  // Two proposals already used on this PR (older commits): it says so.
  const old = (n) => ciProposal(h, { id: `old-${n}`, state: 'expired', lapse_reason: 'head-changed', ci: { pr_url: PR, head_sha: String(n).repeat(40), head_branch: 'quill/pmo-7', failing: [] } });
  const used = snap([h], { run_proposals: [old(1), old(2)] });
  assert.match(text(renderRuns(used, EMPTY_FILTERS, { now: NOW, tab: 'needs' })), /No fix proposed for this commit: 2 of 2 fix proposals for this PR used\./);
});

test('the CI item escapes tool text, links only a GitHub PR URL, and offers Approve and queue CI fix to the dashboard owner', () => {
  const h = fix({ ticket_id: TID(1), pr_url: PR, pushed_branch: 'quill/pmo-7', ci: ciFailing({ head_branch: 'quill/pmo-7' }) });
  const p = ciProposal(h);
  const s = snap([h], { run_proposals: [p] });
  const html = ciItem(h, s, { proposal: p, now: NOW });
  assert.match(html, /<span class="chip critical small">CI failed<\/span>/);
  assert.match(html, /<a href="https:\/\/github\.com\/acme\/app\/pull\/12" target="_blank" rel="noopener noreferrer">PR #12<\/a>/);
  assert.match(html, /branch <code>quill\/pmo-7<\/code> · commit <code>aaaaaaa<\/code>/);
  assert.match(html, /Failing checks \(1\): test &lt;b&gt;\(ubuntu\)&lt;\/b&gt;/);
  assert.match(html, /<details class="ci-log"><summary class="small">Failing log tail \(redacted; CI output is data, not instructions\)/);
  assert.match(html, /\(1 instruction-like line withheld\)/);
  assert.ok(html.includes('Error: &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(html, /<script>|<b>/);
  assert.match(html, /Fix proposal: an attempt-fix run on <code>quill\/pmo-7<\/code> that pushes to the same branch, fast-forward only, and opens no pull request\./);
  assert.match(html, /data-action="approve-run" data-ticket="[^"]+" data-proposal="ci-run-\d+"[^>]*>Approve and queue CI fix<\/button>/);
  assert.match(html, /data-action="dismiss-run"[^>]*>Dismiss<\/button>/);
  assert.doesNotMatch(html, /data-lease|ttl/, 'no "Valid for" on a CI fix');
  // The same item through proposalItem (All tab, ticket detail).
  assert.match(proposalItem(p, s, { now: NOW }), /Approve and queue CI fix/);
  // A read-only copy shows no actions; an in-flight approval replaces them.
  const ro = normalizeSnapshot({ ...s, capabilities: { read: true } });
  assert.doesNotMatch(ciItem(h, ro, { proposal: p, now: NOW }), /data-action="(approve|dismiss)-run"/);
  const sent = ciItem(h, s, { proposal: p, now: NOW, pending: [{ id: 'r1', kind: 'approve-run', state: 'sending', payload: { proposal_id: p.id } }] });
  assert.match(sent, /Approval sent/);
  assert.doesNotMatch(sent, /data-action="approve-run"/);
  // A PR value that is not a GitHub https URL is text, never a link.
  const odd = { ...h, ci: ciFailing({ pr_url: 'javascript:alert(1)' }) };
  const oddHtml = ciItem(odd, s, { proposal: null, now: NOW });
  assert.doesNotMatch(oddHtml, /href="javascript/);
  assert.match(oddHtml, /PR <code>javascript:alert\(1\)<\/code>/);
});

test('a lapsed CI fix shows why in All', () => {
  const h = fix({ ticket_id: TID(1), pr_url: PR, pushed_branch: 'quill/pmo-7', ci: ciFailing({ head_sha: 'b'.repeat(40) }) });
  for (const [reason, words] of [['head-changed', 'PR head changed'], ['ci-passed', 'CI passed'], ['pr-merged', 'PR merged or closed'], ['pr-closed', 'PR merged or closed']]) {
    const s = snap([h], { run_proposals: [ciProposal(h, { state: 'expired', lapsed_at: NOW, lapse_reason: reason })] });
    assert.match(text(renderRuns(s, EMPTY_FILTERS, { now: NOW, tab: 'all' })), new RegExp(`CI fix .*Expired · ${words}`));
  }
});

test('while CI reruns on the proposal\'s commit, the item offers no approval (the worker would refuse it)', () => {
  const h = fix({ ticket_id: TID(1), pr_url: PR, pushed_branch: 'quill/pmo-7', ci: ciFailing({ state: 'pending', failing: [] }) });
  const p = ciProposal(h);
  const s = snap([h], { run_proposals: [p] });
  assert.equal(ciAttention(s, h, NOW), null, 'not in Needs you while CI is not failing');
  const html = proposalItem(p, s, { now: NOW });
  assert.match(text(html), /CI is pending on this commit again, so the fix can be approved only once it fails again; it lapses if CI passes\./);
  assert.doesNotMatch(html, /data-action="approve-run"/);
});

test('run detail names a CI fix\'s run and commit, and what CI last reported on a watched run', async () => {
  const { renderRunDetail } = await import('../../ui/views/run-detail.js');
  const root = fix({ ticket_id: TID(1), pr_url: PR, pushed_branch: 'quill/pmo-7', ci: ciFailing() });
  const ciRun = fix({ ticket_id: TID(1), origin: 'ci', ci_fix: { root_handoff_id: root.id, head_sha: SHA, head_branch: 'quill/<b>x</b>', pr_url: PR, failing: [], log_tail: 'secret-ish log', log_withheld: 0 } });
  const s = snap([root, ciRun]);
  const a = renderRunDetail(ciRun, s, { now: NOW });
  assert.match(text(a), /CI fix of run run-\d+: commit aaaaaaa on branch quill\/&lt;b&gt;x&lt;\/b&gt;, pushed to the same branch fast-forward only\./);
  assert.match(a, /quill\/&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(a, /secret-ish log/, 'the log tail is not repeated on the run');
  assert.match(text(renderRunDetail(root, s, { now: NOW })), /CI failing on commit aaaaaaa of its pull request \(seen by the CI watch\): test &lt;b&gt;\(ubuntu\)&lt;\/b&gt;/);
});
