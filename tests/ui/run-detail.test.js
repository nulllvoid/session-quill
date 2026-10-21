// Run detail (spec §3): evidence, actions and what an export may show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../ui/components.js';
import { renderRunDetail, renderRunNotFound, parseRunRecord } from '../../ui/views/run-detail.js';
import { snapshot, TID } from './fixtures.js';

const NOW = '2026-10-10T12:00:00Z';
const fix = (extra = {}) => ({ id: 'run-1', ticket_id: TID(1), request_id: 'req-1', mode: 'attempt-fix', recipe: { name: 'attempt-fix', source: 'builtin' }, permissions: { read_source: true, edit_source: true }, access: 'standard', repo_id: 'demo', state: 'done', requested_at: '2026-10-10T10:00:00Z', started_at: '2026-10-10T10:00:05Z', finished_at: '2026-10-10T10:05:00Z', error: null, result_summary: 'Fixed <it>', result_ref: 'r'.repeat(64), changed_files: ['src/<a>.js'], commit_sha: '0123456789abcdef', pr_url: 'https://github.com/acme/demo/pull/9', branch: 'feat/x', uncertain_effects: ['push may not have completed'], worktree_path: 'C:\\Users\\me\\wt\\run-1', test_results: ['npm test: 12 passed'], test_gate: { status: 'passed', command: 'npm test' }, timings: { queue_wait_ms: 12000, worktree_ms: 4000, agent_ms: 130000, test_ms: 48000 }, suggestions: [{ id: 's1', type: 'next-action', text: 'Ship it', state: 'proposed' }], batch_id: 'batch-1234abcd', ...extra });
const snap = (h, extra = {}) => normalizeSnapshot({ ...snapshot(), handoffs: [h], ...extra });

test('the header names state, recipe and source, access, the worker test gate and timings', () => {
  const h = fix();
  const html = renderRunDetail(h, snap(h), { now: NOW });
  assert.match(html, /<article class="detail run-detail" data-run="run-1"/);
  assert.match(html, /data-action="close-run"/);
  assert.match(html, /attempt-fix/);
  assert.match(html, /built-in/);
  assert.match(html, /Edits source/);
  assert.match(html, /Tests passed \(worker\)/);
  assert.match(html, /Queue wait/);
  assert.match(html, /Batch batch-12/);
});

test('evidence is escaped; the result loads through the content viewer', () => {
  const h = fix();
  const html = renderRunDetail(h, snap(h), { now: NOW, content: {}, contentStatus: {} });
  assert.match(html, /Fixed &lt;it&gt;/);
  assert.match(html, /<code>src\/&lt;a&gt;\.js<\/code>/);
  assert.match(html, /data-action="load-content" data-hash="r{64}"[^>]*>Show full result/);
  assert.match(html, /0123456/);
  assert.match(html, /npm test: 12 passed/);
  const loaded = renderRunDetail(h, snap(h), { now: NOW, content: { ['r'.repeat(64)]: 'FULL <x>' }, contentStatus: {} });
  assert.match(loaded, /<pre class="full">FULL &lt;x&gt;<\/pre>/);
  const failed = renderRunDetail(h, snap(h), { now: NOW, content: {}, contentStatus: { ['r'.repeat(64)]: { error: 'offline' } } });
  assert.match(failed, /Could not load: offline/);
});

test('uncertain effects are a warning, never inside a success-styled element', () => {
  const h = fix();
  const html = renderRunDetail(h, snap(h), { now: NOW });
  const block = /<div class="run-uncertain"[^>]*>[\s\S]*?<\/div>/.exec(html);
  assert.ok(block, 'uncertain block present');
  assert.match(block[0], /The worker could not confirm/);
  assert.match(block[0], /push may not have completed/);
  assert.doesNotMatch(html, /class="[^"]*\bgood\b[^"]*"[^>]*>(?:(?!<\/).)*push may not have completed/s);
  assert.match(html, /href="https:\/\/github\.com\/acme\/demo\/pull\/9"[^>]*rel="noopener noreferrer"/);
});

test('the checkout path is owner-only text with copy, never a link', () => {
  const h = fix();
  const html = renderRunDetail(h, snap(h), { now: NOW });
  assert.match(html, /<code>C:\\Users\\me\\wt\\run-1<\/code>/);
  assert.match(html, /data-copy="C:\\Users\\me\\wt\\run-1"/);
  assert.doesNotMatch(html, /href="[^"]*wt\\run-1/);
  const viewer = renderRunDetail(h, snap(h, { capabilities: { read: true } }), { now: NOW });
  assert.doesNotMatch(viewer, /wt\\run-1/);
});

