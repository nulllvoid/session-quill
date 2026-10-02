import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decideGate, DENIAL_REASON, isTrackerCliCommand } from '../../src/gate/decide.js';

const unbound = { ticket_id: null, binding_revision: 0 };
const bound = { ticket_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_key: 'LOCAL-x-00000001', binding_revision: 1 };
const base = { workerHealthy: true, gateEnabled: true, hostPlanDir: null, planPath: null, allowTools: [] };

test('unbound Edit/Write/MultiEdit/NotebookEdit are denied with the namespaced command in the reason', () => {
  for (const tool_name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const r = decideGate({ ...base, tool_name, tool_input: { file_path: 'C:/repo/src/a.js' }, binding: unbound });
    assert.equal(r.decision, 'deny', tool_name);
    assert.match(r.reason, /\/session-tracker:ticket bind/);
  }
  assert.match(DENIAL_REASON, /session-tracker:ticket create/);
});

test('dedicated reads and host control tools pass through with no decision', () => {
  for (const tool_name of ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion']) {
    assert.equal(decideGate({ ...base, tool_name, tool_input: {}, binding: unbound }).decision, 'none', tool_name);
  }
});

test('Bash read-only grammar passes; anything else is denied when unbound', () => {
  assert.equal(decideGate({ ...base, tool_name: 'Bash', tool_input: { command: 'git status --short' }, binding: unbound }).decision, 'none');
  assert.equal(decideGate({ ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, binding: unbound }).decision, 'deny');
  assert.equal(decideGate({ ...base, tool_name: 'Bash', tool_input: {}, binding: unbound }).decision, 'deny');
  assert.equal(decideGate({ ...base, tool_name: 'PowerShell', tool_input: { command: 'Get-Location' }, binding: unbound }).decision, 'none');
  assert.equal(decideGate({ ...base, tool_name: 'PowerShell', tool_input: { command: 'Remove-Item x' }, binding: unbound }).decision, 'deny');
});

test('direct tracker CLI invocations are exempt; shell wrappers around them are not', () => {
  assert.equal(isTrackerCliCommand('node C:/plugins/session-tracker/bin/tracker.js ticket bind LOCAL-x-1 --session abc'), true);
  assert.equal(isTrackerCliCommand('node "C:/Program Files/plug in/bin/tracker.js" ticket create "Fix the thing" --session abc'), true);
  assert.equal(isTrackerCliCommand('tracker ticket show'), true);
  assert.equal(isTrackerCliCommand('tracker ticket off'), true);
  assert.equal(isTrackerCliCommand('tracker ticket bind X && rm -rf /'), false);
  assert.equal(isTrackerCliCommand('tracker ticket bind $(cat x)'), false);
  assert.equal(isTrackerCliCommand('tracker worker stop'), false);
  assert.equal(isTrackerCliCommand('tracker ticket create "x" | tee out'), false);
  assert.equal(isTrackerCliCommand('bash -c "tracker ticket bind X"'), false);
  assert.equal(decideGate({ ...base, tool_name: 'Bash', tool_input: { command: 'tracker ticket bind LOCAL-x-1' }, binding: unbound }).decision, 'none');
});

test('MCP and unknown tools are denied unless registered as non-mutating', () => {
  assert.equal(decideGate({ ...base, tool_name: 'mcp__jira__create_issue', tool_input: {}, binding: unbound }).decision, 'deny');
  assert.equal(decideGate({ ...base, tool_name: 'SomeNewTool', tool_input: {}, binding: unbound }).decision, 'deny');
  assert.equal(decideGate({ ...base, allowTools: ['mcp__memory__search'], tool_name: 'mcp__memory__search', tool_input: {}, binding: unbound }).decision, 'none');
});

test('bound sessions produce no decision (never an unconditional allow)', () => {
  const r = decideGate({ ...base, tool_name: 'Edit', tool_input: { file_path: 'x' }, binding: bound });
  assert.equal(r.decision, 'none');
  assert.equal(decideGate({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, binding: bound }).decision, 'none');
});

test('gate off produces no decision; unhealthy worker denies covered tools but not reads', () => {
  assert.equal(decideGate({ ...base, gateEnabled: false, tool_name: 'Edit', tool_input: { file_path: 'x' }, binding: unbound }).decision, 'none');
  const r = decideGate({ ...base, workerHealthy: false, tool_name: 'Edit', tool_input: { file_path: 'x' }, binding: bound });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /worker unavailable/);
  assert.equal(decideGate({ ...base, workerHealthy: false, tool_name: 'Read', tool_input: {}, binding: bound }).decision, 'none');
});

test('plan-file exception permits only the exact canonical plan path under the verified plan dir', () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plans-'));
  const planPath = path.join(planDir, 'quiet-fox.md');
  fs.writeFileSync(planPath, '# plan');
  const ok = decideGate({ ...base, hostPlanDir: planDir, planPath, tool_name: 'Write', tool_input: { file_path: planPath }, binding: unbound });
  assert.equal(ok.decision, 'none');
  const other = decideGate({ ...base, hostPlanDir: planDir, planPath, tool_name: 'Write', tool_input: { file_path: path.join(planDir, 'other.md') }, binding: unbound });
  assert.equal(other.decision, 'deny');
  const outside = decideGate({ ...base, hostPlanDir: planDir, planPath, tool_name: 'Write', tool_input: { file_path: path.join(planDir, '..', 'quiet-fox.md') }, binding: unbound });
  assert.equal(outside.decision, 'deny');
  const noPlan = decideGate({ ...base, hostPlanDir: planDir, planPath: null, tool_name: 'Write', tool_input: { file_path: planPath }, binding: unbound });
  assert.equal(noPlan.decision, 'deny', 'plan mode alone never exempts');
});

test('a symlink inside the plan dir pointing elsewhere is denied', (t) => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plans-'));
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-elsewhere-')), 'secret.md');
  fs.writeFileSync(target, 'x');
  const link = path.join(planDir, 'sneaky.md');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (err) {
    t.skip(`symlink not permitted here: ${err.code}`);
    return;
  }
  const r = decideGate({ ...base, hostPlanDir: planDir, planPath: link, tool_name: 'Write', tool_input: { file_path: link }, binding: unbound });
  assert.equal(r.decision, 'deny');
});
