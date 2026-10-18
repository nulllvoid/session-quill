// The owner's Memory page (spec §6.4, §8; design system §5): Repo / Machine / Quarantine tabs, trust
// in words as well as colour, the actions the owner may take with pending state, empty states that
// tell no memory from no matches, Memory under Track on shortcut 8, and nothing of it in an export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, EMPTY_FILTERS, trustChip, TRUST_LABELS } from '../../ui/components.js';
import { renderMemory, MEMORY_TABS, memoryTabEntries } from '../../ui/views/memory.js';
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
  const editing = renderMemory(memory(), snapshot(), { now: NOW, tab: 'repo', editing: 'v1', drafts: { v1: 'draft wording' } });
  assert.match(editing, /<form class="memory-edit" data-form="memory-edit" data-entry="v1" data-revision="3">/);
  assert.match(editing, /<label for="memory-edit-text-[^"]+">Owner wording<\/label>/);
  assert.match(editing, />draft wording<\/textarea>/, 'a draft survives a re-render');
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
