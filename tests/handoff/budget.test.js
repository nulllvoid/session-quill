import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetFor } from '../../src/handoff/runner.js';

const MIN = 60_000;
const analyse = { mode: 'analyse', permissions: { read_source: true }, timeout_set: false, timeout_min: 20, max_turns: null, max_budget_usd: null };
const fixRecipe = { ...analyse, mode: 'attempt-fix', permissions: { read_source: true, edit_source: true } };

test('budgetFor: spec defaults by mode and access', () => {
  assert.deepEqual(budgetFor(analyse, {}, 'autonomous', 'analyse'), { maxTurns: 80, repairTurns: 4, selfCheckTurns: 20, timeoutMs: 30 * MIN, maxBudgetUsd: 10 });
  assert.equal(budgetFor(fixRecipe, {}, 'autonomous', 'attempt-fix').maxTurns, 150);
  assert.equal(budgetFor(analyse, {}, 'standard', 'analyse').timeoutMs, 20 * MIN);
  assert.equal(budgetFor(null, {}, 'standard', 'attempt-fix').maxTurns, 150);
});

test('budgetFor: config overrides defaults and recipe values override config; bad values fall back', () => {
  const cfg = { handoff: { max_turns: 100, max_turns_fix: 200, repair_turns: 3, self_check_turns: 10, timeout_min: 15, timeout_min_autonomous: 45, max_budget_usd: 5 } };
  assert.deepEqual(budgetFor(analyse, cfg, 'standard', 'analyse'), { maxTurns: 100, repairTurns: 3, selfCheckTurns: 10, timeoutMs: 15 * MIN, maxBudgetUsd: 5 });
  assert.equal(budgetFor(analyse, cfg, 'autonomous', 'analyse').timeoutMs, 45 * MIN);
  assert.equal(budgetFor(fixRecipe, cfg, 'standard', 'attempt-fix').maxTurns, 200);
  const r = { ...analyse, max_turns: 120, max_budget_usd: 2, timeout_set: true, timeout_min: 7 };
  assert.deepEqual(budgetFor(r, cfg, 'autonomous', 'analyse'), { maxTurns: 120, repairTurns: 3, selfCheckTurns: 10, timeoutMs: 7 * MIN, maxBudgetUsd: 2 });
  assert.equal(budgetFor(analyse, { handoff: { max_turns: -3, timeout_min_autonomous: 500 } }, 'autonomous', 'analyse').maxTurns, 80);
  assert.equal(budgetFor(analyse, { handoff: { timeout_min_autonomous: 500 } }, 'autonomous', 'analyse').timeoutMs, 60 * MIN, 'capped at the 60 minute ceiling');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootWorker, until, T1 } from './helpers.js';

const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false, edit_files: false, delete_files: false };

test('through the worker: dispatch passes the budget to the runtime and records turns, spend and its estimate', async () => {
  const capture = path.join(os.tmpdir(), `capture-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const b = await bootWorker({ runtimeAvailable: true, handoff: { max_turns: 33, max_budget_usd: 2.5 }, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture } });
  try {
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    const rid = '66666666-0000-4000-8000-000000000001';
    b.request(rid, { target_id: T1, expected_revision: t.revision, payload: { mode: 'analyse', note: '', permissions: NONE, branch: null } });
    b.w.tick();
    const hid = b.w.state.requests.get(rid).result.handoff_id;
    const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed'].includes(x.state) ? x : null; });
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const args = JSON.parse(fs.readFileSync(capture, 'utf8')).args;
    const after = (f) => args[args.indexOf(f) + 1];
    assert.equal(after('--max-turns'), '33');
    assert.equal(after('--max-budget-usd'), '2.5');
    assert.equal(h.num_turns >= 3, true);
    assert.equal(typeof h.cost_usd, 'number');
    assert.equal(h.cost_estimated, !process.env.ANTHROPIC_API_KEY);
    assert.equal(h.recorded_stage, 'investigated');
  } finally { await b.w.stop(); }
});
