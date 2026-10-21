// Dry-run preflight (FR-3.2, ADR 0031): in an approved critical run whose grant says requireDryRun,
// a pinned k8s.write or db.write action is refused until the run ledger shows its dry-run twin
// allowed by the guard and finished with exit 0. It only refuses: everything else decides as in 1.1.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../../src/gate/run-guard.js';
import { dryRunTwin, commandSha, dryRunRecord } from '../../src/gate/dry-run.js';
import { writeGrant } from '../../src/handoff/grant.js';
import { createStreamCollector } from '../../src/handoff/stream.js';
import { runDir, checkout, home, qh, tmp, VARS, ENV, grantWith, bash, pwsh, K8S_STG, ARGO_STG, PIN_STG, denied } from './guard-fixture.js';

const GUARD = fileURLToPath(new URL('../../bin/quill-guard.js', import.meta.url));
const LEDGER = path.join(runDir, 'ledger.jsonl');
const K8S_PIN_TEXT = 'kubectl --context stg scale deployment/api --replicas=3';
const K8S_TWIN = 'kubectl --context stg scale deployment/api --replicas=3 --dry-run=server';
const K8S_PIN = { scope: 'k8s.write:stg', pin: K8S_PIN_TEXT };
const DB_STG = { name: 'db.write', target: 'db-stg', matchers: { bash: ['psql *'], mcp: [], hosts: [] }, fingerprint: 'f-db' };
const SQL_PIN_TEXT = 'psql -h db-stg -d app -c "UPDATE accounts SET tier = \'gold\' WHERE id = 7"';
const SQL_TWIN = 'psql -h db-stg -d app -c "EXPLAIN UPDATE accounts SET tier = \'gold\' WHERE id = 7"';
const SQL_PIN = { scope: 'db.write:db-stg', pin: SQL_PIN_TEXT };

const k8sGrant = (over = {}) => grantWith({ scopes: [K8S_STG], actionPins: [K8S_PIN], requireDryRun: true, ...over });
const dbGrant = (over = {}) => grantWith({ scopes: [DB_STG], actionPins: [SQL_PIN], requireDryRun: true, ...over });
const ledger = (...lines) => fs.writeFileSync(LEDGER, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
// What the guard hook writes for an allowed twin, and what the stream collector writes for its result.
const guardLine = (command, id, decision = 'allow') => ({ kind: 'guard', ts: '2026-10-21T10:00:00Z', tool_name: 'Bash', tool_use_id: id, decision, argv_sha: commandSha(bash(command)) });
const result = (id, exit_code) => ({ t: '2026-10-21T10:00:01Z', kind: 'tool_result', tool: 'Bash', tool_use_id: id, is_error: exit_code !== 0, exit_code });
const REQUIRED = (twin) => new RegExp(`^QUILL_DENIED dry-run-required: run ${twin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} first`);

beforeEach(() => fs.rmSync(LEDGER, { force: true }));

test('the twin of a kubectl write adds --dry-run=server, replacing any other --dry-run, before a --', () => {
  assert.equal(dryRunTwin(bash(K8S_PIN_TEXT)).text, K8S_TWIN);
  assert.equal(dryRunTwin(bash('kubectl --context stg delete pod api-1 --dry-run=none')).text, 'kubectl --context stg delete pod api-1 --dry-run=server');
  assert.equal(dryRunTwin(bash("kubectl --context stg patch deploy api -p '{\"spec\":{\"replicas\":2}}'")).text, 'kubectl --context stg patch deploy api -p \'{"spec":{"replicas":2}}\' --dry-run=server');
  assert.equal(dryRunTwin(bash('kubectl --context stg run tmp --image=busybox -- sh')).text, 'kubectl --context stg run tmp --image=busybox --dry-run=server -- sh');
  assert.equal(dryRunTwin(pwsh(K8S_PIN_TEXT)).text, K8S_TWIN);
});

test('the twin of a psql statement is the same connection with EXPLAIN before its one -c statement', () => {
  assert.equal(dryRunTwin(bash(SQL_PIN_TEXT)).text, SQL_TWIN);
  assert.equal(dryRunTwin(bash('psql -h db-stg --command=DELETE\\ FROM\\ jobs')).text, 'psql -h db-stg "--command=EXPLAIN DELETE FROM jobs"');
});

test('a pin has no twin when kubectl cannot dry-run the verb, EXPLAIN cannot take the statement, or the tool has no rule', () => {
  for (const command of [
    'kubectl --context stg rollout restart deployment/api', // the guard does not read its dry run as a read
    'kubectl --context stg exec api-1 -- rm -rf /data',
    'psql -h db-stg -c "UPDATE a SET x = 1; DELETE FROM b"', // the second statement is not explained
    'psql -h db-stg -c "UPDATE a SET x = 1" -c "UPDATE b SET y = 2"',
    'psql -h db-stg -c "DROP TABLE a"',
    'helm --kube-context stg upgrade api ./chart',
    'mysql -h db-stg -e "UPDATE a SET x = 1"',
    'argocd app sync pay-stg',
  ]) assert.equal(dryRunTwin(bash(command)), null, command);
});

test('a pinned kubectl write is refused until its twin ran, and the refusal names the twin', () => {
  const r = decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, REQUIRED(K8S_TWIN));
  assert.match(r.reason, /with the Bash tool/);
  assert.equal(r.criticalChange, undefined, 'it is not a new critical change');
});

