// The owner's Memory page (spec §6.4, §8; design system §5): Repo / Machine / Quarantine tabs, trust
// in words as well as colour, the actions the owner may take with pending state, empty states that
// tell no memory from no matches, Memory under Track on shortcut 8, and nothing of it in an export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, EMPTY_FILTERS, trustChip, TRUST_LABELS, tracksSnapshotRequest } from '../../ui/components.js';
import { renderMemory, MEMORY_TABS, memoryTabEntries, memoryRequestFor, memoryEntryBusy, openMemoryEdit, MEMORY_BUSY_MESSAGE } from '../../ui/views/memory.js';
import { renderSidebar, NAV_ITEMS, PHONE_PRIMARY, SHORTCUT_VIEWS } from '../../ui/views/header.js';
import { renderHelpDialog } from '../../ui/views/dialogs.js';
import { buildStaticHtml } from '../../src/export/static.js';
import { buildSnapshot } from '../../src/worker/projections.js';
import { newState, ev } from '../core/helpers.js';
import { snapshot } from './fixtures.js';

const NOW = '2026-10-02T12:00:00Z';
const entry = (id, extra = {}) => ({ id, scope: 'repo', repo_id: 'demo', ticket_id: null, section: 'build', kind: 'fact', key: null, text: `Text of ${id}`, trust: 'verified', pinned: false, staleness: 'active', confirmations: 2, last_confirmed_at: '2026-10-01T08:00:00Z', created_at: '2026-09-30T08:00:00Z', run_id: 'h1', derived_from: 'own-command', evidence: [], revision: 3, conflict_key: null, ...extra });

function memory() {
  return {
    entries: [
      entry('v1'),
      entry('s1', { trust: 'sourced', key: 'test-cmd', conflict_key: 'test-cmd' }),
      entry('o1', { trust: 'observed', key: 'test-cmd', conflict_key: 'test-cmd', text: 'Tests run with <script>alert(1)</script>' }),
      entry('w1', { trust: 'owner', pinned: true, run_id: null }),
      entry('m1', { scope: 'machine', repo_id: null, section: 'tools', trust: 'observed', staleness: 'stale' }),
      entry('q1', { trust: 'quarantined', quarantine_reason: 'instruction-like text', derived_from: 'tool-output' }),
      entry('q2', { scope: 'machine', repo_id: null, trust: 'quarantined', quarantine_reason: 'from a page-proposed run' }),
    ],
    conflicts: [{ id: 'conflict:repo:demo:test-cmd', scope: 'repo', repo_id: 'demo', key: 'test-cmd', entry_ids: ['s1', 'o1'], at: '2026-10-01T08:00:00Z' }],
  };
}

test('trust chips carry their meaning in words: Verified, Sourced, Observed, Quarantined, Owner', () => {
  assert.deepEqual(TRUST_LABELS, { owner: 'Owner', verified: 'Verified', sourced: 'Sourced', observed: 'Observed', quarantined: 'Quarantined' });
  for (const [trust, label] of Object.entries(TRUST_LABELS)) assert.match(trustChip(trust), new RegExp(`class="chip trust[^"]*" data-trust="${trust}"[^>]*>[\\s\\S]*${label}</span>`));
});

