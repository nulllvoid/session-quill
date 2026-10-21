// Memory and Run notes built through the real reducer never leave the machine (spec §9, Task 13
// review Minor 6): state.memory (entries, quarantine reasons, problems) is not part of the owner
// snapshot at all, and Run notes, which the owner's dashboard shows, never reach a static export,
// the mirror, a publisher payload or a vault note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../../src/worker/projections.js';
import { sanitizeSnapshot, SELECTABLE_FIELDS } from '../../src/export/sanitize.js';
import { buildStaticHtml } from '../../src/export/static.js';
import { writeMirror } from '../../src/mirror/mirror.js';
import { rowsFor } from '../../src/publish/content.js';
import { PUBLISH_FIELDS } from '../../src/publish/config.js';
import { renderTicketNote, renderHandoffNote } from '../../src/worker/notes.js';
import { fileLearnings, appendRunNotes } from '../../src/memory/file.js';
import { newState, ev, createTicket } from '../core/helpers.js';

const MEM = 'MEMSENTINEL-41c9';
const NOTE = 'NOTESENTINEL-77b2';
const AT = '2026-10-12T10:00:00Z';
const SIG = 'feedc0de5e471e11';

function seeded() {
  const s = newState();
  const ticket = createTicket(s);
  const run = { id: 'run-sentinel', ticket_id: ticket.id, repo_id: 'demo', state: 'done', mode: 'analyse', permissions: {}, requested_at: AT, created_at: AT, updated_at: AT };
  s.handoffs.set(run.id, run);
  const learnings = [
    { scope: 'repo', section: 'build', kind: 'fact', text: `${MEM} trusted text`, evidence: [`${MEM} evidence`], derived_from: 'own-command' },
    { scope: 'repo', section: 'build', kind: 'fact', text: `${MEM} held text`, evidence: [], derived_from: 'tool-output' },
    { scope: 'task', section: '', kind: 'fact', text: `${MEM} task text`, evidence: [], derived_from: 'own-command' },
  ];
  const events = fileLearnings({ learnings, run, ledger: [], existing: s.memory.entries, now: AT, workerFacts: [] });
  for (const e of events) assert.equal(ev(s, e.kind, e.payload, { source_identity: e.source_identity }).rejected, undefined);
  // A quarantine reason carrying the sentinel too.
  ev(s, 'memory-tx', { op: 'filed', entry: { id: 'q-sentinel', scope: 'machine', section: 'tools', kind: 'fact', text: `${MEM} q`, trust: 'quarantined', quarantine_reason: `${MEM} reason` } });
  // ADR 0032: an anchored entry and a staled one, a failure record and a dismissal reason.
  ev(s, 'memory-tx', { op: 'filed', entry: { id: 'a-sentinel', scope: 'repo', repo_id: 'demo', section: 'pitfalls', kind: 'pitfall', text: `${MEM} anchored`, trust: 'sourced', anchors: [{ file_path: `${MEM}/a.js`, blob_sha: 'c'.repeat(40), line: 3, symbol_name: `${MEM}sym` }] } });
  ev(s, 'memory-tx', { op: 'staled', entry: { id: 'a-sentinel' }, reason: 'anchor-changed', anchor: { file_path: `${MEM}/a.js`, blob_sha: 'c'.repeat(40), current_blob_sha: 'd'.repeat(40), changed_ratio: 0.5 } });
  const failure = { kind: 'test-gate', status: 'failed', command: `${NOTE} test command`, exit_code: 1, signature: SIG, files_touched: [`${NOTE}/changed.js`] };
  const note = appendRunNotes(ticket.id, [{ route: `${NOTE} route`, tool: 'Read', target: NOTE, outcome: 'worked', reason: NOTE, evidence: NOTE }], [{ entry_id: 'x', text: `${NOTE} lesson`, trust: 'observed' }], { run, at: AT, failure });
  assert.equal(ev(s, note.kind, note.payload, { source_identity: note.source_identity }).rejected, undefined);
  s.handoffs.get(run.id).suggestions = [{ id: 's1', type: 'next-action', text: 'do it', state: 'proposed', created_at: AT }];
  ev(s, 'request', { id: 'req-sentinel', kind: 'dismiss-suggestion', target_id: ticket.id, expected_revision: null, payload: { handoff_id: run.id, suggestion_id: 's1', reason: `${NOTE} reason` }, created_at: AT, not_before: AT, actor_id: 'owner', body_hash: 'x' }, { source_identity: 'request:req-sentinel' });
  ev(s, 'request-tx', { request_id: 'req-sentinel', outcome: 'applied', error: null, result: null, mutation: { type: 'suggestion', handoff_id: run.id, suggestion_id: 's1', ticket_id: ticket.id, state: 'dismissed', reason: `${NOTE} reason` } });
  assert.equal(s.tickets.get(ticket.id).run_notes[0].dismissals[0].reason, `${NOTE} reason`);
  assert.equal(s.tickets.get(ticket.id).run_notes[0].failure.signature, SIG);
  assert.ok(s.memory.entries.size >= 4);
  assert.equal(s.tickets.get(ticket.id).run_notes.length, 1);
  return { s, ticket, run: s.handoffs.get(run.id) };
}

const ALL = { fields: SELECTABLE_FIELDS, includeLinks: true, includeCheckpoints: true, exportedAt: AT };

test('the owner snapshot never carries memory; exports, mirror and publishers carry neither memory nor Run notes', () => {
  const { s } = seeded();
  const snap = buildSnapshot(s, { generation_id: 'gen-00000001', generated_at: AT });
  const text = JSON.stringify(snap);
  assert.equal(text.includes(MEM), false, 'memory entries and quarantine reasons are not in the snapshot');
  assert.equal(text.includes('quarantine_reason'), false);
  assert.equal(text.includes(NOTE), true, 'the owner dashboard does show Run notes');
  assert.equal(text.includes(SIG), true, 'the owner dashboard shows the failure record');
  for (const opts of [{ exportedAt: AT }, ALL]) {
    assert.equal(JSON.stringify(sanitizeSnapshot(snap, opts)).includes(NOTE), false);
    assert.equal(buildStaticHtml(snap, opts).includes(NOTE), false);
    // ADR 0032: the failure signature and the files it names never leave the machine.
    assert.equal(JSON.stringify(sanitizeSnapshot(snap, opts)).includes(SIG), false);
    assert.equal(buildStaticHtml(snap, opts).includes(SIG), false);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-mem-sentinel-'));
  try {
    writeMirror(snap, { dir, projects: null, include_links: true }, { now: AT });
    for (const f of fs.readdirSync(dir)) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.equal(body.includes(NOTE) || body.includes(MEM) || body.includes(SIG), false, f);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const rows = rowsFor(snap, { fields: Object.keys(PUBLISH_FIELDS), projects: null, include_links: true }, { exportedAt: AT });
  assert.equal(JSON.stringify(rows).includes(NOTE) || JSON.stringify(rows).includes(SIG), false);
});

test('vault notes of the ticket and of the run never carry memory or Run notes', () => {
  const { s, ticket, run } = seeded();
  const t = renderTicketNote(s.tickets.get(ticket.id), { state: s });
  assert.equal(t.includes(NOTE) || t.includes(MEM) || t.includes(SIG), false);
  const h = renderHandoffNote(run, { state: s });
  assert.equal(h.includes(NOTE) || h.includes(MEM) || h.includes(SIG) || h.includes('memory_filing'), false);
});
