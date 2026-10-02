import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, relativeTime, formatAbsolute } from '../../ui/lib/time.js';
import { esc, statusChip, scoreBadge, ticketCard, ticketKey, externalChip } from '../../ui/components.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';
import { renderPickNext, renderInbox } from '../../ui/views/picknext.js';
import { renderAttachDialog, renderLinkExternalDialog, renderSchedulesDialog, schedulesDialogKey, renderPublishDialog, publishDialogKey } from '../../ui/views/dialogs.js';
import { renderBoard } from '../../ui/views/board.js';
import { renderTree } from '../../ui/views/tree.js';
import { renderSessions } from '../../ui/views/sessions.js';
import { renderDeployments } from '../../ui/views/deployments.js';
import { renderToday } from '../../ui/views/today.js';
import { renderDetail } from '../../ui/views/detail.js';
import { renderHandoffForm } from '../../ui/views/handoff-form.js';
import { renderHeader } from '../../ui/views/header.js';
import { renderRecipeRunDialog, effectiveRecipes } from '../../ui/views/agents.js';
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

test('renderDeployments shows each ticket with outstanding work as a PR by environment matrix, oldest first; empty state', () => {
  const s = snapshot();
  const t = s.tickets.find((x) => x.id === TID(6));
  t.deployments = [
    { id: 'd6', pr_id: 'pr6', environment: 'production', state: 'pending', merged_at: '2026-09-29T08:00:00Z', deployed_at: null, evidence: null, waiver_reason: null },
    { id: 'd6s', pr_id: 'pr6', environment: 'stage', state: 'deployed', merged_at: '2026-09-29T08:00:00Z', deployed_at: '2026-09-30T09:00:00Z', evidence: 'values <v1.4>', evidence_kind: 'tag', waiver_reason: null },
    { id: 'd6d', pr_id: 'pr6', environment: 'dr', state: 'waived', merged_at: '2026-09-29T08:00:00Z', deployed_at: null, evidence: null, waiver_reason: 'not applicable: no DR' },
  ];
  t.environments = [
    { environment: 'stage', state: 'done', pending: 0, deployed_at: '2026-09-30T09:00:00Z', evidence: 'values <v1.4>', evidence_kind: 'tag' },
    { environment: 'production', state: 'pending', pending: 1 },
    { environment: 'dr', state: 'n-a', pending: 0, waiver_reason: 'not applicable: no DR' },
  ];
  const html = renderDeployments(s, noFilters, { now: NOW });
  assert.match(html, /<table class="env-matrix"/);
  assert.match(html, /<th scope="col">stage<\/th><th scope="col">production<\/th><th scope="col">dr<\/th>/);
  assert.match(html, /data-env-state="done"[\s\S]*?Tag bump[\s\S]*?values &lt;v1\.4&gt;/);
  assert.match(html, /data-env-state="pending"[\s\S]*?data-action="record-deployment" data-ticket="[^"]+" data-deployment="d6"/);
  assert.match(html, /data-env-state="n-a"[\s\S]*?not applicable: no DR/);
  assert.match(html, /2026-09-29/);
  const ro = renderDeployments({ ...s, capabilities: { read: true } }, noFilters, { now: NOW });
  assert.doesNotMatch(ro, /data-action="record-deployment"/);
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
  for (const v of ['picknext', 'board', 'tree', 'sessions', 'deployments', 'today']) assert.match(side, new RegExp(`data-view="${v}"`));
  assert.match(side, /data-view="today"[^>]*aria-keyshortcuts="6"/);
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

test('review: the Schedules dialog key ignores new generations and changes only when schedule or Run now state changes', () => {
  const a = scheduleSnapshot();
  const b = { ...scheduleSnapshot(), generation_id: 'gen-next' };
  assert.equal(schedulesDialogKey(a, []), schedulesDialogKey(b, []), 'a poll with nothing new keeps focus and open history');
  const finished = scheduleSnapshot();
  finished.schedules[1] = { ...finished.schedules[1], running: false, last_outcome: 'ok' };
  assert.notEqual(schedulesDialogKey(a, []), schedulesDialogKey(finished, []));
  const req = { id: 'q', kind: 'run-job', state: 'pending', payload: { schedule: 'reconcile' } };
  assert.notEqual(schedulesDialogKey(a, []), schedulesDialogKey(a, [req]));
  assert.notEqual(schedulesDialogKey(a, [req]), schedulesDialogKey(a, [{ ...req, state: 'applied' }]));
  assert.equal(schedulesDialogKey(a, []), schedulesDialogKey(a, [{ id: 'x', kind: 'edit', state: 'pending' }]), 'unrelated requests do not re-render');
  assert.match(renderSchedulesDialog(a, { now: NOW, pending: [] }), /<details data-schedule="reconcile">/, 'history can be reopened after a re-render');
});

const P = (over = {}) => ({ read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false, ...over });
const R = (over) => ({ description: 'd', source: 'builtin', repo_id: null, mode: 'analyse', permissions: P(), tools: null, timeout_min: 20, inputs: [], outputs: ['summary'], legacy: false, schedulable: true, error: null, preview: '', ...over });

function recipeSnapshot() {
  const s = snapshot();
  s.recipes = [
    R({ name: 'deploy-check', description: 'Check deployments', permissions: P({ read_source: true }), timeout_min: 10, outputs: ['summary', 'deploy_evidence', 'next_action'] }),
    R({ name: 'standup', description: 'Builtin standup', timeout_min: 5 }),
    R({ name: 'standup', description: 'Team standup', source: 'repo', repo_id: 'demo', timeout_min: 5 }),
    R({ name: 'broken', source: 'personal', error: 'commit requires edit_source' }),
    R({ name: 'other-repo', description: 'Elsewhere only', source: 'repo', repo_id: 'elsewhere' }),
    R({ name: 'attempt-fix', description: 'Fix it', mode: 'attempt-fix', legacy: true, permissions: P({ read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }) }),
  ];
  const t = s.tickets.find((x) => x.id === TID(5));
  t.handoff_ids = ['h1', 'h2'];
  s.handoffs.push({ ...s.handoffs[0], id: 'h2', state: 'done', error: null, mode: 'analyse', recipe: { name: 'deploy-check', source: 'builtin' }, legacy: false, suggestions: [
    { id: 's1', type: 'next-action', state: 'proposed', text: 'Confirm <prod>' },
    { id: 's2', type: 'deploy-evidence', state: 'proposed', items: [{ environment: 'production', state: 'deployed', evidence: 'tag v1.2' }] },
    { id: 's3', type: 'comment-draft', state: 'proposed', text: 'Deployed to prod' },
    { id: 's4', type: 'followup', state: 'accepted', title: 'Add alert' },
  ] });
  return { s, t };
}

test('the Agents panel lists the recipes for the ticket repository with permissions, and each run with its suggestions', () => {
  const { s, t } = recipeSnapshot();
  assert.deepEqual(effectiveRecipes(s, 'demo').map((r) => [r.name, r.source]), [['deploy-check', 'builtin'], ['standup', 'repo'], ['broken', 'personal'], ['attempt-fix', 'builtin']]);
  const html = renderDetail(t, s, { now: NOW, pending: [], content: {} });
  assert.match(html, /<h3>Agents/);
  assert.match(html, /data-action="run-recipe" data-ticket="[^"]+" data-recipe="deploy-check"/);
  assert.match(html, /Team standup/);
  assert.doesNotMatch(html, /Builtin standup|Elsewhere only/);
  assert.match(html, /broken[\s\S]{0,800}commit requires edit_source/);
  assert.doesNotMatch(html, /data-recipe="broken"/);
  assert.match(html, /Reads source · 10 min/);
  assert.match(html, /Notes only · 5 min/);
  assert.match(html, /Confirm &lt;prod&gt;/);
  assert.match(html, /data-action="accept-suggestion" data-ticket="[^"]+" data-handoff="h2" data-suggestion="s1"/);
  assert.match(html, /data-action="dismiss-suggestion" data-ticket="[^"]+" data-handoff="h2" data-suggestion="s1"/);
  assert.match(html, /production: deployed — tag v1\.2/);
  assert.match(html, /data-copy="Deployed to prod"/);
  assert.match(html, /Add alert[\s\S]{0,120}Accepted/);
  assert.doesNotMatch(html, /data-suggestion="s4"/);
  const pending = renderDetail(t, s, { now: NOW, pending: [{ id: 'q', kind: 'accept-suggestion', target_id: t.id, state: 'pending', payload: { handoff_id: 'h2', suggestion_id: 's1' } }], content: {} });
  assert.doesNotMatch(pending, /data-action="accept-suggestion"[^>]*data-suggestion="s1"/);
  assert.match(pending, /Accepting…/);
  const ro = renderDetail(t, { ...s, capabilities: { read: true } }, { now: NOW, pending: [], content: {} });
  for (const action of ['run-recipe', 'accept-suggestion', 'dismiss-suggestion']) assert.equal(ro.includes(`data-action="${action}"`), false, action);
});

test('the recipe run dialog shows what the run may do and pre-selects only source access', () => {
  const { s, t } = recipeSnapshot();
  const fix = renderRecipeRunDialog(s.recipes.find((r) => r.name === 'attempt-fix'), t, s);
  assert.match(fix, /data-form="recipe-run" data-ticket="[^"]+" data-revision="1" data-recipe="attempt-fix"/);
  assert.match(fix, /name="read_source" checked/);
  assert.match(fix, /name="edit_source" checked disabled/);
  assert.match(fix, /name="commit"(?! checked)/);
  assert.match(fix, /name="push_branch"(?! checked)/);
  assert.match(fix, /name="branch"/);
  assert.match(fix, /applies its next action and follow-ups directly/);
  const standup = renderRecipeRunDialog(s.recipes.find((r) => r.source === 'repo' && r.name === 'standup'), t, s);
  assert.match(standup, /works from the ticket notes only/);
  assert.doesNotMatch(standup, /type="checkbox"/);
  assert.match(standup, /Results arrive as suggestions you accept or dismiss/);
  assert.match(standup, /repository recipe/);
});

test('the Today view lists each day newest first with its tickets, activity counts and items; empty and export states', () => {
  const s = snapshot();
  const t1 = s.tickets[0];
  s.today = { timezone: 'UTC', generated_for: '2026-10-02', days: [
    { date: '2026-10-02', sessions: 2, tickets: [{ ticket_id: t1.id, key: t1.key, title: '<b>Today</b> work', status: 'active', counts: { commit: 2, pr: 1 }, items: [{ at: '2026-10-02T10:00:00Z', kind: 'commit', text: 'Commit <abc>' }], last_at: '2026-10-02T10:00:00Z' }] },
    { date: '2026-09-30', sessions: 0, tickets: [{ ticket_id: t1.id, key: t1.key, title: 'Older', status: 'active', counts: { write: 1 }, items: [{ at: '2026-09-30T08:00:00Z', kind: 'write', text: 'Edit a.js' }], last_at: '2026-09-30T08:00:00Z' }] },
  ] };
  const html = renderToday(s, noFilters, { now: NOW });
  assert.match(html, /<h2[^>]*>Today<\/h2>/);
  assert.match(html, /2026-09-30/);
  assert.match(html, /2 commits · 1 PR/);
  assert.match(html, /2 sessions/);
  assert.match(html, /Commit &lt;abc&gt;/);
  assert.doesNotMatch(html, /<b>Today<\/b>/);
  assert.match(html, new RegExp(`data-open="${t1.id}"`));
  assert.ok(html.indexOf('2026-10-02') < html.indexOf('2026-09-30'));
  assert.match(renderToday({ ...s, today: { timezone: 'UTC', generated_for: '2026-10-02', days: [] } }, noFilters, { now: NOW }), /Nothing tracked in the last 7 days/);
  assert.match(renderToday({ ...s, today: null, meta: { ...s.meta, exported_at: NOW } }, noFilters, { now: NOW }), /not included in exports/i);
});

test('ticket detail shows the per-environment status line with evidence; the record dialog asks for the evidence kind', async () => {
  const s = snapshot();
  const t = s.tickets.find((x) => x.id === TID(6));
  t.environments = [{ environment: 'stage', state: 'done', pending: 0, deployed_at: '2026-09-30T09:00:00Z', evidence: 'argo sync 41', evidence_kind: 'argocd' }, { environment: 'production', state: 'pending', pending: 1 }];
  const html = renderDetail(t, s, { now: NOW, pending: [], content: {} });
  assert.match(html, /class="env-status"[\s\S]*?stage[\s\S]*?ArgoCD sync[\s\S]*?production[\s\S]*?Pending/);
  const { renderDeploymentDialog } = await import('../../ui/views/dialogs.js');
  t.deployments = [{ id: 'd6', pr_id: 'pr6abcdef', environment: 'production', state: 'pending', merged_at: '2026-09-29T08:00:00Z' }];
  const dialog = renderDeploymentDialog(t, { mode: 'record' });
  assert.match(dialog, /<select name="evidence_kind_0"/);
  for (const k of ['tag', 'argocd', 'release', 'manual', 'merge']) assert.match(dialog, new RegExp(`<option value="${k}"`));
});

function publishSnapshot() {
  const s = snapshot();
  s.publishers = [
    { name: 'team', kind: 'artifact', label: 'Live', title: 'Team <tracker>', fields: ['key', 'title', 'status'], projects: ['demo'], include_links: false, after_reconcile: true, destination_label: 'https://claude.ai/artifact/abc', url: 'https://claude.ai/artifact/abc', confirmed: true, running: false, last_published_at: '2026-10-02T11:00:00Z', last_outcome: 'ok', last_error: null, last_summary: 'updated 3 rows', runs: [{ run_id: 'r1', at: '2026-10-02T11:00:00Z', trigger: 'after-reconcile', outcome: 'ok', summary: 'updated 3 rows', error: null }] },
    { name: 'rollup', kind: 'markdown', label: 'Note', title: 'Roll-up', fields: ['key', 'title'], projects: null, include_links: false, after_reconcile: false, destination_label: 'rollup.md', url: null, confirmed: false, running: false, last_published_at: null, last_outcome: 'needs-confirmation', last_error: null, last_summary: 'waiting for confirmation', runs: [] },
    { name: 'copy', kind: 'html', label: 'Copy', title: 'copy', fields: ['key'], projects: null, include_links: false, after_reconcile: false, destination_label: 'copy.html', url: null, confirmed: true, running: false, last_published_at: null, last_outcome: 'failed', last_error: 'disk <full>', last_summary: null, runs: [] },
  ];
  return s;
}

test('the Publish dialog labels live pages and copies, shows what each sends, asks to confirm a new destination and escapes errors', () => {
  const s = publishSnapshot();
  const html = renderPublishDialog(s, { now: NOW, pending: [] });
  assert.match(html, /Live[\s\S]*?Team &lt;tracker&gt;/);
  assert.match(html, /<a href="https:\/\/claude\.ai\/artifact\/abc" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /key, title, status of tickets in demo/);
  assert.match(html, /data-action="publish" data-publisher="team" data-confirm="false"[^>]*>[\s\S]*?Publish now/);
  assert.match(html, /data-action="publish" data-publisher="rollup" data-confirm="true"[^>]*>[\s\S]*?Confirm and publish/);
  assert.match(html, /disk &lt;full&gt;/);
  assert.match(html, /Copy/);
  const queued = renderPublishDialog(s, { now: NOW, pending: [{ id: 'q', kind: 'publish', state: 'pending', payload: { publisher: 'team' } }] });
  assert.doesNotMatch(queued, /data-publisher="team" data-confirm/);
  assert.equal(publishDialogKey(s, []), publishDialogKey({ ...s, generation_id: 'other' }, []));
  const opts = { now: NOW, online: true, refresh: null, theme: 'dark', filters: noFilters, view: 'picknext', endpoint: '127.0.0.1:1', receipt: null };
  assert.match(renderHeader(s, opts), /data-action="publishers"[^>]*>[\s\S]*?Publish/);
  assert.match(renderHeader(s, opts), /data-publish-state="attention"/, 'a failed or unconfirmed publisher marks the button');
  assert.doesNotMatch(renderHeader({ ...s, meta: { ...s.meta, exported_at: NOW } }, opts), /data-action="publishers"/);
  assert.doesNotMatch(renderPublishDialog({ ...s, capabilities: { read: true } }, { now: NOW, pending: [] }), /data-action="publish"/);
});

test('an artifact published from a Claude Code session shows the command to run instead of a publish button', () => {
  const s = publishSnapshot();
  s.publishers[0] = { ...s.publishers[0], executor: 'session' };
  const html = renderPublishDialog(s, { now: NOW, pending: [] });
  assert.match(html, /\/session-quill:publish team/);
  assert.match(html, /data-copy="\/session-quill:publish team"/);
  assert.doesNotMatch(html, /data-publisher="team" data-confirm="false"/);
  s.publishers[0] = { ...s.publishers[0], confirmed: false };
  assert.match(renderPublishDialog(s, { now: NOW, pending: [] }), /data-publisher="team" data-confirm="true"[^>]*>[\s\S]*?Confirm destination/);
});
