import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, relativeTime, formatAbsolute } from '../../ui/lib/time.js';
import { esc, statusChip, scoreBadge, ticketCard, ticketKey, externalChip } from '../../ui/components.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';
import { renderPickNext, renderInbox } from '../../ui/views/picknext.js';
import { renderAttachDialog, renderLinkExternalDialog, renderSchedulesDialog } from '../../ui/views/dialogs.js';
import { renderBoard } from '../../ui/views/board.js';
import { renderTree } from '../../ui/views/tree.js';
import { renderSessions } from '../../ui/views/sessions.js';
import { renderDeployments } from '../../ui/views/deployments.js';
import { renderDetail } from '../../ui/views/detail.js';
import { renderHandoffForm } from '../../ui/views/handoff-form.js';
import { renderHeader } from '../../ui/views/header.js';
import { snapshot, TID, ticket } from './fixtures.js';

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

test('external key chips open the tracker in a new tab and copy the key; only https links render', () => {
  const linked = ticket(20, { key: 'PMLA-12', external: { system: 'jira', key: 'PMLA-12', url: 'https://example.atlassian.net/browse/PMLA-12', validation: 'pending', validated_at: null, error: null } });
  const html = ticketKey(linked);
  assert.match(html, /<a class="key key-link" href="https:\/\/example\.atlassian\.net\/browse\/PMLA-12" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /data-copy="PMLA-12"/);
  assert.match(html, /aria-label="Copy PMLA-12"/);
  const hostile = ticket(21, { key: 'PMLA-13', external: { system: 'jira', key: 'PMLA-13', url: 'javascript:alert(1)', validation: 'pending' } });
  assert.doesNotMatch(ticketKey(hostile), /<a /);
  assert.doesNotMatch(externalChip(hostile), /href/);
  assert.match(ticketKey(ticket(22)), /<code class="key"/, 'local keys stay plain copyable labels');
  const legacy = ticket(23, { key: 'OPS-4', jira: { key: 'OPS-4', url: 'https://example.atlassian.net/browse/OPS-4', validation: 'valid' } });
  assert.match(ticketKey(legacy), /key-link/);
  assert.match(externalChip(linked), /Jira PMLA-12 · pending/);
});

test('cards and the detail header use key chips; local keys offer Link to external only to the owner', () => {
  const snap = snapshot();
  snap.tickets.push(ticket(24, { key: 'PMLA-24', status: 'active', external: { system: 'linear', key: 'PMLA-24', url: 'https://linear.app/acme/issue/PMLA-24', validation: 'pending' } }));
  assert.match(renderBoard(snap, noFilters, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} }), /href="https:\/\/linear\.app\/acme\/issue\/PMLA-24"/);
  const local = renderDetail(snap.tickets[0], snap, { now: NOW });
  assert.match(local, /data-action="link-external" data-ticket="[^"]+"/);
  const linked = renderDetail(snap.tickets.at(-1), snap, { now: NOW });
  assert.doesNotMatch(linked, /data-action="link-external"/);
  assert.match(linked, /Linear PMLA-24/);
  const readOnly = { ...snapshot(), capabilities: { read: true } };
  assert.doesNotMatch(renderDetail(readOnly.tickets[0], readOnly, { now: NOW }), /data-action="link-external"/);
});

test('exports strip external links by default and keep them only when links are included', () => {
  const snap = snapshot();
  snap.tickets[0].external = { system: 'jira', key: 'PMLA-1', url: 'https://example.atlassian.net/browse/PMLA-1', validation: 'pending', validated_at: null, error: null };
  snap.sessions[0].unbound_work = { revision: 2, files: [{ repo_id: null, relative_path: 'secret/plan.md', first_seen: NOW, last_seen: NOW }], commits: [], first_at: NOW, last_at: NOW, dismissed_at: null };
  const plain = sanitizeSnapshot(snap, {});
  assert.deepEqual(Object.keys(plain.tickets[0].external).sort(), ['error', 'key', 'system', 'validated_at', 'validation']);
  assert.equal(JSON.stringify(plain).includes('secret/plan.md'), false, 'unlinked work never leaves the machine');
  assert.equal(sanitizeSnapshot(snap, { includeLinks: true }).tickets[0].external.url, 'https://example.atlassian.net/browse/PMLA-1');
});

