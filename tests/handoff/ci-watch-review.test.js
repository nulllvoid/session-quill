// Review fixes for the CI watch (ADR 0039): an observation the reducer refuses is journaled once,
// not on every sweep; any branch git accepts is observed; a proposal lapses once the pull request is
// recorded merged or closed, and is never approved then; a CI fix is resumed only by the owner on
// the dashboard, as a CI fix, and only while CI still fails on its commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootWorker, makeRepo, git, until, T1 } from './helpers.js';
import { updateHandoff } from '../../src/handoff/results.js';
import { submitRequest } from '../../src/server/requests.js';
import { ciProposalId } from '../../src/core/reduce/ci.js';
import { writeIngress } from '../../src/core/ingress.js';
import { resumeFields } from '../../src/handoff/resume.js';

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

const BRANCH = 'quill/pmo-7';
// A repository with a bare origin and the run's branch pushed there; returns the commit CI "failed" on.
function repoWithOrigin() {
  const repo = makeRepo();
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'st-origin-'));
  git(origin, 'init', '-q', '--bare');
  git(repo.dir, 'remote', 'add', 'origin', origin);
  git(repo.dir, 'checkout', '-q', '-b', BRANCH);
  fs.writeFileSync(path.join(repo.dir, 'src.js'), 'export const a = 2;\n');
  git(repo.dir, 'commit', '-q', '-am', 'fix attempt');
  git(repo.dir, 'push', '-q', 'origin', BRANCH);
  git(repo.dir, 'checkout', '-q', 'main');
  return { repo, origin, head: git(repo.dir, 'rev-parse', BRANCH) };
}
const failing = (sha) => ({ head_sha: sha, head_branch: BRANCH, pr_state: 'draft', state: 'failing', checks: [{ name: 'CI / test', state: 'failed', run_id: null, job_id: null }] });
const approve = (b, p) => submitRequest(b.w, { id: randomUUID(), kind: 'approve-run', target_id: p.ticket_id, expected_revision: null, payload: { proposal_id: p.id } });

test('a CI proposal lapses once the reconciler records its pull request merged; approval refuses a PR recorded ended', async () => {
  const { repo, head } = repoWithOrigin();
  const gh = github(failing(head));
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { provider: 'github' }, ciProviderFor: () => gh });
  try {
    const root = await rootRun(b, BRANCH);
    await b.hext.sweepCi();
    const p = b.w.state.runProposals.get(ciProposalId(root, head));
    assert.equal(p.state, 'proposed');
    // A record that says the PR closed while the proposal is still open (an older state): refused.
    b.w.state.handoffs.get(root).pr_observed = { state: 'closed' };
    const closed = approve(b, p).request;
    b.w.tick();
    assert.deepEqual([b.w.state.requests.get(closed.id).state, b.w.state.requests.get(closed.id).error.code], ['failed', 'ci-pr-closed']);
    delete b.w.state.handoffs.get(root).pr_observed;
    // The reconciler sees the ticket's PR merged: the proposal lapses, though the watch stops polling it.
    b.w.state.tickets.get(T1).prs.push({ id: 'pr1', provider: 'github', url: PR, state: 'draft', opened_at: b.iso(), merged_at: null, base_branch: 'main', head_branch: BRANCH, observed_at: b.iso(), error: null, evidence_id: null });
    b.w.emit('reconcile', { pr_updates: [{ ticket_id: T1, url: PR, state: 'merged', merged_at: b.iso() }] });
    assert.deepEqual([p.lapse_reason, typeof p.lapsed_at], ['pr-merged', 'string']);
    assert.throws(() => approve(b, p), /pull request was merged, so this CI fix proposal lapsed/);
  } finally { await b.w.stop(); }
});

test('a CI fix whose branch is gone from origin does not start, even with a remote-tracking ref left over', async () => {
  const { repo, origin, head } = repoWithOrigin();
  const gh = github(failing(head));
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { provider: 'github' }, ciProviderFor: () => gh, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const root = await rootRun(b, BRANCH);
    await b.hext.sweepCi();
    const p = b.w.state.runProposals.get(ciProposalId(root, head));
    git(origin, 'update-ref', '-d', `refs/heads/${BRANCH}`);
    assert.equal(git(repo.dir, 'rev-parse', `refs/remotes/origin/${BRANCH}`), head, 'the stale tracking ref still names the failing commit');
    const { request } = approve(b, p);
    b.w.tick();
    const fixId = b.w.state.requests.get(request.id).result.handoff_id;
    const failed = await settle(b, fixId);
    assert.deepEqual([failed.state, failed.error.code], ['failed', 'ci-branch-missing'], JSON.stringify(failed.error));
    assert.throws(() => git(origin, 'rev-parse', '--verify', `refs/heads/${BRANCH}`), 'nothing pushed');
  } finally { await b.w.stop(); }
});

