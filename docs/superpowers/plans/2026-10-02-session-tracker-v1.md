# Session Tracker v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 Session Tracker Claude Code plugin described in `docs/`: a ticket gate on hooks, a durable single-writer worker that journals events and renders markdown notes, a loopback dashboard with five views and revision-checked edits, static export, isolated handoff runs, migration tooling and plugin packaging.

**Architecture:** Hooks and CLI commands write immutable ingress files; one worker per store owns a loopback socket lock, appends events to `events.jsonl`, reduces them into in-memory state, and atomically publishes projections (`state/`, `projections/`, markdown notes). The worker also serves the dashboard JSON API and executes mutation requests, reconciliation runs and handoffs. The UI is a static single-page app that polls `/v1/snapshot` and posts requests; `--static` export inlines a snapshot with all mutation capabilities off.

**Tech Stack:** Node 24 LTS (built-ins only: `node:fs`, `node:http`, `node:net`, `node:crypto`, `node:child_process`, `node:test`), ESM modules, no npm dependencies. Git and the `claude` CLI are runtime prerequisites for handoff fixes only.

**Spec:** `docs/PRD.md`, `docs/TRD.md`, `docs/DATA-CONTRACT.md`, `docs/UI-DESIGN.md`, `docs/ACCEPTANCE.md`, `docs/decisions/*.md`.

## Global Constraints

- Core uses Node built-ins only; no network or model calls on the hook path (PRD NFR Performance).
- Hook p95 <= 200 ms; hook persistence timeout 1 s; never return a success receipt for failed persistence (TRD §Durability 8).
- Events persist (temp file, flush, atomic rename to `<event_id>.json` under `~/.claude/tracker/ingress/`) before acknowledgement (TRD §Durability 1).
- Dirty notes flush no later than 30 s after the first unmaterialized event; later events cannot postpone (TRD §Durability 5).
- Worker heartbeat every 5 s; heartbeat older than 15 s is unavailable for gate decisions (TRD §Durability).
- Never resolve a binding by cwd (TRD §Binding). Identity = store ID + machine ID + host session ID (+ agent ID).
- Gate shell allowlist is exactly: `pwd`, `git status` with only `--short`, `--branch`, `--porcelain`; literal-path `ls`/`cat`; PowerShell `Get-Location`/`Get-ChildItem`/`Get-Content` with literal paths. Deny pipelines, redirects, substitution, separators, env assignments, unknown options (TRD §Ticket gate).
- Bound sessions get `permissionDecision: "defer"`-equivalent behaviour: never emit an unconditional `allow` (TRD §Ticket gate; ADR 0003). Implementation emits no decision (exit 0, no JSON) when bound.
- Local keys are `<prefix>-<slug>-<short-id>`, default prefix `LOCAL`; child keys use a serialized parent counter (TRD §Binding).
- Checkpoint preview is 1,500 characters; full blob kept by content hash (TRD §Capture).
- Approval phrases default off; list is `approved`, `lgtm`, `go ahead`, `ship it`; match whole trimmed case-insensitive prompt within 10 min on same binding with no intervening activity (TRD §Capture).
- Reconcile every 2 h all days in the store IANA timezone; catch up once on wake; Refresh begins within 5 s on an idle worker (TRD §Reconciliation, §Dashboard).
- Session state: `ended` on SessionEnd; `live` <= 30 min; `idle` 30 min to < 48 h; `extinct` >= 48 h (TRD §Reconciliation).
- Stale = status `active` and last substantive activity >= 5 days (TRD §Reconciliation).
- Pick-next points: P0/P1/P2/P3 = 40/25/10/0; due overdue or within 3 days = 30, within 7 days = 15 (exclusive); oldest pending merged PR >= 2 days = 20; oldest open PR >= 1 day and status review = 15; nonempty next_action = 10; parent has another direct child done = 10; stale = 10. Display `min(100, raw)`; rank by raw desc, due asc (null last), priority asc, last_activity asc, ticket id. Max five (TRD §Pick-next).
- Ticket edit `not_before = created_at + 10 s`; handoff/refresh have no delay (DATA-CONTRACT §Mutation request).
- Handoff timeout 20 min wall clock including sleep; one queued/running run per ticket; one running attempt-fix per repo (TRD §Handoff).
- Handoff note max 280 characters; modes `analyse`, `analyse-followups`, `attempt-fix`; default `analyse-followups` with source off (DATA-CONTRACT §Handoff).
- Freshness: never-synced when `last_sync` null; fresh < 2 h; ageing 2–6 h; stale > 6 h (DATA-CONTRACT §Dashboard projection).
- Loopback only; validate `Host` and `Origin`; one-use CLI secret exchanged for an HttpOnly SameSite cookie; CSRF token on mutations (TRD §Local dashboard).
- Export excludes checkpoint bodies, local absolute paths and private links by default; contains no request code, owner token or local store URI (TRD §Local dashboard).
- Timestamps UTC RFC 3339 with `Z`; dates `YYYY-MM-DD` (DATA-CONTRACT §Common conventions).
- `schema_version: 1` on every record; unknown enum values and newer schema versions are rejected with a diagnostic.
- Status transitions and `manual_status_evidence_floor` rules exactly as DATA-CONTRACT §Ticket transitions.
- Store layout exactly as TRD §Canonical schema; `TRACKER_HOME` env var overrides `~/.claude/tracker` for tests.
- Commands are namespaced `/session-tracker:<name>`; help and denial text use `session-tracker:` prefix.
- Hook contract verified against Claude Code 2.1.284 docs on 2026-10-02: stdin JSON has `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, `tool_response`/`tool_output`, `error`, `prompt`, `last_assistant_message`, `agent_id`, `agent_type`, `source`, `reason`, `trigger`, `permission_mode`. PreToolUse output `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. SessionStart/UserPromptSubmit may return `additionalContext`. Exit 2 blocks.

## Review Focus

1. **Bash command with trailing comment or newline** (`git status # ok`, `pwd\nrm -rf x`): the gate must deny; multi-line or `#` input is outside the grammar. Test in Task 5.
2. **PostToolUse arriving before its PreToolUse ingress is ingested** (out-of-order files): the result must wait for its attribution record and never be assigned to the current binding. Test in Task 4.
3. **Windows atomic rename while the UI holds a projection file open** (EPERM/EBUSY): retry with backoff, never truncate the destination. Test in Task 1.
4. **A UserPromptSubmit of exactly `approved` while heuristic is off**: nothing is approved; and with heuristic on but a different binding, nothing is approved. Test in Task 4.
5. **Dashboard POST with correct cookie but missing CSRF header, or correct CSRF and foreign Origin**: must be rejected before the request enters the queue. Test in Task 10.

