// The guard decides each tool call of an autonomous run against its grant. This file runs the
// decision rows (guard-rows-basic.js, guard-rows-shell.js) and the checks over all of them;
// run-guard-paths.test.js covers links, wildcards and directories on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../../src/gate/run-guard.js';
import { writeGrant, readGrant } from '../../src/handoff/grant.js';
import {
  dir, runDir, checkout, ENV, PUSH, PR, grantWith, bash, call, K8S_STG, ARGO, JIRA, PIN,
  CRITICAL_TAIL, denied, skipOn, FULL, run
} from './guard-fixture.js';
import { BASIC_ROWS } from './guard-rows-basic.js';
import { SHELL_ROWS } from './guard-rows-shell.js';

const ROWS = [...BASIC_ROWS, ...SHELL_ROWS];

for (const row of ROWS) {
  const [name, c, opts, expected] = row;
  test(name, { skip: skipOn(opts) }, () => {
    const r = run(c, opts);
    assert.ok(r.classification && typeof r.classification.class === 'string', 'returns the classification');
    if (expected === 'allow') {
      assert.equal(r.decision, 'allow', r.reason);
    } else {
      assert.equal(r.decision, 'deny', `expected a deny, got allow: ${r.reason}`);
      assert.match(r.reason, expected);
    }
    if (row.length > 4) assert.deepEqual(r.criticalChange, row[4]);
  });
}

test('deny reasons tell the agent what to do instead', () => {
  for (const [name, c, opts, expected] of ROWS) {
    if (expected === 'allow' || skipOn(opts)) continue;
    const { reason } = run(c, opts);
    assert.match(reason, /^QUILL_(DENIED [a-z-]+|CRITICAL_CHANGE scope=\S+ target=\S*): \S/, name);
    assert.ok(reason.length > 90, `${name}: reason too short to act on: ${reason}`);
    if (reason.startsWith('QUILL_CRITICAL_CHANGE')) assert.ok(reason.endsWith(CRITICAL_TAIL), `${name}: ${reason}`);
  }
  assert.match(run(bash('$CMD apply'), {}).reason, /rewrite it as one plain command without variables, eval, wrappers or globs in write targets/);
});

test('a critical change names the scope and target in both the reason and the result', () => {
  const r = run(bash('argocd app sync pay-prod'), { grant: { actionPins: [PIN] } });
  assert.ok(r.reason.startsWith('QUILL_CRITICAL_CHANGE scope=argo.sync target=pay-prod: '), r.reason);
  assert.deepEqual(r.criticalChange, { scope: 'argo.sync', target: 'pay-prod' });
});

test('a tampered or missing grant allows only local calls that touch no files', () => {
  const grantDir = dir('tamper', 'run1');
  const { path: grantFile, sha256 } = writeGrant(grantDir, grantWith({ permissions: PR, scopes: [K8S_STG] }));
  fs.writeFileSync(grantFile, fs.readFileSync(grantFile, 'utf8').replace('"stg"', '"prod"'));
  assert.throws(() => readGrant(grantFile, sha256), { code: 'grant-tampered' });
  const cases = [
    [bash('ls'), 'allow'],
    [bash('git status'), 'allow'],
    [bash('kubectl get pods'), 'deny'],
    [bash('kubectl --context stg apply -f x.yaml'), 'deny'],
    [bash('echo hi > out.txt'), 'deny'],
    [bash('cat src/app.js'), 'deny'],
    [call('Read', { file_path: path.join(checkout, 'src', 'app.js') }), 'deny'],
    [call('Glob', { pattern: '*.js' }), 'deny'],
    [call('Glob', { pattern: '*.js' }), 'deny', { cwd: undefined }],
    [call('Write', { file_path: path.join(runDir, 'x.txt'), content: 'x' }), 'deny'],
    [call('mcp__claude_ai_Atlassian__getJiraIssue', { issueIdOrKey: 'PMO-1' }, { mcp_server_source: 'claudeai' }), 'deny'],
    [bash('kubectl apply -f x.yaml'), 'deny', FULL.env],
  ];
  for (const [c, want, envOver] of cases) {
    const r = decide(c, null, { ...ENV, ...(envOver ?? {}) });
    assert.equal(r.decision, want, `${JSON.stringify(c)}: ${r.reason}`);
    if (want === 'deny') assert.match(r.reason, denied('grant-tampered'));
  }
});

// A loose regression ceiling; the spec's 5 ms target is asserted serially in
// tests/acceptance/perf.test.js under QUILL_PERF_FULL=1 (rulings R14, R16).
test('decide stays quick on every tool call (M7): p95 under 25 ms', () => {
  const grant = grantWith({ permissions: PUSH, scopes: [K8S_STG, ARGO, JIRA], actionPins: [PIN] });
  const calls = ROWS.map((r) => r[1]);
  // best p95 of three passes, so a busy machine does not fail one pass
  let p95 = Infinity;
  for (let pass = 0; pass < 3 && p95 >= 25; pass += 1) {
    const times = [];
    for (let i = 0; i < 1000; i += 1) {
      const t0 = process.hrtime.bigint();
      decide(calls[i % calls.length], grant, ENV);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    p95 = Math.min(p95, times[Math.floor(times.length * 0.95)]);
  }
  assert.ok(p95 < 25, `p95 ${p95.toFixed(3)} ms`);
});

test('onboarding (spec §3, Review Focus 5): a prod CLI read on a system without read-only credentials is refused with the setup hint', () => {
  const none = grantWith({ credentialSystems: [] });
  for (const [cmd, system] of [['kubectl get pods', 'kubernetes'], ['helm list', 'kubernetes'], ['aws s3 ls', 'aws'], ['gcloud compute instances list', 'gcp'], ['az vm list', 'azure'], ['psql -c "select 1"', 'databases'], ['argocd app get pay', 'argo'], ['bash -c "kubectl.exe get pods"', 'kubernetes']]) {
    const r = decide(bash(cmd), none, ENV);
    assert.equal(r.decision, 'deny', cmd);
    assert.ok(r.reason.startsWith(`QUILL_DENIED no-readonly-credentials: no read-only credentials configured for ${system} — set them in [prod.readonly] in config.toml.`), `${cmd}: ${r.reason}`);
    assert.equal(r.reason.includes('quill doctor'), false, 'M4: doctor does not report read-only profiles, so the refusal does not send the agent there');
  }
  assert.equal(decide(bash('kubectl get pods'), grantWith({ credentialSystems: ['kubernetes'] }), ENV).decision, 'allow', 'a read-only profile lets the read through');
  assert.equal(decide(bash('kubectl get pods'), grantWith(), ENV).decision, 'allow', 'a grant without credentialSystems (older grants) is unaffected');
  for (const cmd of ['git log', 'curl https://example.com', 'ls']) assert.equal(decide(bash(cmd), none, ENV).decision, 'allow', cmd);
  const write = decide(bash('kubectl --context stg apply -f x.yaml'), none, ENV);
  assert.ok(write.reason.startsWith('QUILL_CRITICAL_CHANGE scope=k8s.write'), 'a write is still a critical change');
});
