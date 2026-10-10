import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHeader } from '../../ui/views/header.js';
import { renderAgentsSection } from '../../ui/views/agents.js';
import { formatDuration } from '../../ui/components.js';
import { snapshot, ticket } from './fixtures.js';

const NOW = '2026-10-02T12:30:00Z';

test('the top-bar endpoint has a copy button for the dashboard address (ADR 0022)', () => {
  const html = renderHeader(snapshot(), { now: NOW, online: true, refresh: null, theme: 'dark', endpoint: '127.0.0.1:47321' });
  assert.match(html, /<button type="button" class="btn small ghost icon-only endpoint-copy" data-copy="http:\/\/127\.0\.0\.1:47321\/" data-copy-label="the dashboard address" aria-label="Copy the dashboard address"/);
  const snap = renderHeader(snapshot({ meta: { ...snapshot().meta, exported_at: '2026-10-02T12:00:00Z' } }), { now: NOW, online: true, refresh: null, theme: 'dark' });
  assert.doesNotMatch(snap, /endpoint-copy/, 'a read-only snapshot has no address to copy');
});

test('the worker health item says when the worker starts at login, and keeps "Worker: connected"', () => {
  const s = snapshot();
  const off = renderHeader(s, { now: NOW, online: true, refresh: null, theme: 'dark' });
  assert.match(off, /Worker: connected/);
  assert.doesNotMatch(off, /Starts at login/);
  const on = renderHeader(snapshot({ meta: { ...s.meta, worker_autostart: true } }), { now: NOW, online: true, refresh: null, theme: 'dark' });
  assert.match(on, /Worker: connected/);
  assert.match(on, /<details class="health-item health-pop" data-connection="online">/);
  assert.match(on, /Starts at login/);
});

test('durations read as people say them', () => {
  assert.deepEqual([0, 450, 1234, 12_400, 65_000, 3_600_000].map(formatDuration), ['0 ms', '450 ms', '1.2 s', '12 s', '1 min 5 s', '60 min']);
});

test('each run shows how long it queued, set up and ran, and only what was measured', () => {
  const t = ticket(1, { handoff_ids: ['h1', 'h2', 'h3'] });
  const handoffs = [
    { id: 'h1', ticket_id: t.id, state: 'done', mode: 'attempt-fix', requested_at: '2026-10-02T12:00:00Z', timings: { queue_wait_ms: 2000, worktree_ms: 850, agent_ms: 95_000 } },
    { id: 'h2', ticket_id: t.id, state: 'done', mode: 'analyse', requested_at: '2026-10-02T12:00:00Z', timings: { queue_wait_ms: 0, agent_ms: 30_000 } },
    { id: 'h3', ticket_id: t.id, state: 'done', mode: 'analyse', requested_at: '2026-10-02T12:00:00Z' },
  ];
  const html = renderAgentsSection(t, snapshot({ tickets: [t], handoffs }), { now: NOW });
  assert.match(html, /<p class="run-timings small muted">Queue wait 2.0 s · Setup 850 ms · Agent 1 min 35 s<\/p>/);
  assert.match(html, /<p class="run-timings small muted">Queue wait 0 ms · Agent 30 s<\/p>/);
  assert.equal((html.match(/run-timings/g) ?? []).length, 2, 'a run without timings shows none');
});