---

### Task 1: Scaffold, utilities and atomic filesystem helpers

**Files:**
- Create: `package.json`, `bin/tracker.js`, `src/lib/ids.js`, `src/lib/time.js`, `src/lib/atomic-fs.js`, `src/lib/paths.js`, `src/lib/errors.js`
- Test: `tests/lib/atomic-fs.test.js`, `tests/lib/time.test.js`, `tests/lib/ids.test.js`

**Interfaces:**
- Produces: `uuid()`, `shortId()` (8 hex), `contentHash(string|Buffer)` (sha256 hex), `nowIso()`, `toIso(Date|number)`, `parseIso(string)` -> ms, `addMs(iso, ms)`, `ageMs(iso, nowIso)`, `isoDateInZone(iso, tz)` -> `YYYY-MM-DD`, `dateDiffDays(dateA, dateB)`; `writeFileAtomic(path, data)`, `renameAtomic(from, to)` (Windows retries EPERM/EBUSY/EACCES up to 20 × 25 ms, never truncates), `readJsonIfExists(path)`, `writeJsonAtomic(path, obj)`, `ensureDir(path)`; `trackerHome()` (honours `TRACKER_HOME`), `ingressDir()`, `journalPath()`, `blobsDir()`, `stateDir()`, `projectionsDir()`, `configPath()`; `class TrackerError extends Error { constructor(code, message, extra) }`.

- [ ] **Step 1: Write package.json and bin entry**

```json
{
  "name": "session-tracker",
  "version": "0.1.0",
  "description": "Ticket-bound Claude Code sessions with recoverable local notes and a personal dashboard",
  "type": "module",
  "private": true,
  "bin": { "tracker": "bin/tracker.js" },
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test tests/", "test:acceptance": "node --test tests/acceptance/" },
  "license": "UNLICENSED"
}
```

`bin/tracker.js`: `#!/usr/bin/env node` then `import { main } from '../src/cli/main.js'; main(process.argv.slice(2)).then(code => process.exit(code ?? 0), err => { console.error(err.message); process.exit(1); });`

- [ ] **Step 2: Write failing tests for atomic-fs**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic, writeJsonAtomic, readJsonIfExists } from '../../src/lib/atomic-fs.js';