const SESSION = '5e551011-0000-4000-8000-000000000001';
const resume = (b, h) => submitRequest(b.w, { id: randomUUID(), kind: 'resume-run', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id } });
function resumeViaIngress(b, h) {
  const id = randomUUID();
  writeIngress(b.mk('request', { id, kind: 'resume-run', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id }, created_at: b.iso(), not_before: b.iso(), actor_id: 'owner', body_hash: 'x' }, { source_identity: `request:${id}`, producer: 'cli' }), b.env);
  b.w.tick();
  b.w.tick();
  return b.w.state.requests.get(id);
}
const outcome = (b, request) => { b.w.tick(); const r = b.w.state.requests.get(request.id); return [r.state, r.error ? r.error.code : null]; };

test('a CI fix is resumed as a CI fix, by the owner on the dashboard only, and only while CI still fails on its commit', async () => {
  const { repo, head } = repoWithOrigin();
  const gh = github(failing(head));
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { provider: 'github' }, ciProviderFor: () => gh });
  try {
    const root = await rootRun(b, BRANCH);
    await b.hext.sweepCi();
    const p = b.w.state.runProposals.get(ciProposalId(root, head));
    b.hext.pause();
    const { request } = approve(b, p);
    b.w.tick();
    const fixId = b.w.state.requests.get(request.id).result.handoff_id;
    updateHandoff(b.w, fixId, { state: 'failed', finished_at: b.iso(), session_id: SESSION, error: { code: 'interrupted', message: 'the worker stopped' } });
    b.hext.resume();
    const fix = b.w.state.handoffs.get(fixId);
    const fields = resumeFields(fix);
    assert.deepEqual([fields.origin, fields.ci_fix.head_sha, fields.ci_fix.root_handoff_id, fields.proposal.origin], ['ci', head, root, 'ci']);

    // The CLI (anything through ingress, whatever actor it claims) never resumes a CI fix.
    const cli = resumeViaIngress(b, fix);
    assert.deepEqual([cli.state, cli.error.code], ['failed', 'resume-dashboard-only']);
    // The pull request is recorded closed: refused.
    b.w.state.handoffs.get(root).pr_observed = { state: 'closed' };
    assert.deepEqual(outcome(b, resume(b, fix).request), ['failed', 'ci-pr-closed']);
    delete b.w.state.handoffs.get(root).pr_observed;
    // The pull request has a newer commit: stale.
    gh.seen = failing('b'.repeat(40));
    await b.hext.sweepCi();
    assert.deepEqual(outcome(b, resume(b, fix).request), ['failed', 'ci-proposal-stale']);
    // CI fails on the fix's commit again: the owner on the dashboard resumes it, as a CI fix.
    gh.seen = failing(head);
    await b.hext.sweepCi();
    const ok = resume(b, fix).request;
    assert.deepEqual(outcome(b, ok), ['applied', null]);
    const resumed = b.w.state.handoffs.get(b.w.state.requests.get(ok.id).result.handoff_id);
    assert.deepEqual([resumed.retry_of, resumed.origin, resumed.ci_fix.head_sha, resumed.ci_fix.root_handoff_id, resumed.branch, resumed.permissions.open_draft_pr], [fixId, 'ci', head, root, BRANCH, false]);
  } finally { await b.w.stop(); }
});

test('the log tail never keeps a private key body, whether the key starts before the cut or the log starts inside it', async () => {
  const { ciLogTail } = await import('../../src/handoff/ci-watch.js');
  const body = Array.from({ length: 2000 }, (_, i) => `KEYBODY${String(i).padStart(5, '0')}xx`);
  const after = ['-----END RSA PRIVATE KEY-----', 'FAIL test/a.test.js', '  expected 1 to equal 2'];
  // A key whose BEGIN lies more than 16 KB before the end of the log.
  const whole = ciLogTail(['setup', '-----BEGIN RSA PRIVATE KEY-----', ...body, ...after].join('\n'));
  assert.doesNotMatch(whole.text, /KEYBODY|END RSA PRIVATE KEY/);
  assert.match(whole.text, /FAIL test\/a\.test\.js/);
  // A log that starts inside a key (GitHub kept only its end): the body before the END goes too.
  const orphan = ciLogTail([...body.slice(-50), ...after].join('\n'));
  assert.doesNotMatch(orphan.text, /KEYBODY|END RSA PRIVATE KEY/);
  assert.match(orphan.text, /expected 1 to equal 2/);
  // An unterminated key at the end of the log.
  assert.doesNotMatch(ciLogTail(['FAIL', '-----BEGIN PRIVATE KEY-----', ...body.slice(0, 20)].join('\n')).text, /KEYBODY/);
});
