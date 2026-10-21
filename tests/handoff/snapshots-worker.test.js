// Run snapshots (ADR 0035) through the worker: a fix run's step snapshots, the owner's restore from
// the dashboard (10 s undo, pre-restore snapshot), the refusals, and the archive on checkout removal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeRepo, git, bootWorker, until, T1 } from './helpers.js';
import { submitRequest, cancelRequest } from '../../src/server/requests.js';
import { writeIngress } from '../../src/core/ingress.js';

const DAY = 86_400_000;
const FIX = { mode: 'attempt-fix', note: 'fix it', permissions: { read_source: true, edit_source: true, commit: true, push_branch: false, open_draft_pr: false }, branch: null };
const NO_COMMIT = { ...FIX, permissions: { ...FIX.permissions, commit: false } };
const finished = (h) => ['done', 'failed', 'timed-out', 'cancelled'].includes(h.state);

async function fixRun(b, payload = FIX) {
  const t = b.ticket(T1, 'LOCAL-a-00000001');
  const rid = randomUUID();
  b.request(rid, { target_id: T1, expected_revision: t.revision, payload });
  b.w.tick();
  return b.w.state.requests.get(rid).result.handoff_id;
}
const waitRun = (b, hid) => until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return finished(h) ? h : null; }, { timeoutMs: 30_000 });
const restoreBody = (h, snap) => ({ id: randomUUID(), kind: 'restore-snapshot', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id, snapshot_id: snap.id } });
async function settle(b, id) {
  b.advance(10_000);
  return until(() => { b.w.tick(); const r = b.w.state.requests.get(id); return ['applied', 'failed', 'conflict', 'cancelled'].includes(r.state) ? r : null; }, { timeoutMs: 20_000 });
}

test('a fix run is snapshotted at its step boundaries, each under a ref, and its own commit is unaffected', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: `"${process.execPath}" -e "process.exit(0)"` }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const h = await waitRun(b, await fixRun(b));
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const steps = h.snapshots.map((s) => s.step);
    assert.deepEqual(steps.filter((s) => ['start', 'agent', 'before-tests', 'before-commit'].includes(s)), ['start', 'agent', 'before-tests', 'before-commit'], steps.join());
    assert.deepEqual(h.snapshots.map((s) => s.n), steps.map((_, i) => i));
    assert.equal(h.snapshots[0].files_changed, 0, 'the checkout starts at its base commit');
    assert.equal(h.snapshots[1].files_changed, 1, "the agent's edit to src.js");
    for (const s of h.snapshots) assert.equal(git(repo.dir, 'rev-parse', s.ref), s.commit);
    assert.equal(git(repo.dir, 'show', `${h.snapshots[0].commit}:src.js`), 'export const a = 1;');
    assert.notEqual(git(repo.dir, 'show', `${h.snapshots[1].commit}:src.js`), 'export const a = 1;');
    // The run's own commit sits on the base commit, never on a snapshot.
    assert.ok(h.commit_sha);
    assert.equal(git(h.worktree_path, 'rev-parse', 'HEAD^'), h.base_commit);
    assert.equal(b.w.liveSnapshot().handoffs.find((x) => x.id === h.id).snapshots.length, h.snapshots.length, 'the owner dashboard sees them');
  } finally { await b.w.stop(); }
});

