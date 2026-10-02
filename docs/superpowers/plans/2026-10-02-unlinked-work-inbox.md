# Unlinked Work Inbox and External Key Chips (Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship step 2 of "Session Quill: zero-command ticket tracking": an inbox on Pick next for work captured while a session had no ticket (attach to a ticket, create a ticket from its key, or dismiss), external key chips that open the tracker link and copy the key, and "Link to external" for local keys.

**Architecture:** Today the reducer drops post-tool results that have no ticket. It will keep them on the session as `unbound_work` (files, commits, a monotonic revision). Three new revision-checked request kinds go through the existing request state machine with the 10-second undo window: `attach-unbound` and `dismiss-unbound` target a session and check `unbound_work.revision`; `link-external` targets a ticket and checks its revision. The worker resolves tracker links from the runtime identity it already publishes. The dashboard renders the inbox above the ranked candidates and replaces bare key labels with link-plus-copy chips when a ticket has an external link.

**Tech Stack:** Node 22+ ESM, built-ins only, `node:test`; plain ESM UI modules rendered as HTML strings.

**Spec:** Claude Doc "Session Quill: zero-command ticket tracking" (https://claude.ai/artifact/CQjjJMoyhY2tweXK2jJpQr, rev 11: "UI features" → Unbound work inbox, External key chips; "Changed" → empty states; "Implementation order" step 2), with `docs/DATA-CONTRACT.md` §Mutation request (revision checks, 10 s undo, terminal states), `docs/UI-DESIGN.md` (Pick next, components), `docs/decisions/0005-gate-modes-and-auto-binding.md` (forward-only automatic binding; unlinked work deferred to this step).

## Global Constraints

- Node built-ins only; UI stays plain ESM rendered as strings; every value interpolated into HTML goes through `esc`/`attr`.
- Every mutation is a revision-checked request: no last-write-wins; pending edits have `not_before = created_at + 10 s` and can be cancelled while pending (DATA-CONTRACT §Mutation request).
- Automatic binding stays forward-only (ADR 0005). Attaching unlinked work is retroactive only because the owner explicitly picks the ticket for exactly the work shown.
- Links open only `https://` URLs, in a new tab with `rel="noopener noreferrer"`.
- Exports stay sanitized: `unbound_work` never leaves the machine (sessions keep the existing allowlist), and external links are stripped unless links are explicitly included.
- Only the local owner sees mutation controls; a read-only snapshot shows no inbox and no link actions.
- Nothing is posted to an external tracker.

## Review Focus

1. **New work captured between viewing and applying an attach.** The request must conflict, never silently attach work the owner did not see. Test: Task 3 `new work after the owner looked makes the attach a conflict`.
2. **Hostile values in session titles, file paths, commit messages and URLs.** Everything rendered is escaped and only https links render as anchors. Tests: Task 4 `only https links render`, Task 5 `the inbox escapes session and file text`.
3. **Attaching to a key that already exists, or that was created since the request was queued.** The reducer must reuse the ticket, never create a duplicate key. Test: Task 2 `create reuses a ticket that took the key first`.
4. **A request whose session work was already attached or dismissed.** Refused before the queue, or failed at apply time, never applied twice. Tests: Task 3.
5. **Exported snapshots.** No `unbound_work`, no external URL unless links are included. Test: Task 4 `exports strip external links by default`.

---

### Task 1: Keep unlinked work on the session

**Files:**
- Modify: `src/core/state.js` (`newSession` gains `unbound_work: null`; new `hasUnboundWork`)
- Modify: `src/core/reducer.js` (`recordUnboundWork`; `handlePostTool` records instead of returning)
- Test: new `tests/core/unbound-work.test.js`

**Interfaces:**
- Produces: `session.unbound_work = { revision, files: [{ repo_id, relative_path, first_seen, last_seen }], commits: [{ sha, message, at }], first_at, last_at, dismissed_at } | null`; `hasUnboundWork(session) -> boolean` (has files or commits and is not dismissed).

- [ ] **Step 1: Write the failing test** `tests/core/unbound-work.test.js`

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev, resetSeq, bind } from './helpers.js';
import { hasUnboundWork } from '../../src/core/state.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => resetSeq());

export function edit(state, session_id, id, file, at = '2026-10-02T08:05:00Z') {
  ev(state, 'pre-tool', { tool_name: 'Edit', write_target: file }, { session_id, tool_call_id: id, occurred_at: at });
  return ev(state, 'post-tool', { tool_name: 'Edit', write_paths: [file], repo_id: null, success: true }, { session_id, tool_call_id: id, source_identity: `post-tool:${session_id}:${id}`, occurred_at: at });
}

export function commit(state, session_id, id, sha, at = '2026-10-02T08:06:00Z') {
  ev(state, 'pre-tool', { tool_name: 'Bash', write_target: 'git commit' }, { session_id, tool_call_id: id, occurred_at: at });
  return ev(state, 'post-tool', { tool_name: 'Bash', write_paths: [], commit: { sha, message: 'feat: retry' }, repo_id: null, success: true }, { session_id, tool_call_id: id, source_identity: `post-tool:${session_id}:${id}`, occurred_at: at });
}

test('writes and commits from an unbound session are kept on the session as unlinked work', () => {
  const state = newState();
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id: 'u1' });
  edit(state, 'u1', 't1', 'src/a.js');
  edit(state, 'u1', 't2', 'src/a.js', '2026-10-02T08:07:00Z');
  edit(state, 'u1', 't3', 'src/b.js');
  commit(state, 'u1', 't4', 'abc1234def');
  const s = state.sessions.get('u1');
  assert.deepEqual(s.unbound_work.files.map((f) => f.relative_path), ['src/a.js', 'src/b.js']);
  assert.equal(s.unbound_work.files[0].last_seen, '2026-10-02T08:07:00Z');
  assert.deepEqual(s.unbound_work.commits, [{ sha: 'abc1234def', message: 'feat: retry', at: '2026-10-02T08:06:00Z' }]);
  assert.equal(s.unbound_work.revision, 4);
  assert.equal(s.unbound_work.first_at, '2026-10-02T08:05:00Z');
  assert.equal(s.successful_write_count, 4);
  assert.equal(hasUnboundWork(s), true);
});

