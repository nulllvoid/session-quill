import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunAgentDialog } from '../../ui/views/run-dialog.js';
import { renderRunDetail } from '../../ui/views/run-detail.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';
import { snapshot, ticket } from './fixtures.js';

const NOW = '2026-10-02T12:30:00Z';
const REPO = { id: 'demo', project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] };

test('runs show the worker test gate: passed is good, failed is critical with its recorded output, self-checked stays neutral', () => {
  const t = ticket(1, { handoff_ids: ['h1', 'h2', 'h3', 'h4'] });
  const handoffs = [
    { id: 'h1', ticket_id: t.id, state: 'done', mode: 'attempt-fix', requested_at: NOW, result_quality: { problems: [], repaired: false, self_checked: true }, test_gate: { status: 'passed', command: 'npm test', exit_code: 0, ms: 12_400, tail: 'ok 3 tests', attempts: 1, repaired: false }, timings: { queue_wait_ms: 0, worktree_ms: 900, agent_ms: 30_000, test_ms: 12_400 } },
    { id: 'h2', ticket_id: t.id, state: 'failed', mode: 'attempt-fix', requested_at: NOW, error: { code: 'tests-failed', message: 'the test command exited with code 1 again after one repair turn; no fix is suggested' }, test_gate: { status: 'failed', command: 'npm test', exit_code: 1, ms: 800, tail: 'not ok 2 - <expected> 3', attempts: 2, repaired: false } },
    { id: 'h3', ticket_id: t.id, state: 'failed', mode: 'attempt-fix', requested_at: NOW, test_gate: { status: 'timeout', command: 'npm test', exit_code: null, ms: 600_000, tail: '', attempts: 2, repaired: false } },
    { id: 'h4', ticket_id: t.id, state: 'done', mode: 'attempt-fix', requested_at: NOW, test_gate: { status: 'skipped', reason: 'no test_command for this repository; the fix is not test-verified' } },
  ];
  const snap = snapshot({ tickets: [t], handoffs });
  const html = handoffs.map((h) => renderRunDetail(h, snap, { now: NOW })).join('');
  assert.match(html, /<span class="chip good small" title="[^"]*npm test[^"]*">Tests passed \(worker\)<\/span>/);
  assert.match(html, /<details class="test-output small"><summary><span class="chip critical small">Tests failed<\/span><\/summary>/);
  assert.match(html, /<pre class="preview">not ok 2 - &lt;expected&gt; 3<\/pre>/, 'the recorded output, escaped');
  assert.match(html, /<span class="chip critical small">Tests timed out<\/span>/);
  assert.match(html, /<span class="chip small" title="[^"]*">Not test-verified<\/span>/);
  assert.match(html, /<span class="chip small" title="[^"]*">Self-checked<\/span>/, 'self-check stays neutral');
  assert.match(html, /Queue wait 0 ms · Setup 900 ms · Agent 30 s · Tests 12 s/);
});

const RECIPES = [
  { name: 'attempt-fix', source: 'builtin', mode: 'attempt-fix', description: 'Fix it', permissions: { read_source: true, edit_source: true }, timeout_min: 20, legacy: true, repo_id: null },
  { name: 'analyse', source: 'builtin', mode: 'analyse', description: 'Look', permissions: { read_source: true }, timeout_min: 20, legacy: true, repo_id: null },
];

test('the run dialog names the test command, or says fixes are not test-verified', () => {
  const t = ticket(1);
  const withCmd = renderRunAgentDialog(t, snapshot({ tickets: [t], repos: [{ ...REPO, test_command: 'npm test' }], recipes: RECIPES }), { recipe: 'attempt-fix' });
  assert.match(withCmd, /tests: npm test run by the worker/);
  const without = renderRunAgentDialog(t, snapshot({ tickets: [t], repos: [REPO], recipes: RECIPES }), { recipe: 'attempt-fix' });
  assert.match(without, /Not test-verified/);
  assert.match(without, /not test-verified \(no test command\)/);
  assert.doesNotMatch(renderRunAgentDialog(t, snapshot({ tickets: [t], repos: [REPO], recipes: RECIPES }), { recipe: 'analyse' }), /test-verified/, 'only fixes are gated');
});

test('an export keeps the gate result but never the test output or command', () => {
  const t = ticket(1, { handoff_ids: ['h1'] });
  const snap = snapshot({ tickets: [t], handoffs: [{ id: 'h1', ticket_id: t.id, state: 'done', mode: 'attempt-fix', requested_at: NOW, test_gate: { status: 'passed', command: 'API_KEY=x npm test', exit_code: 0, ms: 10, tail: '/home/me/secret', attempts: 1, repaired: false } }] });
  const out = sanitizeSnapshot(snap, { fields: ['key', 'title'] });
  assert.deepEqual(out.handoffs[0].test_gate, { status: 'passed', exit_code: 0, ms: 10, attempts: 1, repaired: false });
});

test('verification errors report unavailable verification with a reason, never failed tests', async () => {
  const { testGateChip, testGateBadge } = await import('../../ui/views/agents.js');
  const gate = { status: 'error', reason: 'Could not inspect <checkout>; tests did not run' };
  for (const html of [testGateChip(gate), testGateBadge(gate)]) {
    assert.match(html, />Verification unavailable</);
    assert.match(html, /Could not inspect &lt;checkout&gt;; tests did not run/);
    assert.doesNotMatch(html, /Tests failed|Tests passed|class="chip good/);
  }
  assert.match(testGateChip({ status: 'error' }), /The worker could not verify the run/);
  const t = ticket(1);
  const h = { id: 'h-error', ticket_id: t.id, state: 'failed', mode: 'attempt-fix', requested_at: NOW, test_gate: gate };
  assert.match(renderRunDetail(h, snapshot({ tickets: [t], handoffs: [h] }), { now: NOW }), />Verification unavailable</);
});