function inboxSnapshot(extra = {}) {
  const snap = snapshot();
  snap.meta = { ...snap.meta, key_example: 'PMLA-123' };
  snap.sessions.push({ ...snap.sessions[0], id: 'sess-u', host_session_id: 'host-u', title: 'Fix <b>retry</b>', current_ticket_id: null, ticket_ids: [], bindings: [], last_checkpoint_preview: 'Made the retry deterministic', unbound_work: { revision: 3, files: [{ repo_id: null, relative_path: 'src/<a>.js', first_seen: NOW, last_seen: NOW }, ...Array.from({ length: 6 }, (_, i) => ({ repo_id: null, relative_path: `src/f${i}.js`, first_seen: NOW, last_seen: NOW }))], commits: [{ sha: 'abc1234def', message: 'feat: retry', at: NOW }], first_at: NOW, last_at: NOW, dismissed_at: null, ...extra } });
  return snap;
}

test('the inbox lists unlinked work with files, commits, the last checkpoint and three actions, and escapes session and file text', () => {
  const html = renderPickNext(inboxSnapshot(), noFilters, { now: NOW, pending: [] });
  assert.match(html, /Unlinked work <span class="count">1<\/span>/);
  assert.match(html, /Fix &lt;b&gt;retry&lt;\/b&gt;/);
  assert.match(html, /src\/&lt;a&gt;\.js/);
  assert.match(html, /and 2 more/);
  assert.match(html, /abc1234/);
  assert.match(html, /Made the retry deterministic/);
  for (const action of ['data-action="attach-unbound" data-session="sess-u" data-mode="attach"', 'data-action="attach-unbound" data-session="sess-u" data-mode="create"', 'data-action="dismiss-unbound" data-session="sess-u" data-revision="3"']) assert.ok(html.includes(action), action);
  assert.ok(html.indexOf('Unlinked work') < html.indexOf('Ranked candidates'), 'the inbox comes first');
});

test('the inbox hides dismissed or empty work and read-only snapshots, and shows pending requests instead of actions', () => {
  assert.doesNotMatch(renderPickNext(inboxSnapshot({ dismissed_at: NOW }), noFilters, { now: NOW, pending: [] }), /Unlinked work/);
  assert.doesNotMatch(renderPickNext(inboxSnapshot({ files: [], commits: [] }), noFilters, { now: NOW, pending: [] }), /Unlinked work/);
  const ro = inboxSnapshot();
  ro.capabilities = { read: true };
  assert.doesNotMatch(renderPickNext(ro, noFilters, { now: NOW, pending: [] }), /Unlinked work/);
  const pending = [{ id: 'r1', kind: 'attach-unbound', target_id: 'sess-u', state: 'pending', not_before: '2026-10-02T12:00:08Z', payload: { key: 'PMLA-9' } }];
  const html = renderInbox(inboxSnapshot(), { now: NOW, pending });
  assert.match(html, /applies in 8 s/);
  assert.match(html, /data-action="cancel-request" data-request="r1"/);
  assert.doesNotMatch(html, /data-action="dismiss-unbound"/);
});

test('the attach dialog suggests open tickets or takes a new key; the link dialog takes a key and an optional https link', () => {
  const snap = inboxSnapshot();
  const session = snap.sessions.at(-1);
  const attach = renderAttachDialog(session, snap, { mode: 'attach' });
  assert.match(attach, /data-form="attach" data-session="sess-u" data-revision="3" data-mode="attach"/);
  assert.match(attach, /<datalist id="attach-tickets">/);
  assert.match(attach, /<option value="LOCAL-ticket-1-abcdef01">/);
  assert.doesNotMatch(attach, /<option value="LOCAL-ticket-4-abcdef04">/, 'done tickets are not suggested');
  assert.match(attach, /name="bind" checked/);
  const create = renderAttachDialog(session, snap, { mode: 'create' });
  assert.ok(create.includes('name="key" required pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+" placeholder="PMLA-123"'));
  assert.match(create, /name="title"/);
  const link = renderLinkExternalDialog(snap.tickets[0], snap);
  assert.match(link, /data-form="link-external" data-ticket="[^"]+" data-revision="1"/);
  assert.ok(link.includes('name="url" type="url" pattern="https://.*"'));
});

