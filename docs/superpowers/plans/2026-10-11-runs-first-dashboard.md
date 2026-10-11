# Runs-first dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dispatch → monitor → inspect evidence → decide → recover a straight path in the Quill dashboard: a Runs page with run detail, a run strip and Runs tab on tickets, one Run agent dialog, a phone-fitting shell, and the two P1 display bugs fixed.

**Architecture:** Everything stays in the existing plain-HTML-string UI (`ui/`). Pure derivations live in a new `ui/lib/runs.js`; renderers in `ui/views/runs.js`, `ui/views/run-detail.js` and `ui/views/run-dialog.js`; `ui/app.js` only wires state, hash routing and actions. All data comes from the snapshot the server already serves; there are no worker, server or contract changes.

**Tech Stack:** Node ≥ 22 ES modules, `node:test` + `node:assert/strict`, plain CSS in `ui/styles.css`, Playwright from the local Codex runtime for browser checks only (never a project dependency).

**Spec:** `docs/superpowers/specs/2026-10-11-runs-first-dashboard-design.md`

## Global Constraints

- Node ≥ 22, ES modules, plain HTML-string renderers; no framework, bundler or new runtime dependency; `package.json` gains nothing.
- No changes under `src/` except `src/export/static.js` (Task 1). No worker, server, data-contract or event changes.
- Route IDs `picknext`, `board`, `tree`, `sessions`, `deployments`, `today` keep working; `runs` is added. Shortcuts `1`–`6` keep their current targets; `7` opens Runs.
- Queued, running, tests passed and done stay distinct. Never show "Tests passed" without `test_gate.status === 'passed'`. Never show an ETA, a wait reason the snapshot lacks, or an agent/test phase while a run is running.
- Every string from the snapshot goes through `esc()` (text) or `attr()` (attributes). `worktree_path` is text only, never an `href` or a fetch, and only when `capabilities.handoff` is true.
- Exports (`meta.exported_at` set, mutation capabilities false) render no Cancel / Approve / Dismiss / Accept / Retry controls, no `worktree_path`, no Needs you tab, and no empty sections for fields the export stripped.
- Keep Geist, the evergreen accent and the semantic status colours. Only `--text-faint` (dark) and `--border-strong` (both themes) change value.
- Every new UI module must be reachable from `ui/app.js` imports so the static export bundles it (Task 1 makes this automatic).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `C:\Users\shiva\Downloads\session-tracker-docs\session-quill-uireview` on branch `feat/runs-first-dashboard`. Never touch `..\session-quill-1.0` (another agent edits it).

## Review Focus

1. **Snapshot generation changes while a result is loading** — the loader polls, retries once with the new generation, and otherwise shows the error with Retry; it never sits on "Loading…". Pinned in Task 2 (renderer states) and Task 13 (browser).
2. **A run whose ticket is missing or filtered out** — the row and run detail still render, saying the ticket is not in view; filters drop it from tabs only when a filter is set. Pinned in Tasks 4, 5 and 6.
3. **A field-restricted static export** (tickets without `tags`, handoffs stripped of results) — Runs and run detail render without throwing, with no Needs you tab and no empty sections. Pinned in Tasks 1, 4 and 6.
4. **A `run=` hash for a run that no longer exists** — the panel says "Run not found" with a way back. Pinned in Task 6 (`renderRunNotFound`) and Task 7.
5. **Long keys, titles, recipe names and result text at 390 px** — rows and panels truncate or wrap; `scrollWidth === innerWidth`. Pinned in Task 13.

---

### Task 1: Static export bundles the whole UI import graph

The export concatenates a hand-kept list of modules (`MODULE_ORDER`) that already misses `views/agents.js`, `views/today.js`, `views/bulk.js`, `lib/bulk.js` and `lib/proposals.js`, so an exported page throws when it opens ticket detail or Activity. Every later task adds modules, so derive the list from `ui/app.js`'s imports.

**Files:**
- Modify: `src/export/static.js:8-26`
- Test: `tests/export/static.test.js`

**Interfaces:**
- Produces: `uiModuleOrder(uiDir?: string): string[]` — UI-relative paths in dependency order, `lib/api.js` excluded, `app.js` excluded.

- [ ] **Step 1: Write the failing test** — append to `tests/export/static.test.js`:

```js
test('the static bundle contains every module app.js imports, dependencies first', async () => {
  const { uiModuleOrder } = await import('../../src/export/static.js');
  const order = uiModuleOrder();
  for (const rel of ['views/agents.js', 'views/today.js', 'views/bulk.js', 'lib/bulk.js', 'lib/proposals.js', 'components.js']) assert.ok(order.includes(rel), `${rel} bundled`);
  assert.ok(order.indexOf('components.js') < order.indexOf('views/detail.js'), 'dependencies come first');
  assert.equal(order.includes('lib/api.js'), false, 'the live API is never bundled');
  const bundle = bundleUiModules({ staticMode: true });
  for (const name of ['renderAgentsSection', 'renderToday', 'renderBatchStrips', 'freshProposals', 'activeBatches']) assert.ok(bundle.includes(`function ${name}(`), `${name} present`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/export/static.test.js`
Expected: FAIL with `uiModuleOrder is not a function` (and the bundle lacks `renderAgentsSection`).

- [ ] **Step 3: Implement** — in `src/export/static.js`, replace the `MODULE_ORDER` constant and the first line of `bundleUiModules`:

```js
// Every module app.js reaches, dependencies first, so a new UI module is bundled without a list to
// keep in sync. The live API is swapped for the static one.
export function uiModuleOrder(uiDir = UI_DIR) {
  const seen = new Set();
  const order = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const source = fs.readFileSync(path.join(uiDir, rel), 'utf8');
    for (const m of source.matchAll(/^import\s[^;]*from\s+'(\.[^']+)';\s*$/gm)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    order.push(rel);
  };
  walk('app.js');
  return order.filter((rel) => rel !== 'app.js' && rel !== 'lib/api.js');
}
```

```js
export function bundleUiModules({ staticMode = true, uiDir = UI_DIR } = {}) {
  const files = [...uiModuleOrder(uiDir), staticMode ? 'lib/api-static.js' : 'lib/api.js', 'app.js'];
```

Delete the old `const MODULE_ORDER = [...]` line.

- [ ] **Step 4: Run the export tests**

Run: `node --test tests/export/static.test.js`
Expected: PASS (including the existing "parses and stays inert without a DOM" test, which proves no duplicate top-level names).

- [ ] **Step 5: Commit**

```bash
git add src/export/static.js tests/export/static.test.js
git commit -m "fix(export): bundle every UI module app.js imports

The static export concatenated a hand-kept module list that missed the
agents, today and bulk views and two lib modules, so an exported page
threw when it opened ticket detail or Activity.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Full results and timeline text display, with loading and failure states (P1)

`load-content` fetches text into `appState.content`, but run results and timeline entries never render it, and only `generation-expired` failures are handled. One shared viewer renders every content ref.

**Files:**
- Modify: `ui/components.js` (add `contentViewer`)
- Modify: `ui/views/detail.js` (`timelineItem`, plans, checkpoints, `renderDetail` signature)
- Modify: `ui/views/agents.js` (`runItem`, `renderAgentsSection` signature)
- Modify: `ui/app.js` (`appState.contentStatus`, `loadContent`, `hide-content`, `renderDetailPanel`, `poll`)
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Produces: `contentViewer(ref: string|null, { content: Record<string,string>, status: Record<string,'loading'|{error:string}>, generation: string, label: string }): string`
- Produces: `renderDetail(ticket, snapshot, { ..., content, contentStatus })` and `renderAgentsSection(ticket, snapshot, { now, pending, content, contentStatus })`
- Produces: `appState.contentStatus` (object keyed by ref)

- [ ] **Step 1: Write the failing tests** — append to `tests/ui/render.test.js` (add `contentViewer` to the existing `../../ui/components.js` import):

```js
test('contentViewer shows a load button, loading, the escaped text with Hide, and a failure with Retry', () => {
  const ref = 'c'.repeat(64);
  assert.match(contentViewer(ref, { content: {}, status: {}, generation: 'g1', label: 'Show full result' }), /data-action="load-content" data-hash="c{64}" data-generation="g1">Show full result</);
  const loading = contentViewer(ref, { content: {}, status: { [ref]: 'loading' }, generation: 'g1', label: 'x' });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading/);
  const loaded = contentViewer(ref, { content: { [ref]: '<b>done</b>' }, status: {}, generation: 'g1', label: 'x' });
  assert.match(loaded, /<pre class="full">&lt;b&gt;done&lt;\/b&gt;<\/pre>/);
  assert.match(loaded, /data-action="hide-content" data-hash="c{64}"/);
  const failed = contentViewer(ref, { content: {}, status: { [ref]: { error: 'boom <x>' } }, generation: 'g1', label: 'x' });
  assert.match(failed, /role="alert"[^>]*>Could not load: boom &lt;x&gt;/);
  assert.match(failed, /data-action="load-content"[^>]*>Retry</);
  assert.equal(contentViewer(null, { content: {}, status: {}, generation: 'g1', label: 'x' }), '');
});

