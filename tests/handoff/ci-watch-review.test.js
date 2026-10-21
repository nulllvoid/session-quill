// Review fixes for the CI watch (ADR 0039): an observation the reducer refuses is journaled once,
// not on every sweep; any branch git accepts is observed; a proposal lapses once the pull request is
// recorded merged or closed, and is never approved then; a CI fix is resumed only by the owner on
// the dashboard, as a CI fix, and only while CI still fails on its commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootWorker, makeRepo, until, T1 } from './helpers.js';
import { updateHandoff } from '../../src/handoff/results.js';

const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
const FIX = { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true };
const PR = 'https://github.com/acme/app/pull/12';
const SHA = 'a'.repeat(40);

const settle = (b, hid) => until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return x && ['done', 'failed', 'cancelled', 'timed-out'].includes(x.state) ? x : null; });

async function rootRun(b, branch) {
  b.ticket(T1, 'PMO-7');
  const rid = randomUUID();
  b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { mode: 'analyse', note: 'look', permissions: NONE } });
  b.w.tick();
  const hid = b.w.state.requests.get(rid).result.handoff_id;
  await settle(b, hid);
  b.advance(1000);
  updateHandoff(b.w, hid, { pr_url: PR, branch, pushed_branch: branch, permissions: FIX, changed_files: ['src.js'] });
  return hid;
}

function github(seen) {
  const gh = { name: 'github', seen };
  gh.fetchChecks = async () => structuredClone(gh.seen);
  gh.fetchFailedLog = async () => null;
  return gh;
}


test('an observation the reducer refuses is journaled once, not on every sweep, and never counted observed', async () => {
  // An empty check name is refused by the reducer (ci-observation-invalid).
  const gh = github({ head_sha: SHA, head_branch: 'quill/pmo-7', pr_state: 'open', state: 'failing', checks: [{ name: '', state: 'failed', run_id: null, job_id: null }] });
  const b = await bootWorker({ repo: makeRepo(), runtimeAvailable: true, repoExtra: { provider: 'github' }, ciProviderFor: () => gh });
  try {
    const hid = await rootRun(b, 'quill/pmo-7');
    const before = b.w.journal.lastSequence;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await b.hext.sweepCi());
    assert.ok(b.w.journal.lastSequence - before <= 1, `at most one journal line, got ${b.w.journal.lastSequence - before}`);
    assert.ok(results.every((r) => r.observed === 0), JSON.stringify(results));
    assert.equal(b.w.state.handoffs.get(hid).ci ?? null, null);
    // Once the facts change to something valid, the next observation applies.
    gh.seen.checks = [{ name: 'CI / test', state: 'failed', run_id: null, job_id: null }];
    const r = await b.hext.sweepCi();
    assert.equal(r.observed, 1, JSON.stringify(r));
    assert.deepEqual([b.w.state.handoffs.get(hid).ci.n, b.w.state.handoffs.get(hid).ci.state], [1, 'failing']);
  } finally { await b.w.stop(); }
});

test('a branch git accepts (fix/#123) is observed and gets a proposal', async () => {
  const branch = 'fix/#123';
  const gh = github({ head_sha: SHA, head_branch: branch, pr_state: 'open', state: 'failing', checks: [{ name: 'test', state: 'failed', run_id: null, job_id: null }] });
  const b = await bootWorker({ repo: makeRepo(), runtimeAvailable: true, repoExtra: { provider: 'github' }, ciProviderFor: () => gh });
  try {
    const hid = await rootRun(b, branch);
    const r = await b.hext.sweepCi();
    assert.deepEqual([r.observed, r.proposed], [1, 1], JSON.stringify(r));
    assert.equal(b.w.state.handoffs.get(hid).ci.head_branch, branch);
    const before = b.w.journal.lastSequence;
    const again = await b.hext.sweepCi();
    assert.deepEqual([again.observed, again.proposed, b.w.journal.lastSequence], [0, 0, before]);
  } finally { await b.w.stop(); }
});
