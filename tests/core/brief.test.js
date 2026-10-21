import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resumeBrief, BRIEF_MAX, CONTEXT_MAX } from '../../src/core/brief.js';
import { runHook } from '../../src/hooks/adapter.js';
import { writeRuntimeIdentity, writeBindingSnapshot, writeHeartbeat } from '../../src/hooks/binding-snapshot.js';

const NOW = '2026-10-11T12:00:00Z';
const ID = '00000001-0000-4000-8000-000000000000';
const DESC = '**Goal:** Make retry() call fn up to attempts times.\n\n**Context:** retry.js.\n\n**Done when:**\n- tests pass';
const ticket = (o = {}) => ({ id: ID, key: 'FIX-7', title: 'Retry', status: 'active', summary: DESC, next_action: '', blocker: null, plans: [], conclusions: [], files_touched: [], prs: [], deployments: [], last_activity: '2026-10-09T12:00:00Z', ...o });

test('a ticket nothing has happened on yet gets no brief', () => {
  assert.equal(resumeBrief(ticket(), { nowIso: NOW }), null);
  assert.equal(resumeBrief(null, { nowIso: NOW }), null);
});

test('the brief says where the work stands: goal, next action, plan, conclusions, files, PRs', () => {
  const b = resumeBrief(ticket({
    next_action: 'Fix the off-by-one in the loop bound',
    plans: [{ preview: 'Old plan', approved_at: '2026-10-08T00:00:00Z' }, { preview: 'Unapproved idea', approved_at: null }],
    conclusions: [{ preview: 'one' }, { preview: 'Loop stops at attempts - 1' }, { preview: 'Tests reproduce it' }],
    files_touched: [{ relative_path: 'src/retry.js', last_seen: '2026-10-09T00:00:00Z' }, { relative_path: 'C:/tmp/scratch.mjs', last_seen: '2026-10-10T00:00:00Z' }, { relative_path: 'test/retry.test.js', last_seen: '2026-10-08T00:00:00Z' }],
    prs: [{ url: 'https://github.com/a/b/pull/3', state: 'open' }, { url: 'https://github.com/a/b/pull/1', state: 'closed' }],
  }), { nowIso: NOW });
  assert.match(b, /^Where FIX-7 stands \(active, last activity 2 days ago\):/);
  assert.match(b, /Goal: Make retry\(\) call fn up to attempts times\./);
  assert.match(b, /Next action: Fix the off-by-one in the loop bound\./);
  assert.match(b, /Approved plan: Old plan\./, 'an approved plan wins over a later draft');
  assert.match(b, /Recent conclusions: Loop stops at attempts - 1 \| Tests reproduce it\./);
  assert.match(b, /Recently changed: src\/retry\.js, test\/retry\.test\.js\./, 'absolute scratch paths are left out');
  assert.match(b, /PRs: https:\/\/github\.com\/a\/b\/pull\/3 \(open\)\./);
  assert.doesNotMatch(b, /pull\/1/);
});

test('the brief is bounded', () => {
  const b = resumeBrief(ticket({ next_action: 'x'.repeat(5000), conclusions: Array.from({ length: 50 }, () => ({ preview: 'y'.repeat(500) })), files_touched: Array.from({ length: 50 }, (_, i) => ({ relative_path: `f${i}.js`, last_seen: NOW })) }), { nowIso: NOW });
  assert.ok(b.length <= BRIEF_MAX, `${b.length}`);
});

test('a bound SessionStart carries the brief from the ticket projection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-brief-'));
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: '33333333-3333-4333-8333-333333333333', machine_id: '22222222-2222-4222-8222-222222222222', store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: 'nudge', approval_phrases_enabled: false, allow_tools: [] }, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: '33333333-3333-4333-8333-333333333333' }, env);
  writeBindingSnapshot('s1', { ticket_id: ID, ticket_key: 'FIX-7', ticket_title: 'Retry', binding_revision: 1, gate_enabled: true }, env);
  fs.mkdirSync(path.join(home, 'projections', 'tickets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projections', 'tickets', `${ID}.json`), JSON.stringify(ticket({ next_action: 'Fix the loop bound' })));
  const r = runHook('SessionStart', { session_id: 's1', source: 'resume', cwd: home }, { env, now: NOW });
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Bound to FIX-7.*Where FIX-7 stands.*Next action: Fix the loop bound\..*tickets represent tasks/s);
});

// The context card (ADR 0038): a "Context:" block after the brief, at most CONTEXT_MAX characters.
const CARD = {
  ticket_id: ID,
  co_change: [{ file: 'src/retry.js', partner: 'src/backoff.js', n: 4 }, { file: 'src/retry.js', partner: 'test/retry.test.js', n: 3 }],
  related: [{ key: 'FIX-3', title: 'Retry budget', status: 'done', files: ['src/retry.js'], live_run: false }, { key: 'FIX-9', title: null, status: 'active', files: ['src/retry.js'], live_run: true }],
  guard: ['Critical change FIX-7.1 is proposed and waits for the owner\'s decision; it has not run'],
};

test('the brief appends the context card after the existing brief', () => {
  const t = ticket({ next_action: 'Fix the loop bound', files_touched: [{ relative_path: 'src/retry.js', last_seen: NOW }] });
  const plain = resumeBrief(t, { nowIso: NOW });
  const b = resumeBrief(t, { nowIso: NOW, card: CARD });
  assert.ok(b.startsWith(plain), 'the existing brief is unchanged');
  const block = b.slice(plain.length);
  assert.match(block, /^ Context: /);
  assert.match(block, /Often changed together: src\/backoff\.js with src\/retry\.js \(4 commits\), test\/retry\.test\.js with src\/retry\.js \(3 commits\)\./);
  assert.match(block, /Other tickets on these files: FIX-3 "Retry budget" \(done\): src\/retry\.js; FIX-9 \(active, a run is live\): src\/retry\.js\./);
  assert.match(block, /Guard: Critical change FIX-7\.1 is proposed and waits for the owner's decision; it has not run\./);
  assert.equal(resumeBrief(t, { nowIso: NOW, card: { co_change: [], related: [], guard: [] } }), plain, 'an empty card adds nothing');
  assert.equal(resumeBrief(ticket(), { nowIso: NOW, card: CARD }), null, 'no brief, no card');
});

test('the context block is bounded and one line', () => {
  const long = (n) => Array.from({ length: n }, (_, i) => `src/${'deep/'.repeat(20)}f${i}.js`);
  const card = { co_change: long(5).map((f) => ({ file: f, partner: `${f}x`, n: 9 })), related: long(5).map((f, i) => ({ key: `K-${i}`, title: 't\n'.repeat(80), status: 'todo', files: [f], live_run: false })), guard: long(5) };
  const t = ticket({ next_action: 'x'.repeat(5000) });
  const b = resumeBrief(t, { nowIso: NOW, card });
  const block = b.slice(b.indexOf(' Context: '));
  assert.ok(block.length <= CONTEXT_MAX + 1, `${block.length}`);
  assert.ok(b.length <= BRIEF_MAX + CONTEXT_MAX + 1, `${b.length}`);
  assert.doesNotMatch(b, /\n/);
});
