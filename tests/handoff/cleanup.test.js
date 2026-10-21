import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handoffRunDir, handoffsDir, logsDir } from '../../src/lib/paths.js';
import { getBlob } from '../../src/core/blobs.js';
import { bootWorker, makeRepo, until, T1, T2, git } from './helpers.js';

const RID = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const readOnly = { mode: 'analyse', note: 'look', permissions: { read_source: true, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, branch: null };
const fix = { mode: 'attempt-fix', note: 'fix', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, branch: null };
const DAY = 86_400_000;

async function runOne(b, tid, key, rid, payload) {
  const t = b.ticket(tid, key);
  b.request(rid, { target_id: tid, expected_revision: t.revision, payload });
  b.w.tick();
  const hid = b.w.state.requests.get(rid).result.handoff_id;
  return until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed'].includes(x.state) ? x : null; });
}

test('a finished read-only run loses its worktree at once; run files other than the ledger go', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    const done = await runOne(b, T1, 'LOCAL-a-00000001', RID(1), readOnly);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    const wt = path.join(handoffsDir(b.env), 'worktrees', done.id);
    await until(() => !fs.existsSync(wt));
    assert.doesNotMatch(git(repo.dir, 'worktree', 'list'), /worktrees/);
    await until(() => b.w.state.handoffs.get(done.id).worktree_removed_at);
  } finally { await b.w.stop(); }
});

test('terminal cleanup keeps ledger.jsonl and removes every other file in the run dir', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '400' } });
  try {
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID(4), { target_id: T1, expected_revision: t.revision, payload: readOnly });
    b.w.tick();
    const hid = b.w.state.requests.get(RID(4)).result.handoff_id;
    const dir = handoffRunDir(b.env, hid);
    await until(() => { b.w.tick(); return b.w.state.handoffs.get(hid).state === 'running'; });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '{"kind":"tool_use"}\n');
    fs.writeFileSync(path.join(dir, 'env.json'), '{}');
    await until(() => { b.w.tick(); return b.w.state.handoffs.get(hid).state === 'done'; });
    await until(() => !fs.existsSync(path.join(dir, 'env.json')));
    assert.ok(fs.existsSync(path.join(dir, 'ledger.jsonl')));
  } finally { await b.w.stop(); }
});

test('a fix run keeps its worktree, and pruneOldWorktrees removes it after 7 days', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const done = await runOne(b, T1, 'LOCAL-a-00000001', RID(2), fix);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    const wt = path.join(handoffsDir(b.env), 'worktrees', done.id);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(fs.existsSync(wt), 'kept: the patch is collected but the owner may still inspect the checkout');
    await b.hext.pruneOldWorktrees(Date.parse(b.iso()) + 6 * DAY);
    assert.ok(fs.existsSync(wt), 'still kept at 6 days');
    await b.hext.pruneOldWorktrees(Date.parse(b.iso()) + 8 * DAY);
    assert.equal(fs.existsSync(wt), false);
    assert.doesNotMatch(git(repo.dir, 'worktree', 'list'), /worktrees/);
  } finally { await b.w.stop(); }
});

test('retention deletes old run dirs and logs, never a running run, and honours [handoff] log_retention_days', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, handoff: { log_retention_days: 10 } });
  try {
    const mk = (id) => {
      const dir = handoffRunDir(b.env, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '{}\n');
      const log = path.join(logsDir(b.env), 'handoffs', `${id}.log`);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, 'x');
      return { dir, log };
    };
    const oldRun = mk('old-run');
    const newRun = mk('new-run');
    const running = mk('running-run');
    const nowMs = Date.parse(b.iso());
    const age = (p, days) => { const t = new Date(nowMs - days * DAY); fs.utimesSync(p, t, t); };
    age(oldRun.dir, 11); age(oldRun.log, 11);
    age(newRun.dir, 9); age(newRun.log, 9);
    age(running.dir, 40); age(running.log, 40);
    b.w.state.handoffs.set('running-run', { id: 'running-run', state: 'running', ticket_id: 'x' });
    b.hext.pruneRetention(nowMs);
    assert.equal(fs.existsSync(oldRun.dir), false);
    assert.equal(fs.existsSync(oldRun.log), false);
    assert.ok(fs.existsSync(newRun.dir) && fs.existsSync(newRun.log), '9 days is inside the 10 day window');
    assert.ok(fs.existsSync(running.dir) && fs.existsSync(running.log), 'a running run is never touched');
  } finally { await b.w.stop(); }
});

test('the result blob carries the reconciled attempts', async () => {
  const repo = makeRepo();
  const result = JSON.stringify({ summary: 's', attempts: [{ route: 'a', tool: 'ghost-tool', target: 't', outcome: 'worked', reason: '', evidence: '' }] });
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_RESULT: result } });
  try {
    const done = await runOne(b, T2, 'LOCAL-b-00000002', RID(3), readOnly);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    const blob = JSON.parse(getBlob(done.result_ref, b.env));
    assert.equal(blob.attempts.length, 1);
    assert.equal(blob.attempts[0].verified, 'claimed-no-call');
  } finally { await b.w.stop(); }
});