test('bound sessions and non-write tools record no unlinked work', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'b1', T1);
  edit(state, 'b1', 't1', 'src/a.js');
  assert.equal(state.sessions.get('b1').unbound_work, null);
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id: 'u2' });
  ev(state, 'pre-tool', { tool_name: 'Read' }, { session_id: 'u2', tool_call_id: 'r1' });
  ev(state, 'post-tool', { tool_name: 'Read', write_paths: [], repo_id: null, success: true }, { session_id: 'u2', tool_call_id: 'r1', source_identity: 'post-tool:u2:r1' });
  assert.equal(state.sessions.get('u2').unbound_work, null);
  assert.equal(hasUnboundWork(state.sessions.get('u2')), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core/unbound-work.test.js`
Expected: FAIL (`hasUnboundWork` is not exported).

- [ ] **Step 3: Implement**

`src/core/state.js`: add `unbound_work: null,` after `events_since_checkpoint: 0,` in `newSession`, and export:

```js
// A session's unlinked work is shown in the inbox until it is attached or dismissed (ADR 0006).
export function hasUnboundWork(session) {
  const w = session && session.unbound_work;
  return !!(w && !w.dismissed_at && ((w.files && w.files.length) || (w.commits && w.commits.length)));
}
```

`src/core/reducer.js`: add before `handlePostTool`:

```js
const UNBOUND_FILE_CAP = 500;
const UNBOUND_COMMIT_CAP = 200;

// Writes and commits captured while a session had no ticket stay on the session, unattributed,
// until the owner attaches or dismisses them from the inbox (ADR 0006). The revision only moves
// when this work changes, so inbox requests can be revision-checked against what the owner saw.
function recordUnboundWork(session, ev, { writePaths, commit, repo_id }) {
  let w = session.unbound_work;
  if (!w || w.dismissed_at || (!w.files.length && !w.commits.length)) {
    w = { revision: w ? w.revision : 0, files: [], commits: [], first_at: ev.occurred_at, last_at: ev.occurred_at, dismissed_at: null };
    session.unbound_work = w;
  }
  for (const rel of writePaths) {
    const existing = w.files.find((f) => f.repo_id === repo_id && f.relative_path === rel);
    if (existing) existing.last_seen = ev.occurred_at;
    else if (w.files.length < UNBOUND_FILE_CAP) w.files.push({ repo_id, relative_path: rel, first_seen: ev.occurred_at, last_seen: ev.occurred_at });
  }
  if (commit && !w.commits.some((c) => c.sha === commit.sha) && w.commits.length < UNBOUND_COMMIT_CAP) {
    w.commits.push({ sha: commit.sha, message: typeof commit.message === 'string' ? commit.message.slice(0, 200) : '', at: ev.occurred_at });
  }
  if (ev.occurred_at > w.last_at) w.last_at = ev.occurred_at;
  w.revision += 1;
}
```

In `handlePostTool`, replace `if (!ticket) return;` with:

```js
  if (!ticket) {
    const unboundPaths = WRITE_TOOLS.has(p.tool_name) && Array.isArray(p.write_paths) ? p.write_paths.filter((x) => typeof x === 'string' && x) : [];
    const unboundCommit = p.commit && typeof p.commit.sha === 'string' && p.commit.sha ? p.commit : null;
    if (unboundPaths.length || unboundCommit) {
      recordUnboundWork(session, ev, { writePaths: unboundPaths, commit: unboundCommit, repo_id: p.repo_id ?? null });
      session.successful_write_count += 1;
    }
    return;
  }
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/core/unbound-work.test.js tests/core/reducer.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.js src/core/reducer.js tests/core/unbound-work.test.js
git commit -m "feat(core): keep work captured without a ticket on the session"
```

---

### Task 2: Reducer mutations — attach, dismiss, relink

**Files:**
- Modify: `src/core/reducer.js` (`relinkTicket` extracted from the `relink` case; `attachUnboundWork`; `handleRequestTx` branches `unbound-attach`, `unbound-dismiss`, `relink`)
- Test: `tests/core/unbound-work.test.js`

**Interfaces:**
- Consumes: Task 1 fields.
- Produces mutation shapes (built by Task 3, applied here):
  - `{ type: 'unbound-attach', session_id, ticket_id, create: TicketSpec | null, bind: boolean }`
  - `{ type: 'unbound-dismiss', session_id }`
  - `{ type: 'relink', ticket_id, new_key, external, jira? }`

- [ ] **Step 1: Write the failing tests** (append to `tests/core/unbound-work.test.js`; add `import { externalTicketId } from '../../src/core/external-keys.js';` and `import { STORE } from './helpers.js';` to the existing helpers import)

```js
let reqN = 0;
function apply(state, mutation) {
  reqN += 1;
  const id = `00000000-0000-4000-8000-${String(reqN).padStart(12, '0')}`;
  ev(state, 'request', { id, kind: 'attach-unbound', target_id: null, payload: {} });
  return ev(state, 'request-tx', { request_id: id, outcome: 'applied', mutation });
}

function unboundSession(state, id = 'u1') {
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id: id });
  edit(state, id, `${id}-t1`, 'src/a.js');
  commit(state, id, `${id}-t2`, 'abc1234def');
  ev(state, 'stop', { complete: true, content_ref: 'c'.repeat(64), preview: 'Fixed the retry test', length: 20, conclusions: [] }, { session_id: id, occurred_at: '2026-10-02T08:08:00Z' });
  return state.sessions.get(id);
}

test('attaching moves files, commits and checkpoints to the ticket and links the still-unbound session', () => {
  const state = newState();
  const t = createTicket(state);
  const s = unboundSession(state);
  const before = s.unbound_work.revision;
  const r = apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: T1, create: null, bind: true });
  assert.deepEqual(t.files_touched.map((f) => f.relative_path), ['src/a.js']);
  assert.ok(t.timeline.some((e) => e.kind === 'commit' && /abc1234def.*attached/.test(e.text)));
  assert.ok(t.timeline.some((e) => /Attached unlinked work from session u1: 1 file, 1 commit/.test(e.text)));
  const cp = [...state.checkpoints.values()].find((c) => c.session_id === s.id);
  assert.equal(cp.ticket_id, T1);
  assert.equal(s.current_ticket_id, T1);
  assert.ok(t.session_ids.includes(s.id));
  assert.equal(hasUnboundWork(s), false);
  assert.equal(s.unbound_work.revision, before + 1);
  assert.ok(r.bindingChanged.has('u1'));
});

test('attaching never rebinds a session that is already linked to another ticket', () => {
  const state = newState();
  createTicket(state);
  createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'LOCAL-two-00000002' });
  const s = unboundSession(state);
  ev(state, 'bind', { ticket_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', project_id: 'demo' }, { session_id: 'u1' });
  apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: T1, create: null, bind: true });
  assert.equal(s.current_ticket_id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.deepEqual(state.tickets.get(T1).files_touched.map((f) => f.relative_path), ['src/a.js']);
});

test('create from key makes the ticket; create reuses a ticket that took the key first', () => {
  const state = newState();
  const s = unboundSession(state);
  const id = externalTicketId(STORE, 'PMLA-5');
  const spec = { id, key: 'PMLA-5', title: 'Retry fix', project_id: 'demo', category: 'research', priority: 'P2', repo_id: null, external: { system: 'jira', key: 'PMLA-5', url: 'https://example.atlassian.net/browse/PMLA-5', validation: 'pending', validated_at: null, error: null }, jira: null, created_via: 'inbox' };
  apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: id, create: spec, bind: false });
  const t = state.tickets.get(id);
  assert.equal(t.key, 'PMLA-5');
  assert.match(t.timeline[0].text, /Created \(inbox\)/);
  assert.equal(s.current_ticket_id, null, 'bind: false leaves the session unbound');
  const s2 = unboundSession(state, 'u2');
  createTicket(state, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', key: 'PMLA-6' });
  apply(state, { type: 'unbound-attach', session_id: s2.id, ticket_id: externalTicketId(STORE, 'PMLA-6'), create: { ...spec, id: externalTicketId(STORE, 'PMLA-6'), key: 'PMLA-6' }, bind: false });
  assert.equal([...state.tickets.values()].filter((x) => x.key === 'PMLA-6').length, 1);
  assert.deepEqual(state.tickets.get('cccccccc-cccc-4ccc-8ccc-cccccccccccc').files_touched.map((f) => f.relative_path), ['src/a.js']);
});

test('dismissing hides the batch; later unlinked work starts a new batch with a higher revision', () => {
  const state = newState();
  const s = unboundSession(state);
  const rev = s.unbound_work.revision;
  apply(state, { type: 'unbound-dismiss', session_id: s.id });
  assert.equal(hasUnboundWork(s), false);
  assert.ok(s.unbound_work.dismissed_at);
  edit(state, 'u1', 'u1-t9', 'src/c.js', '2026-10-02T09:00:00Z');
  assert.deepEqual(s.unbound_work.files.map((f) => f.relative_path), ['src/c.js']);
  assert.equal(s.unbound_work.dismissed_at, null);
  assert.ok(s.unbound_work.revision > rev + 1);
});

