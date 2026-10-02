import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, relativeTime, formatAbsolute } from '../../ui/lib/time.js';
import { esc, statusChip, scoreBadge, ticketCard } from '../../ui/components.js';
import { renderPickNext } from '../../ui/views/picknext.js';
import { renderBoard } from '../../ui/views/board.js';
import { renderTree } from '../../ui/views/tree.js';
import { renderSessions } from '../../ui/views/sessions.js';
import { renderDeployments } from '../../ui/views/deployments.js';
import { renderDetail } from '../../ui/views/detail.js';
import { renderHandoffForm } from '../../ui/views/handoff-form.js';
import { renderHeader } from '../../ui/views/header.js';
import { snapshot, TID } from './fixtures.js';

const NOW = '2026-10-02T12:00:00Z';
const noFilters = { project: '', category: '', tag: '', repo: '', machine: '', stale: false, q: '' };

test('freshness boundaries: never-synced, fresh < 2 h, ageing 2–6 h, stale > 6 h', () => {
  assert.equal(freshness({ last_sync: null }, NOW), 'never-synced');
  assert.equal(freshness({ last_sync: '2026-10-02T10:00:01Z' }, NOW), 'fresh');
  assert.equal(freshness({ last_sync: '2026-10-02T10:00:00Z' }, NOW), 'ageing');
  assert.equal(freshness({ last_sync: '2026-10-02T06:00:00Z' }, NOW), 'ageing');
  assert.equal(freshness({ last_sync: '2026-10-02T05:59:59Z' }, NOW), 'stale');
  assert.equal(relativeTime('2026-10-02T11:58:00Z', NOW), '2 min ago');
  assert.equal(relativeTime('2026-09-27T12:00:00Z', NOW), '5 days ago');
  assert.match(formatAbsolute('2026-10-02T11:58:00Z', 'UTC'), /2026-10-02/);
});

