// Nothing new on a run record or a ticket may reach an export, mirror, publisher, tracker or vault
// note unless an allow-list names it (autonomous runs spec section 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSnapshot, previewExport, isExportableTicket, HANDOFF_EXPORT_FIELDS, SELECTABLE_FIELDS } from '../../src/export/sanitize.js';
import { buildStaticHtml } from '../../src/export/static.js';
import { writeMirror } from '../../src/mirror/mirror.js';
import { rowsFor } from '../../src/publish/content.js';
import { PUBLISH_FIELDS } from '../../src/publish/config.js';
import { renderHandoffNote, renderTicketNote, renderSessionNote, writeNote, hasVaultNote, handoffHasVaultNote, writeHandoffNote, HANDOFF_NOTE_FIELDS } from '../../src/worker/notes.js';
import { syncable } from '../../src/tracker/client.js';
import { snapshot, TID } from '../ui/fixtures.js';
import { bootWorker } from '../handoff/helpers.js';
import { recordResult } from '../../src/handoff/results.js';
import { parseAgentResult } from '../../src/handoff/runner.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createJobs } from '../../src/schedule/jobs.js';

const S = 'SENTINEL-7f3a';

function fixture() {
  const s = snapshot();
  const h = s.handoffs[0];
  Object.assign(h, {
    attempts: [{ n: 1, note: S }], learnings: [{ text: S }], critical_changes: [{ path: S }], tool_ledger: [{ tool: S }],
    prod_effects: [{ what: S }], scopes: ['k8s.write:prod', S], action_pin: { sha: S }, inventory: { items: [S] }, recorded_stage: 'attempt',
    cred_report: { kubernetes: 'readonly', residual: [S], scope_errors: [S], removed: [`${S}_TOKEN`], env_fingerprint: S }, max_turns: 7, max_budget_usd: 1,
    // ADR 0041: the run environment's removed names and fingerprint, as the owner's snapshot carries them.
    run_env: { removed: [`${S}_TOKEN`], env_fingerprint: S },
    memory_filing: { filed: 1, problems: [{ code: S, count: 1 }] },
    critical_notes: [{ index: 0, reason: S }],
    // ADR 0031: a critical approval's "Valid for" minutes stay on the run record.
    lease_minutes: 15,
    // ADR 0037: planned files are local; only the drift count travels.
    planned_paths: [`src/${S}.js`], scope_drift: 3,
    // R55: what an interrupted run's ledger shows may have run (prod target, MCP tool, scope name).
    possible_writes: [`kubectl apply on ${S}-ctx may have run`, `mcp__${S}__editIssue on X-1 may have run`, `a ${S}.write call may have run`],
    // Run snapshots (ADR 0035): refs, trees, commits and labels stay on the owner's dashboard.
    // CI watch (ADR 0039): the PR's branch, commit, check names and the redacted log tail stay local.
    ci: { n: 1, pr_url: `https://github.com/acme/${S}/pull/1`, head_sha: 'a'.repeat(40), head_branch: `quill/${S}`, pr_state: 'open', state: 'failing', checks: [{ name: S, state: 'failed' }], failing: [S], observed_at: 'T', since: 'T' },
    ci_fix: { proposal_id: S, root_handoff_id: S, pr_url: `https://github.com/acme/${S}/pull/1`, head_sha: 'a'.repeat(40), head_branch: `quill/${S}`, failing: [S], log_tail: `Error ${S}`, log_withheld: 1 },
    origin: 'ci',
    snapshots: [{ id: `snap-${S}`, n: 0, step: 'agent', label: S, tree: S, commit: S, ref: `refs/quill/snapshots/${S}/00-agent`, files_changed: 1, at: 'T', restored_at: 'T', archived_at: null, request_id: S, restores: S, restore: { request_id: S, pre_restore_id: S, restored: 1, removed: 0, skipped: 0 } }],
    // ADR 0033: the evidence receipt's local fields (refs, counts keyed by class) and the run's own PR observation.
    tested_tree: S, commit_tree: S, guard_summary: { allow: 1, deny: 0, critical: 0, by_class: { [S]: 1 } }, change_summary: { files: 1, [S]: 1 },
    receipt: { sha256: S, through_sequence: 1 }, pr_observed: { state: 'merged', merge_commit: S, reverted_by: S, error: S },
    // ADR 0040: the patch and the critic's notes are blobs on the owner's dashboard; refs, status and reason stay local.
    patch_ref: S, patch_too_large: true, critic_ref: S, critic_status: 'warnings', critic_count: 2, critic_reason: S,
  });
  // The Run dialog's machine summary (ADR 0026): inventory, credential report, configured profiles, scope catalog.
  s.meta.autonomy = { inventory: { mcpServers: [{ name: S, status: 'connected', source: 'project' }] }, credentials: { report: { residual: [S], removed: [`${S}_TOKEN`], env_fingerprint: S } }, readonly_configured: ['kubernetes'], trusted_mcp_servers: [S], scopes: [{ name: 'k8s.write', label: S, permits: S, switches: S, targets: [S] }] };
  s.tickets[0].run_notes = [S];
  // ADR 0037: a session's planned files and its last drifting path stay local.
  Object.assign(s.sessions[0], { planned_paths: [`src/${S}.js`], drift: { count: 2, last_path: `src/${S}/x.js`, at: '2026-10-12T00:00:00Z' } });
  s.tickets[0].critical_spec = { rule: S };
  // Ticket worktrees (ADR 0036): local paths and branch names stay on the machine.
  s.tickets[0].worktrees = [{ id: '66666666-0000-4000-8000-000000000001', repo_id: 'demo', path: `C:/Users/me/.claude/quill/worktrees/demo/${S}`, branch: `quill/${S}`, base_sha: 'a'.repeat(40), state: 'kept', mounted_at: '2026-10-01T00:00:00Z', kept_at: '2026-10-09T00:00:00Z', kept_reason: 'uncommitted-changes', pruned_at: null }];
  const local = { ...s.tickets[1], id: TID(40), key: `LOCAL-${S}`, title: `Secret ${S}`, local_only: true };
  s.tickets.push(local);
  s.tickets[2].children_ids = [...(s.tickets[2].children_ids ?? []), local.id];
  s.tickets[3].parent_id = local.id;
  s.handoffs.push({ ...h, id: 'h-local', ticket_id: local.id });
  s.picknext.push({ rank: 3, ticket_id: local.id, raw_score: 1, score: 1, reasons: [S], limitations: [] });
  s.sessions.push({ ...s.sessions[0], id: 'sess-local', ticket_ids: [local.id], current_ticket_id: local.id, bindings: [{ ...s.sessions[0].bindings[0], ticket_id: local.id }] });
  s.sessions[0].ticket_ids = [s.sessions[0].ticket_ids[0], local.id];
  // A critical-change proposal (spec §7.3): its action pin, scopes and local-only child stay on the dashboard.
  local.critical_spec = { action: S, action_pin: { guard: S, normalized: S }, scopes: [{ name: 'argo.sync', target: S, fingerprint: S }] };
  s.run_proposals = [{ id: 'p-critical', ticket_id: local.id, origin: 'run', from_handoff_id: h.id, recipe: { name: 'critical-change', source: 'builtin', hash: null }, access: 'autonomous', scopes: [{ name: 'argo.sync', target: S, fingerprint: S }], action_pin: { guard: S, normalized: S }, dry_run: { twin: `${S} --dry-run=server` }, state: 'proposed', ticket_key: local.key },
    { id: 'p-ci', ticket_id: s.tickets[0].id, origin: 'ci', from_handoff_id: h.id, recipe: { name: 'attempt-fix', source: 'builtin', hash: null }, access: 'standard', ci: { pr_url: `https://github.com/acme/${S}/pull/1`, head_sha: 'a'.repeat(40), head_branch: `quill/${S}`, failing: [S], log_tail: `Error ${S}`, log_withheld: 0 }, state: 'proposed', ticket_key: s.tickets[0].key }];
  return s;
}