test('actions follow state and capability', () => {
  const queued = fix({ state: 'queued', result_summary: null, result_ref: null, suggestions: [] });
  assert.match(renderRunDetail(queued, snap(queued), { now: NOW }), /data-action="cancel-handoff" data-handoff="run-1"/);
  const failed = fix({ state: 'failed', error: { message: 'tests failed' } });
  const html = renderRunDetail(failed, snap(failed), { now: NOW });
  assert.match(html, /data-action="run-agent" data-ticket="[^"]+" data-recipe="attempt-fix" data-retry-of="run-1">Retry as new run/);
  assert.match(html, /tests failed/);
  assert.match(renderRunDetail(fix(), snap(fix()), { now: NOW }), /data-action="accept-suggestion"/);
  const viewer = renderRunDetail(failed, snap(failed, { capabilities: { read: true } }), { now: NOW });
  assert.doesNotMatch(viewer, /cancel-handoff|data-action="run-agent"|accept-suggestion/);
});

test('an export omits stripped sections instead of rendering them empty', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const h = fix();
  const s = normalizeSnapshot(sanitizeSnapshot(snap(h), { exportedAt: NOW }));
  const html = renderRunDetail(s.handoffs[0], s, { now: NOW });
  assert.doesNotMatch(html, /<h3>Result<\/h3>|<h3>Where it is<\/h3>|<h3>Suggestions<\/h3>/, 'stripped result, path and suggestions leave no empty sections');
  assert.doesNotMatch(html, /src\/&lt;a&gt;\.js|cancel-handoff|accept-suggestion/, 'stripped changed files and owner controls are absent');
  assert.match(html, /Tests passed \(worker\)/);
});

test('a missing ticket and a missing run both render', () => {
  const h = fix({ ticket_id: 'gone' });
  assert.match(renderRunDetail(h, snap(h), { now: NOW }), /Ticket not in view/);
  const nf = renderRunNotFound('run-404');
  assert.match(nf, /Run not found/);
  assert.match(nf, /data-action="close-run"/);
});