test('a removal that fails (a lock) is not stamped and is retried by the next sweep', async () => {
  const repo = makeRepo();
  let fail = true;
  const calls = [];
  const b = await bootWorker({ repo, runtimeAvailable: true, removeWorktreeFn: async (a) => { calls.push(a.dir); if (!fail) { fs.rmSync(a.dir, { recursive: true, force: true }); } } });
  try {
    const done = await runOne(b, T1, 'LOCAL-a-00000001', RID(7), readOnly);
    const wt = path.join(handoffsDir(b.env), 'worktrees', done.id);
    await until(() => calls.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(wt), 'the stub could not remove it');
    assert.equal(b.w.state.handoffs.get(done.id).worktree_removed_at ?? null, null, 'not stamped while the directory is still there');
    fail = false;
    await b.hext.pruneOldWorktrees(Date.parse(b.iso()));
    assert.equal(fs.existsSync(wt), false);
    assert.ok(b.w.state.handoffs.get(done.id).worktree_removed_at);
  } finally { await b.w.stop(); }
});

test('a worktree path outside the worktrees folder is never deleted', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    const done = await runOne(b, T1, 'LOCAL-a-00000001', RID(8), readOnly);
    const outside = fs.mkdtempSync(path.join(b.home, 'precious-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    b.w.state.handoffs.get(done.id).worktree_path = outside;
    b.w.state.handoffs.get(done.id).worktree_removed_at = null;
    await b.hext.cleanupRun(done.id);
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  } finally { await b.w.stop(); }
});

test('a run that fails after its checkout was made does not leave the checkout behind', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, claudePath: process.execPath, claudeArgs: ['-e', 'process.exit(0)'] });
  try {
    b.hext.pause();
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID(9), { target_id: T1, expected_revision: t.revision, payload: readOnly });
    b.hext.resume();
    b.w.tick();
    const hid = b.w.state.requests.get(RID(9)).result.handoff_id;
    await until(() => { b.w.tick(); return b.w.state.handoffs.get(hid).state === 'failed'; });
    await until(() => !fs.existsSync(path.join(handoffsDir(b.env), 'worktrees', hid)));
  } finally { await b.w.stop(); }
});

test('a spawn that throws after the checkout was made leaves no checkout behind', async () => {
  const repo = makeRepo();
  const bad = `claude${String.fromCharCode(0)}x`; // spawn() throws synchronously: the fail() path, after createWorktree
  const b = await bootWorker({ repo, runtimeAvailable: true, claudePath: bad });
  try {
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID(10), { target_id: T1, expected_revision: t.revision, payload: readOnly });
    b.w.tick();
    const hid = b.w.state.requests.get(RID(10)).result.handoff_id;
    const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return x.state === 'failed' ? x : null; });
    assert.equal(h.error.code, 'spawn-failed');
    await until(() => !fs.existsSync(path.join(handoffsDir(b.env), 'worktrees', hid)));
    assert.doesNotMatch(git(repo.dir, 'worktree', 'list'), /worktrees/);
  } finally { await b.w.stop(); }
});

// ---- Ticket worktree teardown (ADR 0036, FR-1.3)
import { writeIngress } from '../../src/core/ingress.js';
import { createBranchWorktree } from '../../src/handoff/worktree.js';
import { worktreeIdentity } from '../../src/core/worktrees.js';

const MOUNT = (n) => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A ticket with a real worktree under <home>/worktrees/demo/<KEY>, recorded as the CLI records it.
async function mounted(b, repo, { tid = T1, key = 'LOCAL-a-00000001', n = 1, dir } = {}) {
  b.ticket(tid, key);
  const wt = dir ?? path.join(b.home, 'worktrees', 'demo', key);
  const made = dir ? { base_sha: repo.head } : await createBranchWorktree({ repoPath: repo.dir, dir: wt, branch: `quill/${key}` });
  const payload = { op: 'mounted', mount_id: MOUNT(n), ticket_id: tid, repo_id: 'demo', path: wt, branch: `quill/${key}`, base_sha: made.base_sha };
  writeIngress(b.mk('worktree', payload, { ticket_id: tid, source_identity: worktreeIdentity(payload) }), b.env);
  b.w.tick();
  return { wt, payload, ticket: b.w.state.tickets.get(tid) };
}
const setStatus = (b, tid, status) => { writeIngress(b.mk('ticket-update', { ticket_id: tid, fields: { status }, source: 'manual' }), b.env); b.w.tick(); };
const worktreeEvents = (b, op) => [...b.w.journal.read()].filter((e) => e.kind === 'worktree' && e.payload.op === op);