test('a relink mutation sets the key, keeps the old key as an alias and stores the external link', () => {
  const state = newState();
  const t = createTicket(state);
  apply(state, { type: 'relink', ticket_id: T1, new_key: 'PMLA-1', external: { system: 'jira', key: 'PMLA-1', url: 'https://example.atlassian.net/browse/PMLA-1', validation: 'pending', validated_at: null, error: 'pending' } });
  assert.equal(t.key, 'PMLA-1');
  assert.deepEqual(t.aliases, ['LOCAL-demo-ticket-00000001']);
  assert.equal(t.external.url, 'https://example.atlassian.net/browse/PMLA-1');
  assert.equal(state.keyIndex.get('PMLA-1'), T1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core/unbound-work.test.js`
Expected: FAIL (mutations ignored: files not moved, session unbound).

- [ ] **Step 3: Implement** in `src/core/reducer.js`

Replace the body of the `relink` case with a call to an extracted function:

```js
// Shared by `ticket relink` and the dashboard's "Link to external" request.
function relinkTicket(state, ticket, ev, p, result) {
  const newKey = p.new_key;
  if (newKey && newKey !== ticket.key) {
    try { validateKey(newKey); } catch { return { rejected: 'key-invalid' }; }
    const owner = state.keyIndex.get(newKey);
    if (owner && owner !== ticket.id) return { rejected: 'key-collision' };
    if (!ticket.aliases.includes(ticket.key)) ticket.aliases.push(ticket.key);
    ticket.key = newKey;
    state.keyIndex.set(newKey, ticket.id);
  }
  if (p.jira !== undefined) ticket.jira = p.jira;
  if (p.external !== undefined) ticket.external = p.external;
  const link = ticket.external ? ` (${ticket.external.system} ${ticket.external.key}, validation ${ticket.external.validation})` : ticket.jira ? ` (Jira ${ticket.jira.key}, validation ${ticket.jira.validation})` : '';
  ticket.timeline.push(timelineEntry(ev, 'status', `Relinked to ${ticket.key}${link}`));
  touch(state, ticket, ev, result);
  return {};
}
```

```js
    case 'relink': {
      const ticket = state.tickets.get(ev.payload.ticket_id);
      if (!ticket) { result.rejected = 'ticket-unknown'; break; }
      const r = relinkTicket(state, ticket, ev, ev.payload, result);
      if (r.rejected) result.rejected = r.rejected;
      break;
    }
```

Add after `bindExternal`:

```js
// Owner-confirmed attachment of a session's unlinked work (ADR 0006). Unlike automatic binding
// this is retroactive by design: the owner picked the ticket for exactly the work shown.
function attachUnboundWork(state, ev, m, result) {
  const session = state.sessionsById.get(m.session_id);
  const w = session && session.unbound_work;
  if (!w || w.dismissed_at || (!w.files.length && !w.commits.length)) return { rejected: 'unbound-gone' };
  let ticketId = m.ticket_id ?? null;
  if (m.create) {
    ticketId = state.keyIndex.get(m.create.key) ?? null;
    if (!ticketId) {
      const created = createTicket(state, ev, m.create, 'manual', result);
      if (created.rejected) return created;
      ticketId = m.create.id;
    }
  }
  const ticket = ticketId ? state.tickets.get(ticketId) : null;
  if (!ticket) return { rejected: 'ticket-unknown' };
  for (const f of w.files) {
    const repo_id = f.repo_id ?? ticket.repo_id ?? null;
    const existing = ticket.files_touched.find((x) => x.repo_id === repo_id && x.relative_path === f.relative_path);
    if (existing) {
      if (f.first_seen < existing.first_seen) existing.first_seen = f.first_seen;
      if (f.last_seen > existing.last_seen) existing.last_seen = f.last_seen;
    } else {
      ticket.files_touched.push({ repo_id, relative_path: f.relative_path, first_seen: f.first_seen, last_seen: f.last_seen });
    }
  }
  w.commits.forEach((c, i) => {
    ticket.timeline.push(timelineEntry(ev, 'commit', `Commit ${c.sha.slice(0, 10)}${c.message ? `: ${c.message}` : ''} (attached)`, { index: i }));
  });
  const files = `${w.files.length} file${w.files.length === 1 ? '' : 's'}`;
  const commits = `${w.commits.length} commit${w.commits.length === 1 ? '' : 's'}`;
  ticket.timeline.push(timelineEntry(ev, 'write', `Attached unlinked work from session ${session.host_session_id}: ${files}, ${commits}`));
  for (const id of state.checkpointsBySession.get(session.id) ?? []) {
    const cp = state.checkpoints.get(id);
    if (cp && !cp.ticket_id) cp.ticket_id = ticket.id;
  }
  if (!ticket.session_ids.includes(session.id)) ticket.session_ids.push(session.id);
  if (!session.ticket_ids.includes(ticket.id)) session.ticket_ids.push(ticket.id);
  session.unbound_work = { revision: w.revision + 1, files: [], commits: [], first_at: null, last_at: null, dismissed_at: null };
  if (m.bind && !session.current_ticket_id) bindSession(state, session, ev, { ticket_id: ticket.id, project_id: ticket.project_id }, result);
  else touch(state, ticket, ev, result);
  recomputeUnpromoted(state, session);
  return {};
}
```

In `handleRequestTx`, after the `handoff-cancel` branch add:

```js
    } else if (m.type === 'unbound-attach') {
      const r = attachUnboundWork(state, ev, m, result);
      if (!r.rejected && m.ticket_id && state.tickets.has(m.ticket_id)) req.applied_revision = state.tickets.get(m.ticket_id).revision;
    } else if (m.type === 'unbound-dismiss') {
      const s = state.sessionsById.get(m.session_id);
      if (s && s.unbound_work && !s.unbound_work.dismissed_at) {
        s.unbound_work.dismissed_at = ev.occurred_at;
        s.unbound_work.revision += 1;
      }
    } else if (m.type === 'relink') {
      const ticket = state.tickets.get(m.ticket_id);
      if (ticket && !relinkTicket(state, ticket, ev, m, result).rejected) req.applied_revision = ticket.revision;
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/core/unbound-work.test.js tests/core/reducer.test.js tests/core/external-bind.test.js tests/cli/ticket.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/reducer.js tests/core/unbound-work.test.js
git commit -m "feat(core): attach, dismiss and relink mutations for unlinked work"
```

---

### Task 3: Request kinds `attach-unbound`, `dismiss-unbound`, `link-external`

**Files:**
- Modify: `src/server/requests.js` (kinds, validation, evaluation, session id on the transaction event)
- Modify: `src/worker/worker.js` (`publishIdentity` keeps `this.identity`)
- Test: new `tests/server/unbound-requests.test.js`

**Interfaces:**
- Consumes: Task 2 mutations; `scopeFor` (`src/hooks/scope.js`); `renderUrl`, `isSafeExternalUrl`, `externalTicketId`, `TRACKER_SYSTEMS` (`src/core/external-keys.js`); `hasUnboundWork` (Task 1).
- Produces request bodies (UI in Task 5 sends these):
  - `{ kind: 'attach-unbound', target_id: session.id, expected_revision: session.unbound_work.revision, payload: { ticket_id } | { key, title? }, plus optional bind (default true) }`
  - `{ kind: 'dismiss-unbound', target_id: session.id, expected_revision, payload: {} }`
  - `{ kind: 'link-external', target_id: ticket.id, expected_revision: ticket.revision, payload: { key, system?, url? } }`
  - All three are delayed by the 10 s undo window.

- [ ] **Step 1: Write the failing test** `tests/server/unbound-requests.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { scenario, T1, T2 } from '../acceptance/scenario.js';
import { submitRequest, applyDueRequests } from '../../src/server/requests.js';
import { readBindingSnapshot } from '../../src/hooks/binding-snapshot.js';
import { externalTicketId } from '../../src/core/external-keys.js';

const TRACKER = { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA'] };

async function start() {
  const s = scenario({ gateMode: 'nudge' });
  s.config.tracker = TRACKER;
  s.repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-inbox-'));
  await s.start();
  return s;
}

function unboundEdit(s, session_id, id, rel) {
  const file = path.join(s.repo, ...rel.split('/'));
  s.hook('PreToolUse', { session_id, cwd: s.repo, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file } });
  s.hook('PostToolUse', { session_id, cwd: s.repo, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file }, tool_response: { filePath: file } });
}

const sessionOf = (s, host) => [...s.w.state.sessions.values()].find((x) => x.host_session_id === host);
const body = (kind, target_id, expected_revision, payload) => ({ id: randomUUID(), kind, target_id, expected_revision, payload });

async function applyAfterUndo(s) {
  s.advance(10_000);
  applyDueRequests(s.w, s.iso());
  await s.settle();
}

test('attach-unbound to an existing ticket waits for the undo window, then links the still-unbound session', async () => {
  const s = await start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.hook('SessionStart', { session_id: 'q1', cwd: s.repo, source: 'startup' });
    unboundEdit(s, 'q1', 'qa', 'src/a.js');
    await s.settle();
    const sess = sessionOf(s, 'q1');
    const { status, request } = submitRequest(s.w, body('attach-unbound', sess.id, sess.unbound_work.revision, { ticket_id: T1 }));
    assert.equal(status, 202);
    assert.equal(request.state, 'pending');
    assert.equal(applyDueRequests(s.w, s.iso()), 0, 'nothing applies inside the undo window');
    await applyAfterUndo(s);
    assert.equal(s.w.state.requests.get(request.id).state, 'applied');
    assert.deepEqual(s.w.state.tickets.get(T1).files_touched.map((f) => f.relative_path), ['src/a.js']);
    assert.equal(sessionOf(s, 'q1').current_ticket_id, T1);
    assert.equal(readBindingSnapshot('q1', s.env).ticket_id, T1);
  } finally { await s.stop(); }
});

test('new work after the owner looked makes the attach a conflict; dismiss hides the batch; stale or malformed requests are refused before the queue', async () => {
  const s = await start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.hook('SessionStart', { session_id: 'q2', cwd: s.repo, source: 'startup' });
    unboundEdit(s, 'q2', 'qb', 'src/a.js');
    await s.settle();
    const seen = sessionOf(s, 'q2').unbound_work.revision;
    const { request } = submitRequest(s.w, body('attach-unbound', sessionOf(s, 'q2').id, seen, { ticket_id: T1 }));
    unboundEdit(s, 'q2', 'qc', 'src/b.js');
    await s.settle();
    await applyAfterUndo(s);
    const conflicted = s.w.state.requests.get(request.id);
    assert.equal(conflicted.state, 'conflict');
    assert.equal(conflicted.error.current_revision, sessionOf(s, 'q2').unbound_work.revision);
    assert.deepEqual(s.w.state.tickets.get(T1).files_touched, [], 'nothing was attached');
    const sess = sessionOf(s, 'q2');
    assert.throws(() => submitRequest(s.w, body('attach-unbound', sess.id, sess.unbound_work.revision, { ticket_id: T1, key: 'PMLA-1' })), (e) => e.code === 'request-invalid');
    assert.throws(() => submitRequest(s.w, body('attach-unbound', sess.id, sess.unbound_work.revision, { key: 'not a key' })), (e) => e.code === 'key-invalid');
    assert.throws(() => submitRequest(s.w, body('attach-unbound', sess.id, null, { ticket_id: T1 })), (e) => e.code === 'expected-revision-required');
    const dismiss = submitRequest(s.w, body('dismiss-unbound', sess.id, sess.unbound_work.revision, {})).request;
    await applyAfterUndo(s);
    assert.equal(s.w.state.requests.get(dismiss.id).state, 'applied');
    assert.ok(sessionOf(s, 'q2').unbound_work.dismissed_at);
    assert.throws(() => submitRequest(s.w, body('dismiss-unbound', sess.id, sessionOf(s, 'q2').unbound_work.revision, {})), (e) => e.code === 'unbound-gone');
  } finally { await s.stop(); }
});

