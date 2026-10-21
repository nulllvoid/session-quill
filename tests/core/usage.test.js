import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageStats, usageItems, readJournalTail } from '../../src/core/usage.js';
import { listIngress } from '../../src/core/ingress.js';
import { writeRuntimeIdentity, writeBindingSnapshot } from '../../src/hooks/binding-snapshot.js';

const NOW = '2026-10-11T12:00:00Z';
const tool = (kind, ms, at = '2026-10-10T12:00:00Z') => ({ kind, occurred_at: at, payload: { hook_ms: ms } });

test('usage stats: hook percentiles, gaps and ticket coverage within the window only', () => {
  const events = [
    ...[90, 95, 100, 105, 300].map((ms) => tool('pre-tool', ms)),
    tool('post-tool', 98),
    tool('pre-tool', 5000, '2026-09-01T00:00:00Z'), // outside the 7-day window
    { kind: 'pre-tool', occurred_at: '2026-10-10T12:00:00Z', payload: {} }, // before 0.6.1: no measurement
  ];
  const healthErrors = [{ kind: 'capture-gap', at: '2026-10-09T00:00:00Z' }, { kind: 'capture-gap', at: '2026-09-01T00:00:00Z' }, { kind: 'slow-capture', at: '2026-10-10T00:00:00Z' }];
  const sessions = [
    { last_event_at: '2026-10-10T00:00:00Z', ticket_ids: ['t1'] },
    { last_event_at: '2026-10-10T00:00:00Z', ticket_ids: [], unbound_work: { files: [{}], commits: [] } },
    { last_event_at: '2026-10-10T00:00:00Z', ticket_ids: ['t1'], agent_id: 'sub' },
    { last_event_at: '2026-08-01T00:00:00Z', ticket_ids: [] },
  ];
  const s = usageStats({ events, healthErrors, sessions, nowIso: NOW });
  assert.deepEqual(s, { days: 7, tool_calls: 6, hook_samples: 6, hook_p50_ms: 100, hook_p95_ms: 300, capture_gaps: 1, slow_captures: 1, sessions: 2, sessions_bound: 1, sessions_with_unlinked_work: 1 });
  const items = usageItems(s);
  assert.equal(items.find((i) => i.label === 'hook latency').level, 'warn', 'p95 over the 200 ms budget');
  assert.match(items.find((i) => i.label === 'ticket coverage').detail, /1\/2 sessions linked to a ticket; 1 \(50%\) left unlinked work/);
});

test('the journal tail is bounded and skips a record cut at the boundary', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-usage-')), 'events.jsonl');
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ kind: 'pre-tool', sequence: i, pad: 'x'.repeat(100) }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const tail = readJournalTail(file, { maxBytes: 2000 });
  assert.ok(tail.length > 5 && tail.length < 20, `${tail.length} events`);
  assert.equal(tail[tail.length - 1].sequence, 199);
  assert.equal(readJournalTail(path.join(path.dirname(file), 'missing.jsonl')).length, 0);
});

test('the hook process records its own duration on tool events', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-usage-hook-'));
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: '33333333-3333-4333-8333-333333333333', machine_id: '22222222-2222-4222-8222-222222222222', store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: 'nudge', approval_phrases_enabled: false, allow_tools: [] }, env);
  writeBindingSnapshot('s1', { ticket_id: '00000001-0000-4000-8000-000000000000', ticket_key: 'DEV-1', binding_revision: 1, gate_enabled: true }, env);
  const bin = fileURLToPath(new URL('../../bin/quill-hook.js', import.meta.url));
  const input = JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 't1' });
  const r = spawnSync(process.execPath, [bin, 'PreToolUse'], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [ev] = listIngress(env).map((x) => x.event);
  assert.equal(ev.kind, 'pre-tool');
  assert.ok(Number.isInteger(ev.payload.hook_ms) && ev.payload.hook_ms > 0 && ev.payload.hook_ms < 5000, `hook_ms ${ev.payload.hook_ms}`);
});