test('the twin itself passes the guard as a read in the pinned run, and a twin with exit 0 allows the pin', () => {
  assert.equal(decide(bash(K8S_TWIN), k8sGrant(), ENV).decision, 'allow');
  ledger(guardLine(K8S_TWIN, 'toolu_1'), result('toolu_1', 0));
  const r = decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV);
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.reason, 'allowed by the approved action pin');
});

test('a twin that failed, has no exit code, or failed after passing does not allow the pin', () => {
  ledger(guardLine(K8S_TWIN, 'toolu_1'), result('toolu_1', 1));
  assert.match(decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV).reason, /\(its last run exited 1\)/);
  ledger(guardLine(K8S_TWIN, 'toolu_1'), result('toolu_1', null));
  assert.match(decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV).reason, /no recorded exit code/);
  ledger(guardLine(K8S_TWIN, 'toolu_1'), result('toolu_1', 0), guardLine(K8S_TWIN, 'toolu_2'), result('toolu_2', 1));
  assert.match(decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV).reason, REQUIRED(K8S_TWIN));
  ledger(guardLine(K8S_TWIN, 'toolu_1'), result('toolu_1', 1), guardLine(K8S_TWIN, 'toolu_2'), result('toolu_2', 0));
  assert.equal(decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV).decision, 'allow');
});

test('only an allowed guard line for the exact server twin, followed by its own result, counts', () => {
  const cases = [
    [guardLine(K8S_TWIN.replace('server', 'client'), 't1'), result('t1', 0)], // a client dry run never counts
    [guardLine('kubectl --context stg scale deployment/api --replicas=4 --dry-run=server', 't1'), result('t1', 0)],
    [guardLine(K8S_TWIN, 't1', 'deny'), result('t1', 0)],
    [result('t1', 0), guardLine(K8S_TWIN, 't1')], // a result before the guard line is not its result
    [guardLine(K8S_TWIN, 't1'), result('t2', 0)],
    [{ ...guardLine(K8S_TWIN, 't1'), tool_use_id: undefined }, result('t1', 0)],
    [{ ...guardLine(K8S_TWIN, 't1'), kind: 'tool_use' }, result('t1', 0)],
  ];
  for (const lines of cases) {
    ledger(...lines);
    const r = decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV);
    assert.equal(r.decision, 'deny', JSON.stringify(lines));
    assert.match(r.reason, REQUIRED(K8S_TWIN));
  }
});

test('a pinned psql statement needs its EXPLAIN twin; the twin is a read', () => {
  assert.match(decide(bash(SQL_PIN_TEXT), dbGrant(), ENV).reason, REQUIRED(SQL_TWIN));
  assert.equal(decide(bash(SQL_TWIN), dbGrant(), ENV).decision, 'allow');
  ledger(guardLine(SQL_TWIN, 'toolu_9'), result('toolu_9', 0));
  assert.equal(decide(bash(SQL_PIN_TEXT), dbGrant(), ENV).decision, 'allow');
  // EXPLAIN ANALYZE runs the statement, so it is not a twin and is still a write the pin refuses
  assert.notEqual(decide(bash(SQL_TWIN.replace('EXPLAIN', 'EXPLAIN ANALYZE')), dbGrant(), ENV).decision, 'allow');
});