test('create from key makes the ticket with the tracker link and the given title', async () => {
  const s = await start();
  try {
    s.hook('SessionStart', { session_id: 'q3', cwd: s.repo, source: 'startup' });
    unboundEdit(s, 'q3', 'qd', 'src/retry.js');
    await s.settle();
    const sess = sessionOf(s, 'q3');
    const { request } = submitRequest(s.w, body('attach-unbound', sess.id, sess.unbound_work.revision, { key: 'PMLA-77', title: 'Retry fix' }));
    await applyAfterUndo(s);
    const done = s.w.state.requests.get(request.id);
    assert.equal(done.state, 'applied');
    assert.deepEqual(done.result, { ticket_id: externalTicketId(s.meta.store_id, 'PMLA-77'), created: true });
    const t = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-77'));
    assert.deepEqual([t.key, t.title, t.external.url], ['PMLA-77', 'Retry fix', 'https://example.atlassian.net/browse/PMLA-77']);
    assert.deepEqual(t.files_touched.map((f) => f.relative_path), ['src/retry.js']);
  } finally { await s.stop(); }
});

test('link-external relinks a local ticket with a rendered link and refuses keys owned by another ticket', async () => {
  const s = await start();
  try {
    const t = s.ticket(T1, 'LOCAL-a-00000001');
    s.ticket(T2, 'PMLA-2');
    assert.throws(() => submitRequest(s.w, body('link-external', T1, t.revision, { key: 'PMLA-2' })), (e) => e.code === 'key-collision');
    assert.throws(() => submitRequest(s.w, body('link-external', T1, t.revision, { key: 'PMLA-1', url: 'http://insecure.example/PMLA-1' })), (e) => e.code === 'external-url-invalid');
    const { request } = submitRequest(s.w, body('link-external', T1, t.revision, { key: 'PMLA-1' }));
    await applyAfterUndo(s);
    assert.equal(s.w.state.requests.get(request.id).state, 'applied');
    const after = s.w.state.tickets.get(T1);
    assert.deepEqual([after.key, after.aliases[0], after.external.system, after.external.url], ['PMLA-1', 'LOCAL-a-00000001', 'jira', 'https://example.atlassian.net/browse/PMLA-1']);
  } finally { await s.stop(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/server/unbound-requests.test.js`
Expected: FAIL with `kind-invalid`.

- [ ] **Step 3: Implement**

`src/worker/worker.js` `publishIdentity`: after building, keep it: `this.identity = identity;`.

`src/server/requests.js`:
- imports: `hasUnboundWork` from `'../core/state.js'` (extend the existing import); `validateKey` from `'../core/keys.js'`; `renderUrl, isSafeExternalUrl, externalTicketId, TRACKER_SYSTEMS` from `'../core/external-keys.js'`; `scopeFor` from `'../hooks/scope.js'`.
- constants:

```js
export const KINDS = ['set-next-action', 'set-status', 'record-deployment', 'handoff', 'handoff-cancel', 'refresh', 'attach-unbound', 'dismiss-unbound', 'link-external'];
const TICKET_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment', 'handoff', 'handoff-cancel', 'link-external']);
const SESSION_KINDS = new Set(['attach-unbound', 'dismiss-unbound']);
const DELAYED_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment', 'attach-unbound', 'dismiss-unbound', 'link-external']);
const EXTERNAL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
```

- `validateRequestBody`: after the `TICKET_KINDS` block add

```js
  let session = null;
  if (SESSION_KINDS.has(body.kind)) {
    if (!body.target_id) throw new TrackerError('target-required', `${body.kind} requires target_id`);
    session = state.sessionsById.get(body.target_id);
    if (!session) throw new TrackerError('target-unknown', `unknown session ${body.target_id}`);
    if (!hasUnboundWork(session)) throw new TrackerError('unbound-gone', 'this session has no unlinked work to attach or dismiss');
    if (!Number.isInteger(body.expected_revision) || body.expected_revision < 0) throw new TrackerError('expected-revision-required', 'unlinked-work actions require expected_revision');
  }
```

  cases in the `switch`:

```js
    case 'attach-unbound': {
      const hasTicket = typeof payload.ticket_id === 'string' && payload.ticket_id !== '';
      const hasKey = typeof payload.key === 'string' && payload.key.trim() !== '';
      if (hasTicket === hasKey) throw new TrackerError('request-invalid', 'attach-unbound needs exactly one of ticket_id or key');
      const bind = payload.bind !== false;
      if (hasTicket) {
        if (!state.tickets.has(payload.ticket_id)) throw new TrackerError('target-unknown', `unknown ticket ${payload.ticket_id}`);
        normalized = { ticket_id: payload.ticket_id, bind };
      } else {
        const key = payload.key.trim();
        if (!EXTERNAL_KEY_RE.test(key)) throw new TrackerError('key-invalid', 'a ticket key like PROJ-123 is required');
        validateKey(key);
        normalized = { key, title: typeof payload.title === 'string' ? payload.title.trim().slice(0, 200) : '', bind };
      }
      break;
    }
    case 'dismiss-unbound':
      normalized = {};
      break;
    case 'link-external': {
      const key = typeof payload.key === 'string' ? payload.key.trim() : '';
      if (!EXTERNAL_KEY_RE.test(key)) throw new TrackerError('key-invalid', 'a ticket key like PROJ-123 is required');
      validateKey(key);
      if (payload.system !== undefined && payload.system !== null && !TRACKER_SYSTEMS.includes(payload.system)) throw new TrackerError('system-invalid', `system must be one of ${TRACKER_SYSTEMS.join(', ')}`);
      const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : null;
      if (url && !isSafeExternalUrl(url)) throw new TrackerError('external-url-invalid', 'the external link must be an https:// URL without spaces or quotes');
      const owner = state.keyIndex.get(key);
      if (owner && owner !== target.id) throw new TrackerError('key-collision', `${key} already identifies another ticket`);
      normalized = { key, system: payload.system ?? null, url };
      break;
    }
```

  and in the returned record use `target_id: target ? target.id : (session ? session.id : null)` and `expected_revision: session ? body.expected_revision : (target && !REVISION_OPTIONAL.has(body.kind) ? body.expected_revision : (Number.isInteger(body.expected_revision) ? body.expected_revision : null))`.

- evaluation helpers above `evaluateRequest`:

```js
function trackerFor(worker, { cwd = null, repo_id = null } = {}) {
  const identity = worker.identity;
  if (!identity) return null;
  if (repo_id) {
    const r = (identity.repos ?? []).find((x) => x.repo_id === repo_id);
    if (r) return r.tracker ?? null;
  }
  return cwd ? scopeFor(identity, cwd).tracker : identity.tracker ?? null;
}

function unboundCurrent(session) {
  const w = session && session.unbound_work;
  return { revision: w ? w.revision : null, files: w ? w.files.length : 0, commits: w ? w.commits.length : 0 };
}

function evaluateSessionRequest(worker, req) {
  const { state } = worker;
  const session = state.sessionsById.get(req.target_id);
  if (!session || !hasUnboundWork(session)) {
    return { outcome: 'failed', error: { code: 'unbound-gone', message: 'the unlinked work was already attached or dismissed', retryable: false, current_revision: session && session.unbound_work ? session.unbound_work.revision : null } };
  }
  if (session.unbound_work.revision !== req.expected_revision) {
    return { outcome: 'conflict', error: { code: 'revision-conflict', message: `more work was captured in this session after you looked (revision ${session.unbound_work.revision}, request expected ${req.expected_revision})`, retryable: false, current_revision: session.unbound_work.revision }, result: { current: unboundCurrent(session) } };
  }
  const who = { session_id: session.host_session_id, agent_id: session.agent_id ?? null };
  if (req.kind === 'dismiss-unbound') return { outcome: 'applied', mutation: { type: 'unbound-dismiss', session_id: session.id }, session: who };
  let ticketId = req.payload.ticket_id ?? null;
  let create = null;
  if (ticketId && !state.tickets.has(ticketId)) return { outcome: 'failed', error: { code: 'target-unknown', message: 'that ticket no longer exists', retryable: false, current_revision: null } };
  if (!ticketId) {
    const key = req.payload.key;
    ticketId = state.keyIndex.get(key) ?? null;
    if (!ticketId) {
      const scope = worker.identity ? scopeFor(worker.identity, session.cwd) : { project_id: null, repo_id: null, tracker: null };
      const tracker = trackerFor(worker, { cwd: session.cwd });
      const system = tracker ? tracker.system : 'custom';
      const url = renderUrl(key, tracker);
      const project_id = session.project_ids[session.project_ids.length - 1] ?? scope.project_id ?? Object.keys(state.meta.projects)[0] ?? null;
      if (!project_id) return { outcome: 'failed', error: { code: 'project-required', message: 'no project is configured for new tickets', retryable: false, current_revision: null } };
      const external = { system, key, url, validation: 'pending', validated_at: null, error: null };
      create = {
        id: externalTicketId(state.meta.store_id, key), key, title: req.payload.title || session.title || key, project_id, category: 'research', priority: 'P2', repo_id: scope.repo_id ?? null,
        external, jira: system === 'jira' ? { key, url, validation: 'pending', validated_at: null, error: null } : null, created_via: 'inbox',
      };
      ticketId = create.id;
    }
  }
  return { outcome: 'applied', mutation: { type: 'unbound-attach', session_id: session.id, ticket_id: ticketId, create, bind: req.payload.bind !== false }, result: { ticket_id: ticketId, created: !!create }, session: who };
}
```

- `evaluateRequest`: first line `if (SESSION_KINDS.has(req.kind)) return evaluateSessionRequest(worker, req);`, and a case:

```js
    case 'link-external': {
      const owner = state.keyIndex.get(req.payload.key);
      if (owner && owner !== ticket.id) return { outcome: 'failed', error: { code: 'key-collision', message: `${req.payload.key} already identifies another ticket`, retryable: false, current_revision: ticket.revision } };
      const tracker = trackerFor(worker, { repo_id: ticket.repo_id });
      const system = req.payload.system ?? (tracker ? tracker.system : 'custom');
      const url = req.payload.url ?? (tracker && tracker.system === system ? renderUrl(req.payload.key, tracker) : null);
      const pending = { validation: 'pending', validated_at: null, error: 'no tracker provider configured; remote validation pending' };
      const mutation = { type: 'relink', ticket_id: ticket.id, new_key: req.payload.key, external: { system, key: req.payload.key, url, ...pending } };
      if (system === 'jira') mutation.jira = { key: req.payload.key, url, ...pending };
      return { outcome: 'applied', mutation, result: { key: req.payload.key, url } };
    }
```

- `finish`: pass the session identity so the worker re-renders that session:

```js
  worker.emit('request-tx', payload, { source_identity: `request-tx:${req.id}:${evaluation.outcome}`, ...(evaluation.session ?? {}) });
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/server/unbound-requests.test.js tests/server/requests.test.js tests/server/http.test.js tests/acceptance/phase3.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/requests.js src/worker/worker.js tests/server/unbound-requests.test.js
git commit -m "feat(server): revision-checked attach, dismiss and link-external requests"
```

---

### Task 4: External key chips and sanitized export

**Files:**
- Modify: `ui/components.js` (icons `copy`, `inbox`; `SYSTEM_LABELS`, `externalLink`, `ticketKey`, `externalChip`, `hasUnlinkedWork`; `requestFeedback` moved here from `ui/views/detail.js`; `normalizeTicket` default `external: null`; `ticketCard` uses `ticketKey`)
- Modify: `ui/views/detail.js` (header uses `ticketKey` and `externalChip`; "Link to external…" for keys with no link; imports `requestFeedback`)
- Modify: `src/export/sanitize.js` (`external` in `DEFAULT_FIELDS` and `SELECTABLE_FIELDS`; URL stripped unless links are included)
- Modify: `ui/styles.css` (`.key-group`, `.key-link`, `.copy-key`, `.chip.external`)
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Produces: `ticketKey(ticket) -> html`, `externalChip(ticket) -> html`, `externalLink(ticket) -> { system, key, url } | null` (url only when `https://`), `hasUnlinkedWork(session)`, `requestFeedback(req, { now })`; detail button `data-action="link-external" data-ticket=<id>`.

- [ ] **Step 1: Write the failing tests** (append to `tests/ui/render.test.js`; extend imports with `ticketKey, externalChip` from `../../ui/components.js`, `ticket` from `./fixtures.js`, and `sanitizeSnapshot` from `../../src/export/sanitize.js`)

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL (`ticketKey` is not exported).

- [ ] **Step 3: Implement**

`ui/components.js`:
- add to `ICONS`:

```js
  copy: '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/>',
  inbox: '<path d="M2 9.5 4 3h8l2 6.5V13H2Z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
```

- add after `keyEl`:

```js
export const SYSTEM_LABELS = { jira: 'Jira', linear: 'Linear', github: 'GitHub', custom: 'Tracker' };

// The ticket's tracker link, from `external` or the legacy `jira` field; only https URLs count.
export function externalLink(ticket) {
  const ext = ticket && ticket.external ? ticket.external : (ticket && ticket.jira ? { system: 'jira', ...ticket.jira } : null);
  if (!ext || typeof ext.key !== 'string') return null;
  const url = typeof ext.url === 'string' && /^https:\/\/[^\s"'<>`]+$/.test(ext.url) ? ext.url : null;
  return { system: ext.system ?? 'custom', key: ext.key, url, validation: ext.validation ?? 'pending' };
}

// A key that names an external ticket opens it in a new tab; the copy button copies the key.
export function ticketKey(ticket) {
  const link = externalLink(ticket);
  if (!link || !link.url || link.key !== ticket.key) return keyEl(ticket.key);
  const where = SYSTEM_LABELS[link.system] ?? 'tracker';
  return `<span class="key-group"><a class="key key-link" href="${attr(link.url)}" target="_blank" rel="noopener noreferrer" title="${attr(`Open ${ticket.key} in ${where} (new tab)`)}">${esc(ticket.key)}</a><button type="button" class="copy-key" data-copy="${attr(ticket.key)}" aria-label="${attr(`Copy ${ticket.key}`)}" title="Copy key">${icon('copy')}</button></span>`;
}

export function externalChip(ticket) {
  const link = externalLink(ticket);
  if (!link) return '';
  const label = `${SYSTEM_LABELS[link.system] ?? 'Tracker'} ${link.key} · ${link.validation}`;
  return link.url
    ? ` <a class="chip external" data-validation="${attr(link.validation)}" href="${attr(link.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(label)}</a>`
    : ` <span class="chip external" data-validation="${attr(link.validation)}">${icon('link')}${esc(label)}</span>`;
}

export function hasUnlinkedWork(session) {
  const w = session && session.unbound_work;
  return !!(w && !w.dismissed_at && ((w.files ?? []).length || (w.commits ?? []).length));
}
```

- move `requestFeedback` from `ui/views/detail.js` into `ui/components.js` (exported; it needs `parseMs` from `./lib/time.js`, already imported there), extending its label line to

```js
  const label = { 'set-next-action': 'next action', 'set-status': 'status', 'record-deployment': 'deployment', 'attach-unbound': 'attach', 'dismiss-unbound': 'dismiss', 'link-external': 'link' }[req.kind] ?? req.kind;
```

  and its proposed value to `const proposedValue = req.payload && (req.payload.next_action ?? (req.payload.status ? STATUS_LABELS[req.payload.status] : null) ?? req.payload.key ?? null);`.
- `TICKET_DEFAULTS` gains `external: null`; in `ticketCard` replace `${keyEl(ticket.key)}` with `${ticketKey(ticket)}`.

`ui/views/detail.js`: import `requestFeedback, ticketKey, externalChip` from components and delete the local `requestFeedback`; the keys line becomes

```js
  <div class="detail-keys">${ticketKey(t)}${(t.aliases ?? []).map((a) => ` <span class="muted small">alias ${esc(a)}</span>`).join('')}${externalChip(t)}${!readOnly && !t.external && !t.jira ? ` <button type="button" class="btn small ghost" data-action="link-external" data-ticket="${attr(t.id)}">${icon('link')}Link to external…</button>` : ''}</div>
```

`src/export/sanitize.js`: add `'external'` to both field lists and a branch beside `jira`:

```js
    else if (f === 'external') out.external = t.external ? (o.includeLinks ? { ...t.external } : (({ url, ...x }) => x)(t.external)) : null;
```

`ui/styles.css` (after `.key`):

```css
.key-group { display: inline-flex; align-items: center; gap: 2px; }
.key-link { text-decoration: none; cursor: pointer; color: var(--accent); }
.key-link:hover, .key-link:focus-visible { text-decoration: underline; }
.copy-key { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: copy; padding: 0; }
.copy-key:hover, .copy-key:focus-visible { border-color: var(--border); color: var(--text); }
.copy-key .icon { width: 13px; height: 13px; }
.chip.external { text-decoration: none; text-transform: none; }
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/ui/render.test.js tests/ui/tokens.test.js tests/export/static.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/components.js ui/views/detail.js ui/styles.css src/export/sanitize.js tests/ui/render.test.js
git commit -m "feat(ui): external key chips with open and copy; Link to external for local keys"
```

---

### Task 5: Unlinked-work inbox, dialogs and wiring

**Files:**
- Modify: `ui/views/picknext.js` (`renderInbox`, inbox above ranked candidates, empty-state copy)
- Modify: `ui/views/board.js` (empty-state copy)
- Modify: `ui/views/dialogs.js` (`renderAttachDialog`, `renderLinkExternalDialog`)
- Modify: `ui/views/sessions.js` ("Unlinked work" indicator)
- Modify: `ui/app.js` (actions `attach-unbound`, `dismiss-unbound`, `link-external`; dialogs; forms `attach`, `link-external`; `targetRevision` for retries)
- Modify: `ui/styles.css` (`.inbox`)
- Modify: `src/worker/worker.js` (`snapshotOptions` passes `key_example`), `src/worker/projections.js` (`buildMeta` carries `key_example`)
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Consumes: Task 3 request bodies; Task 4 components.
- Produces: `renderInbox(snapshot, { now, pending })`, `renderAttachDialog(session, snapshot, { mode })`, `renderLinkExternalDialog(ticket, snapshot)`; snapshot `meta.key_example` (for example `PMLA-123`).

- [ ] **Step 1: Write the failing tests** (append to `tests/ui/render.test.js`; import `renderInbox` from picknext and `renderAttachDialog, renderLinkExternalDialog` from dialogs)

```js
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
  assert.match(create, /name="key" required pattern="\[A-Za-z\]\[A-Za-z0-9_\]\*-\[0-9\]\+" placeholder="PMLA-123"/);
  assert.match(create, /name="title"/);
  const link = renderLinkExternalDialog(snap.tickets[0], snap);
  assert.match(link, /data-form="link-external" data-ticket="[^"]+" data-revision="1"/);
  assert.match(link, /name="url" type="url" pattern="https:\/\/\.\*"/);
});

