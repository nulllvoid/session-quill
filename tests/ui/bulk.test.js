import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBoard } from '../../ui/views/board.js';
import { renderPickNext } from '../../ui/views/picknext.js';
import { renderSelectToggle, renderBulkActionBar, renderBulkHandoffForm, renderBulkResults, renderBulkStatusDialog, renderBatchStrips } from '../../ui/views/bulk.js';
import { toggleChecked, selectRange, selectionKey, bulkEntries, bulkRequests, bulkOutcome, batchProgress, activeBatches, pendingUndo, bulkStatusRequests } from '../../ui/lib/bulk.js';
import { renderHelpDialog } from '../../ui/views/dialogs.js';
import { snapshot, ticket, TID } from './fixtures.js';

const NOW = '2026-10-02T12:30:00Z';
const BATCH = 'b6a8f8e5-5d1c-4c1e-9a55-3b1f2c7d9e10';

test('selection: toggle one, Shift-click a range in visible order, clear', () => {
  let checked = toggleChecked(new Set(), 'a');
  assert.deepEqual([...checked], ['a']);
  checked = toggleChecked(checked, 'a');
  assert.equal(checked.size, 0);
  const order = ['a', 'b', 'c', 'd', 'e'];
  checked = selectRange(new Set(['a']), order, 'b', 'd');
  assert.deepEqual([...checked].sort(), ['a', 'b', 'c', 'd']);
  checked = selectRange(new Set(), order, 'd', 'b');
  assert.deepEqual([...checked].sort(), ['b', 'c', 'd'], 'a range works upwards too');
  assert.deepEqual([...selectRange(new Set(), order, null, 'c')], ['c'], 'without an anchor it selects the one card');
});

test('keyboard: x toggles the focused card, Esc clears the selection', () => {
  assert.deepEqual(selectionKey('x', { focusedId: 't1', checkedSize: 0 }), { type: 'toggle', id: 't1' });
  assert.equal(selectionKey('x', { focusedId: null, checkedSize: 0 }), null, 'x needs a focused card');
  assert.deepEqual(selectionKey('Escape', { focusedId: null, checkedSize: 3 }), { type: 'clear' });
  assert.equal(selectionKey('Escape', { focusedId: null, checkedSize: 0 }), null, 'Esc with nothing selected does nothing');
  assert.equal(selectionKey('y', { focusedId: 't1', checkedSize: 1 }), null);
  const help = renderHelpDialog();
  assert.match(help, /<kbd>x<\/kbd><\/th><td>Select or deselect the focused card/);
  assert.match(help, /<kbd>Shift \+ click<\/kbd>/);
  assert.match(help, /<kbd>h<\/kbd><\/th><td>Run agent on a focused eligible card/);
  assert.doesNotMatch(help, /Handoff on a focused/);
});

test('Board and Pick next offer a Select toggle; in select mode every card has an always-visible checkbox beside it, not inside it', () => {
  const s = snapshot();
  const off = renderBoard(s, {}, { now: NOW, layout: 'columns', toggled: new Set(['done']) });
  assert.match(off, /<button type="button" class="btn small" data-action="toggle-select" aria-pressed="false">/);
  assert.doesNotMatch(off, /data-check=/);
  const checked = new Set([TID(1)]);
  const on = renderBoard(s, {}, { now: NOW, layout: 'columns', toggled: new Set(['done']), selecting: true, checked });
  assert.match(on, /data-action="toggle-select" aria-pressed="true"/);
  const pick = on.match(/<div class="card-pick">([\s\S]*?)<\/article>\s*<\/div>/);
  assert.ok(pick, 'card and checkbox share a wrapper');
  assert.match(pick[1], /^<input type="checkbox" class="card-check" data-check="[^"]+" aria-label="Select [^"]+"[^>]*><article /, 'the checkbox is a sibling before the card');
  assert.match(on, new RegExp(`data-check="${TID(1)}" aria-label="Select LOCAL-ticket-1-abcdef01 Ticket 1" checked>`));
  for (const article of on.match(/<article[\s\S]*?<\/article>/g)) assert.doesNotMatch(article, /type="checkbox"/, 'never nested in role=button');
  const pickNext = renderPickNext(s, {}, { now: NOW, selecting: true, checked });
  assert.match(pickNext, /data-action="toggle-select" aria-pressed="true"/);
  assert.match(pickNext, new RegExp(`data-check="${TID(1)}"`));
  const readOnly = renderBoard(snapshot({ capabilities: { read: true } }), {}, { now: NOW });
  assert.doesNotMatch(readOnly, /toggle-select/, 'a read-only snapshot cannot select for bulk actions');
  assert.match(renderSelectToggle({ selecting: true, count: 2 }), /Done selecting \(2\)/);
});