test('the sweep removes a clean worktree of a ticket done for keep_days and keeps the branch', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    const { wt, ticket } = await mounted(b, repo);
    assert.equal(ticket.worktrees[0].state, 'mounted');
    await b.hext.sweepTicketWorktrees();
    assert.ok(fs.existsSync(wt), 'an open ticket keeps its worktree');
    setStatus(b, T1, 'done');
    b.advance(6 * DAY);
    await b.hext.sweepTicketWorktrees();
    assert.ok(fs.existsSync(wt), 'done for less than keep_days');
    b.advance(1 * DAY);
    await b.hext.sweepTicketWorktrees();
    assert.equal(fs.existsSync(wt), false);
    assert.equal(b.w.state.tickets.get(T1).worktrees[0].state, 'pruned');
    assert.equal(worktreeEvents(b, 'pruned')[0].producer, 'worker');
    assert.equal(git(repo.dir, 'rev-parse', '--verify', 'refs/heads/quill/LOCAL-a-00000001'), repo.head, 'the branch stays (ADR 0021)');
    assert.doesNotMatch(git(repo.dir, 'worktree', 'list'), /LOCAL-a-00000001/);
    // Reopening the ticket afterwards starts nothing.
    setStatus(b, T1, 'active');
    await b.hext.sweepTicketWorktrees();
    assert.equal(fs.existsSync(wt), false);
    assert.equal(worktreeEvents(b, 'mounted').length, 1);
  } finally { await b.w.stop(); }
});

test('a dirty worktree is kept and reported once, and goes once it is clean', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, configExtra: { worktree: { keep_days: 2 } } });
  try {
    const { wt } = await mounted(b, repo);
    fs.writeFileSync(path.join(wt, 'draft.txt'), 'unsaved thoughts');
    setStatus(b, T1, 'done');
    b.advance(2 * DAY);
    for (let i = 0; i < 3; i += 1) { await b.hext.sweepTicketWorktrees(); b.advance(DAY); }
    assert.equal(fs.readFileSync(path.join(wt, 'draft.txt'), 'utf8'), 'unsaved thoughts', 'uncommitted work is never deleted');
    const kept = worktreeEvents(b, 'kept');
    assert.equal(kept.length, 1, 'reported once');
    assert.equal(kept[0].payload.reason, 'uncommitted-changes');
    assert.deepEqual([b.w.state.tickets.get(T1).worktrees[0].state, b.w.state.tickets.get(T1).worktrees[0].kept_reason], ['kept', 'uncommitted-changes']);
    fs.rmSync(path.join(wt, 'draft.txt'));
    await b.hext.sweepTicketWorktrees();
    assert.equal(fs.existsSync(wt), false);
    assert.equal(b.w.state.tickets.get(T1).worktrees[0].state, 'pruned');
  } finally { await b.w.stop(); }
});

test('a live session that started in the worktree, or is bound to the ticket, holds it', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  const ingest = (kind, payload, extra = {}) => { writeIngress(b.mk(kind, payload, extra), b.env); b.w.tick(); };
  try {
    const { wt } = await mounted(b, repo);
    setStatus(b, T1, 'done');
    b.advance(8 * DAY);
    ingest('session-start', { source: 'startup', cwd: path.join(wt, 'src') }, { session_id: 'sess-in-wt' });
    await b.hext.sweepTicketWorktrees();
    assert.ok(fs.existsSync(wt));
    ingest('session-end', {}, { session_id: 'sess-in-wt' });
    ingest('session-start', { source: 'startup', cwd: repo.dir }, { session_id: 'sess-bound' });
    ingest('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'sess-bound', ticket_id: T1 });
    b.advance(8 * DAY); // past keep_days again (the binding touched the ticket); the session is still live
    ingest('prompt', { title_candidate: 'still here', length: 10 }, { session_id: 'sess-bound' });
    await b.hext.sweepTicketWorktrees();
    assert.ok(fs.existsSync(wt), 'a session bound to the ticket holds it too');
    b.advance(3 * DAY); // the bound session is extinct by now
    await b.hext.sweepTicketWorktrees();
    assert.equal(fs.existsSync(wt), false);
  } finally { await b.w.stop(); }
});

test('a recorded path outside the worktrees root, or a folder git does not list, is never removed', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    // A forged mount naming the repository checkout itself, and a plain folder inside the root.
    await mounted(b, repo, { dir: repo.dir });
    const plain = path.join(b.home, 'worktrees', 'demo', 'LOCAL-b-00000002');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'keep.txt'), 'k');
    await mounted(b, repo, { tid: T2, key: 'LOCAL-b-00000002', n: 2, dir: plain });
    setStatus(b, T1, 'done');
    setStatus(b, T2, 'done');
    b.advance(30 * DAY);
    await b.hext.sweepTicketWorktrees();
    assert.ok(fs.existsSync(path.join(repo.dir, 'README.md')));
    assert.ok(fs.existsSync(path.join(plain, 'keep.txt')));
    assert.equal(worktreeEvents(b, 'pruned').length + worktreeEvents(b, 'kept').length, 0);
  } finally { await b.w.stop(); }
});
