import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRecipeRunDialog } from '../../ui/views/agents.js';
import { renderRunDetail } from '../../ui/views/run-detail.js';
import { renderHandoffForm } from '../../ui/views/handoff-form.js';
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

test('the handoff form names the test command, or says fixes are not test-verified', () => {
  const t = ticket(1);
  const withCmd = renderHandoffForm(t, snapshot({ tickets: [t], repos: [{ ...REPO, test_command: 'npm test' }] }));
  assert.match(withCmd, /Fixes are checked with <code>npm test<\/code>, run by the worker/);
  const without = renderHandoffForm(t, snapshot({ tickets: [t], repos: [REPO] }));
  assert.match(without, /No test command: fixes are not test-verified/);
  const recipe = { name: 'attempt-fix', source: 'builtin', mode: 'attempt-fix', description: 'Fix it', permissions: { read_source: true, edit_source: true }, timeout_min: 20, outputs: [], legacy: true };
  assert.match(renderRecipeRunDialog(recipe, t, snapshot({ tickets: [t], repos: [REPO] })), /No test command: fixes are not test-verified/);
  const analyse = { ...recipe, name: 'analyse', mode: 'analyse', permissions: { read_source: true } };
  assert.doesNotMatch(renderRecipeRunDialog(analyse, t, snapshot({ tickets: [t], repos: [REPO] })), /test-verified/, 'only fixes are gated');
});

test('an export keeps the gate result but never the test output or command', () => {
  const t = ticket(1, { handoff_ids: ['h1'] });
  const snap = snapshot({ tickets: [t], handoffs: [{ id: 'h1', ticket_id: t.id, state: 'done', mode: 'attempt-fix', requested_at: NOW, test_gate: { status: 'passed', command: 'API_KEY=x npm test', exit_code: 0, ms: 10, tail: '/home/me/secret', attempts: 1, repaired: false } }] });
  const out = sanitizeSnapshot(snap, { fields: ['key', 'title'] });
  assert.deepEqual(out.handoffs[0].test_gate, { status: 'passed', exit_code: 0, ms: 10, attempts: 1, repaired: false });
});