test('the Memory page has Repo, Machine and Quarantine tabs with roving tabindex and counts', () => {
  assert.deepEqual(MEMORY_TABS, ['repo', 'machine', 'quarantine']);
  const html = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo' });
  assert.match(html, /role="tablist" aria-label="Memory"/);
  assert.match(html, /role="tab" id="memory-tab-repo" data-action="memory-tab" data-tab="repo" aria-selected="true" aria-controls="memory-panel" tabindex="0">Repo <span class="count">4<\/span>/);
  assert.match(html, /id="memory-tab-machine"[^>]*aria-selected="false"[^>]*tabindex="-1">Machine <span class="count">1<\/span>/);
  assert.match(html, /id="memory-tab-quarantine"[^>]*tabindex="-1">Quarantine <span class="count">2<\/span>/);
  assert.match(html, /role="tabpanel" id="memory-panel" aria-labelledby="memory-tab-repo"/);
  for (const label of ['Verified', 'Sourced', 'Observed', 'Owner']) assert.match(html, new RegExp(`data-trust="[a-z]+"[^>]*>[\\s\\S]*?${label}</span>`));
  assert.match(html, /Pinned/);
  assert.match(html, /Conflict on key test-cmd/);
  assert.match(html, /Runs get only the higher-ranked entry/);
  assert.match(html, /Tests run with &lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'memory text is escaped');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /data-action="open-run" data-run="h1"/, 'the source run links to its run detail');
  assert.match(html, /Confirmed 2×/);
  assert.doesNotMatch(html, /data-action="memory-approve"/, 'Approve only on quarantined learnings');
  assert.match(html, /data-action="memory-edit" data-entry="v1"/);
  assert.match(html, /data-action="memory-pin" data-entry="v1" data-pinned="true"[^>]*>Pin</);
  assert.match(html, /data-action="memory-pin" data-entry="w1" data-pinned="false"[^>]*>Unpin</);
  assert.match(html, /data-action="memory-retire" data-entry="v1"/);
});

test('Quarantine shows the reason it was held and Approve; Machine shows stale entries as Stale', () => {
  const q = renderMemory(memory(), snapshot(), { now: NOW, tab: 'quarantine' });
  assert.match(q, /Quarantined<\/span>/);
  assert.match(q, /Held: instruction-like text/);
  assert.match(q, /Held: from a page-proposed run/);
  assert.match(q, /<button type="button" class="btn small primary" data-action="memory-approve" data-entry="q1" data-revision="3"/);
  const m = renderMemory(memory(), snapshot(), { now: NOW, tab: 'machine' });
  assert.match(m, /chip stale[^>]*>[\s\S]*?Stale/);
  assert.doesNotMatch(m, /Text of v1/);
});

test('a pending change disables the entry actions and offers Undo while a retire waits', () => {
  const pending = [{ id: 'r1', kind: 'memory-forget', target_id: 'v1', state: 'pending', not_before: '2026-10-02T12:00:08Z', payload: {} }];
  const html = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', pending });
  const li = /<li class="memory-entry" data-entry="v1"[\s\S]*?<\/li>/.exec(html)[0];
  assert.match(li, /data-action="memory-retire"[^>]*disabled/);
  assert.match(li, /data-action="memory-pin"[^>]*disabled/);
  assert.match(li, /data-action="cancel-request" data-request="r1"/);
  assert.match(li, /applies in 8 s/);
  const edit = openMemoryEdit(memory().entries[0], { v1: 'draft wording' });
  assert.deepEqual(edit, { id: 'v1', text: 'draft wording' }, 'reopening Edit starts from the saved draft');
  assert.deepEqual(openMemoryEdit(memory().entries[0], {}), { id: 'v1', text: 'Text of v1' });
  const editing = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', editing: edit });
  assert.match(editing, /<form class="memory-edit" data-form="memory-edit" data-entry="v1" data-revision="3">/);
  assert.match(editing, /<label for="memory-edit-text-[^"]+">Owner wording<\/label>/);
  assert.match(editing, />draft wording<\/textarea>/);
});

test('I1: while an edit is open the markup is identical across polls, whatever the owner has typed since', () => {
  const edit = openMemoryEdit(memory().entries[0], {});
  // The owner types: the app keeps the draft in its own state, never in the markup.
  const poll1 = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', editing: edit });
  const drafts = { v1: 'Text of v1 and more typed since' };
  assert.ok(drafts.v1);
  const poll2 = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', editing: edit });
  assert.equal(poll1, poll2);
  assert.match(poll1, />Text of v1<\/textarea>/, 'the textarea holds the text it opened with');
  assert.doesNotMatch(poll2, /typed since/);
});