test('a pinned k8s or db write with no twin is refused while require_dry_run is on', () => {
  const pin = 'kubectl --context stg rollout restart deployment/api';
  const r = decide(bash(pin), k8sGrant({ actionPins: [{ scope: 'k8s.write:stg', pin }] }), ENV);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, denied('dry-run-required'));
  assert.match(r.reason, /has none the guard accepts/);
});

test('without requireDryRun in the grant, and for pins outside k8s and db, the 1.1 decision stands', () => {
  for (const over of [{ requireDryRun: false }, { requireDryRun: undefined }, { requireDryRun: 'true' }]) {
    assert.equal(decide(bash(K8S_PIN_TEXT), k8sGrant(over), ENV).decision, 'allow', JSON.stringify(over));
  }
  const argo = grantWith({ scopes: [ARGO_STG], actionPins: [PIN_STG], requireDryRun: true });
  assert.equal(decide(bash(PIN_STG.pin), argo, ENV).decision, 'allow');
  // a scoped run without pins (a manual scope grant) is not a critical run: no preflight
  assert.equal(decide(bash(K8S_PIN_TEXT), grantWith({ scopes: [K8S_STG], requireDryRun: true }), ENV).decision, 'allow');
});

test('the preflight never allows what the 1.1 guard refuses', () => {
  ledger(guardLine(K8S_TWIN, 'toolu_1'), result('toolu_1', 0));
  // another write in the pinned scope, the pin with an extra option, and the pin without its scope
  for (const [command, grant] of [
    ['kubectl --context stg scale deployment/web --replicas=3', k8sGrant()],
    [`${K8S_PIN_TEXT} --force`, k8sGrant()],
    [K8S_PIN_TEXT, k8sGrant({ scopes: [] })],
  ]) {
    const r = decide(bash(command), grant, ENV);
    assert.equal(r.decision, 'deny', command);
    assert.match(r.reason, /^QUILL_CRITICAL_CHANGE /);
  }
});

test('an unreadable ledger refuses the pinned write', () => {
  fs.mkdirSync(LEDGER);
  try {
    assert.match(decide(bash(K8S_PIN_TEXT), k8sGrant(), ENV).reason, REQUIRED(K8S_TWIN));
  } finally { fs.rmSync(LEDGER, { recursive: true, force: true }); }
});

test('dryRunRecord skips lines that do not parse', () => {
  const sha = commandSha(bash(K8S_TWIN));
  const text = `not json\n${JSON.stringify(guardLine(K8S_TWIN, 'a'))}\n{"kind":\n${JSON.stringify(result('a', 0))}\n`;
  assert.deepEqual(dryRunRecord(text, sha), { ran: true, exitCode: 0 });
  assert.deepEqual(dryRunRecord('', sha), { ran: false, exitCode: undefined });
});

// The real hook and the real stream collector writing the same ledger, as in a run.
test('end to end: the guard hook records the twin by argv_sha, the stream records its exit 0, and the hook then allows the pin', () => {
  const id = 'run-preflight';
  const dir = path.join(qh, 'handoffs', 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const grant = { ...k8sGrant(), readableRoots: [checkout, dir, tmp], writableRoots: [dir, tmp] };
  const { sha256 } = writeGrant(dir, grant);
  const env = { ...process.env, ...VARS, QUILL_HANDOFF_ID: id, QUILL_HANDOFF_GRANT_SHA256: sha256 };
  delete env.NODE_ENV;
  const hook = (command, toolUseId) => {
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId, cwd: checkout }), env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput;
  };
  assert.equal(hook(K8S_PIN_TEXT, 'toolu_a').permissionDecision, 'deny');
  assert.equal(hook(K8S_TWIN, 'toolu_b').permissionDecision, 'allow');
  const lines = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[1].argv_sha, commandSha(bash(K8S_TWIN)));
  const stream = createStreamCollector({ ledgerPath: path.join(dir, 'ledger.jsonl') });
  stream.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: K8S_TWIN } }] } })}\n`);
  stream.push(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'deployment.apps/api scaled (server dry run)', is_error: false }] }, tool_use_result: { stdout: 'ok', stderr: '', interrupted: false } })}\n`);
  stream.end();
  const pin = hook(K8S_PIN_TEXT, 'toolu_c');
  assert.equal(pin.permissionDecision, 'allow', pin.permissionDecisionReason);
  assert.ok(home);
});
