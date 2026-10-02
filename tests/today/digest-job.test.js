import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scenario, T1 } from '../acceptance/scenario.js';
import { createJobs } from '../../src/schedule/jobs.js';

test('the digest job writes the store-local day into the daily note and an optional file; the snapshot carries the Today feed', async () => {
  const s = await scenario({ timezone: 'Asia/Kolkata', startMs: Date.parse('2026-10-02T14:00:00Z') }).start();
  try {
    s.ticket(T1, 'PROJ-1', { title: 'Retry flake' });
    s.bind('sess-1', T1);
    s.ingest('pre-tool', { tool_name: 'Write' }, { session_id: 'sess-1', tool_call_id: 'w1', source_identity: 'pre:w1' });
    s.ingest('post-tool', { tool_name: 'Write', write_paths: ['src/retry.js'], repo_id: 'demo', success: true }, { session_id: 'sess-1', tool_call_id: 'w1', source_identity: 'post:w1' });
    s.w.tick();
    const snap = s.w.publishGeneration();
    assert.equal(snap.today.generated_for, '2026-10-02');
    assert.equal(snap.today.days[0].tickets[0].key, 'PROJ-1');
    const out = path.join(s.home, 'exports', 'digest.md');
    const jobs = createJobs({ providers: null });
    const r = await jobs.digest(s.w, { run_id: 'r1', schedule: 'daily', settings: { to: ['vault-daily', 'file'], path: out, day: 'today' } });
    const note = path.join(s.storePath, 'daily', '2026-10-02.md');
    assert.equal(r.summary, 'wrote 2 digests for 2026-10-02 (1 ticket)');
    assert.match(fs.readFileSync(note, 'utf8'), /- \*\*PROJ-1\*\* Retry flake — /);
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(note, 'utf8'));
    const y = await jobs.digest(s.w, { run_id: 'r2', schedule: 'daily', settings: { to: ['vault-daily'], path: null, day: 'yesterday' } });
    assert.equal(y.summary, 'wrote 1 digest for 2026-10-01 (0 tickets)');
    assert.match(fs.readFileSync(path.join(s.storePath, 'daily', '2026-10-01.md'), 'utf8'), /No tracked activity\./);
    fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('Retry flake', 'Retry flake (my note)'));
    await assert.rejects(jobs.digest(s.w, { run_id: 'r3', schedule: 'daily', settings: { to: ['vault-daily'], path: null, day: 'today' } }), /was edited after Quill wrote it/);
  } finally { await s.stop(); }
});