test('a pr_url that is not http(s) is plain escaped text, never a link', () => {
  const h = fix({ pr_url: 'javascript:alert(1)' });
  const html = renderRunDetail(h, snap(h), { now: NOW });
  assert.doesNotMatch(html, /href="javascript/i);
  assert.match(html, /<code>javascript:alert\(1\)<\/code>/);
  assert.match(renderRunDetail(fix(), snap(fix()), { now: NOW }), /<a href="https:\/\/github\.com\/acme\/demo\/pull\/9"/);
});

test('a run that was already retried or followed by a later run offers no retry', () => {
  const failed = fix({ state: 'failed', error: { message: 'tests failed' } });
  const later = fix({ id: 'run-2', state: 'done', requested_at: '2026-10-10T11:00:00Z' });
  const s = normalizeSnapshot({ ...snapshot(), handoffs: [failed, later] });
  const html = renderRunDetail(s.handoffs.find((x) => x.id === 'run-1'), s, { now: NOW });
  assert.doesNotMatch(html, /data-action="run-agent"/);
  assert.match(html, /Superseded by a later run/);
});

// Spec §5.3, §5.4, §8: the run's own record (result blob) and what the worker recorded about it.
const XSS = '<img src=x onerror=alert(1)>';
const record = (extra = {}) => ({
  summary: 'Fixed',
  stage_reached: 'deployed',
  plan: ['Read the failing test', 'Patch the retry loop'],
  attempts: [
    { route: 'Jira issue', tool: 'mcp__jira__get_issue', target: 'PAY-1', outcome: 'worked', reason: '', evidence: 'PAY-1 says retries are capped', verified: 'seen' },
    { route: 'Scale the deployment', tool: 'kubectl', target: 'stg/payments', outcome: 'refused', reason: 'QUILL_CRITICAL_CHANGE scope=k8s.write target=stg: not granted for this run', evidence: '', verified: 'seen' },
    { route: 'Kibana error rate', tool: 'mcp__kibana__search', target: 'payments-*', outcome: 'unavailable', reason: 'server needs auth', evidence: '', verified: 'seen' },
    { route: 'Argo app status', tool: 'argocd', target: 'payments', outcome: 'worked', reason: '', evidence: 'Synced', verified: 'claimed-no-call' },
    { route: 'Refused: Bash git push', tool: 'Bash', target: 'git push', outcome: 'refused', reason: 'blocked by the Quill guard', evidence: 'recorded in the run ledger; the agent did not report it', verified: 'seen', added: true },
  ],
  verification: [
    { claim: 'Retry loop stops after 3', method: 'test', command: 'npm test -- retry', result: 'passed', detail: '12 passed' },
    { claim: 'Staging error rate fell', method: 'query', command: '', result: 'not-run', detail: 'Kibana unavailable' },
  ],
  critical_changes: [
    { title: 'Scale payments on staging', scope: 'k8s.write', target: 'stg', action: 'kubectl --context stg scale deploy/payments --replicas=3', why: 'Load', evidence: 'HPA maxed', verify: 'kubectl get deploy', rollback: 'scale back to 2', risk: 'low' },
    { title: 'Bump the prod quota', scope: 'cloud.write', target: 'prod', action: 'aws service-quotas request', why: 'Quota', evidence: '', verify: '', rollback: '', risk: 'high' },
  ],
  learnings: [{ scope: 'repo', section: 'build', kind: 'fact', text: 'raw learning text', evidence: [], derived_from: 'own-command' }],
  ...extra,
});
const autonomous = (extra = {}) => fix({ access: 'autonomous', state: 'done', recorded_stage: 'pushed', stage_reached: 'deployed', num_turns: 12, cost_usd: 1.2, cost_estimated: true, attempt_count: 5, learning_count: 1, critical_count: 2, critical_notes: [{ index: 1, reason: 'no matching scope configured' }], ...extra });
const NEW_SECTIONS = ['Plan', 'Attempts', 'Verification', 'Critical changes', 'Learnings filed', 'Tools used', 'Recorded stage', 'Turns &amp; cost'];
const heading = (name) => new RegExp(`<h3>${name}(?: \\(\\d+\\))?</h3>`);
const MEMORY = { entries: [
  { id: 'mem-1', scope: 'repo', repo_id: 'demo', section: 'build', text: 'npm test runs the suite', trust: 'verified', run_id: 'run-1' },
  { id: 'mem-2', scope: 'machine', section: 'tools', text: 'Kibana says rotation at 02:00', trust: 'quarantined', run_id: 'run-1' },
  { id: 'mem-3', scope: 'repo', repo_id: 'demo', section: 'build', text: 'from another run', trust: 'verified', run_id: 'run-other' },
], conflicts: [] };

test('the new sections are omitted when the run has none of their data', () => {
  const h = fix();
  const html = renderRunDetail(h, snap(h), { now: NOW });
  for (const name of NEW_SECTIONS) assert.doesNotMatch(html, heading(name), `${name} omitted`);
  const empty = renderRunDetail(h, snap(h), { now: NOW, record: { plan: [], attempts: [], verification: [], critical_changes: [], learnings: [] }, memory: { entries: [], conflicts: [] } });
  for (const name of NEW_SECTIONS) assert.doesNotMatch(empty, heading(name), `${name} omitted for empty lists`);
});

test('every section renders when its data is present', () => {
  const h = autonomous();
  const s = snap(h, { run_proposals: [] });
  s.tickets[0].run_notes = [{ run_id: 'run-1', at: '2026-10-10T10:05:00Z', attempts: [], lessons: [{ entry_id: 'mem-task', text: 'The retry test needs FAKE_CLOCK', trust: 'observed' }] }];
  const html = renderRunDetail(h, s, { now: NOW, record: record(), memory: MEMORY });
  for (const name of NEW_SECTIONS) assert.match(html, heading(name), `${name} present`);
  assert.match(html, /<ol class="run-plan[^"]*">\s*<li>Read the failing test<\/li>/);
  assert.match(html, /<h3>Learnings filed \(3\)<\/h3>/, 'two memory entries of this run and one task lesson');
  assert.doesNotMatch(html, /from another run/);
  assert.match(html, /data-trust="verified"[^>]*>Verified</);
  assert.match(html, /data-trust="quarantined"[^>]*>Quarantined</);
  assert.match(html, /data-trust="observed"[^>]*>Observed</);
});

test('cost under a subscription is an estimate; API billing shows the reported cost', () => {
  const h = autonomous();
  const html = renderRunDetail(h, snap(h), { now: NOW });
  assert.match(html, /12 turns · ≈ \$1\.20 \(estimated\)/);
  const billed = autonomous({ cost_estimated: false });
  const b = renderRunDetail(billed, snap(billed), { now: NOW });
  assert.match(b, /12 turns · \$1\.20</);
  assert.doesNotMatch(b, /estimated|≈/);
  const unknown = autonomous({ cost_usd: null, num_turns: null });
  assert.doesNotMatch(renderRunDetail(unknown, snap(unknown), { now: NOW }), heading('Turns &amp; cost'));
  const tiny = autonomous({ cost_usd: 0.0042, num_turns: 1 });
  assert.match(renderRunDetail(tiny, snap(tiny), { now: NOW }), /1 turn · ≈ \$0\.0042 \(estimated\)/);
});

test('the recorded stage is the worker\'s; a higher claim is the agent\'s and says it was not recorded', () => {
  const h = autonomous();
  const html = renderRunDetail(h, snap(h), { now: NOW });
  assert.match(html, /Recorded: pushed · agent reports: deployed \(not recorded\)/);
  const lower = autonomous({ recorded_stage: 'committed', stage_reached: 'changed' });
  const l = renderRunDetail(lower, snap(lower), { now: NOW });
  assert.match(l, /Recorded: committed · agent reports: changed</);
  assert.doesNotMatch(l, /not recorded/);
  const same = autonomous({ recorded_stage: 'pr_opened', stage_reached: 'pr_opened' });
  const sm = renderRunDetail(same, snap(same), { now: NOW });
  assert.match(sm, /Recorded: PR opened</);
  assert.doesNotMatch(sm, /agent reports/);
});

test('the worker\'s floor stage is not an observation: no "Recorded: investigated" (R51)', () => {
  const early = autonomous({ state: 'failed', recorded_stage: 'investigated', stage_reached: null, error: { message: 'spawn failed' } });
  const e = renderRunDetail(early, snap(early), { now: NOW });
  assert.doesNotMatch(e, /Recorded: investigated/);
  assert.doesNotMatch(e, heading('Recorded stage'), 'nothing recorded and nothing claimed: no section');
  const claimed = autonomous({ recorded_stage: 'investigated', stage_reached: 'deployed' });
  const c = renderRunDetail(claimed, snap(claimed), { now: NOW });
  assert.doesNotMatch(c, /Recorded:/);
  assert.match(c, /Agent reports: deployed \(not recorded\)/);
});

// R52 (spec §7): what a full-access run wrote in production, as its observer recorded it.
test('production writes of a full-access run: owner only, warning, escaped, omitted when absent', () => {
  const effects = [{ scope: 'k8s.write', target: 'stg', tool: 'Bash', t: '2026-10-10T10:03:00Z' }, { scope: 'http.write', target: null, tool: XSS, t: null, ambiguous: true }];
  const h = fix({ access: 'full', prod_effects: effects });
  const html = renderRunDetail(h, snap(h), { now: NOW });
  const sec = /<h3>Production writes \(full access\)<\/h3>[\s\S]*?<\/section>/.exec(html);
  assert.ok(sec, 'section present');
  assert.match(sec[0], /class="chip warning small"[^>]*>[\s\S]*?Production write allowed \(outcome not recorded\)<\/span>/);
  // M3 (design system §6): prod_effects are calls the observer allowed, not outcomes
  assert.doesNotMatch(sec[0], /Written in production/);
  assert.match(sec[0], /whether each one succeeded is not recorded/);
  assert.match(sec[0], /<code>Bash<\/code>[\s\S]*?k8s\.write:stg[\s\S]*?<time datetime="2026-10-10T10:03:00Z"/);
  assert.match(sec[0], /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>[\s\S]*?http\.write · target not pinned to one/);
  assert.doesNotMatch(sec[0], /<img/);
  assert.doesNotMatch(renderRunDetail(fix(), snap(fix()), { now: NOW }), /Production writes/);
  assert.doesNotMatch(renderRunDetail(h, snap(h, { capabilities: { read: true } }), { now: NOW }), /Production writes/, 'owner only');
});

test('an export of a full-access run has no production writes, and a scoped run keeps its scope count', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const full = fix({ access: 'full', prod_effects: [{ scope: 'k8s.write', target: 'stg', tool: 'Bash', t: null }] });
  const scoped = fix({ id: 'run-2', access: 'autonomous', scopes: ['jira.write', 'k8s.write:stg'] });
  const s = normalizeSnapshot(sanitizeSnapshot(normalizeSnapshot({ ...snapshot(), handoffs: [full, scoped] }), { exportedAt: NOW, includeCheckpoints: true, includeLinks: true }));
  assert.doesNotMatch(renderRunDetail(s.handoffs[0], s, { now: NOW }), /Production writes|k8s\.write/);
  const html = renderRunDetail(s.handoffs[1], s, { now: NOW });
  assert.match(html, /data-access="autonomous-scopes"[^>]*>Autonomous \+ scopes \(2\)<\/span>/);
  assert.doesNotMatch(html, /jira\.write|k8s\.write/, 'the count travels, never the names');
});