test('empty states point at mentioning a key, and the sessions table flags unlinked work', () => {
  const empty = { ...snapshot(), tickets: [], picknext: [], blocked: [], meta: { ...snapshot().meta, key_example: 'PMLA-123' } };
  assert.match(renderPickNext(empty, noFilters, { now: NOW, pending: [] }), /Mention a ticket key such as <code>PMLA-123<\/code>/);
  assert.match(renderBoard(empty, noFilters, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} }), /Mention a ticket key such as <code>PMLA-123<\/code>/);
  assert.match(renderSessions(inboxSnapshot(), noFilters, { now: NOW }), /Unlinked work · 7 files/);
});

test('review: finished requests from an earlier batch never hide the actions for new unlinked work', () => {
  const done = [{ id: 'r-old', kind: 'dismiss-unbound', target_id: 'sess-u', state: 'applied', not_before: NOW, payload: {} }, { id: 'r-old2', kind: 'attach-unbound', target_id: 'sess-u', state: 'cancelled', not_before: NOW, payload: {} }];
  const html = renderInbox(inboxSnapshot(), { now: NOW, pending: done });
  assert.match(html, /data-action="attach-unbound" data-session="sess-u" data-mode="attach"/);
  assert.doesNotMatch(html, /Applied\./);
});

function scheduleSnapshot() {
  const snap = snapshot();
  snap.schedules = [
    { name: 'reconcile', job: 'reconcile', cron: null, every: '2h', enabled: true, running: false, next_due: '2026-10-02T13:30:00Z', last_started_at: '2026-10-02T11:30:00Z', last_finished_at: '2026-10-02T11:30:04Z', last_outcome: 'ok', last_error: null, last_summary: '3 PR checks', runs: [{ run_id: 'r1', trigger: 'schedule', started_at: '2026-10-02T11:30:00Z', finished_at: '2026-10-02T11:30:04Z', outcome: 'ok', summary: '3 PR checks', error: null }] },
    { name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5', every: null, enabled: true, running: true, next_due: '2026-10-05T14:00:00Z', last_started_at: '2026-10-02T11:59:00Z', last_finished_at: null, last_outcome: 'failed', last_error: 'gh: <offline>', last_summary: null, runs: [] },
    { name: 'paused', job: 'reconcile', cron: null, every: '1d', enabled: false, running: false, next_due: null, last_started_at: null, last_finished_at: null, last_outcome: null, last_error: null, last_summary: null, runs: [] },
  ];
  return snap;
}

test('the Schedules dialog shows when, next run, last result, history and Run now; it escapes errors', () => {
  const html = renderSchedulesDialog(scheduleSnapshot(), { now: NOW, pending: [] });
  assert.match(html, /<code>every 2h<\/code>/);
  assert.match(html, /<code>cron 30 19 \* \* 1-5<\/code>/);
  assert.match(html, /3 PR checks/);
  assert.match(html, /gh: &lt;offline&gt;/);
  assert.match(html, /Recent runs \(1\)/);
  assert.match(html, /data-action="run-job" data-schedule="reconcile"/);
  assert.match(html, /data-action="run-job" data-schedule="evening" disabled/, 'a running schedule cannot be started again');
  assert.match(html, /paused<div class="small muted">reconcile · disabled/);
  assert.match(html, /never run/);
  const queued = renderSchedulesDialog(scheduleSnapshot(), { now: NOW, pending: [{ id: 'q', kind: 'run-job', state: 'pending', payload: { schedule: 'reconcile' } }] });
  assert.doesNotMatch(queued, /data-action="run-job" data-schedule="reconcile"/);
  const ro = { ...scheduleSnapshot(), capabilities: { read: true } };
  assert.doesNotMatch(renderSchedulesDialog(ro, { now: NOW, pending: [] }), /data-action="run-job"/);
});

test('the header offers Schedules only when the worker reports schedules and the page is not an export', () => {
  const opts = { now: NOW, online: true, refresh: null, theme: 'dark', filters: noFilters, view: 'picknext', endpoint: '127.0.0.1:1', receipt: null };
  assert.match(renderHeader(scheduleSnapshot(), opts), /data-action="schedules"/);
  assert.doesNotMatch(renderHeader(snapshot(), opts), /data-action="schedules"/);
  const exported = scheduleSnapshot();
  exported.meta = { ...exported.meta, exported_at: NOW };
  assert.doesNotMatch(renderHeader(exported, opts), /data-action="schedules"/);
});