const ALL = { fields: SELECTABLE_FIELDS, includeLinks: true, includeCheckpoints: true, exportedAt: '2026-10-12T00:00:00Z' };

test('static export and sanitized snapshot never contain the sentinel or a local-only ticket', () => {
  const s = fixture();
  for (const opts of [{ exportedAt: ALL.exportedAt }, ALL, { ...ALL, projects: ['demo'] }]) {
    assert.equal(buildStaticHtml(s, opts).includes(S), false);
    const text = JSON.stringify(sanitizeSnapshot(s, opts));
    assert.equal(text.includes(S), false);
    assert.equal(text.includes(TID(40)), false, 'local-only id absent from relationships, sessions, handoffs and picknext');
  }
  assert.equal(previewExport(s, {}).ticket_count, s.tickets.length - 1);
  assert.equal('run_proposals' in sanitizeSnapshot(s, ALL), false, 'run proposals (action pins, scopes) never leave the dashboard');
});

test('exported handoffs carry counts and the stage, not the records', () => {
  const out = sanitizeSnapshot(fixture(), ALL).handoffs[0];
  assert.deepEqual([out.attempt_count, out.learning_count, out.critical_count, out.recorded_stage], [1, 1, 1, 'attempt']);
  assert.equal(out.scope_count, 2, 'a scoped run exports how many scopes it had (R53), never which');
  assert.equal(JSON.stringify(out).includes('k8s.write'), false, 'scope names and targets never leave the dashboard');
  const forged = fixture();
  delete forged.handoffs[0].scopes;
  forged.handoffs[0].scope_count = 'k8s.write:prod';
  assert.equal('scope_count' in sanitizeSnapshot(forged, ALL).handoffs[0], false, 'only a numeric count travels');
  assert.equal(out.scope_drift, 3, 'a run exports how many writes fell outside its planned files (ADR 0037), never which');
  forged.handoffs[0].scope_drift = `src/${S}.js`;
  assert.equal('scope_drift' in sanitizeSnapshot(forged, ALL).handoffs[0], false, 'only a whole-number drift count travels');
  for (const k of ['planned_paths', 'drift']) assert.equal(k in sanitizeSnapshot(fixture(), ALL).sessions[0], false, k);
  for (const k of ['attempts', 'learnings', 'critical_changes', 'tool_ledger', 'prod_effects', 'scopes', 'action_pin', 'inventory', 'cred_report', 'snapshots', 'lease_minutes', 'planned_paths', 'tested_tree', 'commit_tree', 'guard_summary', 'change_summary', 'receipt', 'pr_observed', 'patch_ref', 'patch_too_large', 'critic_ref', 'critic_status', 'critic_count', 'critic_reason', 'run_env', 'ci', 'ci_fix', 'origin']) assert.equal(k in out, false, k);
  assert.equal(sanitizeSnapshot(fixture(), ALL).meta.autonomy, null, 'the machine summary never leaves the dashboard');
  const gated = fixture();
  gated.handoffs[0].test_gate = { status: 'passed', exit_code: 0, ms: 5, attempts: 2, repaired: true, command: S, tail: S, runs: [{ status: S, exit_code: 1, ms: 3 }] };
  assert.deepEqual(sanitizeSnapshot(gated, ALL).handoffs[0].test_gate, { status: 'passed', exit_code: 0, ms: 5, attempts: 2, repaired: true }, 'every attempt stays local (ADR 0033)');
  assert.ok(Object.keys(out).every((k) => HANDOFF_EXPORT_FIELDS.includes(k)));
});