test('I2: an entry shows its newest request; a pending one shows Undo and disables the actions', () => {
  const conflict = { id: 'r-old', kind: 'memory-forget', target_id: 'v1', state: 'conflict', created_at: '2026-10-02T11:00:00Z', error: { current_revision: 4 }, payload: {} };
  const pending = { id: 'r-new', kind: 'memory-forget', target_id: 'v1', state: 'pending', created_at: '2026-10-02T11:59:58Z', not_before: '2026-10-02T12:00:08Z', payload: {} };
  assert.equal(memoryRequestFor('v1', [conflict, pending]).id, 'r-new', 'a pending request beats an older conflict');
  assert.equal(memoryRequestFor('v1', [pending, conflict]).id, 'r-new', 'whatever order they arrive in');
  assert.equal(memoryEntryBusy('v1', [conflict, pending]), true);
  const html = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', pending: [conflict, pending] });
  const li = /<li class="memory-entry" data-entry="v1"[\s\S]*?<\/li>/.exec(html)[0];
  assert.match(li, /data-action="cancel-request" data-request="r-new"/);
  assert.match(li, /Undo/);
  assert.doesNotMatch(li, /Conflict:/);
  for (const action of ['memory-edit', 'memory-pin', 'memory-retire']) assert.match(li, new RegExp(`data-action="${action}"[^>]*disabled`), action);
  const older = { ...conflict, id: 'r-a', created_at: '2026-10-02T10:00:00Z', state: 'failed', error: { message: 'x' } };
  const newer = { ...conflict, id: 'r-b', created_at: '2026-10-02T11:00:00Z' };
  assert.equal(memoryRequestFor('v1', [newer, older]).id, 'r-b', 'the newest settled request, not the first');
  const applied = { id: 'r-c', kind: 'memory-forget', target_id: 'v1', state: 'applied', created_at: '2026-10-02T11:30:00Z', payload: {} };
  assert.equal(memoryRequestFor('v1', [newer, applied]), null, 'a later applied change clears an old conflict');
  assert.equal(memoryEntryBusy('v1', [newer]), false);
  const sending = { id: 'r-d', kind: 'memory-pin', target_id: 'v1', state: 'sending', payload: { pinned: true } };
  assert.equal(memoryRequestFor('v1', [newer, sending]).id, 'r-d', 'a request still being sent is the newest');
});

test('I2: a dismissed conflict or failure stays dismissed when the next poll brings it back', () => {
  const r = { id: 'r1', kind: 'memory-forget', target_id: 'v1', state: 'conflict' };
  assert.equal(tracksSnapshotRequest(r, undefined, new Set()), true, 'a conflict is tracked from the snapshot');
  assert.equal(tracksSnapshotRequest(r, undefined, new Set(['r1'])), false, 'until the owner dismisses it');
  assert.equal(tracksSnapshotRequest({ ...r, state: 'failed' }, { state: 'failed' }, new Set(['r1'])), false);
  assert.equal(tracksSnapshotRequest({ ...r, state: 'applied' }, undefined, new Set()), false, 'settled successes are tracked only when sent from here');
  assert.equal(tracksSnapshotRequest({ ...r, state: 'applied' }, { state: 'pending' }, new Set()), true);
  assert.equal(tracksSnapshotRequest({ ...r, state: 'applied' }, { state: 'already-applied' }, new Set()), false);
});

test('M2: Quarantine entries offer Approve, Edit and Retire but not Pin', () => {
  const q = renderMemory(memory(), snapshot(), { now: NOW, tab: 'quarantine' });
  assert.doesNotMatch(q, /data-action="memory-pin"/);
  assert.match(q, /data-action="memory-retire" data-entry="q1"/);
  assert.match(q, /data-action="memory-approve" data-entry="q1"/);
});

test('M9: a second change while one is in flight is refused with a message, not dropped', () => {
  const pending = [{ id: 'r1', kind: 'memory-forget', target_id: 'v1', state: 'pending', created_at: NOW, payload: {} }];
  assert.equal(memoryEntryBusy('v1', pending), true);
  assert.equal(memoryEntryBusy('m1', pending), false);
  assert.equal(MEMORY_BUSY_MESSAGE, 'A change to this entry is still being applied');
});