test("the dashboard restores a finished run's checkout after the 10 s undo window, saving the checkout first", async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const h = await waitRun(b, await fixRun(b, NO_COMMIT));
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const start = h.snapshots.find((s) => s.step === 'start');
    const dir = h.worktree_path;
    fs.writeFileSync(path.join(dir, 'owner-note.txt'), 'my own work\n');
    // Ignored through the shared repository's info/exclude, which every worktree reads.
    fs.mkdirSync(path.join(repo.dir, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(repo.dir, '.git', 'info', 'exclude'), '.env\n');
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=ignored-and-kept\n');
    // Undo inside the window: nothing happens.
    const undone = submitRequest(b.w, restoreBody(h, start)).request;
    assert.equal(cancelRequest(b.w, undone.id).outcome, 'cancelled');
    assert.ok(fs.existsSync(path.join(dir, 'owner-note.txt')));
    const req = submitRequest(b.w, restoreBody(h, start)).request;
    assert.equal(Date.parse(req.not_before) - Date.parse(req.created_at), 10_000);
    const done = await settle(b, req.id);
    assert.equal(done.state, 'applied', JSON.stringify(done.error));
    assert.equal(fs.readFileSync(path.join(dir, 'src.js'), 'utf8'), 'export const a = 1;\n');
    assert.equal(fs.existsSync(path.join(dir, 'owner-note.txt')), false);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'TOKEN=ignored-and-kept\n', 'an ignored file is untouched');
    const after = b.w.state.handoffs.get(h.id);
    const pre = after.snapshots.at(-1);
    assert.equal(pre.step, 'pre-restore');
    assert.equal(pre.request_id, req.id);
    assert.equal(pre.restores, start.id);
    assert.equal(git(repo.dir, 'show', `${pre.commit}:owner-note.txt`), 'my own work', "the owner's work is in the pre-restore snapshot");
    const target = after.snapshots.find((s) => s.id === start.id);
    assert.ok(target.restored_at);
    assert.equal(target.restore.pre_restore_id, pre.id);
    assert.ok(b.w.state.tickets.get(h.ticket_id).timeline.some((e) => /restored to snapshot 01 \(Checkout created\); the commit, branch and pull request are unchanged/.test(e.text)));
    assert.deepEqual(done.result, { snapshot_id: start.id, pre_restore_id: pre.id, restored: 1, removed: 1, skipped: 0 });
  } finally { await b.w.stop(); }
});

test('restore is refused while the run is running, through ingress, and once the checkout is archived', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js', FAKE_CLAUDE_SLEEP_MS: '1500' } });
  try {
    const hid = await fixRun(b, NO_COMMIT);
    const running = await until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return h.state === 'running' && (h.snapshots ?? []).length ? h : null; }, { timeoutMs: 20_000 });
    assert.throws(() => submitRequest(b.w, restoreBody(running, running.snapshots[0])), (e) => e.code === 'run-active');
    const h = await waitRun(b, hid);
    // An ingress request claiming the owner (the CLI, or anything that can write ingress) is refused.
    const rid = randomUUID();
    writeIngress(b.mk('request', { id: rid, kind: 'restore-snapshot', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id, snapshot_id: h.snapshots[0].id }, created_at: b.iso(), not_before: b.iso(), actor_id: 'owner', body_hash: 'x' }, { source_identity: `request:${rid}` }), b.env);
    const refused = await settle(b, rid);
    assert.equal(refused.state, 'failed');
    assert.equal(refused.error.code, 'snapshot-restore-dashboard-only');
    assert.equal(b.w.state.handoffs.get(h.id).snapshots.some((s) => s.step === 'pre-restore'), false, 'nothing was snapshotted or restored');
    // After the keep time the checkout goes and its snapshot refs move to the archive.
    await b.hext.pruneOldWorktrees(Date.parse(b.iso()) + 8 * DAY);
    const gone = b.w.state.handoffs.get(h.id);
    assert.ok(gone.worktree_removed_at);
    assert.ok(gone.snapshots.length && gone.snapshots.every((s) => s.archived_at && s.ref.startsWith(`refs/quill/archive/${h.id}/`)), JSON.stringify(gone.snapshots));
    for (const s of gone.snapshots) assert.equal(git(repo.dir, 'rev-parse', s.ref), s.commit);
    assert.equal(git(repo.dir, 'for-each-ref', `refs/quill/snapshots/${h.id}/`), '');
    assert.throws(() => submitRequest(b.w, restoreBody(gone, gone.snapshots[0])), (e) => e.code === 'checkout-removed');
  } finally { await b.w.stop(); }
});