test('mirror snapshot and dashboard omit the sentinel and the local-only ticket', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-sentinel-'));
  try {
    const info = writeMirror(fixture(), { dir, projects: null, include_links: true }, { now: ALL.exportedAt });
    for (const f of ['snapshot.json', 'dashboard.html', 'mirror.json']) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').includes(S), false, f);
    assert.equal(info.ticket_count, fixture().tickets.length - 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a publisher selecting every field omits the sentinel and the local-only ticket', () => {
  const fields = Object.keys(PUBLISH_FIELDS);
  const rows = rowsFor(fixture(), { fields, projects: null, include_links: true }, { exportedAt: ALL.exportedAt });
  assert.equal(JSON.stringify(rows).includes(S), false);
  assert.equal(rows.length, fixture().tickets.length - 1);
});

test('renderHandoffNote front matter is an allow-list', () => {
  const s = fixture();
  const state = { tickets: new Map(s.tickets.map((t) => [t.id, t])) };
  const note = renderHandoffNote({ ...s.handoffs[0], worktree_path: '/x/wt', created_at: 'c', updated_at: 'u' }, { state });
  assert.equal(note.includes(S), false);
  assert.equal(note.includes('worktree_path'), false);
  assert.ok(HANDOFF_NOTE_FIELDS.includes('result_ref') && !HANDOFF_NOTE_FIELDS.includes('worktree_path'));
});

test('local-only tickets are never exportable or synced to a tracker', () => {
  assert.equal(isExportableTicket({ local_only: true }), false);
  assert.equal(isExportableTicket({ local_only: false }), true);
  assert.equal(isExportableTicket({}), true);
  const tracker = { system: 'jira', domain: 'https://example.atlassian.net' };
  const linked = { status: 'active', external: { system: 'jira', key: 'PROJ-1', url: 'https://example.atlassian.net/browse/PROJ-1' } };
  assert.equal(syncable(linked, tracker), true);
  assert.equal(syncable({ ...linked, local_only: true }, tracker), false);
});

test('vault ticket and session notes never contain run notes or the critical spec', () => {
  const s = fixture();
  const state = { tickets: new Map(s.tickets.map((t) => [t.id, t])), handoffs: new Map(s.handoffs.map((h) => [h.id, h])) };
  const base = { plans: [], conclusions: [], timeline: [], files_touched: [], prs: [], deployments: [], children_ids: [], handoff_ids: [], tags: [] };
  const ticket = { ...base, ...s.tickets[0], run_notes: [S], critical_spec: { rule: S } };
  assert.equal(renderTicketNote(ticket, { state }).includes(S), false);
  const session = { ...s.sessions[0], run_notes: [S], critical_spec: S, bindings: s.sessions[0].bindings, ticket_ids: [] };
  assert.equal(renderSessionNote(session, { state }).includes(S), false);
});

// R46: a local-only ticket (a critical child) has no vault note at all, and no other note names it.
test('a local-only critical child yields no vault note, and parent, session and run notes do not name it', () => {
  const s = fixture();
  const base = { plans: [], conclusions: [], timeline: [], files_touched: [], prs: [], deployments: [], children_ids: [], handoff_ids: [], tags: [], validation_issues: [] };
  const parent = { ...base, ...s.tickets[0], children_ids: [] };
  const child = { ...base, ...s.tickets[1], id: TID(41), key: `${parent.key}.1`, title: `Critical ${S}`, parent_id: parent.id, local_only: true, tags: ['critical'], summary: `**Goal:** ${S} goal sentence here.\n\n**Context:** ${S}\n\n**Done when:**\n- ${S}`, critical_spec: { action: S, action_pin: { guard: S } } };
  parent.children_ids = [child.id];
  const state = { tickets: new Map([[parent.id, parent], [child.id, child]]), handoffs: new Map() };
  assert.equal(hasVaultNote(child), false);
  assert.equal(hasVaultNote(parent), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-vault-'));
  try {
    const file = path.join(dir, 'child.md');
    assert.equal(writeNote(file, child, { state, index: {} }), 'skipped');
    assert.equal(fs.existsSync(file), false, 'no vault note, so no front matter with its description or critical_spec');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const parentNote = renderTicketNote(parent, { state });
  assert.equal(parentNote.includes(S), false);
  assert.equal(parentNote.includes(child.id), false, 'the child id is left out of the parent front matter');
  const session = { ...s.sessions[0], bindings: [{ ...s.sessions[0].bindings[0], ticket_id: child.id }], ticket_ids: [parent.id, child.id] };
  const sessionNote = renderSessionNote(session, { state });
  assert.equal(sessionNote.includes(S), false);
  assert.equal(sessionNote.includes(child.key), false);
  const run = { ...s.handoffs[0], id: 'h-critical-0000', ticket_id: child.id, children_ids: [child.id] };
  const runNote = renderHandoffNote(run, { state });
  assert.equal(runNote.includes(S), false);
  assert.equal(runNote.includes(child.key), false);
});

// R49: a run on a local-only ticket (every approved critical-change run) has no vault note either,
// decided in one place (writeHandoffNote) for the worker and quill sync; a stale one is removed.
test('a run on a local-only ticket gets no vault note, and a note an earlier version wrote is removed', () => {
  const s = fixture();
  const base = { plans: [], conclusions: [], timeline: [], files_touched: [], prs: [], deployments: [], children_ids: [], handoff_ids: [], tags: [], validation_issues: [] };
  const parent = { ...base, ...s.tickets[0] };
  const child = { ...base, ...s.tickets[1], id: TID(42), key: `${parent.key}.2`, local_only: true, tags: ['critical'] };
  const state = { tickets: new Map([[parent.id, parent], [child.id, child]]), handoffs: new Map() };
  const critical = { ...s.handoffs[0], id: 'h-critical-0001', ticket_id: child.id, result_summary: `Ran argocd app sync ${S}`, suggestions: [{ id: 's1', type: 'next-action', text: `rollback ${S}`, state: 'proposed' }], error: { code: 'scope-changed', message: `scope argo.sync:${S} changed` }, proposal: { id: 'p', origin: 'run', from_handoff_id: 'x', recipe: 'critical-change' }, action_pins: [{ scope: `argo.sync:${S}`, pin: S }] };
  const normal = { ...s.handoffs[0], id: 'h-normal-0001', ticket_id: parent.id };
  assert.equal(handoffHasVaultNote(critical, state), false);
  assert.equal(handoffHasVaultNote(normal, state), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-vault-'));
  try {
    const file = path.join(dir, `${critical.id}.md`);
    assert.equal(writeHandoffNote(file, critical, { state }), 'skipped');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, renderHandoffNote(critical, { state }));
    assert.equal(writeHandoffNote(file, critical, { state }), 'removed', 'a note written by an earlier version goes');
    assert.equal(fs.existsSync(file), false);
    const ok = path.join(dir, `${normal.id}.md`);
    assert.equal(writeHandoffNote(ok, normal, { state }), 'written');
    assert.equal(fs.readFileSync(ok, 'utf8').includes(S), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted scoped run reaches exports, the mirror and the vault note only as a count of possible production writes (R55)', () => {
  const s = fixture();
  Object.assign(s.handoffs[0], { state: 'failed', error: { code: 'interrupted', message: 'worker restarted' }, uncertain_effects: ['push may not have completed'] });
  const out = sanitizeSnapshot(s, ALL).handoffs[0];
  assert.deepEqual(out.uncertain_effects, ['push may not have completed', '3 production writes may have run']);
  assert.equal('possible_writes' in out, false);
  assert.equal(buildStaticHtml(s, ALL).includes(S), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-sentinel-'));
  try {
    writeMirror(s, { dir, projects: null, include_links: true }, { now: ALL.exportedAt });
    const mirrored = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
    assert.equal(mirrored.includes(S), false);
    assert.match(mirrored, /3 production writes may have run/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const state = { tickets: new Map(s.tickets.map((t) => [t.id, t])) };
  const note = renderHandoffNote(s.handoffs[0], { state });
  assert.equal(note.includes(S), false);
  assert.match(note, /- 3 production writes may have run/);
  assert.equal(HANDOFF_EXPORT_FIELDS.includes('possible_writes') || HANDOFF_NOTE_FIELDS.includes('possible_writes'), false);
  const one = fixture();
  one.handoffs[0].possible_writes = ['git push on feat may have run'];
  assert.deepEqual(sanitizeSnapshot(one, ALL).handoffs[0].uncertain_effects, ['1 production write may have run']);
});

// I4 / ruling R60: a local-only ticket and its runs never reach the vault. Markers planted in a
// local-only critical child's title, in the prompt title and final message of a session bound to it,
// and in the final message of a run on it, are absent from everything the worker writes under
// store_path: ticket, session and run notes and the daily digest. The digest omits the child entirely.
test('R60: nothing about a local-only ticket, its sessions or its runs reaches the vault (digest included)', async () => {
  const M = 'VAULT-SENTINEL-4c2e';
  const b = await bootWorker({ runtimeAvailable: true });
  const ingest = (kind, payload, extra = {}) => { writeIngress(b.mk(kind, payload, extra), b.env); b.w.tick(); };
  try {
    const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    b.ticket(T, 'LOCAL-a-00000001');
    const rid = '22222222-0000-4000-8000-0000000000a1';
    const analyse = { mode: 'analyse', note: 'look', permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, branch: null };
    b.request(rid, { target_id: T, expected_revision: b.w.state.tickets.get(T).revision, payload: analyse });
    b.w.tick();
    const hid = b.w.state.requests.get(rid).result.handoff_id;
    const change = { title: `Sync payments ${M}`, scope: 'argo.sync', target: 'pay-stg', action: 'argocd app sync pay-stg --prune', risk: 'medium', why: 'w', evidence: 'e', verify: 'v', rollback: 'r' };
    recordResult(b.w, hid, parseAgentResult({ text: `x\n\`\`\`json\n${JSON.stringify({ summary: 's', critical_changes: [change] })}\n\`\`\``, is_error: false, session_id: 's1' }), { state: 'done' });
    const child = [...b.w.state.tickets.values()].find((t) => t.local_only === true);
    assert.ok(child && child.title.includes(M), 'the local-only child carries the marker in its title');
    // a session bound to the child: its prompt title and its final message carry the marker
    ingest('session-start', { source: 'startup', cwd: b.home }, { session_id: 'sess-crit' });
    ingest('bind', { ticket_id: child.id, project_id: 'demo', handoff_id: null }, { session_id: 'sess-crit', ticket_id: child.id });
    ingest('prompt', { title_candidate: `Run the change ${M}`, length: 20 }, { session_id: 'sess-crit' });
    ingest('stop', { preview: `I synced pay-stg ${M}`, complete: false, length: 30 }, { session_id: 'sess-crit' });
    const session = [...b.w.state.sessions.values()].find((s) => s.host_session_id === 'sess-crit');
    assert.ok(session && session.ticket_ids.includes(child.id) && String(session.last_checkpoint_preview).includes(M));
    // a run on the child: its final message carries the marker
    const rid2 = '22222222-0000-4000-8000-0000000000a2';
    b.request(rid2, { target_id: child.id, expected_revision: child.revision, payload: analyse });
    b.w.tick();
    const hid2 = b.w.state.requests.get(rid2).result.handoff_id;
    recordResult(b.w, hid2, parseAgentResult({ text: `Final message ${M}\n\`\`\`json\n${JSON.stringify({ summary: `Synced ${M}` })}\n\`\`\``, is_error: false, session_id: 's2' }), { state: 'done' });
    b.w.flushRequested = true;
    b.w.flushNotes();
    const jobs = createJobs({ providers: null });
    await jobs.digest(b.w, { settings: { to: ['vault-daily'], day: 'today' }, due_at: b.iso() });
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(b.storePath);
    const daily = files.filter((f) => f.includes(`${path.sep}daily${path.sep}`));
    assert.ok(daily.length, 'the digest was written to the vault');
    assert.match(fs.readFileSync(daily[0], 'utf8'), /LOCAL-a-00000001/, 'the parent ticket is in the digest');
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(text.includes(M), false, `${path.relative(b.storePath, f)} names the local-only ticket's marker`);
      assert.equal(text.includes(child.key), false, `${path.relative(b.storePath, f)} names the local-only ticket's key`);
    }
    assert.ok(files.some((f) => f.includes(`${path.sep}sessions${path.sep}`)), 'the session note itself is still written');
  } finally { await b.w.stop(); }
});

// M1 (R53): a run error about write scopes names the scope and its target; exports, the mirror and
// vault notes carry only a generic line for it. Other errors keep their message.
test('M1: scope errors reach exports, the mirror and vault notes without scope names or targets', () => {
  for (const code of ['scope-changed', 'scope-credentials-missing', 'scope-conflict', 'unknown-scope', 'invalid-scope-target']) {
    const s = fixture();
    s.handoffs[0].error = { code, message: `scope k8s.write:${S}-ctx changed in config.toml since run 1234 started` };
    const out = sanitizeSnapshot(s, ALL).handoffs[0];
    assert.equal(out.error.code, code);
    assert.equal(JSON.stringify(out).includes(S), false, code);
    assert.match(out.error.message, /write scope/);
    assert.equal(buildStaticHtml(s, ALL).includes(S), false, code);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-sentinel-'));
    try {
      writeMirror(s, { dir, projects: null, include_links: true }, { now: ALL.exportedAt });
      assert.equal(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8').includes(S), false, code);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const state = { tickets: new Map(s.tickets.map((t) => [t.id, t])) };
    assert.equal(renderHandoffNote(s.handoffs[0], { state }).includes(S), false, code);
  }
  const other = fixture();
  other.handoffs[0].error = { code: 'agent-exit', message: 'agent exited with exit code 1' };
  assert.equal(sanitizeSnapshot(other, ALL).handoffs[0].error.message, 'agent exited with exit code 1');
});

test('ticket worktree records never reach an export, the mirror, a publisher or a vault note (ADR 0036)', () => {
  const s = fixture();
  for (const opts of [{ exportedAt: ALL.exportedAt }, ALL, { ...ALL, fields: [...SELECTABLE_FIELDS, 'worktrees'] }]) {
    for (const t of sanitizeSnapshot(s, opts).tickets) assert.equal('worktrees' in t, false);
  }
  assert.equal(SELECTABLE_FIELDS.includes('worktrees'), false);
  assert.equal(Object.keys(PUBLISH_FIELDS).includes('worktrees'), false);
  const base = { plans: [], conclusions: [], timeline: [], files_touched: [], prs: [], deployments: [], children_ids: [], handoff_ids: [], tags: [] };
  const state = { tickets: new Map(s.tickets.map((t) => [t.id, t])), handoffs: new Map() };
  const note = renderTicketNote({ ...base, ...s.tickets[0] }, { state });
  assert.equal(note.includes(S), false);
  assert.equal(note.includes('worktrees'), false);
});
