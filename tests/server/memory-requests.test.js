// Owner review of memory (spec §6.4, ADR 0027): approve, edit, forget (10 s undo) and pin requests,
// revision-checked against the entry, from the owner's dashboard; the CLI may forget, pin and add
// owner notes but never approve or edit; nothing else may touch memory at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scenario } from '../acceptance/scenario.js';
import { submitRequest, cancelRequest, EDIT_DELAY_MS } from '../../src/server/requests.js';

const SENTINEL = 'MEMREQ-SENTINEL-5e1d';

function seed(s) {
  const file = (entry) => s.w.emit('memory-tx', { op: 'filed', entry }, { source_identity: `memory-tx:test:${entry.id}` });
  file({ id: 'q1', scope: 'repo', repo_id: 'demo', section: 'build', kind: 'fact', text: `${SENTINEL} run npm ci first`, trust: 'quarantined', quarantine_reason: 'cited tool output', derived_from: 'tool-output' });
  file({ id: 'v1', scope: 'repo', repo_id: 'demo', section: 'build', kind: 'fact', text: 'npm test runs the suite', trust: 'verified', derived_from: 'own-command' });
  file({ id: 'm1', scope: 'machine', section: 'tools', kind: 'fact', text: 'gh is installed', trust: 'observed', derived_from: 'own-command' });
}

async function started() {
  const s = scenario({ withServer: true });
  await s.start();
  seed(s);
  return s;
}

const entry = (s, id) => s.w.state.memory.entries.get(id);
const owner = (s, body) => submitRequest(s.w, { id: randomUUID(), payload: {}, ...body });
// A request as the CLI writes it to ingress (actor cli, no submit validation, applies at once).
function viaCli(s, body, actor = 'cli') {
  const id = randomUUID();
  const now = s.iso();
  s.ingest('request', { id, target_id: null, expected_revision: null, payload: {}, ...body, created_at: now, not_before: now, actor_id: actor }, { producer: 'cli' });
  s.w.tick();
  s.w.tick();
  return s.w.state.requests.get(id);
}

test('the owner approves a quarantined learning: it becomes an owner entry and leaves quarantine', async () => {
  const s = await started();
  try {
    const before = { ...entry(s, 'q1') };
    assert.equal(before.trust, 'quarantined');
    const { request } = owner(s, { kind: 'memory-approve', target_id: 'q1', expected_revision: before.revision });
    assert.equal(request.not_before, request.created_at, 'approve applies without a delay');
    s.w.tick();
    const r = s.w.state.requests.get(request.id);
    assert.equal(r.state, 'applied', JSON.stringify(r.error));
    assert.equal(entry(s, 'q1').trust, 'owner');
    assert.equal(entry(s, 'q1').quarantine_reason, undefined);
    assert.ok(entry(s, 'q1').revision > before.revision);
  } finally { await s.stop(); }
});

test('approve and edit from the CLI are refused as dashboard-only; forget, pin and note from the CLI apply', async () => {
  const s = await started();
  try {
    const approve = viaCli(s, { kind: 'memory-approve', target_id: 'q1', expected_revision: entry(s, 'q1').revision });
    assert.equal(approve.state, 'failed');
    assert.equal(approve.error.code, 'memory-approve-dashboard-only');
    assert.equal(entry(s, 'q1').trust, 'quarantined');
    const edit = viaCli(s, { kind: 'memory-edit', target_id: 'v1', expected_revision: entry(s, 'v1').revision, payload: { text: 'changed' } });
    assert.equal(edit.state, 'failed');
    assert.equal(edit.error.code, 'memory-edit-dashboard-only');
    assert.equal(entry(s, 'v1').text, 'npm test runs the suite');
    const pin = viaCli(s, { kind: 'memory-pin', target_id: 'v1', expected_revision: entry(s, 'v1').revision, payload: { pinned: true } });
    assert.equal(pin.state, 'applied', JSON.stringify(pin.error));
    assert.equal(entry(s, 'v1').pinned, true);
    const forget = viaCli(s, { kind: 'memory-forget', target_id: 'm1', expected_revision: entry(s, 'm1').revision });
    assert.equal(forget.state, 'applied', JSON.stringify(forget.error));
    assert.equal(entry(s, 'm1').state, 'retired');
    const note = viaCli(s, { kind: 'memory-note', payload: { scope: 'repo', repo_id: 'demo', section: 'pitfalls', text: 'Never run the e2e suite on main' } });
    assert.equal(note.state, 'applied', JSON.stringify(note.error));
    const written = entry(s, note.result.entry_id);
    assert.equal(written.trust, 'owner');
    assert.equal(written.text, 'Never run the e2e suite on main');
  } finally { await s.stop(); }
});