// ADR 0033: recipe stats are counts per recipe from run records and owner requests.
test('recipeStats counts runs, outcomes, first-time and repaired test passes, interventions, merges and reverts', async () => {
  const { recipeStats, recipeLines } = await import('../../src/core/usage.js');
  const at = '2026-10-05T12:00:00Z';
  const fix = { name: 'attempt-fix' };
  const merged = (mergedAt, extra = {}) => ({ state: 'merged', merged_at: mergedAt, merge_commit: 'c'.repeat(40), reverted_by: null, revert_checked_at: null, ...extra });
  const handoffs = [
    { id: 'r1', recipe: fix, requested_at: at, finished_at: '2026-10-05T13:00:00Z', state: 'done', test_gate: { status: 'passed', attempts: 1, runs: [{ exit_code: 0 }] }, pr_url: 'u1', pr_observed: merged('2026-10-06T13:00:00Z', { revert_checked_at: '2026-10-09T00:00:00Z' }) },
    // Reverted 10 h after merge: counts as reverted within 48 h.
    { id: 'r2', recipe: fix, requested_at: at, finished_at: '2026-10-05T13:00:00Z', state: 'done', test_gate: { status: 'passed', attempts: 2, repaired: true, runs: [{ exit_code: 1 }, { exit_code: 0 }] }, pr_url: 'u2', pr_observed: merged('2026-10-05T15:00:00Z', { reverted_by: 'd'.repeat(40), reverted_at: '2026-10-06T01:00:00Z' }) },
    // Reverted 3 days after merge: outside the window, and checked after it closed.
    { id: 'r3', recipe: fix, requested_at: at, finished_at: '2026-10-05T13:00:00Z', state: 'done', pr_url: 'u3', pr_observed: merged('2026-10-05T14:00:00Z', { reverted_by: 'e'.repeat(40), reverted_at: '2026-10-08T15:00:00Z', revert_checked_at: '2026-10-08T15:00:00Z' }) },
    // Merged 10 h ago: the window is still open, so pending.
    { id: 'r4', recipe: fix, requested_at: at, finished_at: '2026-10-11T01:00:00Z', state: 'done', pr_url: 'u4', pr_observed: merged('2026-10-11T02:00:00Z', { revert_checked_at: '2026-10-11T02:00:00Z' }) },
    { id: 'r5', recipe: fix, requested_at: at, state: 'failed', test_gate: { status: 'failed', attempts: 2 } },
    { id: 'r6', recipe: fix, requested_at: at, state: 'cancelled' },
    { id: 'r7', recipe: fix, requested_at: at, state: 'done', retry_of: 'r5' },
    // A PR only its ticket's evidence shows as merged; never checked for a revert: pending.
    { id: 'r8', mode: 'analyse', requested_at: at, finished_at: '2026-10-05T13:00:00Z', state: 'timed-out', pr_url: 'https://github.com/acme/demo/pull/8' },
    { id: 'old', recipe: fix, requested_at: '2026-08-01T00:00:00Z', state: 'done' },
  ];
  const tickets = [{ prs: [{ url: 'https://github.com/acme/demo/pull/8', state: 'merged', merged_at: '2026-10-06T00:00:00Z' }] }];
  const requests = [
    { kind: 'handoff-cancel', state: 'applied', payload: { handoff_id: 'r6' } },
    { kind: 'handoff-cancel', state: 'failed', payload: { handoff_id: 'r1' } },
    { kind: 'undo-file-effect', state: 'applied', payload: { handoff_id: 'r1', effect_id: 'x' } },
    { kind: 'accept-suggestion', state: 'applied', payload: { handoff_id: 'r1' } },
  ];
  const stats = recipeStats({ handoffs, tickets, requests, nowIso: NOW });
  assert.deepEqual(stats.map((s) => s.recipe), ['attempt-fix', 'analyse']);
  const [f, a] = stats;
  assert.deepEqual({ ...f, median_done_to_merge_ms: undefined }, { recipe: 'attempt-fix', runs: 7, done: 5, failed: 1, tests_first_pass: 1, tests_after_repair: 1, interventions: 3, merged: 4, reverted_48h: 1, pending_48h: 1, median_done_to_merge_ms: undefined });
  assert.equal(f.median_done_to_merge_ms, 1.5 * 3600_000, 'median of 24 h, 2 h, 1 h and 1 h');
  assert.deepEqual([a.runs, a.failed, a.merged, a.pending_48h], [1, 1, 1, 1]);
  const lines = recipeLines(stats);
  assert.match(lines[0], /^attempt-fix: 7 run\(s\), 5 done, 1 failed · tests passed \(worker\) first time 1, after a repair 1 · 3 owner intervention\(s\) · 4 PR\(s\) merged, 1 reverted within 48 h, 1 not yet known/);
  assert.deepEqual(recipeLines([]), ['no agent runs in the last 30 days']);
});
