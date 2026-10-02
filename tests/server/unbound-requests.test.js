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

test('review: tracker keys are matched without regard to case, so a lowercase key never duplicates a ticket', async () => {
  const s = await start();
  try {
    s.ticket(T1, 'PMLA-42');
    const local = s.ticket(T2, 'LOCAL-b-00000002');
    s.hook('SessionStart', { session_id: 'q5', cwd: s.repo, source: 'startup' });
    unboundEdit(s, 'q5', 'qe', 'src/case.js');
    await s.settle();
    const sess = sessionOf(s, 'q5');
    const { request } = submitRequest(s.w, body('attach-unbound', sess.id, sess.unbound_work.revision, { key: 'pmla-42' }));
    assert.equal(request.payload.key, 'PMLA-42');
    await applyAfterUndo(s);
    assert.deepEqual(s.w.state.requests.get(request.id).result, { ticket_id: T1, created: false });
    assert.equal([...s.w.state.tickets.values()].filter((t) => t.key.toUpperCase() === 'PMLA-42').length, 1);
    assert.throws(() => submitRequest(s.w, body('link-external', T2, local.revision, { key: 'pmla-42' })), (e) => e.code === 'key-collision');
  } finally { await s.stop(); }
});