test('only the owner (dashboard or CLI) touches memory: a page or a schedule is refused', async () => {
  const s = await started();
  try {
    for (const kind of ['memory-pin', 'memory-forget']) {
      const r = viaCli(s, { kind, target_id: 'v1', expected_revision: entry(s, 'v1').revision, payload: { pinned: true } }, 'artifact:team');
      assert.equal(r.state, 'failed', kind);
      assert.equal(r.error.code, 'memory-owner-only', kind);
    }
    const approve = viaCli(s, { kind: 'memory-approve', target_id: 'q1', expected_revision: entry(s, 'q1').revision }, 'schedule:nightly');
    assert.equal(approve.error.code, 'memory-approve-dashboard-only');
    assert.equal(entry(s, 'v1').pinned, false);
    assert.equal(entry(s, 'v1').state, 'active');
  } finally { await s.stop(); }
});

test('a stale expected_revision is a conflict and changes nothing; the conflict carries no memory text', async () => {
  const s = await started();
  try {
    const rev = entry(s, 'v1').revision;
    s.w.emit('memory-tx', { op: 'confirmed', entry: { id: 'v1' } }, { source_identity: 'memory-tx:test:confirm-v1' });
    const { request } = owner(s, { kind: 'memory-edit', target_id: 'v1', expected_revision: rev, payload: { text: 'owner wording' } });
    s.w.tick();
    const r = s.w.state.requests.get(request.id);
    assert.equal(r.state, 'conflict');
    assert.equal(r.error.code, 'revision-conflict');
    assert.equal(r.error.current_revision, rev + 1);
    assert.equal(entry(s, 'v1').text, 'npm test runs the suite');
    assert.equal(JSON.stringify(r.result).includes('npm test'), false);
    assert.throws(() => owner(s, { kind: 'memory-edit', target_id: 'v1', payload: { text: 'x' } }), (e) => e.code === 'expected-revision-required');
    assert.throws(() => owner(s, { kind: 'memory-pin', target_id: 'nope', expected_revision: 1, payload: { pinned: true } }), (e) => e.code === 'memory-entry-unknown');
    assert.throws(() => owner(s, { kind: 'memory-edit', target_id: 'v1', expected_revision: rev + 1, payload: { text: '   ' } }), (e) => e.code === 'request-invalid');
  } finally { await s.stop(); }
});

test('forget waits 10 s: Undo inside the window keeps the entry; otherwise it is retired', async () => {
  const s = await started();
  try {
    const { request } = owner(s, { kind: 'memory-forget', target_id: 'v1', expected_revision: entry(s, 'v1').revision });
    assert.equal(Date.parse(request.not_before) - Date.parse(request.created_at), EDIT_DELAY_MS);
    s.advance(5_000);
    s.w.tick();
    assert.equal(entry(s, 'v1').state, 'active', 'nothing happens inside the window');
    assert.equal(cancelRequest(s.w, request.id).outcome, 'cancelled');
    s.advance(10_000);
    s.w.tick();
    assert.equal(entry(s, 'v1').state, 'active', 'undone: the entry stays');
    const second = owner(s, { kind: 'memory-forget', target_id: 'v1', expected_revision: entry(s, 'v1').revision }).request;
    s.advance(EDIT_DELAY_MS + 1000);
    s.w.tick();
    assert.equal(s.w.state.requests.get(second.id).state, 'applied');
    assert.equal(entry(s, 'v1').state, 'retired');
  } finally { await s.stop(); }
});

test('the memory listing is served to the owner session only, and never through the snapshot', async () => {
  const s = await started();
  try {
    owner(s, { kind: 'memory-edit', target_id: 'v1', expected_revision: entry(s, 'v1').revision, payload: { text: `${SENTINEL} owner wording` } });
    s.w.tick();
    s.w.publishGeneration();
    const c = await s.client();
    const anon = await fetch(`${c.base}/v1/memory`);
    assert.equal(anon.status, 401);
    const res = await c.get('/v1/memory');
    assert.equal(res.status, 200);
    const body = await res.json();
    const q = body.entries.find((e) => e.id === 'q1');
    assert.equal(q.trust, 'quarantined');
    assert.equal(q.quarantine_reason, 'cited tool output');
    assert.ok(body.entries.some((e) => e.id === 'm1' && e.scope === 'machine'));
    const snap = JSON.stringify(s.w.getSnapshot());
    assert.equal(snap.includes(SENTINEL), false, 'neither entries nor memory request payloads reach the snapshot');
    assert.equal(snap.includes('quarantine_reason'), false);
  } finally { await s.stop(); }
});