test('writeFileAtomic replaces existing content and leaves no temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const p = path.join(dir, 'a.txt');
  writeFileAtomic(p, 'one');
  writeFileAtomic(p, 'two');
  assert.equal(fs.readFileSync(p, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
});

test('writeJsonAtomic + readJsonIfExists round trip; missing returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  writeJsonAtomic(path.join(dir, 'x.json'), { a: 1 });
  assert.deepEqual(readJsonIfExists(path.join(dir, 'x.json')), { a: 1 });
  assert.equal(readJsonIfExists(path.join(dir, 'missing.json')), null);
});
```

- [ ] **Step 3: Run tests, expect module-not-found failure**

Run: `node --test tests/lib/`

- [ ] **Step 4: Implement lib modules**

`atomic-fs.js` core:

```js
export function writeFileAtomic(dest, data) {
  ensureDir(path.dirname(dest));
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameAtomic(tmp, dest);
}
export function renameAtomic(from, to) {
  let attempt = 0;
  for (;;) {
    try { fs.renameSync(from, to); return; }
    catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt++ >= 20) { try { fs.unlinkSync(from); } catch {} throw err; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
```

`time.js` uses `Intl.DateTimeFormat` with `timeZone` for `isoDateInZone`. `ids.js` uses `crypto.randomUUID()` and `createHash('sha256')`.

- [ ] **Step 5: Run tests, expect pass. Commit `feat: scaffold tracker package with atomic fs and time helpers`.**

### Task 2: Configuration, store metadata and repo registry

**Files:**
- Create: `src/config/toml.js`, `src/config/config.js`, `src/config/store.js`
- Test: `tests/config/toml.test.js`, `tests/config/config.test.js`

**Interfaces:**
- Produces: `parseToml(text)` -> object (restricted subset: `[table]`, `[[array]]` not needed, `key = "string" | 123 | true | ["a","b"]`, comments `#`; throws `TrackerError('toml-unsupported')` on anything else), `stringifyToml(obj)`; `loadUserConfig()` -> `{ store_path, store_name, owner_machine_id, machine_name, timezone, key_prefix, default_category, gate_enabled, approval_phrases_enabled, sync_interval_hours, stale_days, projects: {id:{name, repo_id}}, repos: {id:{project_id, display_name, canonical_path, default_branch, deployment_environments, provider}} }`, `saveUserConfig(cfg)`, `loadRepoConfig(cwd)` reads nearest `.tracker.toml` -> `{ project_id, category, repo_id }` or null, `resolveConfig({cli, session, repo, user})` with precedence CLI > session > repo > user; `loadStoreMeta(storePath)` / `writeStoreMeta(storePath, meta)` for `Tracker/store.json` (`schema_version, store_id, store_name, owner_machine_id, created_at, timezone`), `ensureMachineId()` persisted UUID at `~/.claude/tracker/machine.json`.

- [ ] **Step 1: Failing tests** for `parseToml` round-trip (string, number, boolean, string array, nested table), unsupported syntax rejected (`key = { inline = 1 }` throws `toml-unsupported`), unknown authored text preserved by `stringifyToml(parseToml(text), { preserve: text })` using comment lines kept in a `__comments` side array.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement.** Precedence function:

```js
export function resolveConfig({ cli = {}, session = {}, repo = {}, user = {} }) {
  const pick = (k) => cli[k] ?? session[k] ?? repo[k] ?? user[k];
  return { project_id: pick('project_id'), category: pick('category') ?? 'research', repo_id: pick('repo_id'), key_prefix: user.key_prefix ?? 'LOCAL' };
}
```
Store ownership and handoff permission fields are only read from `user` (never from repo).
- [ ] **Step 4: Run, pass. Commit `feat: restricted TOML config and store metadata`.**

### Task 3: Ingress producer, journal and recovery

**Files:**
- Create: `src/core/events.js`, `src/core/ingress.js`, `src/core/journal.js`, `src/core/blobs.js`
- Test: `tests/core/ingress.test.js`, `tests/core/journal.test.js`

**Interfaces:**
- Produces: `EVENT_KINDS` = `session-start, prompt, pre-tool, post-tool, tool-failure, stop, pre-compact, subagent-start, subagent-stop, session-end, bind, gate-off, gate-on, ticket-create, ticket-update, relink, approve, dismiss, request, request-tx, handoff-tx, migration, import, notify, reconcile`; `makeEvent({kind, payload, store_id, machine_id, producer, session_id, agent_id, tool_call_id, ticket_id, binding_revision, source_identity, occurred_at})` -> envelope with `schema_version: 1, event_id`; `validateEvent(ev)` throws on unknown kind/version; `writeIngress(ev, {timeoutMs=1000})` -> `{event_id, path}` (temp `wx`, fsync, rename), throws `TrackerError('ingress-failed')`; `listIngress()` sorted by `occurred_at` then `event_id`; `removeIngress(event_id)`; `putBlob(text)` -> `{hash, path}` (write before event), `getBlob(hash)`; `class Journal { constructor(path); open() -> {lastSequence, quarantined: bool, corrupt: bool}; append(ev) -> ev with sequence & ingested_at (writeSync + fsyncSync); *read() ; readTail(fromSequence) }`. A torn final line is moved to `events.jsonl.quarantine-<ts>` and `quarantined=true`; a malformed non-final line sets `corrupt=true` and recovery stops.

- [ ] **Step 1: Failing tests:** `writeIngress` leaves only `<id>.json` (no `.tmp`); `Journal.append` assigns `sequence` 1,2,3 and persists; reopening resumes at last sequence; a torn tail (`fs.appendFileSync(path, '{"partial')`) opens with `quarantined=true` and `lastSequence` unchanged; a corrupt middle line opens with `corrupt=true`.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Pass. Commit `feat: durable ingress, blob store and journal with tail quarantine`.**

### Task 4: State reducer — tickets, sessions, bindings, checkpoints, approval

**Files:**
- Create: `src/core/state.js`, `src/core/keys.js`, `src/core/reducer.js`, `src/core/transitions.js`, `src/core/approval.js`
- Test: `tests/core/reducer.test.js`, `tests/core/keys.test.js`, `tests/core/transitions.test.js`, `tests/core/approval.test.js`

**Interfaces:**
- Consumes: event envelopes from Task 3.
- Produces: `createState(meta)` -> `{ meta, tickets: Map, sessions: Map, checkpoints: Map, handoffs: Map, requests: Map, bindingsBySession: Map, pendingToolCalls: Map<tool_call_id, attribution>, unresolved: [], notified: Set, counters: {childByParent: Map}, keyIndex: Map<key|alias, ticket_id>, lastSequence }`; `applyEvent(state, ev)` -> `{ changed: Set<ticket_id|session_id>, effects: [] }` idempotent on duplicate `event_id` or `source_identity`; `allocateKey(state, {prefix, title, parent_id})` -> `LOCAL-<slug>-<8hex>` or `<parentKey>.<n>` for children (serialized counter); `slugify(title)` (lowercase, `[a-z0-9]+` joined by `-`, max 40 chars); `validateParent(state, ticket_id, parent_id)` rejects self, cycle, missing, cross-store; `applyStatusChange(ticket, {status, source, evidence_seq, blocker})` and `deriveStatusFromEvidence(ticket, evidence)` implementing DATA-CONTRACT transition table and `manual_status_evidence_floor`; `matchApprovalPhrase(prompt)` returns true only for exact trimmed case-insensitive `approved|lgtm|go ahead|ship it`; `selectCheckpointForApproval(state, session, explicitId)`; `sessionIdentity(ev)` -> `${store_id}:${machine_id}:${session_id}[:${agent_id}]` key.

Reducer rules (write them as the implementation comments):
- `session-start`: create or resume session; `source: resume` keeps bindings; sets `last_event_at`.
- `bind`: closes previous binding interval (`unbound_at`), pushes new `{revision, ticket_id, project_id, bound_at, source_event_id}`, increments `current_binding_revision`. Children (agents with `parent_session_id`) created by `subagent-start` copy the parent's current binding.
- `pre-tool`: stores `pendingToolCalls[tool_call_id] = {session_key, ticket_id, binding_revision, tool_name, sequence}`; also appends nothing to ticket timeline (an allowed attempt is not a write).
- `post-tool`: looks up attribution; if missing push to `unresolved` with reason `missing-pre-tool`; otherwise if `payload.write_paths` non-empty and tool in supported set, add `files_touched` (dedupe repo+path), timeline `write` with coverage `complete`, `session.successful_write_count++`, first write promotes `todo -> active` via `deriveStatusFromEvidence`; bash/mcp successes become timeline `tool` with coverage `unknown`; commit/pr metadata from `payload.commit`/`payload.pr`.
- `tool-failure`: timeline `tool` with coverage `partial` and text `failed: <tool>`; `session.change_coverage = 'partial'`.
- `stop` / `subagent-stop`: checkpoint record `{id, session_id, ticket_id, binding_revision, recorded_at, content_ref, preview (1500 chars), complete}`; conclusions extracted from lines starting with `Conclusion:`/`## Conclusion` referencing `content_ref`; `session.unpromoted = true` if complete.
- `prompt`: first prompt sets session title (80 chars, control chars stripped); if `payload.approval_candidate` true (hook decides using config) and heuristic conditions hold (same binding, <= 10 min since last checkpoint, no events since checkpoint), create approval with provenance `heuristic`.
- `approve`: idempotent on `(checkpoint_id, ticket_id)`; pushes `plans` entry with provenance; sets `checkpoint.approved_at`; `unpromoted` recomputed.
- `dismiss`: marks checkpoint dismissed; recompute `unpromoted`.
- `ticket-create`, `ticket-update`, `relink` (adds alias, changes key atomically, rejects collisions), `gate-off`/`gate-on` (session.gate_enabled, timeline `status` entry text "gate off"), `session-end` (`ended_at`, state `ended`), `pre-compact` (timeline `capture-error`? No: `kind: 'conclusion'` text "recovery summary saved" with content_ref), `request-tx` (applies request result; see Task 10), `handoff-tx` (Task 13), `migration` (Task 14), `notify` (records once per checkpoint).
- Every applied event with a ticket touches `ticket.last_activity` only for substantive kinds (`bind, post-tool, stop, approve, ticket-update, ticket-create, relink`), never for `reconcile`/`notify`.

- [ ] **Step 1: Failing tests** (one `test()` each): key allocation produces distinct keys for identical titles; child key `LOCAL-x-abcd1234.1`, `.2`; self-parent/cycle rejected; duplicate `event_id` applied once (write count 1); post-tool without pre-tool goes to `unresolved` and the current binding's ticket gets no timeline entry; rebind in flight keeps original ticket (pre-tool at rev 1, bind rev 2, post-tool -> ticket of rev 1); first write moves `todo -> active`; manual `set-status blocked` then evidence `open PR` at same floor keeps blocked; evidence above floor from `active` -> `review`; merged evidence creates obligation and `deploy-pending`; `matchApprovalPhrase('Approved')` true, `'"approved"'` false, `'approved, but fix x'` false, `'not approved'` false; heuristic off never approves; heuristic on with different binding never approves; duplicate approve one plan; checkpoint > 1500 chars keeps full blob and preview length 1500.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Pass. Commit `feat: event reducer with bindings, attribution, transitions and approval`.**

### Task 5: Ticket gate decision and shell grammar

**Files:**
- Create: `src/gate/shell-grammar.js`, `src/gate/decide.js`
- Test: `tests/gate/shell-grammar.test.js`, `tests/gate/decide.test.js`

**Interfaces:**
- Produces: `classifyShell(command, {shell: 'bash'|'powershell'})` -> `{ allowed: boolean, reason }`; `decideGate({tool_name, tool_input, binding, workerHealthy, gateEnabled, planPath, hostPlanDir, sessionId})` -> `{ decision: 'deny'|'none', reason }` where `none` means no hook output.

Grammar (bash): tokenize on single spaces only; reject if the command contains any of `| & ; < > $ \` ( ) { } \n \r # * ? [ ] ~ ! =` or leading/trailing whitespace. Allowed forms:
- `pwd`
- `git status` optionally followed by any subset of `--short`, `--branch`, `--porcelain` (each at most once, no `=value`)
- `ls` / `cat` followed by one or more literal path tokens; a token may contain only `[A-Za-z0-9._/\\:-]`, must not start with `-`, no `..` segments.
PowerShell: `Get-Location`; `Get-ChildItem [path...]`; `Get-Content [-Path] path`; same token rules; `-Path` is the only option allowed, and only once.

Tool matrix in `decide.js`:
- `Read, Glob, Grep, LS, WebFetch, WebSearch, TodoWrite, TodoRead, Task, ExitPlanMode, EnterPlanMode, AskUserQuestion` -> `none` (host control / read).
- `Edit, Write, MultiEdit, NotebookEdit` -> deny unless bound, except `tool_input.file_path` resolves (realpath, no symlink/reparse escape) to exactly `planPath` under `hostPlanDir` (`~/.claude/plans/`).
- `Bash` -> `classifyShell(command,'bash')`; `PowerShell` -> powershell grammar; allowed read forms `none`, else deny. A Bash command whose first token is `tracker`, `node` followed by a path ending in `bin/tracker.js`, or `session-tracker` with subcommand in `ticket|approve|dismiss|status|init|doctor` and no shell metacharacters -> `none` (direct tracker CLI exemption).
- Any tool name starting with `mcp__` or unknown -> deny unless bound. Registered non-mutating host control tools list is configurable via `config.gate.allow_tools`.
- If `gateEnabled === false` -> `none` (the hook records a `gate-off` usage event instead).
- If `!workerHealthy` and tool is covered -> deny with reason "tracker worker unavailable; run `tracker doctor`".
- If bound -> `none`.
Denial reason text: `Session Tracker: this session is not bound to a ticket. Run /session-tracker:ticket bind <KEY> or /session-tracker:ticket create "<title>" (or /session-tracker:ticket off to disable the gate for this session).`

- [ ] **Step 1: Failing tests** covering: allowed `pwd`, `git status --short --branch`, `ls src`, `cat README.md`, `Get-Content -Path README.md`; denied `git status --short=1`, `git status -s`, `ls -la`, `cat a | grep b`, `pwd; rm -rf x`, `echo $(pwd)`, `cat ../x`, `git status # ok`, `pwd\nrm x`, `cat *.md`, `FOO=1 pwd`; `decideGate` deny for `Edit` unbound; `none` for `Edit` of the exact plan path; deny for a symlink inside plan dir pointing elsewhere (create symlink in tmp, skip test if `EPERM`); `none` for `Read`; deny for `mcp__jira__create`; `none` when bound; deny when worker unhealthy; `none` when gate off.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Pass. Commit `feat: ticket gate with tested read-only shell grammar`.**

### Task 6: Hook adapter (`tracker hook`)

**Files:**
- Create: `src/hooks/adapter.js`, `src/hooks/payload.js`, `src/hooks/binding-snapshot.js`
- Test: `tests/hooks/adapter.test.js`, fixtures in `tests/fixtures/hooks/*.json`

**Interfaces:**
- Consumes: `writeIngress`, `putBlob`, `decideGate`, `readBindingSnapshot`.
- Produces: `runHook(eventName, stdinJson, {io, now, env})` -> `{ exitCode, stdout }` pure function; `readBindingSnapshot(sessionKey)` reads `state/bindings/<sessionKey>.json` `{ticket_id, ticket_key, binding_revision, gate_enabled, project_id, revision_committed_at}`; `readHeartbeat()` reads `state/heartbeat.json` `{at, pid, store_id}` and returns `healthy` when age <= 15 s; `normalizePayload(eventName, input)` extracts only the fields the data contract allows (never the whole raw payload).

Hook mapping:
- `SessionStart` -> `session-start` event `{source, cwd, agent_type}`; stdout `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Session Tracker: bound to LOCAL-x (title) | unbound; run /session-tracker:ticket ..."}}`.
- `UserPromptSubmit` -> `prompt` event; payload `{title_candidate: first 80 sanitized chars (only when session has no title), approval_candidate: matchApprovalPhrase(prompt) && config.approval_phrases_enabled}`; prompt text itself is not retained.
- `PreToolUse` -> gate decision first (read snapshot + heartbeat), then `pre-tool` event with `{tool_name, tool_call_id, write_target: file_path|command summary}`; attribution carries current `ticket_id` and `binding_revision`. If gate denies, still record `pre-tool` with `payload.denied=true`. Output deny JSON or nothing.
- `PostToolUse` -> `post-tool` with `write_paths` for Edit/Write/MultiEdit/NotebookEdit (`file_path` or `edits[].file_path`/`notebook_path`), `commit` metadata when tool is Bash and command starts with `git commit` and `tool_output` matches `/\[[\w./-]+ ([0-9a-f]{7,})\]/`; `pr` metadata when `gh pr create` output contains a URL; `plan` when `tool_name === 'ExitPlanMode'` and `tool_input.plan` present and `tool_output` does not contain `rejected`/`cancelled`: `putBlob(plan)` then event payload `{plan_ref}` -> reducer creates approved plan with provenance `explicit`.
- `PostToolUseFailure` -> `tool-failure`.
- `Stop` / `SubagentStop` -> blob of `last_assistant_message`; `stop` event `{content_ref, length, complete: message !== undefined}`; missing message -> `complete:false` and timeline `capture-error`.
- `SubagentStart` -> `subagent-start` `{agent_id, agent_type, parent_session_id: session_id}`.
- `PreCompact` -> `pre-compact` `{trigger}`; worker builds recovery summary from state.
- `SessionEnd` -> `session-end` `{reason}`.
All hooks: on `ingress-failed` print one-line diagnostic to stderr, exit 0 for non-gate hooks (never block the session), exit 2 with deny JSON for PreToolUse covered tools; also append to `state/health-errors.jsonl` when writable. Total budget: stop work and report when > 1000 ms.

- [ ] **Step 1: Fixtures**: write one JSON file per hook event in `tests/fixtures/hooks/` using the exact field names from the hooks reference (e.g. `pre-tool-use-edit.json`, `pre-tool-use-bash-ls.json`, `post-tool-use-exit-plan-mode.json`, `stop.json`, `subagent-start.json`, `session-start-resume.json`, `session-end.json`, `pre-compact.json`, `post-tool-use-failure.json`, `user-prompt-submit.json`).
- [ ] **Step 2: Failing tests**: unbound `Edit` -> exit 2 and deny JSON; unbound `Read` -> exit 0 no stdout; bound session (write snapshot file + fresh heartbeat) `Edit` -> exit 0 no stdout, ingress contains `pre-tool`; `Stop` writes blob and event with `content_ref`; `ExitPlanMode` success writes `plan_ref`; ingress dir read-only (chmod skipped on Windows -> simulate by pointing `TRACKER_HOME` at a file path) -> Stop exits 0 with stderr diagnostic and no ingress; `UserPromptSubmit` payload does not contain the prompt text; hook wall time for 200 Edit decisions < 200 ms p95 in-process.
- [ ] **Step 3: Implement. Step 4: Pass. Commit `feat: hook adapter with gate decisions and durable capture`.**

### Task 7: Worker — ownership, ingestion, projections, markdown notes

**Files:**
- Create: `src/worker/lock.js`, `src/worker/worker.js`, `src/worker/projections.js`, `src/worker/notes.js`, `src/worker/markdown.js`, `src/worker/health.js`, `src/worker/scheduler.js`
- Test: `tests/worker/lock.test.js`, `tests/worker/notes.test.js`, `tests/worker/worker.test.js`

**Interfaces:**
- Consumes: Journal, reducer, config.
- Produces: `acquireLock(store_id, machine_id)` -> `{ server: net.Server, endpoint }` listening on `\\.\pipe\session-tracker-<hash>` (Windows) or `<trackerHome>/run/<hash>.sock` (POSIX); throws `TrackerError('lock-held')` if connect succeeds to an existing listener; stale socket file removed only after a failed connect. `class Worker { constructor({config, storeMeta, home, now}); start(); stop(); ingestOnce() -> count; flushNotes(); publishGeneration(); heartbeat(); enqueueRequest(req); getSnapshot(); }`; `renderTicketNote(ticket, {state, authored})` -> markdown string with YAML frontmatter and `<!-- tracker:generated:<section> start hash=<sha256> -->` / `<!-- tracker:generated:<section> end -->` blocks; `parseNote(text)` -> `{ frontmatter, authored: {summary, notes}, generated: {section: {hash, body}} }`; `writeNote(path, ticket, state)` -> `'written'|'conflict'|'unchanged'`.

Worker loop:
1. `start()`: acquire lock, open journal (recover), replay journal into state, rebuild `pendingToolCalls`, mark `applying` requests from their `request-tx` events, write heartbeat every 5 s, scan ingress every 500 ms, note timer, reconciliation timer (Task 9), HTTP server (Task 10).
2. `ingestOnce()`: for each complete `<id>.json`: `validateEvent`; skip + remove if `event_id` or `source_identity` already journaled; `journal.append`; `applyEvent`; `removeIngress`; if a binding changed, publish `state/bindings/<sessionKey>.json` immediately; record `firstDirtyAt` if null.
3. Notes timer: `setTimeout` armed at `firstDirtyAt + 30000`; `flushNotes()` writes changed ticket/session/handoff notes then clears `firstDirtyAt`; Stop/SessionEnd/sync events call `flushNotes()` soon (within 1 s).
4. `publishGeneration()`: writes `projections/gen-<n>/{snapshot.json, tickets/<id>.json}` then `projections/MANIFEST.json` `{generation_id, generated_at, path}` atomically; prunes older generations keeping two.

Note format (ticket):

```markdown
---
<frontmatter per DATA-CONTRACT example>
---
## Summary
<authored, preserved byte-for-byte>

<!-- tracker:generated:timeline start hash=... -->
## Timeline
- 2026-10-02T08:05:00Z write complete src/a.js (session abcd)
<!-- tracker:generated:timeline end -->
... Approved plans, Conclusions, Files touched, PRs and deployments, Follow-ups, Handoff notes ...
## Notes
<authored>
```

Conflict rule: before replacing, re-read the file; for each generated block compare stored hash against sha256 of current body; mismatch -> leave file, add `validation_issues: ['generated-block-edited:<section>']` to ticket projection, return `'conflict'`. Frontmatter is generated; manual frontmatter edits are detected by comparing against the last written frontmatter hash kept in `state/notes-index.json`.

- [ ] **Step 1: Failing tests**: second `acquireLock` on same ids throws `lock-held`; after `server.close()` a new acquire succeeds; `renderTicketNote` then `parseNote` preserves authored sections with CRLF and trailing spaces byte-for-byte; editing a generated block then `writeNote` returns `conflict` and leaves the file unchanged; worker ingests an event file and journal has sequence 1, ingress empty; notes materialize when clock advanced 30 s via injected `now`/timer; a second event at +20 s does not postpone (flush at 30 s); killing (`worker.stop()` without flush) after journal append and restarting yields the same state and no duplicate timeline entries; `MANIFEST.json` only points to a fully written generation.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Pass. Commit `feat: single-writer worker with ownership lock, projections and conflict-safe notes`.**

### Task 8: CLI commands

**Files:**
- Create: `src/cli/main.js`, `src/cli/commands/init.js`, `ticket.js`, `approve.js`, `dismiss.js`, `status.js`, `doctor.js`, `worker.js`, `sync.js`, `replay.js`, `import.js`, `hook.js`, `ui.js` (Task 12), `export.js` (Task 12), `handoff.js` (Task 13), `migrate.js` (Task 14), `src/cli/client.js`
- Test: `tests/cli/ticket.test.js`, `tests/cli/doctor.test.js`

**Interfaces:**
- Produces: `main(argv)`; `client.request(kind, payload)` sends a `request` ingress event and waits for `state/requests/<id>.json` to become terminal (poll 100 ms, timeout 10 s) so bind/create/relink return only after a worker-confirmed revision; `tracker status --json` prints `{session, binding, worker: {healthy, heartbeat_at}, backlog}`; `tracker status --statusline` reads status-line JSON on stdin (`session_id`) and prints `⌁ LOCAL-key title` or `⌁ unbound`.

Commands (all accept `--session <id>`; hook-invoked commands get it from `CLAUDE_SESSION_ID`-style env or `--session`; slash commands pass `${CLAUDE_SESSION_ID}` is not available, so the command markdown runs `tracker ticket ... --session-from-hook` which reads `state/current-session.json` written by the most recent SessionStart for that cwd+pid is NOT allowed (cwd fallback forbidden) — instead the slash command body instructs Claude to run the CLI with the session id injected into context by the SessionStart hook's `additionalContext` (`Session Tracker session: <id>`)):
- `init [--store <path>] [--project <id>] [--project-name <n>] [--repo <path>] [--timezone <tz>] [--yes]`: writes config, `store.json`, `.tracker.toml`, checks Node >= 22, git, claude; registers worker start (writes `~/.claude/tracker/worker.cmd`/`.sh` and prints OS service instructions; starts a detached worker now); verifies round trip by creating and reading a `session-start` noop? No: by submitting a `request` of kind `refresh` and awaiting `applied`.
- `ticket create "<title>" [--category] [--priority] [--parent <key>] [--project] [--due] [--bind]`
- `ticket bind <key>`; `ticket show`; `ticket off`; `ticket on`; `ticket relink <key> --jira <KEY> [--url]`; `ticket children <key>`; `ticket list [--status]`.
- `approve [--checkpoint <id>]`, `dismiss [--checkpoint <id>]`.
- `worker run` (foreground), `worker start` (detached spawn), `worker stop`, `worker status`.
- `sync` (enqueue refresh request), `replay [--into <staging>] [--switch]`, `import <note-path>` (reads frontmatter diffs for supported fields and emits `import` events).
- `doctor`: prints prerequisite versions, store ownership (`store.json.owner_machine_id` vs local machine id), lock status, heartbeat age, ingress backlog count, journal health, health errors, plugin command namespace, and exits 1 on error.

- [ ] **Step 1: Failing tests** with an in-process worker: `ticket create --bind` returns key and binding snapshot exists; `ticket bind` to unknown key errors; `ticket off` writes `gate-off` event and snapshot `gate_enabled=false`; `doctor` reports `lock-held` false when no worker and `worker unavailable`; `status --statusline` output.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Commit `feat: tracker CLI (init, ticket, approve, status, doctor, worker)`.**

### Task 9: Reconciliation, lifecycle, PR providers, pick-next

**Files:**
- Create: `src/reconcile/lifecycle.js`, `src/reconcile/picknext.js`, `src/reconcile/providers/index.js`, `src/reconcile/providers/github.js`, `src/reconcile/providers/null.js`, `src/reconcile/run.js`
- Test: `tests/reconcile/lifecycle.test.js`, `tests/reconcile/picknext.test.js`, `tests/reconcile/run.test.js`

**Interfaces:**
- Produces: `sessionState(session, nowIso)`; `isStale(ticket, nowIso, staleDays)`; `rankPickNext(tickets, {nowIso, timezone})` -> `[{rank, ticket_id, raw_score, score, reasons}]`; `providerFor(repo)` -> `{ name, fetchPr(url) -> {state, opened_at, merged_at, base_branch, head_branch, observed_at} }` (`github` shells out `gh pr view <url> --json state,isDraft,createdAt,mergedAt,baseRefName,headRefName`, mapping `MERGED->merged`, `OPEN+isDraft->draft`, `OPEN->open`, `CLOSED->closed`); `runReconciliation(worker, {reason})` steps 1–5 from TRD, emitting one `reconcile` event with `{last_sync, provider_health}` and publishing a generation; `nextSyncDue(lastSync, intervalHours)`.

- [ ] **Step 1: Failing tests**: session with event 10 min old is `live`, 31 min `idle`, 49 h `extinct`, `ended_at` set -> `ended`; active ticket 5 days -> stale, blocked 5 days -> not stale; new write clears stale without status change; ranking fixture: P0 + overdue + next_action = 80; raw 115 shows 100 but outranks 95; blocked excluded; due within 3 days gets 30 not 45; ties broken by due then id; 3 candidates -> 3 results; provider failure keeps previous `prs[].state` and sets `provider_health[].error`; repeated identical poll after manual `blocked` does not change status; draft PR creates no obligation; merge creates obligation per configured environment; done-with-pending remains in Deployments list (`state.deploymentsOutstanding()`).
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Commit `feat: deterministic reconciliation, lifecycle, PR polling and pick-next ranking`.**

### Task 10: Loopback request transport and request state machine

**Files:**
- Create: `src/server/http.js`, `src/server/auth.js`, `src/server/requests.js`, `src/server/snapshot.js`
- Test: `tests/server/auth.test.js`, `tests/server/requests.test.js`, `tests/server/http.test.js`

**Interfaces:**
- Produces: `createServer(worker)` -> `http.Server` bound to `127.0.0.1:0` (or configured port) with routes: `GET /` (UI), `GET /ui/*` assets, `GET /auth?secret=<one-use>` -> sets `st_owner` HttpOnly SameSite=Strict cookie and redirects to `/` (secret invalid afterwards), `GET /v1/snapshot`, `GET /v1/tickets/:id?generation=`, `GET /v1/content/:hash?generation=`, `GET /v1/requests/:id`, `POST /v1/requests`, `POST /v1/requests/:id/cancel`, `GET /v1/csrf` (returns token tied to cookie). `auth.js`: `issueBootstrapSecret()`, `exchangeSecret(secret)` -> session token, `verifyCookie(req)`, `csrfFor(token)`, `checkOrigin(req, allowedHosts)` (Host must be `127.0.0.1:<port>` or `localhost:<port>`; Origin if present must match; else 403). `requests.js`: `submitRequest(worker, body, actor)` validates kind/payload/expected_revision, idempotency (same id+same body -> existing; same id different body -> 409 `request-mismatch`), writes a `request` ingress event, waits for journal receipt, returns 202 with `{id, state:'pending', not_before}`; `applyDueRequests(worker, nowIso)` picks pending with `not_before <= now`, sets `applying`, validates `expected_revision`, emits `request-tx` event carrying the resulting ticket mutation (or `conflict`/`failed`), terminal state immutable; `cancelRequest(worker, id)` -> `{outcome: 'cancelled'|'already-applied'|'already-terminal'|'applying'}` serialized in the worker lane.

Mutation kinds: `set-next-action {next_action}`, `set-status {status, blocker?, deployment_choice?: 'record'|'waive'|'leave', deployments?: [...]}`, `record-deployment {items:[{pr_id, environment, deployed_at?, evidence?, waiver_reason?}]}`, `handoff {mode, note, permissions}`, `refresh {}`.

- [ ] **Step 1: Failing tests**: GET snapshot without cookie -> 401; POST with cookie, no CSRF -> 403; POST with cookie + CSRF + `Origin: http://evil.test` -> 403; wrong Host -> 403; happy path -> 202 and `GET /v1/requests/:id` pending; two posts same `expected_revision` -> one `applied`, one `conflict` with `current_revision`; same id same body -> same response; same id different body -> 409; cancel within 10 s -> `cancelled` and ticket unchanged; cancel after apply -> `already-applied`; `set-status blocked` without blocker -> 400; `set-status done` with pending deployments and no choice -> 400; `refresh` has `not_before === created_at`; bootstrap secret works once; a generation-mismatched detail request returns 410 `generation-expired`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Commit `feat: authenticated loopback API with durable revision-checked requests`.**

### Task 11: Dashboard UI

**Files:**
- Create: `ui/index.html`, `ui/app.js`, `ui/styles.css`, `ui/components.js`, `ui/views/picknext.js`, `ui/views/board.js`, `ui/views/tree.js`, `ui/views/sessions.js`, `ui/views/deployments.js`, `ui/views/detail.js`, `ui/views/handoff-form.js`, `ui/lib/time.js`, `ui/lib/api.js`
- Test: `tests/ui/render.test.js` (node-side pure render functions), `tests/ui/tokens.test.js` (contrast measurement)

**Interfaces:**
- Consumes: `/v1/snapshot` shape from DATA-CONTRACT §Dashboard projection.
- Produces: pure functions `renderPickNext(snapshot, filters)`, `renderBoard(...)`, `renderTree(...)`, `renderSessions(...)`, `renderDeployments(...)`, `renderDetail(ticket, snapshot)` returning HTML strings (escaped via `esc()`); `freshness(meta, nowIso)` -> `never-synced|fresh|ageing|stale`; `contrastRatio(hexA, hexB)` for the token test; `app.js` wires polling (2 s visible, 30 s hidden, resume on `visibilitychange`/`online`), hash-routed filters, keyboard shortcuts (`/`, `1`–`5`, `h`, `?`, `Escape`, arrows only while nav control focused, never inside inputs), live region, modal vs docked detail by width, request feedback states, 10 s undo countdown, conflict resolution, deployment choice dialog, handoff form with permission dependencies, export dialog (calls `/v1/export/preview` and `/v1/export`). Tokens defined in `styles.css` `:root` and `[data-theme=dark]` with the role names from UI-DESIGN; status chips carry text labels and icons (inline SVG line icons 16 px).

- [ ] **Step 1: Failing tests**: `freshness` boundaries (null, 1h59m, 2h, 6h, 6h01m); `renderBoard` groups six statuses, done collapsed, counts shown, stale badge on active stale card, user text escaped (`<script>` rendered as text); `renderPickNext` shows reasons and raw score explanation when raw > 100; `renderDetail` shows "Capture incomplete" when `checkpoint.complete === false`; every token pair in `tokens.test.js` meets 4.5:1 (text on bg/surface/surface-raised; chip text on chip bg) in both themes; static capability off removes all buttons (`renderDetail` with `capabilities.edit_tickets=false` contains no `<button`).
- [ ] **Step 2: Fail. Step 3: Implement all files. Step 4: Pass. Step 5: Open in the built-in browser via the worker at 1440/1024/800/390 px and fix layout. Commit `feat: local dashboard with five views, detail, requests and handoff form`.**

### Task 12: Static export and `tracker ui`

**Files:**
- Create: `src/export/static.js`, `src/export/sanitize.js`, `src/cli/commands/ui.js`, `src/cli/commands/export.js`
- Test: `tests/export/static.test.js`

**Interfaces:**
- Produces: `buildStaticHtml(snapshot, {fields, projects, includeCheckpoints=false, includePaths=false, exportedAt})` -> standalone HTML with inlined CSS/JS and `window.__SNAPSHOT__` (capabilities all false, `meta.exported_at`), `sanitizeSnapshot(snapshot, opts)` removing `cwd`, `worktree_path`, `canonical_path`, `provider_config_ref`, absolute paths (regex for `/`-rooted and `[A-Z]:\\`), checkpoint `content_ref` bodies unless included, `jira.url`/`pr.url` unless `includeLinks`; `previewExport(opts)` returns `{fields, projects, ticket_count, excluded: [...]}`; `tracker ui [--static <out.html>] [--open]` and `tracker export --projects a,b --fields key,title,status,... --out <path> [--include-links] [--yes]` (prints preview and requires `--yes` or interactive confirm).

- [ ] **Step 1: Failing tests**: export output contains no `/v1/requests`, no `st_owner`, no `C:\\`/`/Users/` strings, no checkpoint body text, `capabilities.edit_tickets === false`, shows `exported_at` and `last_sync`; `includeCheckpoints` opt-in includes previews only; opening the HTML in a `vm` context defines `window.__SNAPSHOT__` and the rendered body contains ticket keys.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Commit `feat: read-only static export with privacy sanitization`.**

### Task 13: Handoff execution

**Files:**
- Create: `src/handoff/reserve.js`, `src/handoff/worktree.js`, `src/handoff/runner.js`, `src/handoff/results.js`, `agents/tracker-handoff.md`, `src/cli/commands/handoff.js`
- Test: `tests/handoff/reserve.test.js`, `tests/handoff/worktree.test.js`, `tests/handoff/runner.test.js`

**Interfaces:**
- Produces: `reserve(state, ticket_id, request_id)` -> `{ ok, existing_handoff_id? }` atomic per ticket plus per-repo fix lane; `createWorktree(repo, baseCommit, dir)` via `git worktree add --detach <dir> <commit>` (fails -> `TrackerError('worktree-failed')`), `removeWorktree`; `buildPrompt(handoff, ticket, notes, permissions)` instructs the agent to treat notes as data, confine to the checkout, and report via `tracker handoff result <id> --json <file>`; `runHandoff(worker, handoff)` spawns `claude -p <prompt> --output-format json --permission-mode <mode> --allowedTools <list> --cwd <worktree>` with `detached: true` so the process group can be killed, deadline `started_at + 20 min`, on timeout `kill` group and state `timed-out`, on cancel `cancelled`, preserves `logs/<id>.log`, diff `git diff` saved to `results/<id>.patch`; `recordResult(worker, handoff_id, result)` emits `handoff-tx` with `result_ref`, `changed_files`, `test_results`, `commit_sha`, `pr_url`, child suggestions keyed `(<handoff_id>, item_index)` so redelivery cannot duplicate children; children only for `analyse-followups`; `next_action` suggestion uses `base_ticket_revision` -> conflict if changed; worker restart marks `running` handoffs `failed` with `error.code='interrupted'`.
- Permission validation at request time and at dispatch: `attempt-fix` requires `read_source && edit_source`; `commit` requires `edit_source`; `push_branch` requires `commit` and `branch` not in `[default_branch, 'main', 'master']`; `open_draft_pr` requires `push_branch` and provider configured. Analyse modes with `read_source=false` run with `cwd` = an empty temp dir and `--allowedTools` excluding Read/Glob/Grep/Bash; notes are passed inline in the prompt.
- `agents/tracker-handoff.md`: frontmatter `name: tracker-handoff`, `description`, `tools` list; body = instructions.

- [ ] **Step 1: Failing tests**: two reservations for one ticket -> second returns existing id; reservations for two tickets on same repo attempt-fix -> second queued not running; worktree created detached at base commit in a temp git repo and live repo dirty file untouched; runner with a fake `claude` executable path (`tests/fixtures/fake-claude.js` that sleeps and writes output) honours deadline (set to 500 ms in test) -> `timed-out` and log preserved; cancellation -> `cancelled`; result redelivery creates children once; permission combinations rejected per rules; restart marks `running` as `failed/interrupted`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Commit `feat: isolated handoff runs with explicit permissions and timeouts`.**

### Task 14: Migration framework and PMLA profile

**Files:**
- Create: `src/migrate/inventory.js`, `src/migrate/pmla.js`, `src/migrate/backup.js`, `src/migrate/run.js`, `profiles/pmla/profile.json`, `src/cli/commands/migrate.js`
- Test: `tests/migrate/pmla.test.js`, `tests/migrate/run.test.js`, fixtures `tests/fixtures/pmla/*.md`

**Interfaces:**
- Produces: `inventory(sourceDir, profile)` -> `{ tickets: [{path, frontmatter, authored, mapped: {status, category, priority, ...}, issues: []}], ambiguous: [] }`; PMLA mapping: `open` -> `active` only when `in_progress: true` or a timeline entry exists, else `todo`; `pr_raised` -> `review`; `merged` -> `deploy-pending` with obligation; `deployed` -> `done`; `stale` -> `active` + derived stale; `deploy_skipped` -> waiver with `waiver_reason` from `deploy_skip_reason` or issue `missing-waiver-reason`; `backup(paths, dest)` -> manifest; `runMigration({source, profile, dryRun, backupDir})` writes `migration` events (idempotent on `source_identity = pmla:<path>`), preserves original files, writes `migration-manifest.json`; `rollback(manifest)` restores settings/hooks snapshot and exports newer tracker events to `rollback-export-<ts>.jsonl`.

Assumption (recorded here): the PMLA source format is markdown notes with YAML frontmatter fields `status`, `title`, `jira`, `pr`, `deployed`, `deploy_skipped`, `deploy_skip_reason`, `in_progress`; the profile file maps these names so a different real layout only needs a profile change.

- [ ] **Step 1: Failing tests**: dry run writes nothing and lists every fixture including ambiguous; import twice yields one event per ticket; authored sections preserved; status mapping table; rollback restores backup files.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Commit `feat: migration with dry run, backup, PMLA profile and rollback`.**

### Task 15: Plugin packaging, commands, status line, README

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/ticket.md`, `commands/approve.md`, `commands/status.md`, `commands/handoff.md`, `scripts/statusline.js`, `README.md` (rewrite as install/usage; move the design index to `docs/README.md`), `LICENSE` placeholder note (license is a release input; add `LICENSE-TBD.md`), `.gitignore` additions
- Test: `tests/plugin/manifest.test.js`

**Interfaces:**
- `hooks/hooks.json` uses exec form: `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/bin/tracker.js","hook","PreToolUse"],"timeout":5}` for `PreToolUse` (matcher omitted so every tool is evaluated), `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`.
- Commands: `commands/ticket.md` frontmatter `description`, `argument-hint: "create \"<title>\" | bind <KEY> | show | off | on | relink <KEY> --jira <J>"`, `allowed-tools: Bash(node *)`; body tells Claude to run `node "${CLAUDE_PLUGIN_ROOT}/bin/tracker.js" ticket $ARGUMENTS --session <id from Session Tracker context>` and show the output.
- `tests/plugin/manifest.test.js`: `plugin.json` parses, `name === 'session-tracker'`, every path referenced in `hooks.json` exists, every hook uses exec form with `node`, no hook has `async: true` on PreToolUse, and `claude plugin validate .` passes when `claude` is on PATH (skip otherwise).

- [ ] **Step 1: Failing test. Step 2: Implement files. Step 3: Run `claude plugin validate .`. Step 4: Pass. Commit `feat: plugin manifest, hooks, commands, status line and README`.**

### Task 16: Acceptance suite and end-to-end smoke

**Files:**
- Create: `tests/acceptance/phase1.test.js` (A08–A14, A16–A18, A20), `tests/acceptance/phase3.test.js` (A24–A32), `tests/acceptance/phase4.test.js` (A35–A37, A39, A41), `tests/acceptance/phase0.test.js` (A01, A02, A03, A05, A07 as in-process fixture runs), `tests/acceptance/perf.test.js` (A19 scaled: 1,000 hook calls with 10,000 tickets / 100,000 events, reports p95; asserts hook path never reads `events.jsonl`), `docs/ACCEPTANCE-RESULTS.md`

- [ ] **Step 1: Write the acceptance tests referencing scenario IDs in test names.** Step 2: Run `npm test` and `npm run test:acceptance`. Step 3: Record results, OS, Node and Claude Code versions in `docs/ACCEPTANCE-RESULTS.md`, listing scenarios that require manual host verification (A04 real plan payloads, A06 live command names, A33/A34 usability, A38 20-minute timeout, A40 real push) as "pending manual". Step 4: Update `README.md` status line from "Implementation has not started" to the real state. Commit `test: acceptance suite and results record`.
