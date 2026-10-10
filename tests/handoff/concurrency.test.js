import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concurrencyLimits } from '../../src/handoff/extension.js';
import { bootWorker, makeRepo, until, T1, T2 } from './helpers.js';

const RID = (n) => `33333333-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T4 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const analyse = { mode: 'analyse', note: 'look', permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, branch: null };
const fix = { mode: 'attempt-fix', note: 'fix', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, branch: null };

test('[handoff] caps default to 2 read-only runs and 1 fix run; bad values fall back to the defaults', () => {
  assert.deepEqual(concurrencyLimits({}), { readonly: 2, fix: 1 });
  assert.deepEqual(concurrencyLimits({ handoff: { max_concurrent_readonly: 5, max_concurrent_fix: 3 } }), { readonly: 5, fix: 3 });
  assert.deepEqual(concurrencyLimits({ handoff: { max_concurrent_readonly: 0, max_concurrent_fix: 'many' } }), { readonly: 2, fix: 1 });
  assert.deepEqual(concurrencyLimits({ handoff: { max_concurrent_readonly: 2.5, max_concurrent_fix: -1 } }), { readonly: 2, fix: 1 });
});

test('read-only runs and fix runs are counted against separate caps', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, maxConcurrent: null, handoff: { max_concurrent_readonly: 1, max_concurrent_fix: 1 }, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '1500' } });
  try {
    b.hext.pause();
    for (const [i, [id, key, payload]] of [[T1, 'LOCAL-a-00000001', analyse], [T2, 'LOCAL-b-00000002', analyse], [T3, 'LOCAL-c-00000003', fix]].entries()) {
      const t = b.ticket(id, key);
      b.request(RID(i + 1), { target_id: id, expected_revision: t.revision, payload });
    }
    b.hext.resume();
    b.w.tick();
    const states = () => Object.fromEntries([...b.w.state.handoffs.values()].map((h) => [h.ticket_id, h.state]));
    await until(() => { b.w.tick(); const s = states(); return s[T1] === 'running' && s[T3] === 'running'; });
    assert.equal(states()[T2], 'queued', 'the second analysis waits for the read-only slot; the fix does not');
    await until(() => { b.w.tick(); return states()[T2] === 'running'; }, { timeoutMs: 15_000 });
  } finally { await b.w.stop(); }
});

test('a second fix waits for the fix cap even on another repository', async () => {
  const repo = makeRepo();
  const other = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, maxConcurrent: null, handoff: { max_concurrent_fix: 1 }, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '1500' } });
  try {
    b.config.repos.other = { ...b.config.repos.demo, display_name: 'other', canonical_path: other.dir };
    b.hext.pause();
    const t1 = b.ticket(T1, 'LOCAL-a-00000001');
    const t4 = b.ticket(T4, 'LOCAL-d-00000004', { repo_id: 'other' });
    b.request(RID(10), { target_id: T1, expected_revision: t1.revision, payload: fix });
    b.request(RID(11), { target_id: T4, expected_revision: t4.revision, payload: fix });
    b.hext.resume();
    b.w.tick();
    const state = (id) => [...b.w.state.handoffs.values()].find((h) => h.ticket_id === id).state;
    await until(() => { b.w.tick(); return state(T1) === 'running'; });
    b.w.tick();
    assert.equal(state(T4), 'queued');
  } finally { await b.w.stop(); }
});