test('the bulk action bar is a labelled group with the count and the four actions, plus Undo all while edits can be undone', () => {
  const html = renderBulkActionBar({ count: 5 });
  assert.match(html, /<div class="bulk-bar" role="group" aria-label="Bulk actions"/);
  assert.match(html, /<span class="bulk-count">5 selected<\/span>/);
  for (const [action, label] of [['bulk-handoff" data-mode="analyse', 'Analyze'], ['bulk-handoff" data-mode="attempt-fix', 'Attempt fix'], ['bulk-status', 'Change status'], ['bulk-clear', 'Clear']]) {
    assert.match(html, new RegExp(`data-action="${action}"[^>]*>(<svg[\\s\\S]*?</svg>)?${label}<`), label);
  }
  assert.doesNotMatch(html, /Undo all/);
  assert.match(renderBulkActionBar({ count: 0, undo: 3 }), /data-action="bulk-undo-all"[^>]*>(<svg[\s\S]*?<\/svg>)?<span class="bulk-undo-label">Undo all \(<span class="bulk-undo-count">3<\/span>\)<\/span>/);
  assert.doesNotMatch(renderBulkActionBar({ count: 0, undo: 3 }), /data-action="bulk-handoff"/, 'no actions on an empty selection');
});

function bulkSnapshot() {
  const tickets = [
    ticket(1, { status: 'todo' }),
    ticket(2, { status: 'active', handoff_ids: ['run2'] }),
    ticket(3, { status: 'todo', repo_id: null }),
    ticket(4, { status: 'done' }),
    ticket(5, { status: 'review' }),
    ticket(6, { status: 'active' }),
  ];
  const handoffs = [{ id: 'run2', ticket_id: TID(2), state: 'running', mode: 'analyse', requested_at: '2026-10-02T12:00:00Z', permissions: {} }];
  return snapshot({ tickets, handoffs, meta: { ...snapshot().meta, handoff_limits: { readonly: 2, fix: 1 } }, repos: [{ id: 'demo', project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'], test_command: 'npm test' }] });
}

test('each selected ticket is listed as ready, already running, no repo or not eligible; fixes on one repo wait for it', () => {
  const s = bulkSnapshot();
  const ids = [1, 2, 3, 4, 5, 6].map(TID);
  const fix = bulkEntries(s, ids, { mode: 'attempt-fix' });
  assert.deepEqual(fix.map((e) => e.state), ['ready', 'running', 'no-repo', 'not-eligible', 'ready', 'ready']);
  assert.deepEqual(fix.map((e) => e.waits), [false, false, false, false, true, true], 'one fix per repository at a time');
  const analyse = bulkEntries(s, ids, { mode: 'analyse' });
  assert.deepEqual(analyse.map((e) => e.state), ['ready', 'running', 'ready', 'not-eligible', 'ready', 'ready'], 'an analysis without a repository works from the notes');
  assert.equal(analyse[2].notesOnly, true);

  const form = renderBulkHandoffForm(s, ids, { mode: 'attempt-fix' });
  assert.match(form, /data-form="bulk-handoff"/);
  for (const label of ['Ready', 'Already running', 'No repo', 'Not eligible', 'Waits for repo']) assert.match(form, new RegExp(label));
  assert.match(form, /3 runs/);
  assert.match(form, /At most 1 fix run at a time/);
  assert.match(form, /<input type="checkbox" name="confirm_edit" required>/, 'bulk fixes need an explicit edit_source confirmation');
  assert.match(form, /name="access"/, 'access is chosen once');
  assert.match(form, /Tests: <code>npm test<\/code>/);
  assert.match(form, /<p class="run-summary">Edits in an isolated checkout · not test-verified \(no test command\) · no commit, push or PR · applies its next action; follow-ups need your acceptance<\/p>/);
  const a = renderBulkHandoffForm(s, ids, { mode: 'analyse' });
  assert.match(a, /name="mode" value="analyse" checked/);
  assert.match(a, /name="mode" value="analyse-followups"/);
  assert.match(a, /At most 2 read-only runs at a time/);
  assert.doesNotMatch(a, /confirm_edit/);
  assert.match(a, /4 runs/);
  assert.match(a, /<p class="run-summary">Reads source · applies its next action; follow-ups need your acceptance<\/p>/);
});

test('selecting 5 cards and choosing Analyze sends 5 requests with one batch id and shows 5 outcomes', () => {
  const s = bulkSnapshot();
  const ids = [1, 3, 5, 6, 2].map(TID);
  const s5 = { ...s, handoffs: [] };
  const entries = bulkEntries(s5, ids, { mode: 'analyse' });
  const bodies = bulkRequests(entries, { mode: 'analyse', access: 'settings', note: 'look', batchId: BATCH });
  assert.equal(bodies.length, 5);
  for (const b of bodies) {
    assert.equal(b.kind, 'handoff');
    assert.equal(b.payload.batch_id, BATCH);
    assert.equal(b.payload.mode, 'analyse');
    assert.equal(b.payload.access, 'settings');
    assert.equal(b.payload.permissions.edit_source, false);
    assert.ok(Number.isInteger(b.expected_revision));
  }
  assert.equal(bodies.find((b) => b.target_id === TID(3)).payload.permissions.read_source, false, 'no repository, notes only');
  assert.equal(bodies.find((b) => b.target_id === TID(1)).payload.permissions.read_source, true);
  const fixBodies = bulkRequests(bulkEntries(s5, ids, { mode: 'attempt-fix' }), { mode: 'attempt-fix', access: 'standard', note: '', batchId: BATCH });
  assert.ok(fixBodies.every((b) => b.payload.permissions.read_source && b.payload.permissions.edit_source && !b.payload.permissions.commit));
  const requests = bodies.map((b, i) => ({ id: `r${i}`, kind: 'handoff', target_id: b.target_id, payload: b.payload, state: ['applied', 'failed', 'conflict', 'pending', 'sending'][i], error: i === 1 ? { code: 'handoff-reserved', message: 'already queued' } : i === 2 ? { code: 'conflict', current_revision: 4 } : null }));
  assert.deepEqual(requests.map((r) => bulkOutcome(r).label), ['Queued', 'Already running', 'Stale, refresh', 'Sending', 'Sending']);
  const html = renderBulkResults(s5, { batchId: BATCH, rows: requests.map((r) => ({ ticketId: r.target_id, requestId: r.id })), requests });
  assert.equal((html.match(/<li class="bulk-result"/g) ?? []).length, 5);
  for (const label of ['Queued', 'Already running', 'Stale, refresh']) assert.match(html, new RegExp(label));
});

test('bulk status changes keep one request each, and Undo all gathers those still inside their 10 s window', () => {
  const s = bulkSnapshot();
  const { bodies, skipped } = bulkStatusRequests(s, [1, 4, 5, 6].map(TID), { status: 'active' });
  assert.deepEqual(bodies.map((b) => b.target_id), [TID(1), TID(4), TID(5)], 'a ticket already in the status is skipped');
  assert.equal(skipped[0].ticketId, TID(6));
  assert.ok(bodies.every((b) => b.kind === 'set-status' && b.payload.status === 'active' && b.original && b.original.status));
  const blocked = bulkStatusRequests(s, [TID(1)], { status: 'blocked', blocker: 'waiting' });
  assert.equal(blocked.bodies[0].payload.blocker, 'waiting');
  const withDeploy = snapshot();
  const done = bulkStatusRequests(withDeploy, [TID(1), TID(6)], { status: 'done' });
  assert.deepEqual(done.bodies.map((b) => b.target_id), [TID(1)], 'done with an outstanding deployment needs its own choice');
  assert.match(done.skipped[0].reason, /deployment/);
  const requests = new Map([['a', { id: 'a', state: 'pending' }], ['b', { id: 'b', state: 'applied' }], ['c', { id: 'c', state: 'pending' }]]);
  assert.deepEqual(pendingUndo(requests, ['a', 'b', 'c', 'missing']), ['a', 'c']);
  const dialog = renderBulkStatusDialog(3);
  assert.match(dialog, /data-form="bulk-status"/);
  assert.match(dialog, /3 tickets/);
  assert.match(dialog, /name="blocker"/);
});

test('bulk runs get a progress strip per batch with Cancel batch while runs are queued', () => {
  const tickets = [ticket(1), ticket(2), ticket(3)];
  const handoffs = [
    { id: 'a', ticket_id: TID(1), batch_id: BATCH, state: 'queued', mode: 'analyse', requested_at: NOW },
    { id: 'b', ticket_id: TID(2), batch_id: BATCH, state: 'running', mode: 'analyse', requested_at: NOW },
    { id: 'c', ticket_id: TID(3), batch_id: BATCH, state: 'done', mode: 'analyse', requested_at: NOW },
    { id: 'd', ticket_id: TID(3), batch_id: 'old', state: 'done', mode: 'analyse', requested_at: NOW },
  ];
  const s = snapshot({ tickets, handoffs });
  assert.deepEqual(batchProgress(s, BATCH), { total: 3, queued: 1, running: 1, done: 1, failed: 0, cancelled: 0 });
  assert.deepEqual(activeBatches(s, []), [BATCH], 'finished batches drop out unless launched here');
  assert.deepEqual(activeBatches(s, ['old']), [BATCH, 'old']);
  const html = renderBatchStrips(s, [BATCH], { canCancel: true });
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="1" aria-valuemax="3"/);
  assert.match(html, /1 done · 1 running · 1 queued/);
  assert.match(html, new RegExp(`data-action="cancel-batch" data-batch="${BATCH}"[^>]*>Cancel batch \\(1 queued\\)`));
  const finished = renderBatchStrips(s, ['old'], { canCancel: true });
  assert.doesNotMatch(finished, /cancel-batch/);
  assert.match(finished, /data-action="dismiss-batch"/);
});

test('x with ctrl, meta or alt held is left to the browser', async () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(selectionKey('x', { focusedId: 't1', [mod]: true }), null, mod);
  assert.deepEqual(selectionKey('x', { focusedId: 't1', shiftKey: true }), { type: 'toggle', id: 't1' }, 'shift alone does not block it');
});

test('a bulk submit updates only its own results dialog and clears only the tickets it submitted', async () => {
  const { batchDialogUpdate, withoutIds } = await import('../../ui/lib/bulk.js');
  const rows = [{ ticketId: 'a', requestId: 'r1' }];
  assert.deepEqual(batchDialogUpdate({ type: 'bulk-results', batchId: 'B', rows: [] }, 'B', rows), { type: 'bulk-results', batchId: 'B', rows });
  assert.equal(batchDialogUpdate(null, 'B', rows), null, 'a closed dialog is not reopened');
  const other = { type: 'bulk-results', batchId: 'C', rows: [] };
  assert.equal(batchDialogUpdate(other, 'B', rows), other, 'another batch keeps its dialog');
  const help = { type: 'help' };
  assert.equal(batchDialogUpdate(help, 'B', rows), help);
  assert.deepEqual([...withoutIds(new Set(['a', 'b', 'c']), ['a', 'c'])], ['b'], 'tickets checked meanwhile stay checked');
});

test('Undo all counts edits still being sent and keeps earlier bulk edits inside their window', async () => {
  const { mergeUndo } = await import('../../ui/lib/bulk.js');
  const requests = new Map([['a', { id: 'a', state: 'pending' }], ['b', { id: 'b', state: 'applied' }], ['s', { id: 's', state: 'sending' }]]);
  assert.deepEqual(pendingUndo(requests, ['a', 'b', 's']), ['a', 's'], 'a request still being sent can be undone once it lands');
  assert.deepEqual(mergeUndo(requests, ['a', 'b'], ['n1', 'n2']), ['a', 'n1', 'n2'], 'a second bulk change adds to the set');
  assert.deepEqual(mergeUndo(requests, ['a'], ['a']), ['a'], 'no duplicates');
});

test('changing filters drops checked tickets the filters now hide', async () => {
  const { pruneChecked } = await import('../../ui/lib/bulk.js');
  const s = bulkSnapshot();
  const all = new Set([1, 4, 5].map(TID));
  const key = s.tickets.find((t) => t.id === TID(1)).key;
  const kept = pruneChecked(s, all, { q: key });
  assert.deepEqual([...kept], [TID(1)]);
  assert.equal(pruneChecked(s, all, {}).size, 3, 'no filter, nothing hidden');
});

test('the bulk bar is a labelled group whose count can change without replacing its buttons', async () => {
  const { bulkBarShape } = await import('../../ui/views/bulk.js');
  const html = renderBulkActionBar({ count: 3 });
  assert.match(html, /<div class="bulk-bar" role="group" aria-label="Bulk actions" data-shape="[^"]+">/);
  assert.doesNotMatch(html, /role="toolbar"/, 'no toolbar role without roving focus');
  assert.equal(bulkBarShape({ count: 3, undo: 0 }), bulkBarShape({ count: 7, undo: 0 }), 'a new count keeps the same buttons');
  assert.notEqual(bulkBarShape({ count: 3, undo: 0 }), bulkBarShape({ count: 3, undo: 2 }));
  assert.notEqual(bulkBarShape({ count: 3, undo: 0 }), bulkBarShape({ count: 0, undo: 2 }));
  assert.match(renderBulkActionBar({ count: 0, undo: 2 }), /<span class="bulk-undo-count">2<\/span>/);
});
