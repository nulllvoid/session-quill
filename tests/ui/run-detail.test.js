// Run detail (spec §3): evidence, actions and what an export may show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../ui/components.js';
import { renderRunDetail, renderRunNotFound } from '../../ui/views/run-detail.js';
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