test('empty states point at mentioning a key, and the sessions table flags unlinked work', () => {
  const empty = { ...snapshot(), tickets: [], picknext: [], blocked: [], meta: { ...snapshot().meta, key_example: 'PMLA-123' } };
  assert.match(renderPickNext(empty, noFilters, { now: NOW, pending: [] }), /Mention a ticket key such as <code>PMLA-123<\/code>/);
  assert.match(renderBoard(empty, noFilters, { now: NOW, layout: 'columns', expanded: new Set(), pages: {} }), /Mention a ticket key such as <code>PMLA-123<\/code>/);
  assert.match(renderSessions(inboxSnapshot(), noFilters, { now: NOW }), /Unlinked work · 7 files/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/render.test.js`
Expected: FAIL (`renderInbox` is not exported).

- [ ] **Step 3: Implement**

`src/worker/projections.js` `buildMeta`: accept `key_example = 'PROJ-123'` in the options and return `key_example`. `src/worker/worker.js`: import `keyExample` from `'../core/external-keys.js'` and add to the object returned by `snapshotOptions()`:

```js
      key_example: keyExample((this.identity && (this.identity.tracker ?? (this.identity.repos ?? []).map((r) => r.tracker).find(Boolean))) ?? null),
```

`ui/views/picknext.js`:

```js
import { esc, attr, ticketCard, ticketById, emptyState, matchesFilters, keyEl, icon, normalizeSnapshot, sessionChip, timeEl, countLabel, hasUnlinkedWork, requestFeedback } from '../components.js';

function mentionHint(snapshot) {
  return `Mention a ticket key such as <code>${esc(snapshot.meta.key_example ?? 'PROJ-123')}</code> in a Claude Code prompt, or run <code>/session-quill:ticket create "&lt;title&gt;"</code>.`;
}

function inboxItem(s, snapshot, { now, pending }) {
  const w = s.unbound_work;
  const tz = snapshot.meta.timezone;
  const files = w.files ?? [];
  const commits = w.commits ?? [];
  const mine = pending.filter((r) => r.target_id === s.id);
  const preview = s.last_checkpoint_preview ?? '';
  return `<li class="inbox-item" data-session="${attr(s.id)}">
  <div class="inbox-head">${sessionChip(s.state)} <strong>${esc(s.title || s.host_session_id)}</strong> <span class="muted small">${esc(s.host_session_id)} · ${esc(s.machine_name)} · last change ${timeEl(w.last_at, now, tz)}</span></div>
  <p class="small">${esc(countLabel(files.length, 'file'))}${commits.length ? `, ${esc(countLabel(commits.length, 'commit'))}` : ''}${files.length ? `: ${files.slice(0, 5).map((f) => `<code>${esc(f.relative_path)}</code>`).join(' ')}` : ''}${files.length > 5 ? ` <span class="muted">and ${esc(files.length - 5)} more</span>` : ''}</p>
  ${commits.length ? `<p class="small muted">${commits.slice(0, 3).map((c) => `<code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.message)}`).join(' · ')}</p>` : ''}
  ${preview ? `<p class="small preview-inline"><span class="eyebrow">Last checkpoint</span> ${esc(preview.slice(0, 200))}${preview.length > 200 ? '…' : ''}</p>` : ''}
  ${mine.length ? mine.map((r) => requestFeedback(r, { now })).join('') : `<div class="inbox-actions"><button type="button" class="btn small" data-action="attach-unbound" data-session="${attr(s.id)}" data-mode="attach">${icon('link')}Attach to…</button><button type="button" class="btn small" data-action="attach-unbound" data-session="${attr(s.id)}" data-mode="create">${icon('ticket')}Create from key</button><button type="button" class="btn small ghost" data-action="dismiss-unbound" data-session="${attr(s.id)}" data-revision="${attr(w.revision)}">Dismiss as no-ticket</button></div>`}
</li>`;
}

// Work captured while a session had no ticket (ADR 0006). Owner-only: exports never carry it.
export function renderInbox(rawSnapshot, { now, pending = [] } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (!snapshot.capabilities || !snapshot.capabilities.edit_tickets) return '';
  const items = snapshot.sessions.filter(hasUnlinkedWork).sort((a, b) => (a.unbound_work.last_at < b.unbound_work.last_at ? 1 : -1));
  if (!items.length) return '';
  return `<section class="inbox" aria-labelledby="inbox-heading"><h2 id="inbox-heading">${icon('inbox')}Unlinked work <span class="count">${esc(items.length)}</span></h2><p class="small muted">Sessions that changed files or committed without a ticket. Attach the work to a ticket, create the ticket from its key, or dismiss it.</p><ul>${items.map((s) => inboxItem(s, snapshot, { now, pending })).join('')}</ul></section>`;
}
```

  In `renderPickNext` destructure `{ now, pending = [] }`, use `mentionHint(snapshot)` in both empty states (keeping their first sentences), and return `...<h2 class="sr-only">Pick next</h2>${renderInbox(snapshot, { now, pending })}${main}${blockedHtml}</section>`.

`ui/views/board.js`: the "No tickets yet" empty state body becomes `Create the first one: mention a ticket key such as <code>${esc(snapshot.meta.key_example ?? 'PROJ-123')}</code> in a Claude Code prompt, or run <code>/session-quill:ticket create "&lt;title&gt;"</code>.` (import `esc` if not already imported).

`ui/views/dialogs.js` (import `countLabel, normalizeSnapshot` from components):

```js
export function renderAttachDialog(session, rawSnapshot, { mode = 'attach' } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const w = session.unbound_work ?? { revision: 0, files: [], commits: [] };
  const example = snapshot.meta.key_example ?? 'PROJ-123';
  const what = `${countLabel((w.files ?? []).length, 'file')}${(w.commits ?? []).length ? `, ${countLabel(w.commits.length, 'commit')}` : ''}`;
  const candidates = snapshot.tickets.filter((t) => t.status !== 'done').sort((a, b) => (a.last_activity < b.last_activity ? 1 : -1)).slice(0, 200);
  const bound = !!session.current_ticket_id;
  return `<form class="dialog-form" data-form="attach" data-session="${attr(session.id)}" data-revision="${attr(w.revision)}" data-mode="${attr(mode)}">
<h2 id="dialog-title">${icon('link')}${mode === 'create' ? 'Create a ticket from its key' : 'Attach unlinked work'}</h2>
<p class="muted small">${esc(what)} from session ${esc(session.title || session.host_session_id)}.</p>
${mode === 'create'
    ? `<label class="label" for="attach-key">Ticket key</label><input id="attach-key" name="key" required pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+" placeholder="${attr(example)}" autocomplete="off">
<label class="label" for="attach-title">Title (optional)</label><input id="attach-title" name="title" maxlength="200" placeholder="${attr(session.title || '')}">`
    : `<label class="label" for="attach-key">Ticket</label><input id="attach-key" name="key" required list="attach-tickets" placeholder="Key or title" autocomplete="off"><datalist id="attach-tickets">${candidates.map((t) => `<option value="${attr(t.key)}">${esc(t.title)}</option>`).join('')}</datalist>
<p class="small muted">Pick an open ticket, or type a new key such as ${esc(example)} to create it.</p>`}
<label class="check"><input type="checkbox" name="bind" ${bound ? 'disabled' : 'checked'}> Also link this session's later work${bound ? ' (already linked to another ticket)' : ''}</label>
<p class="small muted">Applies after a 10-second undo window. Nothing is posted to your tracker.</p>
<div class="dialog-actions"><button type="submit" class="btn primary">${mode === 'create' ? 'Create and attach' : 'Attach'}</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

export function renderLinkExternalDialog(rawTicket, rawSnapshot) {
  const ticket = normalizeTicket(rawTicket);
  const snapshot = normalizeSnapshot(rawSnapshot);
  return `<form class="dialog-form" data-form="link-external" data-ticket="${attr(ticket.id)}" data-revision="${attr(ticket.revision)}">
<h2 id="dialog-title">${icon('link')}Link ${keyEl(ticket.key)} to a tracker ticket</h2>
<label class="label" for="link-key">Ticket key</label><input id="link-key" name="key" required pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+" placeholder="${attr(snapshot.meta.key_example ?? 'PROJ-123')}" autocomplete="off">
<label class="label" for="link-url">Link (optional)</label><input id="link-url" name="url" type="url" pattern="https://.*" placeholder="Built from your tracker settings when empty">
<p class="small muted">The current key stays as an alias. Applies after a 10-second undo window.</p>
<div class="dialog-actions"><button type="submit" class="btn primary">Link</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}
```

`ui/views/sessions.js`: import `hasUnlinkedWork`; add `if (hasUnlinkedWork(s)) flags.push(`<span class="chip warning" title="Changed files or committed without a ticket; see Pick next">${icon('inbox')}Unlinked work · ${esc(countLabel((s.unbound_work.files ?? []).length, 'file'))}</span>`);`.

`ui/app.js`:
- import `renderAttachDialog, renderLinkExternalDialog`.
- `renderDialog`: `else if (d.type === 'attach') html = renderAttachDialog(s.sessions.find((x) => x.id === d.session), s, { mode: d.mode }); else if (d.type === 'link-external') html = renderLinkExternalDialog(ticketById(s, d.ticket), s);`
- `handleAction` cases:

```js
    case 'attach-unbound': appState.dialog = { type: 'attach', session: el.dataset.session, mode: el.dataset.mode === 'create' ? 'create' : 'attach' }; render(); break;
    case 'dismiss-unbound': submit({ kind: 'dismiss-unbound', target_id: el.dataset.session, expected_revision: Number(el.dataset.revision), payload: {} }, { announceText: 'Dismissal queued; undo within 10 seconds' }); break;
    case 'link-external': appState.dialog = { type: 'link-external', ticket: el.dataset.ticket }; render(); break;
```

- replace the two `ticketRevision(r.target_id)` calls in `retry-request`/`resubmit-request` and `reverse-request` with `targetRevision(r)`:

```js
function targetRevision(r) {
  if (r.kind === 'attach-unbound' || r.kind === 'dismiss-unbound') {
    const sess = (appState.snapshot.sessions ?? []).find((x) => x.id === r.target_id);
    return sess && sess.unbound_work ? sess.unbound_work.revision : null;
  }
  return ticketRevision(r.target_id);
}
```

- `handleSubmit` branches:

```js
  } else if (kind === 'attach') {
    const key = String(fd.get('key') ?? '').trim();
    const bind = fd.get('bind') === 'on';
    const match = appState.snapshot.tickets.find((x) => x.key === key || (x.aliases ?? []).includes(key));
    const payload = match && form.dataset.mode !== 'create' ? { ticket_id: match.id, bind } : { key, title: String(fd.get('title') ?? '').trim(), bind };
    closeDialog();
    submit({ kind: 'attach-unbound', target_id: form.dataset.session, expected_revision: revision, payload }, { announceText: match ? `Attaching to ${match.key}; undo within 10 seconds` : `Creating ${key} and attaching; undo within 10 seconds` });
  } else if (kind === 'link-external') {
    const url = String(fd.get('url') ?? '').trim();
    closeDialog();
    submit({ kind: 'link-external', target_id: ticketId, expected_revision: revision, payload: url ? { key: String(fd.get('key') ?? '').trim(), url } : { key: String(fd.get('key') ?? '').trim() } }, { original: null });
```

`ui/styles.css`:

```css
.inbox { margin-bottom: 24px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 12px; max-width: 900px; }
.inbox h2 { display: flex; align-items: center; gap: 8px; font-size: 17px; }
.inbox ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
.inbox-item { border-top: 1px solid var(--border); padding-top: 8px; }
.inbox-item p { margin: 4px 0; }
.inbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/ui/render.test.js tests/ui/tokens.test.js tests/export/static.test.js tests/worker/worker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui src/worker/worker.js src/worker/projections.js tests/ui/render.test.js
git commit -m "feat(ui): unlinked work inbox on Pick next with attach, create-from-key and dismiss"
```

---

### Task 6: Acceptance A46–A48, dev seed and a browser check

**Files:**
- Modify: `tests/acceptance/phase6.test.js` (A46–A48 over the authenticated HTTP API)
- Modify: `scripts/dev-seed.mjs` (an unbound session with writes and a commit; an external-key ticket)

**Interfaces:**
- Consumes: the full stack through `s.client()` (cookie, CSRF, Origin) and the dashboard in the browser pane.

- [ ] **Step 1: Write the scenarios** (append to `tests/acceptance/phase6.test.js`; import `randomUUID` from `node:crypto`; `start()` and `editIn()` already exist there, and `start` must pass `withServer: true` through to `scenario` for these tests: change its signature to `start({ gateMode = 'nudge', branch = null, withServer = false } = {})` and call `scenario({ gateMode, withServer })`)

```js
const snap = async (c) => (await c.get('/v1/snapshot')).json();

test('A46 work captured without a ticket appears in the inbox and "create from key" attaches it after the undo window', async () => {
  const s = await start({ withServer: true });
  try {
    const c = await s.client();
    s.hook('SessionStart', { session_id: 'z5', cwd: s.repo, source: 'startup' });
    const e = editIn(s, 'z5', 'tz5', 'src/inbox.js');
    e.pre(); e.post();
    await s.settle();
    const sess = (await snap(c)).sessions.find((x) => x.host_session_id === 'z5');
    assert.deepEqual(sess.unbound_work.files.map((f) => f.relative_path), ['src/inbox.js']);
    const res = await c.post('/v1/requests', { id: randomUUID(), kind: 'attach-unbound', target_id: sess.id, expected_revision: sess.unbound_work.revision, payload: { key: 'PMLA-50' } });
    assert.equal(res.status, 202);
    s.advance(10_000);
    await s.settle();
    const after = await snap(c);
    const t = after.tickets.find((x) => x.key === 'PMLA-50');
    assert.deepEqual(t.files_touched.map((f) => f.relative_path), ['src/inbox.js']);
    assert.equal(t.external.url, 'https://example.atlassian.net/browse/PMLA-50');
    const linked = after.sessions.find((x) => x.host_session_id === 'z5');
    assert.equal(linked.current_ticket_id, t.id);
    assert.deepEqual(linked.unbound_work.files, []);
  } finally { await s.stop(); }
});

test('A47 an attach queued before more work arrived conflicts; dismiss removes the item; unauthenticated callers cannot do either', async () => {
  const s = await start({ withServer: true });
  try {
    const c = await s.client();
    const t = s.ticket('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'LOCAL-c-00000003');
    s.hook('SessionStart', { session_id: 'z6', cwd: s.repo, source: 'startup' });
    const a = editIn(s, 'z6', 'tz6a', 'src/one.js');
    a.pre(); a.post();
    await s.settle();
    const sess = (await snap(c)).sessions.find((x) => x.host_session_id === 'z6');
    const id = randomUUID();
    assert.equal((await c.post('/v1/requests', { id, kind: 'attach-unbound', target_id: sess.id, expected_revision: sess.unbound_work.revision, payload: { ticket_id: t.id } })).status, 202);
    const b = editIn(s, 'z6', 'tz6b', 'src/two.js');
    b.pre(); b.post();
    s.advance(10_000);
    await s.settle();
    const conflicted = await (await c.get(`/v1/requests/${id}`)).json();
    assert.equal(conflicted.state, 'conflict');
    const noAuth = await fetch(`${c.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', origin: c.base }, body: JSON.stringify({ id: randomUUID(), kind: 'dismiss-unbound', target_id: sess.id, expected_revision: 0, payload: {} }) });
    assert.notEqual(noAuth.status, 202);
    const fresh = (await snap(c)).sessions.find((x) => x.host_session_id === 'z6');
    assert.equal((await c.post('/v1/requests', { id: randomUUID(), kind: 'dismiss-unbound', target_id: fresh.id, expected_revision: fresh.unbound_work.revision, payload: {} })).status, 202);
    s.advance(10_000);
    await s.settle();
    assert.ok((await snap(c)).sessions.find((x) => x.host_session_id === 'z6').unbound_work.dismissed_at);
  } finally { await s.stop(); }
});

test('A48 "Link to external" turns a local key into a tracker key with a working link, keeping the old key as an alias', async () => {
  const s = await start({ withServer: true });
  try {
    const c = await s.client();
    const t = s.ticket('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'LOCAL-d-00000004');
    assert.equal((await c.post('/v1/requests', { id: randomUUID(), kind: 'link-external', target_id: t.id, expected_revision: t.revision, payload: { key: 'PMLA-88' } })).status, 202);
    s.advance(10_000);
    await s.settle();
    const after = (await snap(c)).tickets.find((x) => x.id === t.id);
    assert.deepEqual([after.key, after.aliases, after.external.url], ['PMLA-88', ['LOCAL-d-00000004'], 'https://example.atlassian.net/browse/PMLA-88']);
  } finally { await s.stop(); }
});
```

- [ ] **Step 2: Run them**

Run: `node --test tests/acceptance/phase6.test.js`
Expected: PASS (all behaviour exists after Tasks 1–5; a failure is a defect in those tasks, debugged with superpowers:systematic-debugging).

- [ ] **Step 3: Extend the dev seed** — in `scripts/dev-seed.mjs` set `config.tracker = { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PROJ'] }` and, after the existing sessions, add an unbound session with two edits and a commit, plus one external-key ticket:

```js
  ev('session-start', { source: 'startup', cwd: root }, { session_id: 'sess-unlinked-5a6b7c8d', at: ago(1800e3) });
  ev('prompt', { title_candidate: 'Tidy the export dialog copy', approval_candidate: false, length: 28 }, { session_id: 'sess-unlinked-5a6b7c8d', at: ago(1790e3) });
  for (const [i, file] of ['ui/views/dialogs.js', 'ui/styles.css'].entries()) {
    ev('pre-tool', { tool_name: 'Edit', write_target: file }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: `u${i}`, source_identity: `pre:su:u${i}`, at: ago(1700e3 - i * 1000) });
    ev('post-tool', { tool_name: 'Edit', write_paths: [file], repo_id: null, success: true }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: `u${i}`, source_identity: `post:su:u${i}`, at: ago(1690e3 - i * 1000) });
  }
  ev('pre-tool', { tool_name: 'Bash', write_target: 'git commit' }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: 'uc', source_identity: 'pre:su:uc', at: ago(1600e3) });
  ev('post-tool', { tool_name: 'Bash', write_paths: [], commit: { sha: '9f8e7d6c5b4a', message: 'ui: clearer export copy' }, repo_id: null, success: true }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: 'uc', source_identity: 'post:su:uc', at: ago(1590e3) });
  ev('stop', { content_ref: putBlob('Reworded the export dialog and tightened spacing.', env).hash, preview: 'Reworded the export dialog and tightened spacing.', length: 49, complete: true, conclusions: [] }, { session_id: 'sess-unlinked-5a6b7c8d', at: ago(1500e3) });
  ev('ticket-create', { ticket: { id: T(20), key: 'PROJ-42', title: 'Tracker-linked ticket from a prompt mention', project_id: 'session-quill', project_name: 'Session Quill', category: 'feature', priority: 'P1', parent_id: null, repo_id: 'session-quill', due: null, jira: { key: 'PROJ-42', url: 'https://example.atlassian.net/browse/PROJ-42', validation: 'pending', validated_at: null, error: null }, external: { system: 'jira', key: 'PROJ-42', url: 'https://example.atlassian.net/browse/PROJ-42', validation: 'pending', validated_at: null, error: null } } }, { at: ago(2 * 86400e3) });
```

- [ ] **Step 4: Browser check** — restart the dev seed, open its owner URL in the browser pane, and confirm with screenshots at 1440 px and 390 px: the inbox shows above Pick next with the session, files, commit and checkpoint; "Attach to…", "Create from key" and "Dismiss" open their dialogs or queue an undoable request; `PROJ-42` renders as a link with a copy button on its card and in the detail header; a `LOCAL-` ticket's detail offers "Link to external…". Note any visual defect and fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add tests/acceptance/phase6.test.js scripts/dev-seed.mjs
git commit -m "test(acceptance): A46-A48 inbox and key linking; dev seed shows unlinked work"
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/decisions/0006-unlinked-work-inbox.md`
- Modify: `docs/DATA-CONTRACT.md` (session `unbound_work`; request kinds and their revision rules)
- Modify: `docs/UI-DESIGN.md` (Pick next inbox; ticket key chip component)
- Modify: `docs/ACCEPTANCE.md` (A46–A48), `docs/ACCEPTANCE-RESULTS.md` (phase 6 rows, test count), `docs/README.md` (decision list), `README.md` (inbox and key chips), `CHANGELOG.md` (Unreleased)

- [ ] **Step 1: Write ADR 0006**: Context (nudge leaves work unbound; the reducer used to drop it), Decision (session `unbound_work` with its own revision; three delayed, revision-checked requests; attach is retroactive only on explicit owner choice and links the session only while it is unbound; create-from-key uses the tracker template and a deterministic id; dismiss keeps the batch for audit until new work starts a new one; exports never carry it; key chips render only https links), Consequences (inbox item conflicts when new work arrives after viewing; checkpoints without a ticket move with the attach; conclusions recorded before the attach are not re-derived), Alternatives (auto-attach on the next bind, rejected as it breaks forward-only binding; attaching individual files, deferred).
- [ ] **Step 2: Amend DATA-CONTRACT, UI-DESIGN and ACCEPTANCE**; update README, CHANGELOG, docs/README and ACCEPTANCE-RESULTS.
- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass (1 skip where symlink creation is not permitted).

- [ ] **Step 4: Commit**

```bash
git add docs README.md CHANGELOG.md
git commit -m "docs: ADR 0006 unlinked work inbox; data contract, UI design, acceptance and changelog"
```
