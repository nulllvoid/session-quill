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
import { renderHandoffNote, HANDOFF_NOTE_FIELDS } from '../../src/worker/notes.js';
import { syncable } from '../../src/tracker/client.js';
import { snapshot, TID } from '../ui/fixtures.js';

const S = 'SENTINEL-7f3a';

function fixture() {
  const s = snapshot();
  const h = s.handoffs[0];
  Object.assign(h, {
    attempts: [{ n: 1, note: S }], learnings: [{ text: S }], critical_changes: [{ path: S }], tool_ledger: [{ tool: S }],
    prod_effects: [{ what: S }], scopes: ['k8s.write:prod', S], action_pin: { sha: S }, inventory: { items: [S] }, recorded_stage: 'attempt',
  });
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
});

test('exported handoffs carry counts and the stage, not the records', () => {
  const out = sanitizeSnapshot(fixture(), ALL).handoffs[0];
  assert.deepEqual([out.attempt_count, out.learning_count, out.critical_count, out.recorded_stage], [1, 1, 1, 'attempt']);
  for (const k of ['attempts', 'learnings', 'critical_changes', 'tool_ledger', 'prod_effects', 'scopes', 'action_pin', 'inventory']) assert.equal(k in out, false, k);
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