test('empty states tell no memory, an empty tab, no matches and a failed load apart', () => {
  assert.match(renderMemory({ entries: [], conflicts: [] }, snapshot(), { now: NOW }), /No memory yet/);
  const noQuarantine = { entries: memory().entries.filter((e) => e.trust !== 'quarantined'), conflicts: [] };
  assert.match(renderMemory(noQuarantine, snapshot(), { now: NOW, tab: 'quarantine' }), /Nothing awaiting approval/);
  assert.match(renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', filters: { ...EMPTY_FILTERS, q: 'zzz-nothing' } }), /No entries match/);
  assert.equal(memoryTabEntries(memory(), 'repo', { q: 'of v1' }).length, 1);
  assert.match(renderMemory(null, snapshot(), { now: NOW, status: { error: 'the server returned 500' } }), /Memory could not be loaded[\s\S]*the server returned 500[\s\S]*data-action="memory-reload"/);
  assert.match(renderMemory(null, snapshot(), { now: NOW }), /role="status"/);
});

test('several repositories get a selector; one repository does not', () => {
  const two = memory();
  two.entries.push(entry('x1', { repo_id: 'other' }));
  const snap = snapshot({ repos: [...snapshot().repos, { id: 'other', project_id: 'demo', display_name: 'Other repo', default_branch: 'main', deployment_environments: [] }] });
  const html = renderMemory(two, snap, { now: NOW, tab: 'repo', repo: 'other' });
  assert.match(html, /<select id="memory-repo" data-memory-repo>[\s\S]*<option value="other" selected>Other repo<\/option>/);
  assert.match(html, /Text of x1/);
  assert.doesNotMatch(html, /Text of v1/);
  assert.doesNotMatch(renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo' }), /data-memory-repo/);
});

test('Memory sits under Track on shortcut 8, outside the phone bar; 1 to 7 keep their views', () => {
  assert.deepEqual(NAV_ITEMS.find((n) => n[0] === 'memory'), ['memory', 'Memory', 'research', '8', 'track']);
  assert.equal(PHONE_PRIMARY.has('memory'), false);
  assert.deepEqual(SHORTCUT_VIEWS, { 1: 'picknext', 2: 'board', 3: 'tree', 4: 'sessions', 5: 'deployments', 6: 'today', 7: 'runs', 8: 'memory' });
  const side = renderSidebar(snapshot(), { view: 'memory', now: NOW, memory: memory() });
  assert.match(side, /<span class="nav-caption">Track<\/span>[\s\S]*aria-label="Memory, 7 items" data-view="memory" id="tab-memory" aria-selected="true"[^>]*aria-keyshortcuts="8"/);
  assert.match(side, /data-view="memory"[\s\S]*?<span class="badge" aria-hidden="true"[^>]*>7<\/span>/);
  assert.match(renderSidebar(snapshot(), { view: 'board', now: NOW, moreOpen: true, memory: memory() }), /class="more-panel"[\s\S]*data-view="memory"/, 'phones reach Memory through More');
  assert.match(renderHelpDialog(), /8 opens Memory/);
});

test('a static export has no Memory nav item and no memory text', () => {
  const exported = normalizeSnapshot(snapshot({ meta: { ...snapshot().meta, exported_at: NOW } }));
  const side = renderSidebar(exported, { view: 'picknext', now: NOW, memory: memory(), moreOpen: true });
  assert.doesNotMatch(side, /data-view="memory"/);
  const s = newState();
  ev(s, 'memory-tx', { op: 'filed', entry: { id: 'mem-x', scope: 'machine', section: 'tools', kind: 'fact', text: 'MEMPAGE-SENTINEL-9a1', trust: 'quarantined', quarantine_reason: 'MEMPAGE-REASON-9a1' } });
  const html = buildStaticHtml(buildSnapshot(s, { generation_id: 'gen-00000001', generated_at: NOW }), { exportedAt: NOW });
  assert.equal(html.includes('MEMPAGE-SENTINEL-9a1'), false);
  assert.equal(html.includes('MEMPAGE-REASON-9a1'), false);
  assert.equal(html.includes('/v1/memory'), false, 'the export bundles no memory endpoint');
});