test('esc neutralizes HTML and chips carry text labels', () => {
  assert.equal(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  const chip = statusChip('deploy-pending', {});
  assert.match(chip, /Deploy pending/);
  assert.match(chip, /data-status="deploy-pending"/);
  assert.match(statusChip('active', { stale: true, staleAge: '12 days' }), /Stale · 12 days/);
});

test('renderPickNext shows reasons, raw-score explanation for capped scores, limitations and the blocked list', () => {
  const html = renderPickNext(snapshot(), noFilters, { now: NOW });
  assert.match(html, /Write the plan/);
  assert.match(html, /Priority P1: \+25/);
  assert.match(html, /raw 115/i, 'explains that the raw score exceeds the displayed cap');
  assert.match(html, /provider evidence unavailable/);
  assert.match(html, /Waiting on infra/);
  assert.match(html, /2 candidates/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('renderPickNext empty states', () => {
  const s = snapshot({ picknext: [], blocked: [] });
  const html = renderPickNext(s, noFilters, { now: NOW });
  assert.match(html, /No eligible work/);
  assert.match(html, /session-quill:ticket create/);
  const allBlocked = snapshot({ picknext: [], blocked: [{ ticket_id: TID(3), blocker: 'x' }] });
  assert.match(renderPickNext(allBlocked, noFilters, { now: NOW }), /Everything eligible is blocked/);
});

test('renderBoard groups six statuses in order, collapses done, shows counts, stale badge and escapes titles', () => {
  const html = renderBoard(snapshot(), noFilters, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} });
  const order = ['todo', 'active', 'review', 'deploy-pending', 'blocked', 'done'].map((s) => html.indexOf(`data-column="${s}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /data-column="done"[^>]*data-collapsed="true"/);
  assert.match(html, /<span class="count" aria-label="1 ticket">1<\/span>/);
  assert.match(html, /Stale · /);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
});

test('renderBoard pages columns beyond 40 cards and reports zero filter results', () => {
  const s = snapshot();
  for (let i = 10; i < 60; i += 1) s.tickets.push({ ...s.tickets[0], id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, key: `LOCAL-many-${i}`, title: `Many ${i}` });
  const html = renderBoard(s, noFilters, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} });
  assert.match(html, /Show 11 more/);
  const none = renderBoard(s, { ...noFilters, q: 'zzzz-no-match' }, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} });
  assert.match(none, /No tickets match the current filters/);
});

test('renderTree indents three levels, drills deeper via View children, and flags orphans', () => {
  const s = snapshot();
  const deep = (n, parent) => ({ ...s.tickets[0], id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, key: `LOCAL-deep-${n}`, title: `Deep ${n}`, parent_id: parent, children_ids: [] });
  s.tickets.push(deep(21, TID(7)), deep(22, '00000021-0000-4000-8000-000000000000'), deep(23, '00000022-0000-4000-8000-000000000000'));
  s.tickets.push({ ...s.tickets[0], id: '00000099-0000-4000-8000-000000000000', key: 'LOCAL-orphan', title: 'Orphan', parent_id: 'ffffffff-0000-4000-8000-000000000000', validation_issues: ['parent-missing'] });
  const html = renderTree(s, noFilters, { root: null });
  assert.match(html, /Deep 21/);
  assert.match(html, /Deep 22/);
  assert.match(html, /View children/);
  assert.equal(html.includes('Deep 23'), false, 'depth > 3 is reachable only through drill-down');
  assert.match(html, /Unresolved parent link/);
  const drilled = renderTree(s, noFilters, { root: '00000022-0000-4000-8000-000000000000' });
  assert.match(drilled, /Deep 23/);
  assert.match(drilled, /breadcrumb/);
});

test('renderSessions shows state, binding, machine, writes, coverage, unpromoted and gate-off indicators and paginates 200 rows', () => {
  const s = snapshot();
  for (let i = 0; i < 199; i += 1) s.sessions.push({ ...s.sessions[0], id: `sess-${i + 2}`, host_session_id: `host-${i + 2}`, state: 'idle', unpromoted: false, gate_enabled: true });
  const html = renderSessions(s, noFilters, { now: NOW, page: 0 });
  assert.match(html, /200 sessions/);
  assert.match(html, /Unpromoted checkpoint/);
  assert.match(html, /Gate off/);
  assert.match(html, /laptop/);
  assert.match(html, /Live/);
  assert.match(html, /Page 1 of 4/);
});

test('renderDeployments lists obligations oldest first with evidence dates and a journey strip; empty state', () => {
  const html = renderDeployments(snapshot(), noFilters, { now: NOW });
  assert.match(html, /production/);
  assert.match(html, /2026-09-29/);
  assert.match(html, /journey/);
  assert.match(renderDeployments(snapshot({ deployments_outstanding: [] }), noFilters, { now: NOW }), /Nothing awaiting deployment/);
});

test('renderDetail shows summary, status, next action, timeline, plans, PRs, handoffs and Capture incomplete; no buttons when read-only', () => {
  const s = snapshot();
  const t = s.tickets[1];
  t.timeline = [{ id: 'tl', at: '2026-10-02T11:00:00Z', kind: 'write', text: 'Edit src/a.js', event_id: 'e', content_ref: null, coverage: 'complete' }];
  const html = renderDetail(t, s, { now: NOW, pending: [], content: {} });
  assert.match(html, /Edit src\/a\.js/);
  assert.match(html, /Capture incomplete/);
  assert.match(html, /<button/);
  const ro = renderDetail(t, { ...s, capabilities: { read: true, edit_tickets: false, handoff: false, refresh: false, cancel_requests: false, export: false } }, { now: NOW, pending: [], content: {} });
  for (const action of ['handoff', 'status-select', 'record-deployment', 'cancel-request', 'cancel-handoff', 'resubmit-request']) assert.equal(ro.includes(`data-action="${action}"`), false, `no ${action} control when read-only`);
  assert.equal(ro.includes('<form'), false, 'no edit forms when read-only');
  assert.match(ro, /Read-only/);
});

test('renderDetail surfaces pending, conflict and failed request states for the ticket', () => {
  const s = snapshot();
  const t = s.tickets[0];
  const pending = [{ id: 'r1', kind: 'set-next-action', target_id: t.id, state: 'pending', not_before: '2026-10-02T12:00:08Z', payload: { next_action: 'Pending value' } }, { id: 'r2', kind: 'set-status', target_id: t.id, state: 'conflict', error: { code: 'revision-conflict', current_revision: 3 }, result: { current: { status: 'active' } }, payload: { status: 'review' } }, { id: 'r3', kind: 'set-next-action', target_id: t.id, state: 'failed', error: { code: 'x', message: 'disk full', retryable: true }, payload: { next_action: 'z' } }];
  const html = renderDetail(t, s, { now: NOW, pending, content: {} });
  assert.match(html, /Pending value/);
  assert.match(html, /Undo/);
  assert.match(html, /Conflict/);
  assert.match(html, /disk full/);
  assert.match(html, /Retry/);
});

test('renderHandoffForm defaults to analyse-followups with source off and shows permission dependencies', () => {
  const s = snapshot();
  const html = renderHandoffForm(s.tickets[0], s, {});
  assert.match(html, /value="analyse-followups"[^>]*checked/);
  assert.match(html, /name="read_source"(?![^>]*checked)/);
  assert.match(html, /requires push branch/i);
  assert.match(html, /maxlength="280"/);
});

test('every view renders a field-restricted sanitized export without throwing', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const s = sanitizeSnapshot(snapshot(), { exportedAt: NOW, fields: ['key', 'title', 'status'] });
  const t = s.tickets[0];
  assert.equal(t.tags, undefined, 'fixture really omits tags');
  const outputs = [
    renderPickNext(s, noFilters, { now: NOW }),
    renderBoard(s, noFilters, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} }),
    renderBoard(s, { ...noFilters, q: 'ticket' }, { now: NOW, layout: 'list', expanded: new Set(), pages: {} }),
    renderTree(s, noFilters, { root: null }),
    renderSessions(s, noFilters, { now: NOW, page: 0 }),
    renderDeployments(s, noFilters, { now: NOW }),
    renderDetail(t, s, { now: NOW, pending: [], content: {} }),
    renderHeader(s, { now: NOW, online: false, refresh: null, theme: 'dark' }),
  ];
  for (const html of outputs) assert.ok(html.length > 50);
  assert.match(outputs[6], /Read-only/);
});

test('renderHeader exposes freshness, worker, capture, provider error, receipt and refresh states; sidebar lists five views with shortcuts', async () => {
  const s = snapshot();
  const html = renderHeader(s, { now: NOW, online: true, refresh: null, theme: 'light', endpoint: '127.0.0.1:4321', receipt: { text: 'next action applied', tone: 'good' } });
  assert.match(html, /Ageing/);
  assert.match(html, /gh: auth required/);
  assert.match(html, /Refresh/);
  assert.match(html, /127\.0\.0\.1:4321/);
  assert.match(html, /Receipt: next action applied/);
  const offline = renderHeader(s, { now: NOW, online: false, refresh: null, theme: 'dark' });
  assert.match(offline, /Offline/);
  assert.match(offline, /disabled/);
  const never = renderHeader(snapshot({ meta: { ...s.meta, last_sync: null } }), { now: NOW, online: true, refresh: null, theme: 'light' });
  assert.match(never, /Never synced/);
  const { renderSidebar } = await import('../../ui/views/header.js');
  const side = renderSidebar(s, { view: 'board', endpoint: '127.0.0.1:4321' });
  for (const v of ['picknext', 'board', 'tree', 'sessions', 'deployments']) assert.match(side, new RegExp(`data-view="${v}"`));
  assert.match(side, /aria-keyshortcuts="2"/);
  assert.match(side, /aria-selected="true"[^>]*aria-controls="main" aria-keyshortcuts="2"/);
  const score = scoreBadge({ score: 100, raw_score: 115, reasons: [] });
  assert.match(score, /100/);
  const card = ticketCard(s.tickets[0], s, { variant: 'board', now: NOW });
  assert.match(card, /tabindex="0"/);
});
