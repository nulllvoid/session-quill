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
    assert.ok(b.w.state.handoffs.get(done.id).worktree_removed_at, 'the record says the checkout is gone');
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