test('attempt outcomes use the honest labels and never success styling', () => {
  const h = autonomous();
  const html = renderRunDetail(h, snap(h), { now: NOW, record: record() });
  assert.match(html, />Refused \(no scope\)</);
  assert.match(html, />Unavailable \(needs auth\)</);
  assert.match(html, />Claimed, no tool call seen</);
  assert.match(html, />Refused</);
  assert.match(html, />Added from the run ledger</);
  const attempts = /<h3>Attempts[^<]*<\/h3>[\s\S]*?<\/section>/.exec(html)[0];
  assert.doesNotMatch(attempts, /class="chip[^"]*\bgood\b/, 'an agent-reported outcome is never green');
  assert.match(html, /<h3>Verification<\/h3>[\s\S]*?Not verified[\s\S]*?Kibana unavailable/);
  assert.doesNotMatch(/<h3>Verification<\/h3>[\s\S]*?<\/section>/.exec(html)[0], /class="chip[^"]*\bgood\b/, 'the agent\'s check is not the worker\'s');
});

test('tools used come from the attempts, checked against the ledger', () => {
  const h = autonomous();
  const html = renderRunDetail(h, snap(h), { now: NOW, record: record() });
  const tools = /<h3>Tools used<\/h3>[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(tools, /<code>mcp__jira__get_issue<\/code>/);
  assert.match(tools, /<code>argocd<\/code>[^]*?Claimed, no tool call seen/);
  assert.match(tools, /<code>kubectl<\/code>/);
});

test('critical changes show their proposal state, link to Needs you, and owner-only notes', () => {
  const h = autonomous();
  const child = { ...snapshot().tickets[1], id: 'child-1', key: 'LOCAL-crit-1', title: 'Scale payments on staging', local_only: true, tags: ['critical'], critical_spec: { from_handoff_id: 'run-1', index: 0 } };
  const s = normalizeSnapshot({ ...snapshot(), tickets: [...snapshot().tickets, child], handoffs: [h], run_proposals: [{ id: 'p-crit', origin: 'run', from_handoff_id: 'run-1', ticket_id: 'child-1', state: 'proposed', proposed_at: '2026-10-10T11:00:00Z', recipe: { name: 'critical-change' }, scopes: [{ name: 'k8s.write', target: 'stg' }] }] });
  const html = renderRunDetail(h, s, { now: NOW, record: record() });
  const crit = /<h3>Critical changes \(2\)<\/h3>[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(crit, /Scale payments on staging/);
  assert.match(crit, /<code[^>]*>kubectl --context stg scale deploy\/payments --replicas=3<\/code>/);
  assert.match(crit, /Proposed as/);
  assert.match(crit, /data-action="open-needs-you"/);
  assert.doesNotMatch(crit, /data-action="approve-run"/, 'approval stays in Needs you');
  assert.match(crit, /Not proposed: no matching scope configured/);
  const viewer = renderRunDetail(h, snap(h, { capabilities: { read: true } }), { now: NOW, record: record() });
  assert.doesNotMatch(viewer, /no matching scope configured|open-needs-you/);
  const approved = normalizeSnapshot({ ...s, run_proposals: [{ ...s.run_proposals[0], state: 'approved', handoff_id: 'run-9' }] });
  assert.match(renderRunDetail(h, approved, { now: NOW, record: record() }), /Approved; queued as a run on/);
});

test('every record field is escaped', () => {
  const h = autonomous({ recorded_stage: XSS, stage_reached: XSS, critical_notes: [{ index: 0, reason: XSS }] });
  const evil = record({
    plan: [XSS],
    attempts: [{ route: XSS, tool: XSS, target: XSS, outcome: XSS, reason: XSS, evidence: XSS, verified: XSS }],
    verification: [{ claim: XSS, method: XSS, command: XSS, result: XSS, detail: XSS }],
    critical_changes: [{ title: XSS, scope: XSS, target: XSS, action: XSS, why: XSS, evidence: XSS, verify: XSS, rollback: XSS, risk: XSS }],
  });
  const s = snap(h);
  s.tickets[0].run_notes = [{ run_id: 'run-1', attempts: [], lessons: [{ entry_id: null, text: XSS, trust: XSS }] }];
  const html = renderRunDetail(h, s, { now: NOW, record: evil, memory: { entries: [{ id: XSS, scope: XSS, text: XSS, trust: XSS, run_id: 'run-1' }], conflicts: [] } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the run record loads, fails visibly with Retry, and parses only a JSON object', () => {
  const h = autonomous();
  assert.match(renderRunDetail(h, snap(h), { now: NOW, recordStatus: 'loading' }), /aria-busy="true"[^>]*>[^<]*Loading the run's plan, attempts and checks/);
  const failed = renderRunDetail(h, snap(h), { now: NOW, recordStatus: { error: 'offline <b>' } });
  assert.match(failed, /role="alert">Could not load the run's plan, attempts and checks: offline &lt;b&gt;/);
  assert.match(failed, /data-action="load-run-record" data-hash="r{64}"/);
  assert.deepEqual(parseRunRecord('{"plan":["a"]}'), { plan: ['a'] });
  assert.equal(parseRunRecord('[1]'), null);
  assert.equal(parseRunRecord('not json'), null);
  assert.equal(parseRunRecord(null), null);
});

test('an export shows none of the record sections, only the recorded stage it keeps', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const h = autonomous();
  const base = snap(h);
  base.tickets[0].run_notes = [{ run_id: 'run-1', attempts: [{ route: 'r', outcome: 'worked' }], lessons: [{ text: 'lesson', trust: 'verified' }] }];
  const s = normalizeSnapshot(sanitizeSnapshot(base, { exportedAt: NOW, includeCheckpoints: true, includeLinks: true }));
  const html = renderRunDetail(s.handoffs[0], s, { now: NOW });
  for (const name of NEW_SECTIONS.filter((n) => n !== 'Recorded stage')) assert.doesNotMatch(html, heading(name), `${name} omitted in an export`);
  assert.match(html, /Recorded: pushed</);
  assert.doesNotMatch(html, /agent reports|no matching scope configured|load-run-record/);
  assert.match(html, /<span class="chip small" data-access="autonomous">Autonomous<\/span>/, 'a run without scopes exports as Autonomous');
  const { renderDetail } = await import('../../ui/views/detail.js');
  const ticketHtml = renderDetail(s.tickets[0], s, { now: NOW, tab: 'runs' });
  assert.doesNotMatch(ticketHtml, /Run notes|lesson/, 'an export has no Run notes');
});

// Planned files (ADR 0037): drift is an amber count in words, never success, never a refusal.
test('writes outside the planned files are an amber chip in the header; the planned list is owner-only text', () => {
  const h = fix({ access: 'autonomous', scope_drift: 3, planned_paths: ['src/<core>/**', 'README.md'] });
  const html = renderRunDetail(h, snap(h), { now: NOW });
  const chip = /<span class="chip warning small"[^>]*>(?:<svg[\s\S]*?<\/svg>)?[^<]*writes outside planned files<\/span>/.exec(html);
  assert.ok(chip, 'amber chip present');
  assert.match(chip[0], /3 writes outside planned files/);
  assert.match(chip[0], /title="[^"]*recorded, not blocked[^"]*"/);
  assert.match(html, /Planned files: <code>src\/&lt;core&gt;\/\*\*<\/code> <code>README\.md<\/code>/);
  const one = fix({ access: 'autonomous', scope_drift: 1, planned_paths: ['src/a.js'] });
  assert.match(renderRunDetail(one, snap(one), { now: NOW }), />1 write outside planned files</);
  for (const v of [0, null, undefined, '3', -1]) {
    const x = fix({ scope_drift: v, planned_paths: ['src/a.js'] });
    assert.doesNotMatch(renderRunDetail(x, snap(x), { now: NOW }), /outside planned files/, String(v));
  }
  const exported = fix({ access: 'autonomous', scope_drift: 2 });
  const viewer = renderRunDetail(exported, snap(exported, { capabilities: { read: true } }), { now: NOW });
  assert.match(viewer, /2 writes outside planned files/, 'an export shows the count');
  assert.doesNotMatch(viewer, /Planned files:/, 'and no paths');
});
