import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffChip, normalizeSnapshot } from '../../ui/components.js';
import { runRow } from '../../ui/views/runs.js';
import { renderRunDetail } from '../../ui/views/run-detail.js';
import { renderDetail } from '../../ui/views/detail.js';
import { snapshot, TID } from './fixtures.js';

const NOW = '2026-10-10T12:00:00Z';
const fix = (extra = {}) => ({ id: 'run-fix', ticket_id: TID(1), mode: 'attempt-fix', state: 'done', permissions: { edit_source: true }, requested_at: NOW, changed_files: [], ...extra });
const labels = { 'no-changes': 'No changes', 'changed-unverified': 'Changes not test-verified', 'tests-passed': 'Changes tested', unknown: 'Outcome not verified' };

test('finished source-edit runs show recorded outcomes in cards, detail, and accessible names', () => {
  for (const [fix_outcome, label] of Object.entries(labels)) {
    const h = fix({ fix_outcome });
    const s = normalizeSnapshot({ ...snapshot(), handoffs: [h] });
    const row = runRow(s, h, { now: NOW, tz: 'UTC' });
    assert.ok(row.includes(`>${label}</span>`), row);
    assert.match(row, new RegExp(`aria-label="[^"]*${label}`));
    assert.ok(renderRunDetail(h, s, { now: NOW }).includes(`>${label}</span>`));
    const detail = renderDetail(s.tickets[0], s, { now: NOW });
    assert.match(detail, new RegExp(`aria-label="Open run: [^"]*${label}`));
    assert.match(handoffChip(h), new RegExp(`data-fix-outcome="${fix_outcome}"`));
  }
});

test('historical runs infer only recorded changes and worker test results', () => {
  assert.match(handoffChip(fix()), />Outcome not verified</);
  assert.match(handoffChip(fix({ test_gate: { status: 'passed' }, commit_sha: 'abc' })), />Outcome not verified</);
  assert.match(handoffChip(fix({ changed_files: ['a.js'], test_results: ['Tests passed (agent)'] })), />Changes not test-verified</);
  assert.match(handoffChip(fix({ changed_files: ['a.js'], test_gate: { status: 'passed' } })), />Changes tested</);
  assert.match(handoffChip(fix({ fix_outcome: 'unknown', changed_files: ['a.js'], test_gate: { status: 'passed' } })), />Outcome not verified</);
});

test('other lifecycle states and read-only runs retain their existing labels', () => {
  assert.match(handoffChip(fix({ permissions: { edit_source: false } })), />Done</);
  for (const [state, label] of [['queued', 'Queued'], ['running', 'Running'], ['failed', 'Failed'], ['cancelled', 'Cancelled']]) {
    const html = handoffChip(fix({ state, fix_outcome: 'tests-passed' }));
    assert.ok(html.includes(`>${label}</span>`));
    assert.doesNotMatch(html, /data-fix-outcome/);
  }
});

test('sanitized exports do not recover stripped outcome evidence', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const h = fix({ fix_outcome: 'tests-passed', changed_files: ['private-file.js'], test_gate: { status: 'passed' } });
  const s = normalizeSnapshot(sanitizeSnapshot({ ...snapshot(), handoffs: [h] }, { exportedAt: NOW }));
  assert.equal(s.handoffs[0].fix_outcome, undefined);
  const html = renderRunDetail(s.handoffs[0], s, { now: NOW });
  assert.match(html, />Outcome not verified</);
  assert.doesNotMatch(html, /private-file\.js|>Changes tested</);
});
