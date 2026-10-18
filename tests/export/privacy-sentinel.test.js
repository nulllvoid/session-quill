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

const S = 'SENTINEL-7f3a';

function fixture() {
  const s = snapshot();
  const h = s.handoffs[0];
  Object.assign(h, {
    attempts: [{ n: 1, note: S }], learnings: [{ text: S }], critical_changes: [{ path: S }], tool_ledger: [{ tool: S }],
    prod_effects: [{ what: S }], scopes: ['k8s.write:prod', S], action_pin: { sha: S }, inventory: { items: [S] }, recorded_stage: 'attempt',
    cred_report: { kubernetes: 'readonly', residual: [S], scope_errors: [S] }, max_turns: 7, max_budget_usd: 1,
    memory_filing: { filed: 1, problems: [{ code: S, count: 1 }] },
    critical_notes: [{ index: 0, reason: S }],
    // R55: what an interrupted run's ledger shows may have run (prod target, MCP tool, scope name).
    possible_writes: [`kubectl apply on ${S}-ctx may have run`, `mcp__${S}__editIssue on X-1 may have run`, `a ${S}.write call may have run`],
  });
  // The Run dialog's machine summary (ADR 0026): inventory, credential report, configured profiles, scope catalog.
  s.meta.autonomy = { inventory: { mcpServers: [{ name: S, status: 'connected', source: 'project' }] }, credentials: { report: { residual: [S] } }, readonly_configured: ['kubernetes'], trusted_mcp_servers: [S], scopes: [{ name: 'k8s.write', label: S, permits: S, switches: S, targets: [S] }] };
  s.tickets[0].run_notes = [S];
  s.tickets[0].critical_spec = { rule: S };
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
  s.run_proposals = [{ id: 'p-critical', ticket_id: local.id, origin: 'run', from_handoff_id: h.id, recipe: { name: 'critical-change', source: 'builtin', hash: null }, access: 'autonomous', scopes: [{ name: 'argo.sync', target: S, fingerprint: S }], action_pin: { guard: S, normalized: S }, state: 'proposed', ticket_key: local.key }];
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
  for (const k of ['attempts', 'learnings', 'critical_changes', 'tool_ledger', 'prod_effects', 'scopes', 'action_pin', 'inventory', 'cred_report']) assert.equal(k in out, false, k);
  assert.equal(sanitizeSnapshot(fixture(), ALL).meta.autonomy, null, 'the machine summary never leaves the dashboard');
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
