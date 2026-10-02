// Phase 6 — zero-command tracking (ADR 0005). Each test is named after its ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { scenario } from './scenario.js';
import { externalTicketId } from '../../src/core/external-keys.js';
import { readBindingSnapshot } from '../../src/hooks/binding-snapshot.js';

const TRACKER = { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA'] };

function repoDir(branch = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-p6-'));
  if (branch) {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  }
  return dir;
}

async function start({ gateMode = 'nudge', branch = null, withServer = false } = {}) {
  const s = scenario({ gateMode, withServer });
  s.repo = repoDir(branch);
  s.config.repos.demo.canonical_path = s.repo;
  s.config.tracker = TRACKER;
  await s.start();
  return s;
}

const editIn = (s, session_id, id, rel) => {
  const file = path.join(s.repo, ...rel.split('/'));
  return {
    pre: () => s.hook('PreToolUse', { session_id, cwd: s.repo, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file } }),
    post: () => s.hook('PostToolUse', { session_id, cwd: s.repo, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file }, tool_response: { filePath: file } }),
  };
};

test('A42 mentioning a ticket key links the session with no commands, and its work is attributed to that ticket', async () => {
  const s = await start();
  try {
    s.hook('SessionStart', { session_id: 'z1', cwd: s.repo, source: 'startup' });
    const r = s.hook('UserPromptSubmit', { session_id: 'z1', cwd: s.repo, prompt: 'PMLA-4242 make retries deterministic' });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Linked to PMLA-4242/);
    const e = editIn(s, 'z1', 'tz1', 'src/retry.js');
    assert.equal(e.pre().stdout, '');
    e.post();
    await s.settle();
    const t = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-4242'));
    assert.equal(t.key, 'PMLA-4242');
    assert.equal(t.title, 'PMLA-4242 make retries deterministic');
    assert.equal(t.external.url, 'https://example.atlassian.net/browse/PMLA-4242');
    assert.ok(t.files_touched.some((f) => f.relative_path === 'src/retry.js'));
    const snap = readBindingSnapshot('z1', s.env);
    assert.equal(snap.provisional, undefined, 'the worker confirmed the provisional binding');
    assert.equal(snap.ticket_key, 'PMLA-4242');
    s.w.flushNotes();
    assert.ok(fs.existsSync(s.notePath('PMLA-4242')));
  } finally { await s.stop(); }
});

test('A43 a session started on a ticket branch is linked at SessionStart; a later key mention switches it forward only', async () => {
  const s = await start({ branch: 'feat/PMLA-77-retry-flake' });
  try {
    const r = s.hook('SessionStart', { session_id: 'z2', cwd: s.repo, source: 'startup' });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Bound to PMLA-77 \(retry flake\)/);
    const first = editIn(s, 'z2', 'tz2a', 'src/a.js');
    first.pre(); first.post();
    await s.settle();
    s.hook('UserPromptSubmit', { session_id: 'z2', cwd: s.repo, prompt: 'switch to PMLA-78 now' });
    await s.settle();
    const second = editIn(s, 'z2', 'tz2b', 'src/b.js');
    second.pre(); second.post();
    await s.settle();
    const t77 = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-77'));
    const t78 = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-78'));
    assert.deepEqual(t77.files_touched.map((f) => f.relative_path), ['src/a.js']);
    assert.deepEqual(t78.files_touched.map((f) => f.relative_path), ['src/b.js']);
  } finally { await s.stop(); }
});

test('A44 nudge mode never blocks unlinked work, asks once at Stop, and the reply links the session for later work', async () => {
  const s = await start();
  try {
    s.hook('SessionStart', { session_id: 'z3', cwd: s.repo, source: 'startup' });
    const before = editIn(s, 'z3', 'tz3a', 'src/early.js');
    assert.equal(before.pre().stdout, '');
    before.post();
    await s.settle();
    const stop = s.hook('Stop', { session_id: 'z3', cwd: s.repo, stop_hook_active: false, last_assistant_message: 'Edited early.js.' });
    assert.equal(JSON.parse(stop.stdout).decision, 'block');
    assert.equal(s.hook('Stop', { session_id: 'z3', cwd: s.repo, stop_hook_active: true, last_assistant_message: 'Which ticket?' }).stdout, '');
    await s.settle();
    s.hook('UserPromptSubmit', { session_id: 'z3', cwd: s.repo, prompt: 'It is PMLA-9' });
    await s.settle();
    const after = editIn(s, 'z3', 'tz3b', 'src/late.js');
    after.pre(); after.post();
    await s.settle();
    const t = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-9'));
    assert.deepEqual(t.files_touched.map((f) => f.relative_path), ['src/late.js'], 'binding is forward-only: earlier unlinked work is not reassigned');
  } finally { await s.stop(); }
});

test('A45 strict mode keeps the original gate, and mentioning a key unlocks writes without running a command', async () => {
  const s = await start({ gateMode: 'strict' });
  try {
    s.hook('SessionStart', { session_id: 'z4', cwd: s.repo, source: 'startup' });
    const e = editIn(s, 'z4', 'tz4', 'src/x.js');
    const denied = JSON.parse(e.pre().stdout).hookSpecificOutput;
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /PMLA-123/);
    s.hook('UserPromptSubmit', { session_id: 'z4', cwd: s.repo, prompt: 'PMLA-10 go' });
    const e2 = editIn(s, 'z4', 'tz4b', 'src/x.js');
    assert.equal(e2.pre().stdout, '', 'the provisional binding lets the very next call through');
    await s.settle();
    assert.equal(readBindingSnapshot('z4', s.env).ticket_key, 'PMLA-10');
  } finally { await s.stop(); }
});

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