test('a run result and a timeline entry render their loaded full text', () => {
  const s = snapshot();
  const ref = 'b'.repeat(64);
  const t = { ...s.tickets[4], handoff_ids: ['h1'], timeline: [{ id: 'e1', at: '2026-10-02T09:00:00Z', kind: 'plan', text: 'plan text', event_id: 'x', content_ref: 'd'.repeat(64), coverage: 'complete' }], timeline_total: 1 };
  const content = { [ref]: 'FULL-RESULT-SENTINEL', ['d'.repeat(64)]: 'FULL-TIMELINE-SENTINEL' };
  const overview = renderDetail(t, s, { now: NOW, pending: [], content, contentStatus: {} });
  assert.match(overview, /FULL-RESULT-SENTINEL/);
  const activity = renderDetail(t, s, { now: NOW, pending: [], content, contentStatus: {}, tab: 'activity' });
  assert.match(activity, /FULL-TIMELINE-SENTINEL/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL — `contentViewer` is not exported; the sentinels are absent.

- [ ] **Step 3: Implement `contentViewer`** — add to `ui/components.js` after `pager`:

```js
// Loaded text for a content ref (results, timeline entries, plans, checkpoints) with its loading
// and failure states. A failure always offers Retry; nothing is left silently empty.
export function contentViewer(ref, { content = {}, status = {}, generation = '', label = 'Full text' } = {}) {
  if (!ref) return '';
  if (Object.hasOwn(content, ref)) return `<div class="content-viewer" data-ref="${attr(ref)}"><button type="button" class="link small" data-action="hide-content" data-hash="${attr(ref)}">Hide</button><pre class="full">${esc(content[ref])}</pre></div>`;
  const st = status[ref];
  if (st === 'loading') return `<div class="content-viewer" data-ref="${attr(ref)}" aria-busy="true"><span class="muted small">Loading…</span></div>`;
  if (st && st.error) return `<div class="content-viewer" data-ref="${attr(ref)}"><span class="small critical" role="alert">Could not load: ${esc(st.error)}</span> <button type="button" class="btn small ghost" data-action="load-content" data-hash="${attr(ref)}" data-generation="${attr(generation)}">Retry</button></div>`;
  return `<button type="button" class="link small" data-action="load-content" data-hash="${attr(ref)}" data-generation="${attr(generation)}">${esc(label)}</button>`;
}
```

- [ ] **Step 4: Use it in `ui/views/detail.js`** — add `contentViewer` to the components import, then:

Replace `timelineItem` with:

```js
function timelineItem(e, { now, tz, generation, content, contentStatus }) {
  const kindLabel = { bind: 'Bound', write: 'Write', tool: 'Tool', commit: 'Commit', pr: 'PR', plan: 'Plan', conclusion: 'Conclusion', handoff: 'Handoff', comment: 'Comment', proposal: 'Proposed run', status: 'Status', deployment: 'Deployment', 'capture-error': 'Capture error' }[e.kind] ?? e.kind;
  return `<li class="timeline-item" data-kind="${attr(e.kind)}"><span class="tl-kind">${esc(kindLabel)}</span> ${timeEl(e.at, now, tz)} <span class="tl-text">${esc(e.text)}</span>${e.coverage !== 'complete' ? ` <span class="chip warning small" title="Change coverage">${esc(e.coverage)}</span>` : ''} ${contentViewer(e.content_ref, { content, status: contentStatus, generation, label: 'Full text' })}</li>`;
}
```

Change the `renderDetail` signature to accept `contentStatus = {}`:

```js
export function renderDetail(rawTicket, rawSnapshot, { now, pending = [], content = {}, contentStatus = {}, loadedTicket = null, editingNext = false, tab = 'overview', expanded = false }) {
```

Add one line after `const total = ...`:

```js
  const viewer = (ref, label) => contentViewer(ref, { content, status: contentStatus, generation: snapshot.generation_id, label });
```

In the Approved plans section replace
`${p.content_ref ? `<button type="button" class="link small" data-action="load-content" data-hash="${attr(p.content_ref)}" data-generation="${attr(snapshot.generation_id)}">Full plan</button>${content[p.content_ref] ? `<pre class="full">${esc(content[p.content_ref])}</pre>` : ''}` : ''}`
with `${viewer(p.content_ref, 'Full plan')}`.

In the checkpoints section replace
`<button type="button" class="link small" data-action="load-content" data-hash="${attr(c.content_ref)}" data-generation="${attr(snapshot.generation_id)}">Full checkpoint</button>${content[c.content_ref] ? `<pre class="full">${esc(content[c.content_ref])}</pre>` : ''}`
with `${viewer(c.content_ref, 'Full checkpoint')}`.

Change the timeline map call to `timelineItem(e, { now, tz, generation: snapshot.generation_id, content, contentStatus })`, and the agents call to `renderAgentsSection(t, snapshot, { now, pending, content, contentStatus })`.

- [ ] **Step 5: Use it in `ui/views/agents.js`** — add `contentViewer` to the components import; change the signatures and the result button:

```js
function runItem(h, ticket, snapshot, { now, tz, caps, pending, content = {}, contentStatus = {} }) {
```

Replace `${h.result_ref ? `<button type="button" class="link small" data-action="load-content" data-hash="${attr(h.result_ref)}" data-generation="${attr(snapshot.generation_id)}">Partial/full result</button>` : ''}` with
`${contentViewer(h.result_ref, { content, status: contentStatus, generation: snapshot.generation_id, label: h.state === 'done' ? 'Show full result' : 'Show partial result' })}`.

```js
export function renderAgentsSection(ticket, rawSnapshot, { now, pending = [], content = {}, contentStatus = {} } = {}) {
```

and in its body `runItem(h, ticket, snapshot, { now, tz, caps, pending, content, contentStatus })`.

- [ ] **Step 6: Wire loading in `ui/app.js`**

Add `contentStatus: {},` to `appState` after `content: {},`.

Add this function after `cancelBatch`:

```js
// Loads one content ref. A snapshot that moved on is polled and the load retried once with the new
// generation; any other failure stays visible with Retry.
async function loadContent(hash, generation, retried = false) {
  appState.contentStatus[hash] = 'loading';
  render();
  try {
    const text = await api.getContent(hash, generation);
    delete appState.contentStatus[hash];
    appState.content[hash] = text ?? '(content unavailable: capture incomplete)';
  } catch (err) {
    if (err.code === 'generation-expired' && !retried) { await poll(); return loadContent(hash, appState.snapshot.generation_id, true); }
    appState.contentStatus[hash] = { error: err.message || 'the request failed' };
  }
  render();
}
```

Replace the `load-content` case and add `hide-content`:

```js
    case 'load-content': loadContent(el.dataset.hash, el.dataset.generation); break;
    case 'hide-content': delete appState.content[el.dataset.hash]; render(); break;
```

In `poll`, change `if (changed) { appState.content = {}; appState.loadedTicket = null; }` to
`if (changed) { appState.content = {}; appState.contentStatus = {}; appState.loadedTicket = null; }`.

In `renderDetailPanel`, pass `contentStatus: appState.contentStatus` to `renderDetail` beside `content`.

- [ ] **Step 7: Run the UI tests**

Run: `node --test "tests/ui/*.test.js" tests/agents/run.test.js tests/handoff/files.test.js`
Expected: PASS. If an existing assertion matched the old `Partial/full result` label, update it to `/Show (full|partial) result/`.

- [ ] **Step 8: Commit**

```bash
git add ui/components.js ui/views/detail.js ui/views/agents.js ui/app.js tests/ui/render.test.js
git commit -m "fix(ui): show loaded run results and timeline text, with load failures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sessions → View checkpoints opens the checkpoint's own ticket (P1)

**Files:**
- Modify: `ui/views/sessions.js:30`
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Consumes: `snapshot.checkpoints[].ticket_id`, `session.last_checkpoint_id`

- [ ] **Step 1: Write the failing test** — append to `tests/ui/render.test.js` (`TID` is exported by `fixtures.js`; import it if the file does not yet):

```js
test('Sessions links the checkpoint to the ticket it was captured on, not the current binding', () => {
  const base = snapshot();
  const rebound = { ...base, sessions: [{ ...base.sessions[0], current_ticket_id: TID(1), ticket_ids: [TID(2), TID(1)] }] };
  const html = renderSessions(rebound, noFilters, { now: NOW, page: 0 });
  assert.match(html, new RegExp(`data-open="${TID(2)}" data-section="activity">View checkpoints on ${base.tickets[1].key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(html, new RegExp(`data-open="${TID(1)}" data-section="activity"`));
  const missing = { ...base, checkpoints: [] };
  assert.doesNotMatch(renderSessions(missing, noFilters, { now: NOW, page: 0 }), /View checkpoints/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL — the link targets `TID(1)` and says "View checkpoints".

- [ ] **Step 3: Implement** — in `ui/views/sessions.js`, inside the row map, after `const current = ...` add:

```js
    // The preview belongs to the checkpoint's own ticket; a later rebind does not move it.
    const checkpoint = s.last_checkpoint_id ? snapshot.checkpoints.find((c) => c.id === s.last_checkpoint_id) : null;
    const checkpointTicket = checkpoint && checkpoint.ticket_id ? ticketById(snapshot, checkpoint.ticket_id) : null;
```

and replace the checkpoint cell (`<td class="preview">…</td>`) with:

```js
  <td class="preview">${s.last_checkpoint_preview ? `<span title="${attr(s.last_checkpoint_preview.slice(0, 300))}">${esc(s.last_checkpoint_preview.slice(0, 180))}${s.last_checkpoint_preview.length > 180 ? '…' : ''}</span>${checkpointTicket ? `<button type="button" class="link small" data-open="${attr(checkpointTicket.id)}" data-section="activity">View checkpoints on ${esc(checkpointTicket.key)}</button>` : ''}` : '<span class="muted" aria-label="none">-</span>'}${current?.next_action ? `<p class="small"><strong>Next on ${esc(current.key)}</strong> ${esc(current.next_action)}</p>` : ''}</td>
```

- [ ] **Step 4: Run the UI tests**

Run: `node --test "tests/ui/*.test.js"`
Expected: PASS. If `workspace-design.test.js` asserted the exact text `View checkpoints</button>`, update it to `/View checkpoints on /`.

- [ ] **Step 5: Commit**

```bash
git add ui/views/sessions.js tests/ui/render.test.js
git commit -m "fix(ui): Sessions opens the checkpoint's own ticket after a rebind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Runs model (`ui/lib/runs.js`)

Pure functions: tab membership, batch grouping, row facts. Everything later tasks render comes from here.

**Files:**
- Create: `ui/lib/runs.js`
- Test: `tests/ui/runs.test.js`

**Interfaces:**
- Consumes: `ticketById(snapshot, id)`, `matchesFilters(ticket, filters, snapshot)`, `formatDuration(ms)` from `ui/components.js`
- Produces:
  - `RUN_TABS = ['needs','live','failed','all']`, `RUN_TAB_LABELS`
  - `isStaticSnapshot(snapshot): boolean`, `visibleRunTabs(snapshot): string[]`
  - `ticketRuns(snapshot, ticketId): Handoff[]` (newest first)
  - `supersededBy(snapshot, h): { run: Handoff, retried: boolean } | null`
  - `openSuggestions(h): Suggestion[]`
  - `needsYou(snapshot, h, now: string): boolean`
  - `runTabs(snapshot, filters, now): { needs: Item[], live: Item[], failed: Item[], all: Item[] }` where `Item = { kind: 'run', id, at, run } | { kind: 'proposal', id, at, proposal }`, newest first
  - `defaultRunTab(tabs, names): string`
  - `groupRuns(items): Array<Item | { kind: 'batch', id, at, items: Item[] }>`
  - `runFacts(snapshot, h, now): string[]` (plain text; callers escape)
  - `liveRunCount(snapshot): number`, `needsYouCount(snapshot, now): number`

- [ ] **Step 1: Write the failing tests** — create `tests/ui/runs.test.js`:

```js
// Runs model (spec §2): tabs, grouping and the facts a row may state, from snapshot records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, EMPTY_FILTERS } from '../../ui/components.js';
import { runTabs, needsYou, groupRuns, runFacts, supersededBy, defaultRunTab, visibleRunTabs, liveRunCount, needsYouCount, ticketRuns, RUN_TABS } from '../../ui/lib/runs.js';
import { snapshot, TID } from './fixtures.js';

const NOW = '2026-10-10T12:00:00Z';
let seq = 0;
export const run = (extra = {}) => ({ id: `run-${++seq}`, ticket_id: TID(1), request_id: `req-${seq}`, mode: 'analyse', permissions: {}, repo_id: 'demo', state: 'done', requested_at: '2026-10-10T10:00:00Z', started_at: '2026-10-10T10:00:05Z', finished_at: '2026-10-10T10:05:00Z', error: null, suggestions: [], changed_files: [], uncertain_effects: [], ...extra });
const snap = (handoffs, extra = {}) => normalizeSnapshot({ ...snapshot(), handoffs, ...extra });
const ids = (items) => items.map((i) => i.id);

test('Live holds queued and running; Failed holds failed, timed-out and cancelled', () => {
  const q = run({ state: 'queued' }), r = run({ state: 'running' }), f = run({ state: 'failed' }), to = run({ state: 'timed-out' }), c = run({ state: 'cancelled' }), d = run();
  const tabs = runTabs(snap([q, r, f, to, c, d]), EMPTY_FILTERS, NOW);
  assert.deepEqual(new Set(ids(tabs.live)), new Set([q.id, r.id]));
  assert.deepEqual(new Set(ids(tabs.failed)), new Set([f.id, to.id, c.id]));
  assert.equal(tabs.all.length, 6);
});

test('Needs you: open suggestions, recent unsuperseded failures on open tickets, open proposals; never cancelled runs', () => {
  const withSuggestion = run({ suggestions: [{ id: 's1', type: 'next-action', text: 'x', state: 'proposed' }] });
  const resolved = run({ suggestions: [{ id: 's2', type: 'next-action', text: 'x', state: 'accepted' }] });
  const recentFail = run({ state: 'failed', ticket_id: TID(2), finished_at: '2026-10-09T12:00:00Z' });
  const oldFail = run({ state: 'failed', ticket_id: TID(3), finished_at: '2026-10-01T12:00:00Z' });
  const doneTicketFail = run({ state: 'failed', ticket_id: TID(4), finished_at: '2026-10-09T12:00:00Z' });
  const cancelled = run({ state: 'cancelled', ticket_id: TID(5), finished_at: '2026-10-09T12:00:00Z' });
  const supersededFail = run({ state: 'timed-out', ticket_id: TID(6), requested_at: '2026-10-09T10:00:00Z', finished_at: '2026-10-09T10:20:00Z' });
  const later = run({ state: 'done', ticket_id: TID(6), requested_at: '2026-10-09T11:00:00Z' });
  const proposal = { id: 'p1', ticket_id: TID(1), state: 'proposed', proposed_at: '2026-10-10T11:00:00Z', recipe: { name: 'analyse' } };
  const expired = { id: 'p2', ticket_id: TID(1), state: 'expired', proposed_at: '2026-09-01T11:00:00Z', recipe: { name: 'analyse' } };
  const s = snap([withSuggestion, resolved, recentFail, oldFail, doneTicketFail, cancelled, supersededFail, later], { run_proposals: [proposal, expired] });
  const needs = ids(runTabs(s, EMPTY_FILTERS, NOW).needs);
  assert.deepEqual(new Set(needs), new Set([withSuggestion.id, recentFail.id, 'p1']));
  assert.equal(needsYou(s, cancelled, NOW), false);
  assert.ok(ids(runTabs(s, EMPTY_FILTERS, NOW).all).includes('p2'), 'expired proposals stay visible in All');
  assert.equal(needsYouCount(s, NOW), 3);
});

test('a retry is told apart from a later unrelated run', () => {
  const failed = run({ state: 'failed', requested_at: '2026-10-09T10:00:00Z' });
  const retry = run({ requested_at: '2026-10-09T11:00:00Z', retry_of: failed.id });
  assert.deepEqual(supersededBy(snap([failed, retry]), failed), { run: retry, retried: true });
  const other = run({ requested_at: '2026-10-09T11:00:00Z' });
  assert.equal(supersededBy(snap([failed, other]), failed).retried, false);
  assert.equal(supersededBy(snap([failed]), failed), null);
});

test('All covers 30 days, filters apply through the ticket, and a missing ticket is kept only without filters', () => {
  const old = run({ requested_at: '2026-09-01T10:00:00Z' });
  const orphan = run({ ticket_id: 'gone' });
  const s = snap([old, orphan]);
  assert.deepEqual(ids(runTabs(s, EMPTY_FILTERS, NOW).all), [orphan.id]);
  assert.deepEqual(runTabs(s, { ...EMPTY_FILTERS, category: 'bugfix' }, NOW).all, []);
});

test('groupRuns keeps batches together at the position of their newest member', () => {
  const a1 = { kind: 'run', id: 'a1', at: '3', run: { batch_id: 'B' } };
  const solo = { kind: 'run', id: 's', at: '2', run: {} };
  const a2 = { kind: 'run', id: 'a2', at: '1', run: { batch_id: 'B' } };
  const out = groupRuns([a1, solo, a2]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'batch');
  assert.deepEqual(out[0].items.map((i) => i.id), ['a1', 'a2']);
  assert.equal(out[1].id, 's');
});

test('queued facts state occupancy only; repository busy only for a queued fix', () => {
  const runningRead = run({ state: 'running', repo_id: 'demo' });
  const runningRead2 = run({ state: 'running', repo_id: 'demo' });
  const queuedRead = run({ state: 'queued' });
  const s = snap([runningRead, runningRead2, queuedRead], { meta: { ...snapshot().meta, handoff_limits: { readonly: 2, fix: 1 } } });
  assert.deepEqual(runFacts(s, queuedRead, NOW), ['Queued', 'read-only slots 2/2 in use']);
  const runningFix = run({ state: 'running', permissions: { edit_source: true }, repo_id: 'demo' });
  const queuedFix = run({ state: 'queued', permissions: { edit_source: true }, repo_id: 'demo' });
  const s2 = snap([runningFix, queuedFix], { meta: { ...snapshot().meta, handoff_limits: { readonly: 2, fix: 1 } } });
  assert.deepEqual(runFacts(s2, queuedFix, NOW), ['Queued', 'fix slots 1/1 in use', 'repository busy']);
  assert.deepEqual(runFacts(snap([queuedRead]), queuedRead, NOW), ['Queued'], 'no caps known, no claim');
  for (const f of [...runFacts(s, queuedRead, NOW), ...runFacts(s2, queuedFix, NOW)]) assert.doesNotMatch(f, /\b(eta|minutes? left|because)\b/i);
});

test('running facts never claim an agent or test phase', () => {
  const r = run({ state: 'running', started_at: '2026-10-10T11:58:00Z', timings: { queue_wait_ms: 1000, worktree_ms: 4000 } });
  const facts = runFacts(snap([r]), r, NOW);
  assert.match(facts[0], /^Running for /);
  assert.match(facts[1], /^setup /);
  assert.equal(facts.some((f) => /agent|tests?/i.test(f)), false);
});

test('done and failed facts', () => {
  const d = run({ suggestions: [{ id: 'a', state: 'proposed' }, { id: 'b', state: 'proposed' }], changed_files: ['a.js'], pr_url: 'https://x/pr/1' });
  assert.deepEqual(runFacts(snap([d]), d, NOW), ['2 suggestions to review', '1 file changed', 'draft PR opened']);
  const f = run({ state: 'failed', error: { message: 'tests failed after repair' }, requested_at: '2026-10-09T10:00:00Z' });
  const retry = run({ retry_of: f.id, requested_at: '2026-10-09T11:00:00Z' });
  assert.deepEqual(runFacts(snap([f, retry]), f, NOW), ['tests failed after repair', 'Retried as a new run']);
});

test('tabs, defaults and counts', () => {
  const s = snap([run({ state: 'queued' })]);
  assert.deepEqual(visibleRunTabs(s), RUN_TABS);
  const exported = snap([run({ state: 'queued' })], { meta: { ...snapshot().meta, exported_at: NOW }, capabilities: { read: true } });
  assert.deepEqual(visibleRunTabs(exported), ['live', 'failed', 'all']);
  assert.deepEqual(runTabs(exported, EMPTY_FILTERS, NOW).needs, []);
  const tabs = runTabs(s, EMPTY_FILTERS, NOW);
  assert.equal(defaultRunTab(tabs, RUN_TABS), 'live');
  assert.equal(defaultRunTab({ needs: [], live: [], failed: [], all: [] }, RUN_TABS), 'all');
  assert.equal(liveRunCount(s), 1);
  assert.equal(ticketRuns(snap([run({ requested_at: '1' }), run({ requested_at: '2' })]), TID(1))[0].requested_at, '2');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/runs.test.js`
Expected: FAIL with `Cannot find module '.../ui/lib/runs.js'`.

- [ ] **Step 3: Implement** — create `ui/lib/runs.js`:

```js
// Runs (spec §2): which tab a run belongs to, batch groups, and the facts a row may state. Pure
// functions over snapshot records; nothing here guesses a reason or an ETA the worker did not record.
import { ticketById, matchesFilters, formatDuration } from '../components.js';

export const RUN_TABS = ['needs', 'live', 'failed', 'all'];
export const RUN_TAB_LABELS = { needs: 'Needs you', live: 'Live', failed: 'Failed', all: 'All' };
const LIVE = new Set(['queued', 'running']);
const FAILED = new Set(['failed', 'timed-out', 'cancelled']);
const DAY_MS = 86_400_000;
const NEEDS_WINDOW_MS = 7 * DAY_MS;
const ALL_WINDOW_MS = 30 * DAY_MS;

const newestFirst = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function isStaticSnapshot(snapshot) {
  return !!(snapshot.meta && snapshot.meta.exported_at);
}

// An export cannot act and strips suggestions, so it has no Needs you tab.
export function visibleRunTabs(snapshot) {
  return isStaticSnapshot(snapshot) ? RUN_TABS.filter((t) => t !== 'needs') : RUN_TABS;
}

export function ticketRuns(snapshot, ticketId) {
  return (snapshot.handoffs ?? []).filter((h) => h.ticket_id === ticketId).sort((a, b) => (a.requested_at < b.requested_at ? 1 : a.requested_at > b.requested_at ? -1 : 0));
}

// The run that retried this one (Retry as new run), else the next run on the same ticket.
export function supersededBy(snapshot, h) {
  const later = (snapshot.handoffs ?? []).filter((x) => x.id !== h.id && x.ticket_id === h.ticket_id && x.requested_at > h.requested_at);
  const retry = later.find((x) => x.retry_of && (x.retry_of === h.id || x.retry_of === h.request_id));
  if (retry) return { run: retry, retried: true };
  const next = later.sort((a, b) => (a.requested_at < b.requested_at ? -1 : 1))[0];
  return next ? { run: next, retried: false } : null;
}

export function openSuggestions(h) {
  return (h.suggestions ?? []).filter((s) => s.state === 'proposed');
}

// A finished run needs the owner while it has suggestions to decide on; a failure does for 7 days,
// on a ticket that is still open, until any later run on that ticket supersedes it. Cancelled runs
// never do: the owner cancelled them.
export function needsYou(snapshot, h, now) {
  if (h.state === 'done') return openSuggestions(h).length > 0;
  if (h.state !== 'failed' && h.state !== 'timed-out') return false;
  const t = ticketById(snapshot, h.ticket_id);
  if (!t || t.status === 'done') return false;
  if (Date.parse(now) - Date.parse(h.finished_at ?? h.requested_at) > NEEDS_WINDOW_MS) return false;
  return !supersededBy(snapshot, h);
}

function hasFilters(f = {}) {
  return !!(f.project || f.category || f.tag || f.repo || f.stale || f.q);
}

export function runTabs(snapshot, filters, now) {
  const keep = (ticketId) => {
    const t = ticketById(snapshot, ticketId);
    return t ? matchesFilters(t, filters, snapshot) : !hasFilters(filters);
  };
  const runs = (snapshot.handoffs ?? []).filter((h) => keep(h.ticket_id)).map((h) => ({ kind: 'run', id: h.id, at: h.requested_at ?? '', run: h }));
  const proposals = (snapshot.run_proposals ?? []).filter((p) => (p.state === 'proposed' || p.state === 'expired') && keep(p.ticket_id)).map((p) => ({ kind: 'proposal', id: p.id, at: p.proposed_at ?? '', proposal: p }));
  const nowMs = Date.parse(now);
  const tabs = {
    needs: isStaticSnapshot(snapshot) ? [] : [...proposals.filter((x) => x.proposal.state === 'proposed'), ...runs.filter((x) => needsYou(snapshot, x.run, now))],
    live: runs.filter((x) => LIVE.has(x.run.state)),
    failed: runs.filter((x) => FAILED.has(x.run.state)),
    all: [...proposals, ...runs.filter((x) => nowMs - Date.parse(x.at) <= ALL_WINDOW_MS)],
  };
  for (const k of RUN_TABS) tabs[k].sort(newestFirst);
  return tabs;
}

export function defaultRunTab(tabs, names) {
  for (const k of ['needs', 'live']) if (names.includes(k) && tabs[k].length) return k;
  return 'all';
}

// Runs sharing a batch_id stay together, placed where their newest member falls.
export function groupRuns(items) {
  const out = [];
  const batches = new Map();
  for (const item of items) {
    const batchId = item.kind === 'run' ? item.run.batch_id : null;
    if (!batchId) { out.push(item); continue; }
    let group = batches.get(batchId);
    if (!group) { group = { kind: 'batch', id: batchId, at: item.at, items: [] }; batches.set(batchId, group); out.push(group); }
    group.items.push(item);
  }
  return out;
}

// What a row may say about a run: occupancy facts while queued, elapsed time while running, and
// outcomes once finished. Plain text; the caller escapes.
export function runFacts(snapshot, h, now) {
  const facts = [];
  if (h.state === 'queued') {
    facts.push('Queued');
    const fix = !!(h.permissions && h.permissions.edit_source);
    const running = (snapshot.handoffs ?? []).filter((x) => x.state === 'running' && !!(x.permissions && x.permissions.edit_source) === fix);
    const limits = snapshot.meta && snapshot.meta.handoff_limits;
    const cap = limits ? limits[fix ? 'fix' : 'readonly'] : null;
    if (Number.isInteger(cap) && running.length >= cap) facts.push(`${fix ? 'fix' : 'read-only'} slots ${running.length}/${cap} in use`);
    if (fix && h.repo_id && running.some((x) => x.repo_id === h.repo_id)) facts.push('repository busy');
  } else if (h.state === 'running') {
    facts.push(h.started_at ? `Running for ${formatDuration(Math.max(0, Date.parse(now) - Date.parse(h.started_at)))}` : 'Running');
    if (h.timings && Number.isFinite(h.timings.worktree_ms)) facts.push(`setup ${formatDuration(h.timings.worktree_ms)}`);
  } else if (h.state === 'done') {
    const open = openSuggestions(h).length;
    if (open) facts.push(`${plural(open, 'suggestion')} to review`);
    if ((h.changed_files ?? []).length) facts.push(`${plural(h.changed_files.length, 'file')} changed`);
    if (h.pr_url) facts.push('draft PR opened');
    if (!facts.length) facts.push('Finished');
  } else {
    facts.push(h.error && h.error.message ? h.error.message : h.state === 'cancelled' ? 'Cancelled' : h.state === 'timed-out' ? 'Timed out' : 'Failed');
    const next = supersededBy(snapshot, h);
    if (next) facts.push(next.retried ? 'Retried as a new run' : 'Superseded by a later run');
  }
  return facts;
}

export function liveRunCount(snapshot) {
  return (snapshot.handoffs ?? []).filter((h) => LIVE.has(h.state)).length;
}

export function needsYouCount(snapshot, now) {
  return runTabs(snapshot, {}, now).needs.length;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/ui/runs.test.js`
Expected: PASS. If the `Running for` / `setup` assertions fail only because `formatDuration` returns a different prefix, keep the assertions and fix the code, not the test.

- [ ] **Step 5: Commit**

```bash
git add ui/lib/runs.js tests/ui/runs.test.js
git commit -m "feat(ui): runs model for tabs, batches and row facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Runs page renderer (`ui/views/runs.js`)

**Files:**
- Create: `ui/views/runs.js`
- Modify: `ui/components.js` (add `shortKey`)
- Modify: `ui/views/agents.js` (export `SOURCE_LABELS`, add `testGateBadge`, `accessBadge`)
- Test: `tests/ui/runs.test.js`

**Interfaces:**
- Consumes: Task 4 exports; `batchProgress(snapshot, batchId)` from `ui/lib/bulk.js`; `proposalItem` from `ui/components.js`
- Produces:
  - `shortKey(key: string, max = 22): string` in `ui/components.js`
  - `testGateBadge(gate): string` (plain chip, no interactive content) and `accessBadge(h): string` in `ui/views/agents.js`
  - `runRow(snapshot, h, { now, tz, selected }): string` — an `<li>` containing one `<button data-action="open-run" data-run="<id>">`
  - `renderRuns(snapshot, filters, { now, pending, tab, selectedRun }): string`

- [ ] **Step 1: Write the failing tests** — append to `tests/ui/runs.test.js` (extend the imports):

```js
import { renderRuns, runRow } from '../../ui/views/runs.js';
import { shortKey } from '../../ui/components.js';

test('shortKey keeps short keys and middle-ellipsises long ones', () => {
  assert.equal(shortKey('PROJ-44'), 'PROJ-44');
  const k = 'LOCAL-preserve-session-checkpoints-00000001';
  const out = shortKey(k);
  assert.ok(out.length <= 22);
  assert.ok(out.startsWith('LOCAL-pre') && out.endsWith('00000001') && out.includes('…'));
});

test('the Runs page shows tabs with counts, batch groups with Cancel queued, and escaped rows', () => {
  const b1 = run({ state: 'queued', batch_id: 'batch-7f3a0000', ticket_id: TID(1) });
  const b2 = run({ state: 'done', batch_id: 'batch-7f3a0000', ticket_id: TID(2), suggestions: [{ id: 's', state: 'proposed' }] });
  const solo = run({ state: 'running', ticket_id: TID(5), recipe: { name: '<img src=x>', source: 'personal' } });
  const s = snap([b1, b2, solo]);
  const html = renderRuns(s, EMPTY_FILTERS, { now: NOW, tab: 'all' });
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-tab="needs"[^>]*>Needs you <span class="count">1<\/span>/);
  assert.match(html, /data-tab="live"[^>]*>Live <span class="count">2<\/span>/);
  assert.match(html, /data-batch="batch-7f3a0000"/);
  assert.match(html, /Batch batch-7f/);
  assert.match(html, /data-action="cancel-batch" data-batch="batch-7f3a0000">Cancel queued \(1\)/);
  assert.match(html, /data-action="open-run" data-run="run-\d+"/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test('rows survive a missing ticket and pick the default tab', () => {
  const orphan = run({ state: 'running', ticket_id: 'gone' });
  const html = renderRuns(snap([orphan]), EMPTY_FILTERS, { now: NOW });
  assert.match(html, /aria-selected="true"[^>]*data-tab="live"|data-tab="live"[^>]*aria-selected="true"/);
  assert.match(html, /Ticket not in view/);
});

test('proposals: open ones can be approved, expired ones cannot', () => {
  const open = { id: 'p1', ticket_id: TID(1), ticket_key: 'K', publisher: 'team', editor: 'ed', state: 'proposed', proposed_at: '2026-10-10T11:00:00Z', recipe: { name: 'analyse' }, access: 'standard', permissions: {}, read_only: true };
  const expired = { ...open, id: 'p2', state: 'expired', proposed_at: '2026-09-01T11:00:00Z' };
  const html = renderRuns(snap([], { run_proposals: [open, expired] }), EMPTY_FILTERS, { now: NOW, tab: 'all' });
  assert.match(html, /data-action="approve-run"[^>]*data-proposal="p1"/);
  assert.doesNotMatch(html, /data-proposal="p2" aria-label="Approve/);
  assert.match(html, /data-proposal="p2"[^>]*data-state="expired"/);
  assert.match(html, /Expired · older than 7 days/);
});

test('an export shows no Needs you tab and no controls', () => {
  const s = snap([run({ state: 'queued', batch_id: 'b' })], { meta: { ...snapshot().meta, exported_at: NOW }, capabilities: { read: true } });
  const html = renderRuns(s, EMPTY_FILTERS, { now: NOW });
  assert.doesNotMatch(html, /data-tab="needs"/);
  assert.doesNotMatch(html, /cancel-batch|approve-run|dismiss-run/);
});

test('a row is one button with the state in its label and a plain test-gate chip', () => {
  const h = run({ test_gate: { status: 'failed', command: 'npm test', tail: 'boom' } });
  const html = runRow(snap([h]), h, { now: NOW, tz: 'UTC' });
  assert.match(html, /<button type="button" class="run-open" data-action="open-run" data-run="run-\d+" aria-label="[^"]*done[^"]*"/);
  assert.match(html, /Tests failed/);
  assert.doesNotMatch(html, /<details/, 'nothing interactive nests inside the row button');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/runs.test.js`
Expected: FAIL with `Cannot find module '.../ui/views/runs.js'`.

- [ ] **Step 3: Add `shortKey`** to `ui/components.js` after `keyEl`:

```js
// Long local keys keep their prefix and unique suffix; the full key stays in titles and copies.
export function shortKey(key, max = 22) {
  const k = String(key ?? '');
  if (k.length <= max) return k;
  const tail = Math.floor((max - 1) / 2);
  return `${k.slice(0, max - 1 - tail)}…${k.slice(-tail)}`;
}
```

- [ ] **Step 4: Add badges to `ui/views/agents.js`** — change `const SOURCE_LABELS` to `export const SOURCE_LABELS`, and add after `testGateChip`:

```js
// The test gate as a plain chip, for places where a disclosure cannot nest (row buttons).
export function testGateBadge(g) {
  if (!g || !g.status) return '';
  if (g.status === 'passed') return '<span class="chip good small">Tests passed (worker)</span>';
  if (g.status === 'skipped') return '<span class="chip small">Not test-verified</span>';
  return `<span class="chip critical small">${g.status === 'timeout' ? 'Tests timed out' : 'Tests failed'}</span>`;
}

// Whether a run reads or edits, and Full access as a warning.
export function accessBadge(h) {
  const p = h.permissions ?? {};
  const kind = p.edit_source ? '<span class="chip warning small">Edits source</span>' : p.edit_files || p.delete_files ? '<span class="chip warning small">Changes files</span>' : '<span class="chip small">Read-only</span>';
  return h.access === 'full' ? `${kind} <span class="chip warning small">Full access</span>` : kind;
}
```

- [ ] **Step 5: Implement the view** — create `ui/views/runs.js`:

```js
// Runs (spec §2): every agent run and proposed run, by what needs the owner, grouped by batch. Rows
// open the run detail; nothing here acts except batch cancel and proposal approve or dismiss.
import { esc, attr, timeEl, handoffChip, ticketById, normalizeSnapshot, emptyState, proposalItem, shortKey, HANDOFF_LABELS } from '../components.js';
import { batchProgress } from '../lib/bulk.js';
import { runTabs, visibleRunTabs, defaultRunTab, groupRuns, runFacts, RUN_TAB_LABELS } from '../lib/runs.js';
import { testGateBadge, accessBadge } from './agents.js';

const EMPTY = {
  needs: ['Nothing needs you', 'Proposed runs, results with suggestions to decide on, and recent failures appear here.'],
  live: ['No runs queued or running', 'Start one with Run agent on a ticket, or select tickets on Board for a bulk run.'],
  failed: ['No failed runs', 'Failed, timed-out and cancelled runs appear here with what went wrong.'],
  all: ['No runs in the last 30 days', 'Agent runs and proposed runs appear here as they are requested.'],
};

export function runRow(snapshot, h, { now, tz, selected = false }) {
  const t = ticketById(snapshot, h.ticket_id);
  const name = h.recipe ? h.recipe.name : h.mode;
  const facts = runFacts(snapshot, h, now);
  const label = `${t ? t.key : 'Ticket not in view'}: ${name}, ${HANDOFF_LABELS[h.state] ?? h.state}${facts.length ? `, ${facts.join(', ')}` : ''}`;
  const ticket = t ? `<code class="key" title="${attr(t.key)}">${esc(shortKey(t.key))}</code> <span class="run-title">${esc(t.title)}</span>` : '<span class="muted">Ticket not in view</span>';
  return `<li class="run-row" data-state="${attr(h.state)}"><button type="button" class="run-open" data-action="open-run" data-run="${attr(h.id)}" aria-label="${attr(label)}" aria-pressed="${selected ? 'true' : 'false'}">${handoffChip({ ...h, error: null })}<span class="run-ticket">${ticket}</span><span class="run-recipe">${esc(name)}</span><span class="run-badges">${accessBadge(h)} ${testGateBadge(h.test_gate)}</span><span class="run-facts small muted">${esc(facts.join(' · '))}</span><span class="run-time small muted">${timeEl(h.requested_at, now, tz)}</span></button></li>`;
}

function proposalRow(snapshot, p, { now, pending }) {
  if (p.state !== 'expired') return proposalItem(p, snapshot, { now, pending, withTicket: true }).replace('<li class="proposal"', '<li class="proposal run-row" data-state="proposed"');
  const t = ticketById(snapshot, p.ticket_id);
  const why = !t || t.status === 'done' ? 'ticket is done' : 'older than 7 days';
  return `<li class="proposal run-row" data-proposal="${attr(p.id)}" data-state="expired"><strong>${esc(p.recipe.name)}</strong> <span class="muted small">${t ? esc(t.key) : ''} proposed ${timeEl(p.proposed_at, now, snapshot.meta.timezone)}</span> <span class="chip small">Expired · ${esc(why)}</span></li>`;
}

function batchGroup(snapshot, g, { now, tz, caps, selectedRun }) {
  const p = batchProgress(snapshot, g.id);
  const finished = p.done + p.failed + p.cancelled;
  const names = [...new Set(g.items.map((i) => (i.run.recipe ? i.run.recipe.name : i.run.mode)))];
  const parts = [p.done ? `${p.done} done` : null, p.running ? `${p.running} running` : null, p.queued ? `${p.queued} queued` : null, p.failed ? `${p.failed} failed` : null, p.cancelled ? `${p.cancelled} cancelled` : null].filter(Boolean);
  const cancel = caps.handoff && p.queued ? `<button type="button" class="btn small ghost" data-action="cancel-batch" data-batch="${attr(g.id)}">Cancel queued (${esc(p.queued)})</button>` : '';
  const pct = p.total ? Math.round((finished / p.total) * 100) : 0;
  return `<li class="run-batch" data-batch="${attr(g.id)}"><div class="run-batch-head"><span class="eyebrow">Batch ${esc(g.id.slice(0, 8))}</span><span class="small">${esc(names.length === 1 ? names[0] : 'mixed')} · ${esc(parts.join(' · '))}</span><div class="batch-bar" role="progressbar" aria-label="${attr(`Batch ${g.id.slice(0, 8)}: ${finished} of ${p.total} runs finished`)}" aria-valuemin="0" aria-valuenow="${finished}" aria-valuemax="${p.total}"><span style="width:${pct}%"></span></div>${cancel}</div><ul class="run-list">${g.items.map((i) => runRow(snapshot, i.run, { now, tz, selected: selectedRun === i.id })).join('')}</ul></li>`;
}

export function renderRuns(rawSnapshot, filters, { now, pending = [], tab = null, selectedRun = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  const caps = snapshot.capabilities ?? {};
  const tabs = runTabs(snapshot, filters, now);
  const names = visibleRunTabs(snapshot);
  const current = names.includes(tab) ? tab : defaultRunTab(tabs, names);
  const tablist = `<div class="run-tabs" role="tablist" aria-label="Run filters">${names.map((n) => `<button type="button" role="tab" id="run-tab-${n}" data-action="run-tab" data-tab="${n}" aria-selected="${n === current}" aria-controls="run-panel" tabindex="${n === current ? 0 : -1}">${esc(RUN_TAB_LABELS[n])}${n === 'all' ? '' : ` <span class="count">${esc(tabs[n].length)}</span>`}</button>`).join('')}</div>`;
  const entries = groupRuns(tabs[current]);
  const body = entries.length
    ? `<ul class="run-list">${entries.map((e) => (e.kind === 'batch' ? batchGroup(snapshot, e, { now, tz, caps, selectedRun }) : e.kind === 'proposal' ? proposalRow(snapshot, e.proposal, { now, pending }) : runRow(snapshot, e.run, { now, tz, selected: selectedRun === e.id }))).join('')}</ul>`
    : emptyState(EMPTY[current][0], EMPTY[current][1]);
  return `<section class="view view-runs" aria-labelledby="tab-runs">${tablist}<div id="run-panel" role="tabpanel" aria-labelledby="run-tab-${current}">${body}</div></section>`;
}
```

`HANDOFF_LABELS` is already exported by `ui/components.js`. The `proposalRow` replace targets the opening tag `proposalItem` emits (`<li class="proposal" data-proposal=…`); keep it in sync if that tag changes.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/ui/runs.test.js "tests/ui/*.test.js"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/views/runs.js ui/views/agents.js ui/components.js tests/ui/runs.test.js
git commit -m "feat(ui): Runs page renderer with tabs, batch groups and proposals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Run detail renderer (`ui/views/run-detail.js`)

**Files:**
- Create: `ui/views/run-detail.js`
- Modify: `ui/views/agents.js` (export `suggestionItem`, `runTimings`, `fileEffects`; add a `gate` option to `runQuality`)
- Test: `tests/ui/run-detail.test.js`

**Interfaces:**
- Consumes: `contentViewer` (Task 2), `accessBadge`, `testGateChip`, `SOURCE_LABELS` (Task 5), `supersededBy` (Task 4)
- Produces:
  - `renderRunDetail(run, snapshot, { now, pending, content, contentStatus }): string` — root `<article class="detail run-detail" data-run="<id>">`, close button `data-action="close-run"`, prev/next `data-action="run-prev"|"run-next"`, Open ticket `data-action="open-ticket-from-run" data-ticket`, retry `data-action="run-agent" data-ticket data-recipe data-retry-of`
  - `renderRunNotFound(id): string`

- [ ] **Step 1: Write the failing tests** — create `tests/ui/run-detail.test.js`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/run-detail.test.js`
Expected: FAIL with `Cannot find module '.../ui/views/run-detail.js'`.

- [ ] **Step 3: Export helpers from `ui/views/agents.js`** — prefix `function suggestionItem`, `function runTimings` and `function fileEffects` with `export`. Change `runQuality` to `export function runQuality(h, { gate = true } = {})` and its gate lines to:

```js
  const gateChip = gate ? testGateChip(h.test_gate) : '';
  if (gateChip) parts.push(gateChip);
```

- [ ] **Step 4: Implement** — create `ui/views/run-detail.js`:

```js
// Run detail (spec §3): what a run did, what the worker verified, where it is, and what is left for
// the owner to decide. Sections an export stripped are omitted, never shown empty.
import { esc, attr, icon, timeEl, handoffChip, ticketById, normalizeSnapshot, contentViewer, keyEl } from '../components.js';
import { testGateChip, accessBadge, runTimings, runQuality, suggestionItem, fileEffects, SOURCE_LABELS } from './agents.js';
import { supersededBy } from '../lib/runs.js';

const section = (title, body) => (body ? `<section class="detail-section"><h3>${esc(title)}</h3>${body}</section>` : '');

function closeRow(t) {
  return `<div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-run" aria-label="Close run (Escape)">${icon('x')}</button>${t ? `<button type="button" class="btn small ghost" data-action="open-ticket-from-run" data-ticket="${attr(t.id)}">Open ticket</button>` : ''}<span class="detail-nav-keys"><button type="button" class="btn small ghost icon-only prev" data-action="run-prev" aria-label="Previous run">${icon('chevron')}</button><button type="button" class="btn small ghost icon-only" data-action="run-next" aria-label="Next run">${icon('chevron')}</button></span></div>`;
}

export function renderRunNotFound(id) {
  return `<article class="detail run-detail" data-run="${attr(id)}"><header class="detail-head"><div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-run" aria-label="Close (Escape)">${icon('x')}</button></div><h2 id="detail-title">Run not found</h2><p class="muted small">This run is not in the current snapshot. It may be older than the snapshot keeps or belong to another store.</p></header></article>`;
}

export function renderRunDetail(h, rawSnapshot, { now, pending = [], content = {}, contentStatus = {} } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  const tz = snapshot.meta.timezone;
  const t = ticketById(snapshot, h.ticket_id);
  const name = h.recipe ? h.recipe.name : h.mode;
  const source = h.recipe && h.recipe.source ? ` <span class="chip small">${esc(SOURCE_LABELS[h.recipe.source] ?? h.recipe.source)}</span>` : '';
  const next = supersededBy(snapshot, h);

  const head = `<header class="detail-head run-head">${closeRow(t)}
  <div class="detail-keys">${t ? keyEl(t.key) : '<span class="muted">Ticket not in view</span>'}</div>
  <h2 id="detail-title">${t ? esc(t.title) : esc(name)}</h2>
  <div class="detail-chips">${handoffChip({ ...h, error: null })} <strong>${esc(name)}</strong>${source}${h.recipe && h.recipe.name !== h.mode ? ` <span class="muted small">${esc(h.mode)}</span>` : ''} ${accessBadge(h)} ${testGateChip(h.test_gate)}</div>
  ${runTimings(h)}
  <p class="small muted">Requested ${timeEl(h.requested_at, now, tz)}${h.batch_id ? ` · Batch ${esc(h.batch_id.slice(0, 8))}` : ''}${h.retry_of ? ' · Retry of an earlier run' : ''}${next ? ` · ${next.retried ? 'Retried as a new run' : 'Superseded by a later run'}` : ''}</p>
</header>`;

  const result = [
    h.error && h.error.message ? `<p class="small critical">${esc(h.error.message)}</p>` : '',
    h.result_summary ? `<p class="prewrap">${esc(h.result_summary)}</p>` : '',
    h.result_ref ? contentViewer(h.result_ref, { content, status: contentStatus, generation: snapshot.generation_id, label: h.state === 'done' ? 'Show full result' : 'Show partial result' }) : '',
    runQuality(h, { gate: false }),
  ].join('');

  const changes = [
    (h.changed_files ?? []).length ? `<p class="small">${h.changed_files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : '',
    h.commit_sha ? `<p class="small">Commit <code>${esc(h.commit_sha.slice(0, 7))}</code> <button type="button" class="btn small ghost icon-only" data-copy="${attr(h.commit_sha)}" data-copy-label="the commit" aria-label="Copy the commit">${icon('copy')}</button></p>` : '',
    (h.test_results ?? []).length ? `<ul class="small test-results">${h.test_results.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '',
    fileEffects(h, t ?? { id: h.ticket_id }, { canEdit: !!caps.edit_tickets, pending }),
  ].join('');

  const uncertain = (h.uncertain_effects ?? []).length ? `<div class="run-uncertain" role="note">${icon('alert')}<div><strong>The worker could not confirm:</strong><ul>${h.uncertain_effects.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>` : '';
  const delivery = [
    h.pr_url ? `<p><a href="${attr(h.pr_url)}" target="_blank" rel="noopener noreferrer">${esc(h.pr_url)}</a></p>` : '',
    h.branch ? `<p class="small">Branch <code>${esc(h.branch)}</code></p>` : '',
    uncertain,
  ].join('');

  // Local paths are owner-only text: never a link, never fetched, never exported.
  const where = caps.handoff && h.worktree_path ? `<p class="small"><code>${esc(h.worktree_path)}</code> <button type="button" class="btn small ghost icon-only" data-copy="${attr(h.worktree_path)}" data-copy-label="the run's checkout path" aria-label="Copy the checkout path">${icon('copy')}</button></p>` : '';

  const suggestions = (h.suggestions ?? []).length ? `<ul class="suggestions">${h.suggestions.map((s) => suggestionItem(s, h, t ?? { id: h.ticket_id }, { canEdit: !!caps.edit_tickets, pending })).join('')}</ul>` : '';

  const actions = [];
  if (caps.handoff && ['queued', 'running'].includes(h.state)) actions.push(`<button type="button" class="btn small" data-action="cancel-handoff" data-handoff="${attr(h.id)}">Cancel</button>`);
  if (caps.handoff && t && ['failed', 'timed-out', 'cancelled'].includes(h.state)) actions.push(`<button type="button" class="btn small" data-action="run-agent" data-ticket="${attr(t.id)}" data-recipe="${attr(name)}" data-retry-of="${attr(h.id)}">Retry as new run</button>`);

  return `<article class="detail run-detail" data-run="${attr(h.id)}" aria-labelledby="detail-title">
${head}
${section('Result', result)}
${section('Changes', changes)}
${section('Delivery', delivery)}
${section('Where it is', where)}
${section('Suggestions', suggestions)}
${actions.length ? `<div class="run-actions">${actions.join(' ')}</div>` : ''}
</article>`;
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/ui/run-detail.test.js "tests/ui/*.test.js" tests/handoff/files.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/views/run-detail.js ui/views/agents.js tests/ui/run-detail.test.js
git commit -m "feat(ui): run detail with evidence, uncertain effects and owner-only paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire Runs into the app

Route, hash, shortcut `7`, nav item, opening and stepping run detail in the side panel, proposals moving from Activity to Runs, and the approvals button.

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/views/header.js` (`NAV_ITEMS` gains `runs`; approvals button label)
- Modify: `ui/components.js` (`viewCounts` gains `runs`)
- Modify: `ui/views/today.js` (remove the proposals section)
- Modify: `ui/views/bulk.js` (`renderBatchStrips` gains "View in Runs")
- Modify: `ui/lib/proposals.js` (notice text)
- Modify: `ui/views/dialogs.js` (help rows)
- Test: `tests/ui/proposals.test.js`, `tests/ui/render.test.js`

**Interfaces:**
- Consumes: `renderRuns` (Task 5), `renderRunDetail`, `renderRunNotFound` (Task 6), `liveRunCount` (Task 4)
- Produces: `appState.runTab: string|null`, `appState.selectedRun: string|null`; hash params `tab=` and `run=` on `view=runs`; actions `run-tab`, `open-run`, `close-run`, `run-prev`, `run-next`, `open-ticket-from-run`, `open-runs`; `SHORTCUT_VIEWS` in `ui/views/header.js`

- [ ] **Step 1: Write the failing tests** — in `tests/ui/proposals.test.js` replace the assertions that expect proposals in `renderToday` output with:

```js
test('Activity is history only: proposals are no longer listed there', () => {
  const s = snap([proposal(1)]);
  assert.doesNotMatch(renderToday(s, EMPTY_FILTERS, { now: NOW }), /data-action="approve-run"/);
});

test('the proposal notice points at Runs', () => {
  assert.match(proposalNotice(proposal(1)), /approve or dismiss it in Runs$/);
});
```

and append to `tests/ui/render.test.js`:

```js
test('the sidebar lists Runs with shortcut 7 and a live count; 1 to 6 keep their views', async () => {
  const { renderSidebar, SHORTCUT_VIEWS } = await import('../../ui/views/header.js');
  const s = snapshot({ handoffs: [{ ...snapshot().handoffs[0], id: 'q1', state: 'queued' }] });
  const side = renderSidebar(s, { view: 'runs' });
  assert.match(side, /data-view="runs"[^>]*aria-selected="true"[^>]*aria-keyshortcuts="7"/);
  assert.match(side, /data-view="runs"[\s\S]*?<span class="badge"[^>]*>1<\/span>/);
  assert.deepEqual(SHORTCUT_VIEWS, { 1: 'picknext', 2: 'board', 3: 'tree', 4: 'sessions', 5: 'deployments', 6: 'today', 7: 'runs' });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/proposals.test.js tests/ui/render.test.js`
Expected: FAIL — Today still lists proposals; the notice says "Today"; no `runs` nav item; `SHORTCUT_VIEWS` undefined.

- [ ] **Step 3: Header and counts**

In `ui/views/header.js`:

```js
export const NAV_ITEMS = [['picknext', 'Pick next', 'ticket', '1'], ['board', 'Board', 'machine', '2'], ['tree', 'Relationships', 'branch', '3'], ['sessions', 'Sessions', 'user', '4'], ['deployments', 'Deployments', 'rocket', '5'], ['today', 'Activity', 'clock', '6'], ['runs', 'Runs', 'play', '7']];
export const SHORTCUT_VIEWS = { 1: 'picknext', 2: 'board', 3: 'tree', 4: 'sessions', 5: 'deployments', 6: 'today', 7: 'runs' };
```

In `renderHeader`, the approvals button now opens Runs: change its text to `${openProposals(snapshot).length} awaiting approval` (unchanged) and keep `data-action="review-proposals"`.

In `ui/components.js` `viewCounts`, add an import-free count (components cannot import `lib/runs.js` without a cycle):

```js
    runs: (snapshot.handoffs ?? []).filter((h) => h.state === 'queued' || h.state === 'running').length,
```

- [ ] **Step 4: Activity, notices, batch strips, help**

In `ui/views/today.js`: delete `proposalsSection` and every `${proposals}` interpolation, remove the `const proposals = …` line, and drop `openProposals, proposalItem` from the import.

In `ui/lib/proposals.js` change the notice ending to `; approve or dismiss it in Runs`.

In `ui/views/bulk.js` `renderBatchStrips`, append inside each strip before `${action}`:

```js
<button type="button" class="link small" data-action="open-runs" data-tab="all">View in Runs</button>
```

In `ui/views/dialogs.js` `renderHelpDialog`, change `['1 to 6', 'Switch view']` to `['1 to 7', 'Switch view (7 opens Runs)']`.

- [ ] **Step 5: App state, hash and render** — in `ui/app.js`:

Imports:

```js
import { renderHeader, renderSidebar, renderPageHeading, SHORTCUT_VIEWS } from './views/header.js';
import { renderRuns } from './views/runs.js';
import { renderRunDetail, renderRunNotFound } from './views/run-detail.js';
```

`const VIEWS = ['picknext', 'board', 'tree', 'sessions', 'deployments', 'today', 'runs'];`

Add to `appState`: `runTab: null,` and `selectedRun: null,`.

`readHash` — append:

```js
  appState.runTab = params.get('tab') || null;
  appState.selectedRun = appState.view === 'runs' ? params.get('run') || null : null;
```

`setView` — add `appState.selectedRun = null;` and `appState.runTab = null;`.

`writeHash` — before `const next =`:

```js
  if (appState.view === 'runs' && appState.runTab) params.set('tab', appState.runTab);
  if (appState.view === 'runs' && appState.selectedRun) params.set('run', appState.selectedRun);
```

`render` — after the `today` branch:

```js
  else if (appState.view === 'runs') html = renderRuns(s, appState.filters, { ...opts, tab: appState.runTab, selectedRun: appState.selectedRun });
```

In `syncRequests`, the notice for several proposals: change `in Today` to `in Runs`.

- [ ] **Step 6: The side panel shows a ticket or a run** — replace `renderDetailPanel` with:

```js
function renderDetailPanel(now, pending) {
  const panel = $('#detail');
  const s = appState.snapshot;
  const ticket = appState.selected ? ticketById(s, appState.selected) : null;
  const runId = !ticket && appState.view === 'runs' ? appState.selectedRun : null;
  const run = runId ? (s.handoffs ?? []).find((h) => h.id === runId) ?? null : null;
  const open = !!(ticket || runId);
  const mode = layoutMode();
  document.body.dataset.expandedTicket = appState.detailExpanded && ticket ? 'true' : 'false';
  panel.hidden = !open;
  document.body.dataset.detail = open ? 'open' : 'closed';
  if (!open) { $('#main').inert = false; for (const id of ['sidebar', 'header', 'filters', 'bulk']) $(`#${id}`).inert = false; setMarkup(panel, ''); panel.removeAttribute('aria-modal'); renderedDetail = null; return; }
  const modal = mode !== 'desktop';
  $('#main').inert = modal || (!!ticket && appState.detailExpanded);
  for (const id of ['sidebar', 'header', 'filters', 'bulk']) $(`#${id}`).inert = modal;
  panel.setAttribute('role', modal ? 'dialog' : 'complementary');
  panel.setAttribute('aria-label', ticket ? 'Ticket detail' : 'Run detail');
  if (modal) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
  const active = document.activeElement;
  const activeId = active && panel.contains(active) ? active.id || active.dataset.action : null;
  const selectionStart = active && panel.contains(active) && active.tagName === 'TEXTAREA' ? active.selectionStart : null;
  const editing = active && panel.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
  if (editing) return; // never clobber an in-progress edit on poll
  const key = ticket ? ticket.id : `run:${runId}`;
  const html = ticket
    ? renderDetail(ticket, s, { now, pending, content: appState.content, contentStatus: appState.contentStatus, loadedTicket: appState.loadedTicket, editingNext: appState.editingNext === ticket.id, tab: appState.detailTab, expanded: appState.detailExpanded })
    : run ? renderRunDetail(run, s, { now, pending, content: appState.content, contentStatus: appState.contentStatus }) : renderRunNotFound(runId);
  setMarkup(panel, html);
  if (renderedDetail !== key) { panel.scrollTop = 0; renderedDetail = key; }
  if (activeId) { const el = panel.querySelector(`#${CSS.escape(activeId)}`) || panel.querySelector(`[data-action="${CSS.escape(activeId)}"]`); if (el) { el.focus(); if (selectionStart !== null && el.setSelectionRange) el.setSelectionRange(selectionStart, selectionStart); } }
}
```

- [ ] **Step 7: Actions** — add these functions after `stepDetail`:

```js
function openRun(id, source) {
  appState.lastFocus = source ?? document.activeElement;
  if (appState.view !== 'runs') { setView('runs'); appState.runTab = 'all'; }
  appState.selected = null;
  appState.selectedRun = id;
  render();
  if (layoutMode() !== 'desktop') $('#detail [data-action="close-run"]')?.focus();
}

function closeRun() {
  const id = appState.selectedRun;
  appState.selectedRun = null;
  render();
  const source = appState.lastFocus && document.contains(appState.lastFocus) ? appState.lastFocus : $(`#main [data-run="${CSS.escape(id ?? '')}"]`);
  source?.focus({ preventScroll: true });
}

function stepRun(delta) {
  const ids = [...document.querySelectorAll('#main [data-action="open-run"]')].map((el) => el.dataset.run);
  const next = ids[ids.indexOf(appState.selectedRun) + delta];
  if (next) { appState.selectedRun = next; render(); }
}
```

and these cases in `handleAction`:

```js
    case 'run-tab': appState.runTab = el.dataset.tab; render(); document.querySelector(`#run-tab-${CSS.escape(appState.runTab)}`)?.focus(); break;
    case 'open-run': openRun(el.dataset.run, el); break;
    case 'close-run': closeRun(); break;
    case 'run-prev': stepRun(-1); break;
    case 'run-next': stepRun(1); break;
    case 'open-ticket-from-run': { const id = el.dataset.ticket; setView('board'); openDetail(id, null); break; }
    case 'open-runs': setView('runs'); appState.runTab = el.dataset.tab || null; render(); break;
```

Change `review-proposals` to:

```js
    case 'review-proposals': appState.filters = { ...EMPTY_FILTERS }; setView('runs'); appState.runTab = 'needs'; render(); break;
```

- [ ] **Step 8: Keyboard** — in `onKey`:

Replace the `/^[1-6]$/` line with:

```js
  if (SHORTCUT_VIEWS[e.key]) { setView(SHORTCUT_VIEWS[e.key]); render(); const tab = $(`#tab-${appState.view}`); if (tab) tab.focus(); return; }
```

In the Escape block, after the dialog branch add:

```js
    if (appState.selectedRun && !inInput) { e.preventDefault(); closeRun(); return; }
```

Before the existing `detailTab` handling add run-tab arrows:

```js
  const runTab = target?.closest('[role="tab"][data-action="run-tab"]');
  if (runTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const tabs = [...document.querySelectorAll('#main [data-action="run-tab"]')].map((b) => b.dataset.tab);
    const i = tabs.indexOf(runTab.dataset.tab);
    appState.runTab = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    render(); document.querySelector(`#run-tab-${CSS.escape(appState.runTab)}`)?.focus(); return;
  }
```

Change the existing `detailTab` selector to `target?.closest('[role="tab"][data-action="detail-tab"]')` so the two tablists do not collide.

- [ ] **Step 9: CSS** — append to `ui/styles.css`:

```css
/* Runs (spec 2026-10-11 §2–3): tabs, batch groups, one-button rows, run detail evidence. */
.run-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 0 0 14px; }
.run-tabs [role="tab"] { border: 0; background: none; color: var(--text-muted); font: inherit; font-weight: 500; padding: 6px 12px; border-radius: 999px; min-height: 36px; cursor: pointer; }
.run-tabs [role="tab"][aria-selected="true"] { background: var(--surface-raised); color: var(--text); box-shadow: inset 0 0 0 1px var(--hairline-strong); }
.run-tabs .count { font-family: var(--mono); font-size: 11px; color: var(--text-faint); margin-left: 4px; }
.run-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.run-batch { border-radius: var(--radius); box-shadow: inset 0 0 0 1px var(--hairline); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.run-batch-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.run-batch-head .batch-bar { flex: 1 1 120px; }
.run-open { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "state ticket time" "state recipe badges" "state facts facts"; gap: 2px 10px; align-items: center; text-align: left; font: inherit; color: var(--text); background: var(--surface); border: 0; border-radius: var(--radius-ctl); padding: 10px 12px; min-height: 44px; cursor: pointer; box-shadow: inset 0 0 0 1px var(--hairline); }
.run-open:hover, .run-open[aria-pressed="true"] { background: var(--surface-raised); box-shadow: inset 0 0 0 1px var(--hairline-strong); }
.run-open > .chip { grid-area: state; align-self: start; }
.run-ticket { grid-area: ticket; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-recipe { grid-area: recipe; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-badges { grid-area: badges; display: inline-flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.run-facts { grid-area: facts; min-width: 0; overflow-wrap: anywhere; }
.run-time { grid-area: time; white-space: nowrap; }
.run-row.proposal { padding: 10px 12px; border-radius: var(--radius-ctl); box-shadow: inset 0 0 0 1px var(--hairline); }
.run-uncertain { display: flex; gap: 8px; padding: 10px 12px; border-radius: var(--radius-ctl); background: var(--status-deploy-bg); color: var(--status-deploy); }
.run-uncertain ul { margin: 4px 0 0; padding-left: 18px; }
.run-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
@media (max-width: 599px) {
  .run-open { grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "state ticket" "state recipe" "state badges" "state facts" "state time"; }
  .run-badges { justify-content: flex-start; }
}
```

- [ ] **Step 10: Run all tests and check the bundle**

Run: `node --test "tests/ui/*.test.js" tests/export/static.test.js`
Expected: PASS. `node --check ui/app.js` prints nothing.

- [ ] **Step 11: Smoke-check in a browser** — run the dashboard against a throwaway store, open Runs, queue a run, open its detail. Save as `$TMPDIR/runs-smoke.mjs` (any temp dir outside the repo) and run it while `node scripts/dev-seed.mjs --home <tmp>/seed --port 47990 > <tmp>/seed.log` runs in the background:

```js
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/shiva/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/');
const { chromium } = require('playwright');
const [log] = process.argv.slice(2);
const url = /Owner URL[^:]*: (\S+)/.exec(fs.readFileSync(log, 'utf8'))[1];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url); await page.waitForTimeout(1500);
await page.keyboard.press('7'); await page.waitForTimeout(500);
if (!(await page.locator('.view-runs').count())) throw new Error('Runs view did not open on 7');
await page.evaluate(() => { location.hash = 'view=board'; }); await page.waitForTimeout(500);
await page.locator('.card').first().click(); await page.waitForTimeout(400);
await page.locator('#detail [data-action="handoff"]').first().click(); await page.waitForTimeout(400);
await page.getByRole('button', { name: /queue/i }).last().click(); await page.waitForTimeout(6000);
await page.keyboard.press('Escape'); await page.keyboard.press('7'); await page.waitForTimeout(500);
await page.locator('[data-action="run-tab"][data-tab="all"]').click();
await page.locator('[data-action="open-run"]').first().click(); await page.waitForTimeout(500);
if (!(await page.locator('#detail .run-detail').count())) throw new Error('run detail did not open');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
if (await page.locator('#detail .run-detail').count()) throw new Error('Escape did not close run detail');
if (errors.length) throw new Error(errors.join('\n'));
console.log('runs smoke ok'); await browser.close();
```

Run: `node $TMPDIR/runs-smoke.mjs <tmp>/seed.log`
Expected: `runs smoke ok`. Stop the seed server afterwards; each owner URL works once, so start a fresh seed for each run.

- [ ] **Step 12: Commit**

```bash
git add ui/app.js ui/views/header.js ui/components.js ui/views/today.js ui/views/bulk.js ui/lib/proposals.js ui/views/dialogs.js ui/styles.css tests/ui/proposals.test.js tests/ui/render.test.js
git commit -m "feat(ui): Runs page and run detail in the dashboard; proposals move to Runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Ticket detail — run strip and a Runs tab

**Files:**
- Modify: `ui/views/detail.js`
- Modify: `ui/views/agents.js` (`renderAgentsSection` becomes the recipe catalogue; `runItem` removed)
- Modify: `ui/app.js` (`section=` hash, `data-open` sections, four-tab keys)
- Test: `tests/ui/render.test.js`; update `tests/ui/always-on.test.js`, `tests/ui/test-gate.test.js`, `tests/handoff/files.test.js`, `tests/agents/run.test.js`

**Interfaces:**
- Consumes: `ticketRuns`, `openSuggestions` (Task 4), `runRow` (Task 5), `testGateBadge` (Task 5), `renderRunDetail` (Task 6)
- Produces: `DETAIL_TABS = ['overview','runs','activity','delivery']` exported from `ui/views/detail.js`; `runStrip(ticket, snapshot, { now, tz }): string`; recipe rows use `data-action="run-agent" data-ticket data-recipe`

- [ ] **Step 1: Write the failing tests** — append to `tests/ui/render.test.js` (import `DETAIL_TABS` from `../../ui/views/detail.js`):

```js
test('ticket detail: a run strip under the title and a Runs tab with runs, proposals and recipes', () => {
  const base = snapshot();
  const t = { ...base.tickets[0] };
  const queued = { ...base.handoffs[0], id: 'q1', ticket_id: t.id, state: 'queued', requested_at: '2026-10-02T11:00:00Z' };
  const done = { ...base.handoffs[0], id: 'd1', ticket_id: t.id, state: 'done', requested_at: '2026-10-02T10:00:00Z', suggestions: [{ id: 's', type: 'next-action', text: 'x', state: 'proposed' }] };
  const s = { ...base, handoffs: [queued, done], recipes: [{ name: 'analyse', source: 'builtin', mode: 'analyse', description: 'd', permissions: {}, timeout_min: 20, legacy: true, repo_id: null }] };
  const html = renderDetail(t, s, { now: NOW, pending: [], content: {} });
  assert.match(html, /class="run-strip" data-action="open-run" data-run="q1"/, 'the live run leads');
  assert.deepEqual(DETAIL_TABS, ['overview', 'runs', 'activity', 'delivery']);
  assert.match(html, /id="detail-tab-runs"/);
  const overview = /id="detail-page-overview"[\s\S]*?id="detail-page-runs"/.exec(html)[0];
  assert.doesNotMatch(overview, /data-recipe-row|class="detail-section proposals"/, 'Overview no longer lists recipes or proposals');
  const runsTab = renderDetail(t, s, { now: NOW, pending: [], content: {}, tab: 'runs' });
  assert.match(runsTab, /data-action="open-run" data-run="d1"/);
  assert.match(runsTab, /data-action="run-agent" data-ticket="[^"]+" data-recipe="analyse"/);
  const none = renderDetail(t, { ...s, handoffs: [] }, { now: NOW, pending: [], content: {} });
  assert.match(none, /No agent runs yet/);
  assert.match(none, /data-action="run-agent" data-ticket="[^"]+">/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL — no run strip, no `runs` tab, `DETAIL_TABS` undefined.

- [ ] **Step 3: Recipe catalogue** — in `ui/views/agents.js`:

In `recipeRow`, change the run button to:

```js
  const run = canRun ? ` <button type="button" class="btn small" data-action="run-agent" data-ticket="${attr(ticket.id)}" data-recipe="${attr(r.name)}">${icon('play')}Run…</button>` : '';
```

Delete `runItem`. Replace `renderAgentsSection` with:

```js
// The recipes a ticket's repository offers (ADR 0008). Runs themselves are listed on the Runs tab
// and opened as run detail.
export function renderAgentsSection(ticket, rawSnapshot, { busy = false } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  // A files recipe is offered only where there are attached files for it to work on.
  const hasFiles = attachedFilePaths(ticket).length > 0;
  const recipes = effectiveRecipes(snapshot, ticket.repo_id).filter((r) => r.mode !== 'files' || hasFiles);
  const canRun = !!caps.handoff && ticket.status !== 'done';
  return `<section class="detail-section agents"><h3>Recipes</h3>
${recipes.length ? `<ul class="recipes">${recipes.map((r) => recipeRow(r, ticket, canRun && !busy)).join('')}</ul>${canRun && busy ? '<p class="muted small">One run per ticket: wait for the current run or cancel it.</p>' : ''}` : '<p class="muted small">No recipes found. Add one in <code>.quill/agents/</code> or <code>~/.claude/quill/agents/</code>.</p>'}</section>`;
}
```

Remove now-unused imports from `agents.js` (`handoffChip`, `timeEl`, `contentViewer` if unused) so the bundle stays lint-clean.

- [ ] **Step 4: Detail** — in `ui/views/detail.js`:

Imports: add `import { ticketRuns, openSuggestions } from '../lib/runs.js';` and `import { runRow } from './runs.js';`, and `testGateBadge` from `./agents.js`.

Add after `proposalsBlock`:

```js
export const DETAIL_TABS = ['overview', 'runs', 'activity', 'delivery'];
const TAB_LABELS = { overview: 'Overview', runs: 'Runs', activity: 'Activity', delivery: 'Delivery' };

// The current run, or else the latest, under the title; it opens the run detail.
function runStrip(t, snapshot, { now, tz }) {
  const runs = ticketRuns(snapshot, t.id);
  const current = runs.find((h) => h.state === 'queued' || h.state === 'running') ?? runs[0];
  const caps = snapshot.capabilities ?? {};
  if (!current) return caps.handoff && t.status !== 'done' ? `<div class="run-strip" data-empty="true"><span class="muted small">No agent runs yet</span> <button type="button" class="btn small" data-action="run-agent" data-ticket="${attr(t.id)}">${icon('play')}Run agent</button></div>` : '';
  const name = current.recipe ? current.recipe.name : current.mode;
  const open = openSuggestions(current).length;
  return `<button type="button" class="run-strip" data-action="open-run" data-run="${attr(current.id)}" aria-label="${attr(`Open run: ${name}, ${current.state}`)}">${handoffChip({ ...current, error: null })} <strong>${esc(name)}</strong> ${testGateBadge(current.test_gate)}${open ? ` <span class="chip small">${esc(open)} suggestion${open === 1 ? '' : 's'} to review</span>` : ''} <span class="muted small">${timeEl(current.requested_at, now, tz)}</span></button>`;
}
```

In `renderDetail`: change the first line to `if (!DETAIL_TABS.includes(tab)) tab = 'overview';`. Insert `${runStrip(t, snapshot, { now, tz })}` on its own line right after the `detail-chips` div. Change the Handoff button in `statusControls` to `data-action="run-agent"` with label `Run agent`. Replace the tablist line with:

```js
<div class="detail-tabs" role="tablist" aria-label="Ticket sections">${DETAIL_TABS.map((name) => `<button type="button" role="tab" id="detail-tab-${name}" data-action="detail-tab" data-tab="${name}" aria-selected="${tab === name}" aria-controls="detail-page-${name}" tabindex="${tab === name ? 0 : -1}">${TAB_LABELS[name]}</button>`).join('')}</div>
```

Remove `${proposalsBlock(t, snapshot, { now, pending })}${renderAgentsSection(...)}` from the Overview page, and add a Runs page between Overview and Activity:

```js
<div class="detail-page" id="detail-page-runs" role="tabpanel" aria-labelledby="detail-tab-runs" ${tab !== 'runs' ? 'hidden' : ''}>
<section class="detail-section"><h3>Runs <span class="count">${esc(ticketRuns(snapshot, t.id).length)}</span></h3>${ticketRuns(snapshot, t.id).length ? `<ul class="run-list">${ticketRuns(snapshot, t.id).map((h) => runRow(snapshot, h, { now, tz })).join('')}</ul>` : '<p class="muted small">No runs yet.</p>'}${caps.handoff && t.status !== 'done' ? `<p><button type="button" class="btn small" data-action="run-agent" data-ticket="${attr(t.id)}">${icon('play')}Run agent</button></p>` : ''}</section>
${proposalsBlock(t, snapshot, { now, pending })}${renderAgentsSection(t, snapshot, { busy: hasActiveRun(snapshot, t.id) })}
</div>
```

Remove the `content`/`contentStatus` arguments from the `renderAgentsSection` call (the catalogue no longer shows runs).

- [ ] **Step 5: App** — in `ui/app.js`:

Import `DETAIL_TABS` from `./views/detail.js`.

`readHash`: append `const section = params.get('section'); if (appState.selected && DETAIL_TABS.includes(section)) appState.detailTab = section;`.

`writeHash`: after the `ticket` line add `if (appState.selected && appState.detailTab !== 'overview') params.set('section', appState.detailTab);`.

`detail-tab` case: replace the guard with `if (!DETAIL_TABS.includes(el.dataset.tab)) break;`.

`onKey` detail-tab arrows: replace the hard-coded three-tab arithmetic with:

```js
    const tabs = DETAIL_TABS;
    const index = tabs.indexOf(appState.detailTab);
    appState.detailTab = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
```

`onClick` `data-open` branch: replace the `activity`-only special case with
`if (DETAIL_TABS.includes(open.dataset.section)) { appState.detailTab = open.dataset.section; render(); $(`#detail-tab-${open.dataset.section}`)?.focus(); }`.

- [ ] **Step 6: Move run assertions to run detail** — the run list left `renderAgentsSection`. In each test below, build the run under test as `h` and call `renderRunDetail(h, snap, { now })` from `../../ui/views/run-detail.js` instead of `renderAgentsSection(...)`, keeping the same assertions:
  - `tests/ui/always-on.test.js:39` (timings)
  - `tests/ui/test-gate.test.js:19` (gate chips; `renderRunDetail` uses the same `testGateChip`)
  - `tests/handoff/files.test.js:145` (file effects with Undo)
  - `tests/agents/run.test.js:219-224` (suggestions with Accept/Dismiss)
  Assertions about recipes (`file-task` present/absent at `files.test.js:135-137`) stay on `renderAgentsSection`.

- [ ] **Step 7: CSS** — append to `ui/styles.css`:

```css
.run-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; width: 100%; margin: 10px 0 4px; padding: 8px 12px; border: 0; border-radius: var(--radius-ctl); background: var(--surface-inset); color: var(--text); font: inherit; text-align: left; box-shadow: inset 0 0 0 1px var(--hairline); min-height: 44px; }
button.run-strip { cursor: pointer; }
button.run-strip:hover { box-shadow: inset 0 0 0 1px var(--hairline-strong); }
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/views/detail.js ui/views/agents.js ui/app.js ui/styles.css tests
git commit -m "feat(ui): run strip and Runs tab on ticket detail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: One Run agent dialog

Step 1 picks a recipe (built-in recipes include the three legacy modes); step 2 is the existing recipe form plus a live summary, prerequisite blockers and an Advanced disclosure. The old Handoff form is removed.

**Files:**
- Create: `ui/views/run-dialog.js`
- Modify: `ui/views/agents.js` (`renderRecipeRunDialog` gains summary, blockers, Advanced)
- Modify: `ui/app.js` (dialog type `run-agent`, actions, submit, live summary, `h` shortcut)
- Modify: `ui/components.js` (card button label "Run agent")
- Modify: `src/export/static.js` — nothing (Task 1 bundles new modules automatically)
- Delete: `ui/views/handoff-form.js`
- Test: `tests/ui/run-dialog.test.js`; update `tests/ui/render.test.js:174-181`, `tests/ui/test-gate.test.js:31-33`, `tests/handoff/access.test.js:66-73`

**Interfaces:**
- Consumes: `effectiveRecipes`, `attachedFilePaths`, `permissionSummary`, `renderRecipeRunDialog`, `SOURCE_LABELS` (agents.js); `hasActiveRun` (components.js)
- Produces:
  - `runSummary(recipe, choices: Record<string, boolean>, repo|null): string` and `runBlockers(ticket, snapshot, recipe): Array<{ level: 'blocker'|'warning', text: string }>`, both exported from `ui/views/agents.js` (no `export { … }` re-export lists: the static bundler only strips `export function/const`)
  - `renderRunAgentDialog(ticket, snapshot, { recipe: string|null, retryOf: string|null }): string`
  - dialog state `{ type: 'run-agent', ticket, recipe: string|null, retryOf: string|null }`; actions `run-agent`, `run-agent-pick`, `run-agent-back`

- [ ] **Step 1: Write the failing tests** — create `tests/ui/run-dialog.test.js`:

```js
// Run agent dialog (spec §5): pick a recipe, then permissions with a plain summary and blockers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../ui/components.js';
import { renderRunAgentDialog } from '../../ui/views/run-dialog.js';
import { runSummary, runBlockers } from '../../ui/views/agents.js';
import { snapshot, ticket } from './fixtures.js';

const recipes = [
  { name: 'analyse', source: 'builtin', mode: 'analyse', description: 'Summarise', permissions: { read_source: true }, timeout_min: 20, legacy: true, repo_id: null },
  { name: 'attempt-fix', source: 'builtin', mode: 'attempt-fix', description: 'Fix it', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }, timeout_min: 20, legacy: true, repo_id: null },
  { name: 'standup', source: 'repo', mode: 'analyse', description: 'Standup <b>', permissions: {}, timeout_min: 10, legacy: false, repo_id: 'demo', outputs: ['comment-draft'] },
];
const REPO = { id: 'demo', project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: [] };
const snap = (extra = {}) => normalizeSnapshot({ ...snapshot(), recipes, repos: [{ ...REPO, test_command: 'npm test' }], ...extra });

test('step 1 shows a card per recipe with what it may do', () => {
  const s = snap();
  const html = renderRunAgentDialog(s.tickets[0], s, { recipe: null });
  assert.match(html, /data-action="run-agent-pick" data-ticket="[^"]+" data-recipe="analyse"/);
  assert.match(html, /data-recipe="attempt-fix"[\s\S]*?Edits source/);
  assert.match(html, /Standup &lt;b&gt;/);
  assert.doesNotMatch(html, /<form/);
});

test('step 2 is the recipe form with Advanced side effects, a summary and a Back button', () => {
  const s = snap();
  const html = renderRunAgentDialog(s.tickets[0], s, { recipe: 'attempt-fix', retryOf: 'run-9' });
  assert.match(html, /<form class="handoff-form" data-form="recipe-run"[^>]*data-recipe="attempt-fix"[^>]*data-retry-of="run-9"/);
  assert.match(html, /<details class="advanced"><summary>Advanced: commit, push, PR<\/summary>[\s\S]*name="commit"/);
  assert.match(html, /<p class="run-summary"[^>]*>Edits in an isolated checkout · tests: npm test run by the worker · no commit, push or PR · applies its next action and follow-ups directly<\/p>/);
  assert.match(html, /data-action="run-agent-back"/);
});

test('runSummary says what the run will do', () => {
  const [analyse, fix, standup] = recipes;
  assert.equal(runSummary(analyse, { read_source: true }, REPO), 'Reads source · applies its next action and follow-ups directly');
  assert.equal(runSummary(fix, { read_source: true, edit_source: true, commit: true, push_branch: true }, { ...REPO, test_command: 'npm test' }), 'Edits in an isolated checkout · tests: npm test run by the worker · commits, pushes a branch · applies its next action and follow-ups directly');
  assert.equal(runSummary(fix, { edit_source: true }, REPO), 'Edits in an isolated checkout · not test-verified (no test command) · no commit, push or PR · applies its next action and follow-ups directly');
  assert.equal(runSummary(standup, {}, REPO), 'Notes only · result needs your acceptance');
});

test('blockers disable Queue; warnings do not', () => {
  const t = ticket(1);
  const busy = snap({ handoffs: [{ id: 'h', ticket_id: t.id, state: 'running', permissions: {} }] });
  assert.deepEqual(runBlockers(t, busy, recipes[0]).map((b) => b.level), ['blocker']);
  const html = renderRunAgentDialog(t, busy, { recipe: 'analyse' });
  assert.match(html, /<button type="submit" class="btn primary" disabled/);
  assert.match(html, /already queued or running/);
  const noRepo = snap({ repos: [] });
  assert.equal(runBlockers({ ...t, repo_id: null }, noRepo, recipes[1])[0].level, 'blocker');
  assert.equal(runBlockers({ ...t, repo_id: null }, noRepo, recipes[0])[0].level, 'warning');
  const noTests = snap({ repos: [REPO] });
  assert.match(runBlockers(t, noTests, recipes[1]).map((b) => b.text).join(' '), /Not test-verified/);
  assert.match(renderRunAgentDialog(t, noTests, { recipe: 'attempt-fix' }), /<button type="submit" class="btn primary">Queue run/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/run-dialog.test.js`
Expected: FAIL with `Cannot find module '.../ui/views/run-dialog.js'`.

- [ ] **Step 3: Summary, blockers and Advanced in `renderRecipeRunDialog`** — in `ui/views/agents.js`:

Add `hasActiveRun` to the components import. Add before `renderRecipeRunDialog`:

```js
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// What a run with these choices will do, in plain words (spec §5).
export function runSummary(recipe, c = {}, repo = null) {
  const parts = [c.edit_source ? 'edits in an isolated checkout' : c.read_source ? 'reads source' : c.edit_files || c.delete_files ? 'works on copies of the attached files' : 'notes only'];
  if (c.edit_source) parts.push(repo && repo.test_command ? `tests: ${repo.test_command} run by the worker` : 'not test-verified (no test command)');
  const delivery = [c.commit ? 'commits' : null, c.push_branch ? 'pushes a branch' : null, c.open_draft_pr ? 'opens a draft PR' : null].filter(Boolean);
  if (c.edit_source) parts.push(delivery.length ? delivery.join(', ') : 'no commit, push or PR');
  parts.push(recipe.legacy ? 'applies its next action and follow-ups directly' : 'result needs your acceptance');
  return cap(parts.join(' · '));
}

// What stops a run (blocker) or limits it (warning), from facts the snapshot has.
export function runBlockers(ticket, rawSnapshot, recipe) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const p = recipe.permissions ?? {};
  const repo = (snapshot.repos ?? []).find((r) => r.id === ticket.repo_id) ?? null;
  const out = [];
  if (ticket.status === 'done') out.push({ level: 'blocker', text: 'This ticket is done.' });
  if (hasActiveRun(snapshot, ticket.id)) out.push({ level: 'blocker', text: 'A run is already queued or running on this ticket. Cancel it first or wait.' });
  if (!repo && (p.read_source || p.edit_source)) {
    const why = ticket.repo_state === 'needs-clone' ? 'The repository needs a clone first' : 'No registered repository';
    out.push(p.edit_source || recipe.mode === 'attempt-fix' ? { level: 'blocker', text: `${why}: this recipe edits source.` } : { level: 'warning', text: `${why}: the run works from the ticket notes only.` });
  }
  if (repo && (p.edit_source || recipe.mode === 'attempt-fix') && !repo.test_command) out.push({ level: 'warning', text: 'No test command: fixes will be marked Not test-verified.' });
  return out;
}
```

In `renderRecipeRunDialog`:
- Move the `commit`, `push_branch` (with its Branch input) and `open_draft_pr` boxes into a separate `advanced` array instead of `boxes`, and render it inside the permissions fieldset as:

```js
${advanced.length ? `<details class="advanced"><summary>Advanced: commit, push, PR</summary>${advanced.join('\n')}</details>` : ''}
```

- Compute and render blockers, summary and the Queue button state:

```js
  const blockers = runBlockers(ticket, snapshot, recipe);
  const blocked = blockers.some((b) => b.level === 'blocker');
  const defaults = { read_source: !!(p.read_source && repo), edit_source: !!(p.edit_source && repo) };
```

Above the actions row:

```js
${blockers.length ? `<ul class="issues">${blockers.map((b) => `<li data-level="${b.level}">${icon('alert')}${esc(b.text)}</li>`).join('')}</ul>` : ''}
<p class="run-summary" aria-live="polite">${esc(runSummary(recipe, defaults, repo))}</p>
```

and the actions row becomes:

```js
<div class="dialog-actions"><button type="submit" class="btn primary"${blocked ? ` disabled title="${attr(blockers.find((b) => b.level === 'blocker').text)}"` : ''}>Queue run</button><button type="button" class="btn ghost" data-action="run-agent-back" data-ticket="${attr(ticket.id)}">Back</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
```

- Remove the old `testCommandNote` line from this dialog (the blocker list now says it).

- [ ] **Step 4: The dialog** — create `ui/views/run-dialog.js`:

```js
// Run agent (spec §5): one dialog for every recipe, built-in modes included. Step 1 picks what to
// run; step 2 is the recipe form with a plain summary of what the run will do.
import { esc, attr, icon, keyEl, normalizeSnapshot, normalizeTicket } from '../components.js';
import { effectiveRecipes, attachedFilePaths, permissionSummary, renderRecipeRunDialog, SOURCE_LABELS } from './agents.js';

export function renderRunAgentDialog(rawTicket, rawSnapshot, { recipe = null, retryOf = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const ticket = normalizeTicket(rawTicket);
  const hasFiles = attachedFilePaths(ticket).length > 0;
  const recipes = effectiveRecipes(snapshot, ticket.repo_id).filter((r) => r.mode !== 'files' || hasFiles);
  const chosen = recipe ? recipes.find((r) => r.name === recipe && !r.error) : null;
  if (chosen) return renderRecipeRunDialog(chosen, ticket, snapshot, { retryOf });
  const cards = recipes.map((r) => {
    if (r.error) return `<li class="recipe-card" data-invalid="true"><strong>${esc(r.name)}</strong> <span class="small critical">${icon('alert')}Invalid: ${esc(r.error)}</span></li>`;
    const edits = r.permissions && (r.permissions.edit_source || r.permissions.edit_files || r.permissions.delete_files);
    return `<li><button type="button" class="recipe-card" data-action="run-agent-pick" data-ticket="${attr(ticket.id)}" data-recipe="${attr(r.name)}"${retryOf ? ` data-retry-of="${attr(retryOf)}"` : ''}><span class="recipe-card-head"><strong>${esc(r.name)}</strong> <span class="chip small">${esc(SOURCE_LABELS[r.source] ?? r.source)}</span> <span class="chip small${edits ? ' warning' : ''}">${edits ? 'Edits source' : 'Reads only'}</span></span><span class="small">${esc(r.description)}</span><span class="small muted">${esc(permissionSummary(r.permissions))} · ${esc(r.timeout_min)} min</span></button></li>`;
  }).join('');
  return `<div class="dialog-form run-agent"><h2 id="dialog-title">${icon('play')}Run agent on ${keyEl(ticket.key)}</h2>
<p class="muted small">${esc(ticket.title)}. Pick what to run; you choose its permissions next.</p>
${cards ? `<ul class="recipe-cards">${cards}</ul>` : '<p class="muted small">No recipes found. Add one in <code>.quill/agents/</code> or <code>~/.claude/quill/agents/</code>.</p>'}
<div class="dialog-actions"><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div></div>`;
}
```

- [ ] **Step 5: App** — in `ui/app.js`:

Remove the `renderHandoffForm` import and the `d.type === 'handoff'` and `d.type === 'recipe-run'` dialog branches; import `renderRunAgentDialog` from `./views/run-dialog.js` and `runSummary` from `./views/agents.js`; add:

```js
  else if (d.type === 'run-agent') {
    const t = ticketById(s, d.ticket);
    if (!t) { appState.dialog = null; return renderDialog(); }
    html = renderRunAgentDialog(t, s, { recipe: d.recipe, retryOf: d.retryOf });
  }
```

Replace the `handoff` and `run-recipe` cases with:

```js
    case 'handoff':
    case 'run-agent': appState.dialog = { type: 'run-agent', ticket: el.dataset.ticket, recipe: el.dataset.recipe ?? null, retryOf: el.dataset.retryOf ?? null }; render(); break;
    case 'run-agent-pick': appState.dialog = { ...appState.dialog, recipe: el.dataset.recipe }; render(); break;
    case 'run-agent-back': appState.dialog = { ...appState.dialog, recipe: null }; render(); break;
```

Delete the `kind === 'handoff'` branch of `handleSubmit` (the `recipe-run` branch already submits `{ kind: 'handoff', payload: { recipe, note, permissions, access, branch }, retry_of }`).

In the `h` shortcut line, set `appState.dialog = { type: 'run-agent', ticket: card.dataset.ticket, recipe: null, retryOf: null };`.

Keep the summary live — add to `onChange` before the `status-select` branch:

```js
  const runForm = el.closest && el.closest('form[data-form="recipe-run"]');
  if (runForm) {
    const t = ticketById(appState.snapshot, runForm.dataset.ticket);
    const recipe = t ? effectiveRecipes(appState.snapshot, t.repo_id).find((r) => r.name === runForm.dataset.recipe) : null;
    const repo = t ? (appState.snapshot.repos ?? []).find((r) => r.id === t.repo_id) ?? null : null;
    const fd = new FormData(runForm);
    const choices = Object.fromEntries(['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'].map((k) => [k, fd.get(k) === 'on' || !!runForm.querySelector(`[name="${k}"][disabled][checked]`)]));
    const out = runForm.querySelector('.run-summary');
    if (recipe && out) out.textContent = runSummary(recipe, choices, repo);
  }
```

In `ui/components.js` `ticketCard`, change the card button label `Handoff` to `Run agent` (keep `data-action="handoff"`, which now opens the same dialog).

Delete `ui/views/handoff-form.js`.

- [ ] **Step 6: Update the tests that used the Handoff form**
  - `tests/ui/render.test.js`: delete the `renderHandoffForm` import and replace the test at line 174 with one that calls `renderRunAgentDialog(s.tickets[0], s, { recipe: null })` and asserts the three built-in cards exist when `s.recipes` lists them (use the `recipes` array from `run-dialog.test.js`).
  - `tests/ui/test-gate.test.js:31-38` (both the Handoff-form and the recipe-dialog `test-verified` assertions): assert the same "test command" facts through `runBlockers`/`renderRunAgentDialog(t, snap, { recipe: 'attempt-fix' })`: with `npm test` → the summary contains `tests: npm test run by the worker`; without → the blocker list contains `Not test-verified`.
  - `tests/handoff/access.test.js:66-73`: assert `name="access" value="settings" checked` on `renderRunAgentDialog(ticket, snap, { recipe: 'analyse' })`.
  - Any assertion matching the old dialog's `No test command: fixes are not test-verified` text now matches `/Not test-verified/`.

- [ ] **Step 7: CSS** — append to `ui/styles.css`:

```css
.recipe-cards { list-style: none; margin: 12px 0; padding: 0; display: grid; gap: 8px; }
.recipe-card { width: 100%; display: flex; flex-direction: column; gap: 4px; text-align: left; font: inherit; color: var(--text); background: var(--surface-raised); border: 0; border-radius: var(--radius-ctl); padding: 10px 12px; cursor: pointer; box-shadow: inset 0 0 0 1px var(--hairline-strong); min-height: 44px; }
.recipe-card:hover { box-shadow: inset 0 0 0 1px var(--border-strong); }
.recipe-card-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.handoff-form .advanced { margin-top: 8px; }
.handoff-form .advanced > summary { cursor: pointer; color: var(--text-muted); font-size: 13px; }
.run-summary { margin: 12px 0 0; padding: 8px 12px; border-radius: var(--radius-ctl); background: var(--surface-inset); font-size: 13px; }
.issues li[data-level="blocker"] { color: var(--critical); }
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A ui tests
git commit -m "feat(ui): one Run agent dialog with a plain summary and blockers

Replaces the separate Handoff and recipe Run dialogs. Built-in modes are
recipes, so every run is queued through the recipe form.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Grouped navigation, attention dot and the phone More sheet

**Files:**
- Modify: `ui/views/header.js` (`NAV_ITEMS`, `renderSidebar`)
- Modify: `ui/app.js` (`moreOpen`, `toggle-more`, Escape, `now` to sidebar)
- Modify: `ui/styles.css`
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Consumes: `needsYouCount` (Task 4)
- Produces: `NAV_ITEMS` entries `[id, label, icon, shortcut, group]`, groups `'work'|'track'`; `PHONE_PRIMARY: Set<string>`; `renderSidebar(snapshot, { ..., now, moreOpen })`; action `toggle-more`

- [ ] **Step 1: Write the failing test** — append to `tests/ui/render.test.js`:

```js
test('navigation is grouped, Runs has a live count and an attention dot, phones get More', async () => {
  const { renderSidebar, NAV_ITEMS, PHONE_PRIMARY } = await import('../../ui/views/header.js');
  assert.deepEqual(NAV_ITEMS.map((n) => n[0]), ['picknext', 'board', 'runs', 'today', 'sessions', 'deployments', 'tree']);
  assert.deepEqual([...PHONE_PRIMARY], ['picknext', 'board', 'runs', 'today']);
  const base = snapshot();
  const s = { ...base, handoffs: [{ ...base.handoffs[0], id: 'f', ticket_id: base.tickets[0].id, state: 'failed', finished_at: '2026-10-02T11:00:00Z' }] };
  const side = renderSidebar(s, { view: 'sessions', now: NOW });
  assert.match(side, /<span class="nav-caption">Work<\/span>[\s\S]*data-view="runs"[\s\S]*<span class="nav-caption">Track<\/span>/);
  assert.match(side, /data-view="runs"[\s\S]*?class="attention-dot" role="img" aria-label="1 needs you"/);
  assert.match(side, /data-view="sessions"[^>]*class="nav-item nav-overflow"|class="nav-item nav-overflow"[^>]*data-view="sessions"/);
  assert.match(side, /data-action="toggle-more" aria-expanded="false" aria-controls="more-sheet" aria-current="page"/, 'More is current when an overflow view is open');
  const open = renderSidebar(s, { view: 'board', now: NOW, moreOpen: true });
  assert.match(open, /id="more-sheet" class="more-sheet" role="dialog" aria-label="More views"/);
  assert.match(open, /class="more-panel"[\s\S]*data-view="deployments"/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL — flat nav order; no groups or More.

- [ ] **Step 3: Implement** — in `ui/views/header.js`:

```js
import { needsYouCount } from '../lib/runs.js';

export const NAV_ITEMS = [
  ['picknext', 'Pick next', 'ticket', '1', 'work'], ['board', 'Board', 'machine', '2', 'work'], ['runs', 'Runs', 'play', '7', 'work'],
  ['today', 'Activity', 'clock', '6', 'track'], ['sessions', 'Sessions', 'user', '4', 'track'], ['deployments', 'Deployments', 'rocket', '5', 'track'], ['tree', 'Relationships', 'branch', '3', 'track'],
];
// The phone bottom bar holds these four plus More (at most five items).
export const PHONE_PRIMARY = new Set(['picknext', 'board', 'runs', 'today']);
const GROUP_LABELS = { work: 'Work', track: 'Track' };
```

Replace the `<span class="nav-caption">Your workspace</span><div class="nav" …>…</div>` part of `renderSidebar` with output from these helpers, and add `now = null, moreOpen = false` to its options:

```js
function navButton(item, { view, counts, needs }) {
  const [id, label, ic, key] = item;
  const badge = counts[id] ?? 0;
  const dot = id === 'runs' && needs ? `<span class="attention-dot" role="img" aria-label="${attr(`${needs} need${needs === 1 ? 's' : ''} you`)}"></span>` : '';
  return `<button type="button" role="tab" class="nav-item${PHONE_PRIMARY.has(id) ? '' : ' nav-overflow'}" title="${esc(label)}" aria-label="${esc(label)}" data-view="${id}" id="tab-${id}" aria-selected="${view === id ? 'true' : 'false'}" aria-controls="main" aria-keyshortcuts="${key}">${icon(ic)}<span class="nav-label">${esc(label)}</span>${dot}<span class="badge" aria-label="${attr(`${badge} ${id === 'runs' ? 'live' : 'items'}, shortcut ${key}`)}" title="Shortcut ${key}">${esc(badge)}</span></button>`;
}

function navGroups(opts) {
  return ['work', 'track'].map((g) => `<span class="nav-caption">${GROUP_LABELS[g]}</span>${NAV_ITEMS.filter((n) => n[4] === g).map((n) => navButton(n, opts)).join('')}`).join('');
}

function moreControl({ view, moreOpen, counts }) {
  const overflow = NAV_ITEMS.filter(([id]) => !PHONE_PRIMARY.has(id));
  const current = overflow.some(([id]) => id === view);
  const sheet = moreOpen ? `<div id="more-sheet" class="more-sheet" role="dialog" aria-label="More views"><button type="button" class="more-backdrop" data-action="toggle-more" aria-label="Close"></button><div class="more-panel">${overflow.map(([id, label, ic]) => `<button type="button" class="nav-item" data-view="${id}"${view === id ? ' aria-current="page"' : ''}>${icon(ic)}<span class="nav-label">${esc(label)}</span><span class="badge">${esc(counts[id] ?? 0)}</span></button>`).join('')}</div></div>` : '';
  return `<button type="button" class="nav-item nav-more" data-action="toggle-more" aria-expanded="${moreOpen}" aria-controls="more-sheet"${current ? ' aria-current="page"' : ''}>${icon('chevron')}<span class="nav-label">More</span></button>${sheet}`;
}
```

and in `renderSidebar`:

```js
  const needs = snapshot && now && !isStatic ? needsYouCount(snapshot, now) : 0;
  const opts = { view, counts, needs, moreOpen };
  // …
  <div class="nav" role="tablist" aria-label="Views">${navGroups(opts)}</div>${moreControl(opts)}
```

In `ui/app.js`: add `moreOpen: false,` to `appState`; pass `now` and `moreOpen: appState.moreOpen` to `renderSidebar`; add `case 'toggle-more': appState.moreOpen = !appState.moreOpen; render(); break;`; in the `[data-view]` click branch set `appState.moreOpen = false;` before `setView`; in the Escape block add first `if (appState.moreOpen) { e.preventDefault(); appState.moreOpen = false; render(); $('.nav-more')?.focus(); return; }`.

- [ ] **Step 4: CSS** — append to `ui/styles.css`:

```css
.attention-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warning); flex: none; }
.nav-more, .more-sheet { display: none; }
@media (max-width: 899px) {
  .nav-caption, .nav-overflow { display: none; }
  .nav-more { display: flex; }
  .nav-more[aria-current="page"] { color: var(--accent); }
  .more-sheet { display: block; position: fixed; inset: 0; z-index: calc(var(--z-nav) + 1); }
  .more-backdrop { position: absolute; inset: 0; border: 0; background: color-mix(in srgb, var(--bg) 60%, transparent); }
  .more-panel { position: absolute; left: 8px; right: 8px; bottom: calc(64px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: var(--radius-lg); background: var(--surface); box-shadow: inset 0 0 0 1px var(--hairline-strong), var(--shadow); }
  .more-panel .nav-item { flex-direction: row; font-size: 14px; min-height: 44px; padding: 8px 12px; }
  .more-panel .nav-item .badge { display: inline; }
  .nav-item .attention-dot { position: absolute; top: 6px; right: calc(50% - 14px); }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS. Update the older sidebar test (render.test.js:202) only where it relied on the flat order; its `aria-keyshortcuts` assertions still hold.

- [ ] **Step 6: Commit**

```bash
git add ui/views/header.js ui/app.js ui/styles.css tests/ui/render.test.js
git commit -m "feat(ui): grouped navigation with a Runs attention dot and a phone More sheet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: One-row top bar, toasts and the Filter popover

**Files:**
- Modify: `ui/views/header.js` (`renderHeader`, `renderReceipt`, new `statusLabel`, `receiptLifetime`, `renderFilterBar`, `activeFilterCount`)
- Modify: `ui/app.js` (receipt timer, dismiss, filter bar import, popover open state, focus after filter change)
- Modify: `ui/styles.css`
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Produces: `statusLabel(snapshot, { now, online }): { text, tone: 'good'|'warning'|'critical'|'muted' }`; `receiptLifetime(tone): number|null` (6000 or null for `critical`); `renderFilterBar(snapshot, filters): string`; `activeFilterCount(filters): number`; action `dismiss-receipt`

- [ ] **Step 1: Write the failing test** — append to `tests/ui/render.test.js`:

```js
test('the top bar is one row with a status button; receipts are toasts; filters sit behind a counted button', async () => {
  const { renderHeader, statusLabel, receiptLifetime, renderFilterBar, activeFilterCount } = await import('../../ui/views/header.js');
  const s = snapshot();
  const html = renderHeader(s, { now: NOW, online: true, refresh: null, theme: 'dark', endpoint: '127.0.0.1:4321', receipt: { text: 'next action applied', tone: 'good' } });
  assert.doesNotMatch(html, /class="statusline"/);
  assert.match(html, /<summary class="btn small ghost status-button"[^>]*><span class="dot"[^>]*><\/span><span class="status-label">1 provider error<\/span>/);
  assert.match(html, /class="popover status-popover"[\s\S]*Refresh[\s\S]*127\.0\.0\.1:4321/);
  assert.match(html, /class="receipt toast"[\s\S]*Receipt: next action applied[\s\S]*data-action="dismiss-receipt"/);
  assert.deepEqual(statusLabel(s, { now: NOW, online: false }), { text: 'Offline', tone: 'critical' });
  assert.equal(receiptLifetime('critical'), null);
  assert.equal(receiptLifetime('good'), 6000);
  assert.equal(activeFilterCount({ project: 'demo', category: '', tag: '', repo: 'demo', machine: '', stale: true, q: '' }), 3);
  const bar = renderFilterBar(s, { project: '', category: 'feature', tag: '', repo: '', machine: '', stale: false, q: '' });
  assert.match(bar, /<details class="filter-pop health-pop"><summary class="btn small ghost">[\s\S]*Filter · 1<\/summary>/);
  assert.match(bar, /data-filter="category"/);
  assert.match(bar, /data-action="clear-filter" data-filter="category"/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL — `statusLabel` is not exported; a `statusline` row still renders.

- [ ] **Step 3: Implement in `ui/views/header.js`**

Add `EMPTY_FILTERS, NEEDS_CLONE_FILTER` to the components import, then:

```js
export function statusLabel(snapshot, { now, online }) {
  const meta = snapshot.meta;
  if (meta.exported_at) return { text: 'Read-only snapshot', tone: 'muted' };
  if (!online) return { text: 'Offline', tone: 'critical' };
  const failing = (meta.provider_health ?? []).filter((p) => p.error).length;
  if (failing) return { text: failing === 1 ? '1 provider error' : `${failing} provider errors`, tone: 'critical' };
  if ((meta.capture_health && meta.capture_health.status !== 'ok') || meta.unresolved_event_count) return { text: 'Needs attention', tone: 'warning' };
  return { text: meta.last_sync ? `Updated ${relativeTime(meta.last_sync, now)}` : 'Not synced yet', tone: 'good' };
}

// Errors stay until dismissed; everything else clears itself (spec §1).
export function receiptLifetime(tone) {
  return tone === 'critical' ? null : 6000;
}

export function activeFilterCount(f = {}) {
  return ['project', 'category', 'tag', 'repo', 'machine', 'q'].filter((k) => f[k]).length + (f.stale ? 1 : 0);
}

export function renderFilterBar(rawSnapshot, f = EMPTY_FILTERS) {
  const s = normalizeSnapshot(rawSnapshot);
  const tokens = [];
  for (const [k, v] of Object.entries(f)) {
    if (!v || k === 'project') continue;
    tokens.push(`<button type="button" class="token" data-action="clear-filter" data-filter="${attr(k)}" aria-label="Remove filter ${attr(k)}">${esc(k)}: ${esc(k === 'stale' ? 'stale only' : v === NEEDS_CLONE_FILTER ? 'needs clone' : v)} ${icon('x')}</button>`);
  }
  const categories = ['feature', 'bugfix', 'vuln', 'infra', 'research', 'analysis'];
  const repos = s.repos ?? [];
  const needsClone = s.tickets.some((t) => t.repo_state === 'needs-clone');
  const tags = [...new Set(s.tickets.flatMap((t) => (t.tags ?? []).filter((x) => !x.startsWith('quill/'))))];
  const projects = [...new Map(s.tickets.map((t) => [t.project_id, t.project_name])).entries()];
  const n = activeFilterCount(f);
  const controls = `<label>Project <select data-filter="project" aria-label="Project filter (applies to every view)"><option value="">All</option>${projects.map(([id, name]) => `<option value="${attr(id)}" ${f.project === id ? 'selected' : ''}>${esc(name ?? id)}</option>`).join('')}</select></label>
  <label>Category <select data-filter="category"><option value="">All</option>${categories.map((c) => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
  ${repos.length || needsClone ? `<label>Repo <select data-filter="repo"><option value="">All</option>${repos.map((r) => `<option value="${attr(r.id)}" ${f.repo === r.id ? 'selected' : ''}>${esc(r.display_name)}</option>`).join('')}${needsClone || f.repo === NEEDS_CLONE_FILTER ? `<option value="${NEEDS_CLONE_FILTER}" ${f.repo === NEEDS_CLONE_FILTER ? 'selected' : ''}>Needs clone</option>` : ''}</select></label>` : ''}
  ${tags.length ? `<label>Tag <select data-filter="tag"><option value="">All</option>${tags.map((t) => `<option value="${attr(t)}" ${f.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
  <label class="check"><input type="checkbox" data-filter="stale" ${f.stale ? 'checked' : ''}> Stale only</label>`;
  return `<details class="filter-pop health-pop"><summary class="btn small ghost">${icon('search')}Filter${n ? ` · ${n}` : ''}</summary><div class="popover filter-popover" role="group" aria-label="Filters">${controls}</div></details>${tokens.length ? `<div class="tokens">${tokens.join('')}<button type="button" class="link small" data-action="clear-filters">Clear all</button></div>` : ''}`;
}
```

Change `renderReceipt` to:

```js
export function renderReceipt(receipt, { online }) {
  if (!receipt) return '';
  return `<div class="receipt toast" data-tone="${attr(receipt.tone ?? 'neutral')}" title="${attr(receipt.at ?? '')}">${icon(receipt.tone === 'critical' ? 'alert' : 'check')}<span class="receipt-text">Receipt: ${esc(receipt.text)}</span><span class="live">${online ? 'LIVE' : 'OFFLINE'}</span><button type="button" class="btn small ghost icon-only" data-action="dismiss-receipt" aria-label="Dismiss">${icon('x')}</button></div>`;
}
```

Replace the body of `renderHeader` from `<details class="connection-details">` to the end with:

```js
  ${(() => { const st = statusLabel(snapshot, { now, online }); return `<details class="health-pop status-pop" data-tone="${st.tone}"><summary class="btn small ghost status-button" aria-label="${attr(`Workspace status: ${st.text}`)}"><span class="dot" aria-hidden="true"></span><span class="status-label">${esc(st.text)}</span></summary><div class="popover status-popover" role="group" aria-label="Workspace status">
    <p class="endpoint" title="${attr(isStatic ? 'Read-only exported snapshot' : 'Owner session on loopback')}">${isStatic ? 'snapshot' : esc(endpoint ?? '127.0.0.1')} <strong>${isStatic ? 'Viewer' : 'Owner'}</strong>${!isStatic && endpoint ? ` <button type="button" class="btn small ghost icon-only endpoint-copy" data-copy="${attr(`http://${endpoint}/`)}" data-copy-label="the dashboard address" aria-label="Copy the dashboard address">${icon('copy')}</button>` : ''}</p>
    ${renderHealth(snapshot, { now, online, includeProviders: true })}
    ${!online ? '<p class="critical small">Changes unavailable until the worker reconnects.</p>' : ''}
    ${renderRefreshControl(snapshot, { online, refresh })}
  </div></details>`; })()}
  <div class="topbar-actions">
    ${openProposals(snapshot).length ? `<button type="button" class="btn small attention-button" data-action="review-proposals">${icon('alert')}${openProposals(snapshot).length} awaiting approval</button>` : ''}
    ${snapshot.schedules.length && !isStatic ? `<button type="button" class="btn small ghost" data-action="schedules">${icon('clock')}<span class="action-label">Schedules</span></button>` : ''}
    ${(snapshot.publishers ?? []).length && !isStatic ? `<button type="button" class="btn small ghost" data-action="publishers" data-publish-state="${snapshot.publishers.some((p) => p.last_outcome === 'failed' || !p.confirmed) ? 'attention' : 'ok'}">${icon('download')}<span class="action-label">Publish</span></button>` : ''}
    ${caps.export ? `<button type="button" class="btn small ghost" data-action="export">${icon('download')}<span class="action-label">Export</span></button>` : ''}
    <button type="button" class="btn small ghost icon-only" data-action="theme" aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme" title="Theme">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
    <button type="button" class="btn small ghost icon-only" data-action="help" aria-label="Keyboard shortcuts" title="Help (?)">${icon('help')}</button>
  </div>
</div>
${renderReceipt(receipt, { online })}`;
```

- [ ] **Step 4: App** — in `ui/app.js`:

Delete the local `renderFilterBar` function and import `renderFilterBar, receiptLifetime` from `./views/header.js`; call `setMarkup($('#filters'), renderFilterBar(s, appState.filters));`.

Replace `setReceipt` with:

```js
let receiptTimer = null;
function setReceipt(text, tone = 'neutral') {
  const receipt = { text, tone, at: nowIso() };
  appState.receipt = receipt;
  clearTimeout(receiptTimer);
  const ms = receiptLifetime(tone);
  if (ms) receiptTimer = setTimeout(() => { if (appState.receipt === receipt) { appState.receipt = null; render(); } }, ms);
}
```

Add `case 'dismiss-receipt': appState.receipt = null; render(); break;`.

In `render`, keep the filter popover open across re-renders: before `setMarkup($('#filters'), …)` add `const filterOpen = $('#filters .filter-pop')?.open;` and after it `if (filterOpen) $('#filters .filter-pop').open = true;`. Delete the `connectionOpen` lines (the connection details now live in the status popover, restored by the existing `healthOpen` logic).

In `onChange`, after `render();` in the `data-filter` branch, refocus the changed control: `$(`#filters [data-filter="${CSS.escape(el.dataset.filter)}"]`)?.focus();` (the existing `q` handling stays).

- [ ] **Step 5: CSS** — append to `ui/styles.css`:

```css
.topbar-wrap { padding-bottom: 0; }
.status-pop > summary { list-style: none; }
.status-pop > summary::-webkit-details-marker { display: none; }
.status-button .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); }
.status-pop[data-tone="critical"] .status-button { color: var(--critical); }
.status-pop[data-tone="critical"] .dot { background: var(--critical); }
.status-pop[data-tone="warning"] .dot { background: var(--warning); }
.status-pop[data-tone="muted"] .dot { background: var(--text-faint); }
.status-popover { min-width: min(360px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 8px; }
.filters { padding: 6px 28px; min-height: 0; border-bottom: 0; }
.filter-popover { display: flex; flex-direction: column; gap: 10px; min-width: min(300px, calc(100vw - 32px)); }
.receipt.toast { position: fixed; right: 16px; bottom: 16px; z-index: var(--z-panel); max-width: min(460px, calc(100vw - 32px)); padding: 8px 8px 8px 12px; border-radius: var(--radius); background: var(--surface-raised); box-shadow: inset 0 0 0 1px var(--hairline-strong), var(--shadow); color: var(--text); }
@media (max-width: 899px) { .receipt.toast { left: 12px; right: 12px; bottom: calc(72px + env(safe-area-inset-bottom)); max-width: none; } }
@media (max-width: 599px) {
  .topbar { flex-wrap: nowrap; }
  .topbar .brand span, .topbar-actions .action-label { display: none; }
  .topbar .search { flex: 0 1 36px; min-width: 36px; }
  .topbar .search:focus-within { flex: 1 1 100%; }
  .topbar .search input::placeholder { color: transparent; }
  .topbar .search kbd { display: none; }
  .status-button .status-label { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS. The older header test (render.test.js:202) keeps passing: `Ageing`, `gh: auth required`, `Refresh`, the endpoint and `Receipt:` all still render (now inside the popover or toast); `Offline` and `disabled` render when offline.

- [ ] **Step 7: Commit**

```bash
git add ui/views/header.js ui/app.js ui/styles.css tests/ui/render.test.js
git commit -m "feat(ui): one-row top bar with a status popover, toasts and a Filter popover

Critical receipts stay until dismissed; others clear after six seconds.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Tokens and small visual fixes

**Files:**
- Modify: `ui/styles.css` (tokens; control border)
- Modify: `ui/components.js` (`keyEl`/`ticketKey` `short` option; `ticketCard` uses it)
- Modify: `ui/views/board.js:33` (Hide becomes an icon button)
- Test: `tests/ui/tokens.test.js`, `tests/ui/render.test.js`

**Interfaces:**
- Consumes: `shortKey` (Task 5)
- Produces: `keyEl(key, { short = false })`, `ticketKey(ticket, { short = false })`

- [ ] **Step 1: Write the failing tests** — in `tests/ui/tokens.test.js`, inside the per-theme test after the focus assertion, add:

```js
    for (const bg of ['bg', 'surface']) assert.ok(contrastRatio(t['border-strong'], t[bg]) >= 3, `${label}: --border-strong on --${bg} is ${contrastRatio(t['border-strong'], t[bg]).toFixed(2)}:1, controls need 3:1`);
    if (label === 'dark') assert.ok(contrastRatio(t['text-muted'], t.surface) - contrastRatio(t['text-faint'], t.surface) >= 2, 'faint text reads as a distinct level from muted');
```

and append to `tests/ui/render.test.js`:

```js
test('cards show a shortened key with the full key in title and copy; Hide is an icon button', () => {
  const long = { ...snapshot().tickets[0], key: 'LOCAL-preserve-session-checkpoints-00000001' };
  const card = ticketCard(long, snapshot(), { variant: 'board', now: NOW });
  assert.match(card, /data-copy="LOCAL-preserve-session-checkpoints-00000001"[^>]*title="LOCAL-preserve-session-checkpoints-00000001[^"]*">LOCAL-pre[^<]*…[^<]*00000001</);
  const board = renderBoard(snapshot(), noFilters, { now: NOW, layout: 'columns', toggled: new Set(), pages: {} });
  assert.match(board, /class="btn small ghost icon-only" data-action="toggle-column"[^>]*aria-label="Hide To do"/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/tokens.test.js tests/ui/render.test.js`
Expected: FAIL — `--border-strong` is 2.42:1 (dark) / 2.31:1 (light); faint and muted differ by 1.26; the card shows the full key; Hide is a text button.

- [ ] **Step 3: Tokens** — in `ui/styles.css`:
  - dark block (line 6 onwards): `--text-faint: #8a9992;` and `--border-strong: #6f8277;`
  - light block (`:root {` at line 54): `--border-strong: #7f8f86;`
  - the form-control rule at line 254 (`background: var(--surface-inset); border: 1px solid var(--border); …`): change `var(--border)` to `var(--border-strong)`.

These values were checked during design: borders 3.16–4.26:1 against `--bg`/`--surface`; dark faint text 4.57–6.09:1 on every surface.

- [ ] **Step 4: Keys** — in `ui/components.js`:

```js
export function keyEl(key, { short = false } = {}) {
  return `<code class="key" data-copy="${attr(key)}" title="${attr(key)} · Click to copy">${esc(short ? shortKey(key) : key)}</code>`;
}
```

In `ticketKey`, add `{ short = false } = {}` as a second parameter, pass `{ short }` to the `keyEl` call, and use `esc(short ? shortKey(ticket.key) : ticket.key)` for the link text. In `ticketCard`, change `${ticketKey(ticket)}` to `${ticketKey(ticket, { short: true })}`. `shortKey` is declared above `keyEl` after Task 5; if not, move it above.

- [ ] **Step 5: Board Hide** — in `ui/views/board.js:33`, replace the button with:

```js
    <button type="button" class="btn small ghost${collapsed ? '' : ' icon-only'}" data-action="toggle-column" data-column="${attr(status)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${attr(`${collapsed ? 'Show' : 'Hide'} ${STATUS_LABELS[status]}`)}" title="${attr(`${collapsed ? 'Show' : 'Hide'} ${STATUS_LABELS[status]}`)}">${collapsed ? 'Show' : icon('x')}</button>
```

Make sure `icon` is in the board.js components import. Note the class order in the test: `btn small ghost icon-only`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS. If an older test matched `>Hide<` on the board, change it to the `aria-label="Hide …"` form.

- [ ] **Step 6b: Regenerate the design-system token snapshot** — `ui/assets/tokens.css`, `tokens.json` and `manifest.json` are generated from `ui/styles.css`; never hand-edit them.

Run: `node scripts/build-ui-assets.mjs` then `node scripts/build-ui-assets.mjs --check`
Expected: the second command prints `Verified … Quill assets.` and exits 0. `git status` shows only the regenerated `ui/assets/` files changing besides this task's files.

- [ ] **Step 7: Commit**

```bash
git add ui/styles.css ui/components.js ui/views/board.js tests/ui/tokens.test.js tests/ui/render.test.js ui/assets
git commit -m "fix(ui): 3:1 control borders, a distinct faint text level, short card keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Phone widths, browser verification and screenshots

**Files:**
- Modify: `ui/styles.css` (remaining width fixes found by the check)
- Modify: `docs/images/dashboard-pick-next.jpg`, `docs/images/dashboard-board-detail.jpg`
- Modify: `CHANGELOG.md` (Unreleased entries)
- Temporary (not committed): `$TMPDIR/runs-verify.mjs`

- [ ] **Step 1: Write the browser check** — save as `$TMPDIR/runs-verify.mjs` (outside the repo):

```js
// Browser verification for the runs-first dashboard (spec §9). Not committed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/shiva/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/');
const { chromium } = require('playwright');
const [log, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const url = /Owner URL[^:]*: (\S+)/.exec(fs.readFileSync(log, 'utf8'))[1];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url); await page.waitForTimeout(1500);
const VIEWS = ['picknext', 'board', 'runs', 'today', 'sessions', 'deployments', 'tree'];
const failures = [];
for (const [w, h] of [[1440, 900], [1280, 720], [390, 844]]) {
  for (const scheme of ['dark', 'light']) {
    for (const motion of ['no-preference', 'reduce']) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: motion });
      await page.evaluate((s) => { document.documentElement.dataset.theme = s; }, scheme);
      for (const v of VIEWS) {
        await page.evaluate((x) => { location.hash = `view=${x}`; }, v); await page.waitForTimeout(350);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 0) failures.push(`${w}x${h} ${scheme} ${motion} ${v}: ${over}px horizontal overflow`);
        if (motion === 'no-preference') await page.screenshot({ path: path.join(out, `${w}-${scheme}-${v}.png`) });
      }
    }
  }
}
// Keyboard: open a run, Tab stays in the modal at 390, Escape returns focus to the row.
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => { location.hash = 'view=runs&tab=all'; }); await page.waitForTimeout(400);
const row = page.locator('[data-action="open-run"]').first();
if (await row.count()) {
  await row.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
  if (!(await page.evaluate(() => document.querySelector('#detail').contains(document.activeElement)))) failures.push('focus left the run detail modal');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  if (!(await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'open-run'))) failures.push('Escape did not return focus to the run row');
}
// More sheet and filter popover.
await page.locator('.nav-more').click(); await page.waitForTimeout(200);
if (!(await page.locator('#more-sheet').count())) failures.push('More sheet did not open');
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => { location.hash = 'view=board'; }); await page.waitForTimeout(300);
await page.locator('.filter-pop > summary').click();
await page.locator('[data-filter="category"]').selectOption('feature'); await page.waitForTimeout(300);
if (!(await page.evaluate(() => location.hash.includes('category=feature')))) failures.push('filter popover did not set the hash');
if (errors.length) failures.push(...errors);
await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('runs-first verification ok');
```

- [ ] **Step 2: Run it against a fresh seed**

```bash
node scripts/dev-seed.mjs --home "$TMPDIR/qseed" --port 47991 > "$TMPDIR/qseed.log" 2>&1 &
sleep 3
node "$TMPDIR/runs-verify.mjs" "$TMPDIR/qseed.log" "$TMPDIR/qshots"
```

Expected first run: it may FAIL listing overflowing views at 390 px. That is the test failing for real.

- [ ] **Step 3: Fix each overflow it reports** — for each `NNNpx horizontal overflow` line, open the matching `390-*-<view>.png`, find the element wider than the viewport (`document.querySelectorAll('*')` with `getBoundingClientRect().right > innerWidth` in the Playwright console), and constrain it in a single appended block in `ui/styles.css`:

```css
/* Phone widths (spec §1): nothing wider than the viewport; the board scrolls inside itself. */
@media (max-width: 599px) {
  .page-heading, .work-overview, .view { min-width: 0; max-width: 100%; }
  .work-overview { flex-wrap: wrap; }
  .table-wrap { max-width: 100%; overflow-x: auto; }
  .board { max-width: 100%; overflow-x: auto; }
  .detail-panel { max-width: 100vw; }
  .detail-keys, .detail-chips { flex-wrap: wrap; min-width: 0; }
}
```

Add only selectors the check actually reports; re-run Step 2 after each change until it prints `runs-first verification ok`. Stop the seed server and start a fresh one before each run (owner URLs are one-use).

- [ ] **Step 4: Look at the screenshots** — open `1440-dark-runs.png`, `1440-light-picknext.png`, `390-dark-runs.png` and `390-dark-board.png`. Check: the run list reads at a glance, batch headers sit above their rows, chips never wrap mid-word, the top bar is one row, the toast does not cover the bottom bar.

- [ ] **Step 5: Refresh the documentation screenshots** — copy the 1440-dark Pick next and a Board-with-detail capture over `docs/images/dashboard-pick-next.jpg` and `docs/images/dashboard-board-detail.jpg` (convert to JPEG at quality 85 with the bundled Python Pillow if present, otherwise save PNGs under the same names with `.png` and update the two README links).

- [ ] **Step 6: CHANGELOG** — under `## [Unreleased]` add:

```markdown
### Added

- **Runs** page (shortcut 7): Needs you, Live, Failed and All, grouped by batch, with run detail showing the result, changed files, worker test gate, PR, uncertain effects and the checkout path. Batch summaries survive a reload.
- A run strip and a Runs tab on every ticket; one **Run agent** dialog with a plain summary of what the run will do and any blockers.

### Changed

- Navigation is grouped into Work and Track; phones show Pick next, Board, Runs, Activity and More.
- The top bar is one row: workspace status, refresh and connection details live in one popover; filters sit behind a Filter button; receipts are toasts, and errors stay until dismissed.
- Proposed runs moved from Activity to Runs → Needs you.
- Form controls have 3:1 borders; dark-mode faint text is a distinct level.

### Fixed

- Full run results and timeline text now display after loading, and failed loads show Retry.
- Sessions → View checkpoints opens the ticket the checkpoint was captured on.
- Static exports bundle every dashboard module; ticket detail and Activity no longer fail in an exported page.
```

- [ ] **Step 7: Full verification**

Run: `npm test`
Expected: PASS, 0 failures.

Run: `git diff --check`
Expected: no output.

Run: `node scripts/build-ui-assets.mjs --check`
Expected: exits 0 (`Verified … Quill assets.`). If it reports stale files, a `ui/styles.css` token changed after Task 12: run `node scripts/build-ui-assets.mjs` and include `ui/assets` in this commit.

- [ ] **Step 8: Commit**

```bash
git add ui/styles.css docs/images CHANGELOG.md
git commit -m "fix(ui): fit every view to phone widths; refresh dashboard screenshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Update the Fieldnotes design system to the shipped runs-first design

The design system (`306ca3f`, merged in `a08a41c`) was written before this plan. It describes the Runs workspace as a proposal, with example copy that claims run phases and wait reasons the worker does not record. The owner ruled that the plan's design is authoritative: update the design system to describe what Tasks 1–13 shipped. Documentation and reference page only; no production code changes.

**Files:**
- Modify: `docs/design-system/CLAUDE-DESIGN-SYSTEM.md` (§3, §4, §5, §6, §7, §8, §10)
- Modify: `docs/design-system/index.html` (the `#orchestration` specimen only)
- Modify: `DESIGN.md`, `CLAUDE.md`
- Modify: `docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md` (add a status section at the top; do not rewrite the original sections)
- Regenerate: `docs/design-system/preview-light.png`, `preview-dark.png`
- Test: `node scripts/build-ui-assets.mjs --check` and the stale-copy grep in Step 9

**Interfaces:**
- Consumes: everything Tasks 1–13 shipped. Before writing, read the final `ui/views/runs.js`, `ui/views/run-detail.js`, `ui/views/run-dialog.js`, `ui/views/header.js`, `ui/lib/runs.js` and the Runs CSS in `ui/styles.css`. Describe the code as it is, not as this plan says it should be; where they differ, the code wins and the report names the difference.

- [ ] **Step 1: §3 Foundation tokens** — update the token table from the current `ui/assets/tokens.json` (Task 12 regenerated it): `--text-faint` dark is `#8a9992`; `--border-strong` is `#6f8277` dark and `#7f8f86` light (add a row for each). Add one sentence after the table: "Form controls (inputs, selects, textareas) draw their boundary with `--border-strong`, which meets 3:1 against `--bg` and `--surface` in both themes; `tests/ui/tokens.test.js` enforces it."

- [ ] **Step 2: §4 Assets** — add under the Illustrations bullet: "Production views do not reference `/ui/assets/…` images. Static exports inline the stylesheet and bundle the scripts and must not contain `src=\"/ui/` URLs (`tests/export/static.test.js`), so dashboard empty states are text with a next step. Use illustrations only on surfaces that are never exported, or inline the SVG."

- [ ] **Step 3: §5 Component contract** — replace the `Run row`, `Batch summary` and `Toast/receipt` rows, and add the new rows, keeping the table's three columns:

| Component | Required anatomy | States and behavior |
| --- | --- | --- |
| Run row | One `<button>` per run: state chip, ticket key (middle-ellipsised, full key in `title`) and title, recipe or mode, access badge (Read-only / Edits source / Full access), worker test-gate badge, one fact line, requested time | The fact line states only recorded facts: queued → "Queued" plus slot occupancy from `meta.handoff_limits`, and "repository busy" for a queued fix whose repository has a running fix; running → "Running for …" and "setup …" when measured; done → suggestions to review, files changed, draft PR; failed → the error plus "Retried as a new run" or "Superseded by a later run". Nothing interactive nests inside the row button |
| Batch summary | Batch short id, recipe or "mixed", outcome counts across the whole batch, progress bar, "Cancel queued (n)" | Derived from run records, so it survives a reload; cancelling names only queued members and never claims running ones stopped |
| Run strip | Under the ticket title: the current run (else the latest) with state, recipe, test-gate badge, suggestions to review and time; opens run detail | "No agent runs yet · Run agent" when there are none (owner only) |
| Run detail | Header (state, recipe and source, mode, access, test gate, measured timings, batch, retry relationship); Result; Changes; Delivery (PR link, branch, uncertain effects); Where it is (owner-only checkout path as text with copy, never a link); Suggestions; actions | Sections absent from the record or stripped by an export are omitted, never rendered empty; uncertain effects use warning styling, never success; a stale link shows "Run not found" |
| Run agent dialog | Step 1 recipe cards (reads/edits marker, time cap); step 2 permissions with side effects under Advanced, a plain summary of what the run will do, prerequisite blockers and warnings | Queue is disabled while a blocker applies and says why; a missing test command is a warning ("Not test-verified"), not a pass |
| Status button | One top-bar button: dot and short label (Updated …, provider errors, Offline, Needs attention) opening a popover with connection, health and Refresh | Errors and offline colour the dot and label; never hidden behind the popover |
| Toast/receipt | Action and confirmed outcome, LIVE chip, dismiss | Neutral and good receipts clear after 6 s; critical receipts stay until dismissed; never imply queued work has completed |
| Filter button | "Filter · n" opening a popover of the existing filters; active filters stay visible as removable tokens | Same hash parameters as before |
| Navigation | Grouped Work (Pick next, Board, Runs) and Track (Activity, Sessions, Deployments, Relationships); phones show Pick next, Board, Runs, Activity and More | The Runs badge counts live runs; a separate attention dot means "needs you"; shortcuts 1–6 unchanged, 7 opens Runs |

- [ ] **Step 4: §6 Honest state language** — replace the "Use explicit copy:" example list with examples the shipped UI produces, followed by the rule that motivated them:

```markdown
- "Queued · read-only slots 2/2 in use" — occupancy, not a claimed cause.
- "Queued · fix slots 1/1 in use · repository busy" — only for a queued fix.
- "Running for 2 min · setup 4 s" — the worker records agent and test time only when a run finishes, so a running row never names a phase.
- "Tests passed (worker)" / "Not test-verified" / "Tests failed".
- "2 suggestions to review".
- "Retried as a new run" / "Superseded by a later run".
- "Cancel queued (3)" when running members are unaffected.

A row or chip states only what the snapshot records. When the worker starts projecting live phases or wait reasons, add them here first, then to the UI.
```

- [ ] **Step 5: §7 Orchestration information architecture** — replace the **Shipped** and **Proposed** paragraphs with:

```markdown
**Shipped:** Pick next, Board, Runs, Activity, Sessions, Deployments, Relationships. Runs (`#view=runs`, shortcut 7) has Needs you, Live, Failed and All tabs (`tab=`), rows grouped by batch, and run detail in the side panel (`run=`). Needs you holds open proposals, finished runs with suggestions to decide, and failed or timed-out runs from the last 7 days on open tickets that no later run superseded; cancelled runs never need you; exports have no Needs you. Ticket detail has Overview, Runs, Activity and Delivery tabs (`section=`) and a run strip under the title. Proposed runs live in Runs → Needs you and the ticket's Runs tab; Activity is history only. Internal route names `tree` and `today` remain.

**Not yet built:** worker-projected phases and wait reasons, readiness checks the snapshot cannot answer, prewarmed worktrees, nested run groups.
```

Keep the existing "Recommended Runs workflow" list; it matches what shipped.

- [ ] **Step 6: §8 and §10** — in §8 add: "Runs rows and the run detail panel must fit 390px with no document overflow (the runs-first browser check asserts it)." In §10 add: "Run `node scripts/build-ui-assets.mjs --check` after any `ui/styles.css` token change; regenerate with `node scripts/build-ui-assets.mjs` when it reports drift."

- [ ] **Step 7: Reference specimen** — in `docs/design-system/index.html`, change only the `#orchestration` section so it mirrors the shipped Runs page:
  - tabs Needs you / Live / Failed, keeping the existing `q-tabs` / `q-tab` / `data-panel` markup that `reference.js` drives (update `id`, `aria-controls` and `data-panel` values consistently);
  - row captions use only the Step 4 copy — no "Phase: worker tests", no "another fix holds the checkout slot", no agent time on a running row;
  - the lede "Proposed pattern, not a shipped Runs view." becomes "The shipped Runs page, with example data.", and the "Reference pattern" chip text becomes "Example data".

- [ ] **Step 8: DESIGN.md, CLAUDE.md, handover**
  - `DESIGN.md`: replace "The reference kit is opt-in. It does not change dashboard styles or create a production Runs view." with "The reference kit is opt-in; the production dashboard keeps its own stylesheet. The Runs page and run detail are shipped (see §7 of the contract)."
  - `CLAUDE.md`: replace "Do not claim to have implemented a Runs workspace merely by adding assets or a reference-page example." with "The Runs page, run detail, ticket Runs tab and Run agent dialog are shipped; their contract is §5–§7 of the design system. Asset or specimen changes alone do not change that behaviour."
  - `docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md`: insert directly under the title a `## Status (runs-first dashboard)` section listing which handover items the branch resolved — P1 full results, P1 Sessions checkpoint link, P2 batch history after reload, the Runs surface, run detail evidence, ticket run discovery, dispatch consolidation, attention dot, mobile navigation — and which remain (authoritative wait reasons and phases, worker readiness projections, filter-scope labelling beyond the approvals button). Leave the original sections untouched.

- [ ] **Step 9: Regenerate previews and check**

Run: `node scripts/build-ui-assets.mjs --check` — expected exit 0.

Start `node scripts/preview-design-system.mjs --port 0` in the background, capture the reference page at 1440×900 in light and dark with Playwright (same runtime path as Task 13) over `docs/design-system/preview-light.png` and `preview-dark.png` (the page's theme button toggles `data-theme`), then stop the server.

Run: `git grep -n -e "Phase: worker tests" -e "another fix holds the checkout slot" -e "not a shipped Runs view" -e "create a production Runs view" -- docs DESIGN.md CLAUDE.md`
Expected: no output (the plan and spec under `docs/superpowers` do not contain these strings).

- [ ] **Step 10: Commit**

```bash
git add docs/design-system DESIGN.md CLAUDE.md docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md
git commit -m "docs(design): describe the shipped runs-first dashboard in Fieldnotes

The Runs page, run detail, ticket Runs tab, Run agent dialog, grouped
navigation, status popover and toasts are now part of the contract;
example copy states only what the worker records.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
