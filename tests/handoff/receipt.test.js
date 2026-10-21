import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, receiptFacts, guardSummary, changeSummary, canonicalJson, publicCommand, RECEIPT_HEADING } from '../../src/handoff/receipt.js';

const S = 'SENTINEL-7f3a';
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const HID = '1a2b3c4d-0000-4000-8000-000000000001';

function state(over = {}, { proposals = [], lastSequence = 812 } = {}) {
  const h = {
    id: HID, ticket_id: 'T1', mode: 'attempt-fix', recipe: { name: 'attempt-fix', source: 'builtin', hash: 'x' }, access: 'autonomous',
    scopes: [`k8s.write:${S}`], worktree_path: `/home/me/${S}/wt`, patch_path: `C:\\Users\\${S}\\x.patch`,
    test_gate: { status: 'passed', command: 'npm test', exit_code: 0, ms: 1100, tail: `ok ${S}`, attempts: 2, repaired: true, runs: [{ status: 'failed', exit_code: 1, ms: 1234 }, { status: 'passed', exit_code: 0, ms: 1100 }] },
    tested_tree: TREE, commit_sha: SHA, commit_tree: TREE,
    guard_summary: { allow: 41, deny: 2, critical: 1, by_class: { read: 30, local: 11, write: 2 } },
    change_summary: { files: 3, config: 1, tests: 1, code: 1, docs: 0, critical_paths: 0 },
    result_summary: `agent says ${S}`, prod_effects: [{ scope: S, target: S }],
    ...over,
  };
  return { handoffs: new Map([[h.id, h]]), runProposals: new Map(proposals.map((p) => [p.id, p])), lastSequence };
}

test('a receipt states the worker-recorded facts in Markdown, ending with Not a deployment', () => {
  const r = buildReceipt(state(), HID);
  const md = r.markdown;
  assert.ok(md.startsWith(`${RECEIPT_HEADING}\n`));
  assert.match(md, /Run `1a2b3c4d` · recipe `attempt-fix` · Autonomous \+ scopes \(1\)/);
  assert.match(md, /`npm test` · attempt 1 exit code 1 in 1\.2 s · attempt 2 exit code 0 in 1\.1 s · Tests passed \(worker\) after one repair turn/);
  assert.match(md, /Tested tree matches commit aaaaaaa\./);
  assert.match(md, /Guard: 41 allowed, 2 refused, 1 critical · by class: local 11, read 30, write 2\./);
  assert.match(md, /Owner approvals: 0\./);
  assert.match(md, /Changes: 3 files · 1 config · tests:code 1:1 · 0 critical-path files\./);
  assert.match(md, new RegExp(`Digest sha256 ${r.sha256} over the run's journaled facts through sequence 812\\.`));
  assert.equal(md.trimEnd().split('\n').pop(), 'Not a deployment.');
  assert.equal(r.through_sequence, 812);
  assert.doesNotMatch(md, /proof/i, 'a digest, never proof');
});

test('determinism: the same state gives the same digest; a changed fact changes it', () => {
  const a = buildReceipt(state(), HID);
  const b = buildReceipt(state(), HID);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.markdown, b.markdown);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  // Fields the receipt does not state (agent text, paths) do not move the digest.
  assert.equal(buildReceipt(state({ result_summary: 'other' }), HID).sha256, a.sha256);
  assert.notEqual(buildReceipt(state({ commit_tree: 'c'.repeat(40) }), HID).sha256, a.sha256);
  // Key order never matters.
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test('the receipt never carries scope names, targets, local paths, test output or agent text', () => {
  const s = state({ test_gate: { status: 'passed', command: `"/home/me/${S}/node" "C:\\Users\\${S}\\gate.js" --out=/tmp/${S}`, exit_code: 0, ms: 5, tail: S, runs: [{ status: 'passed', exit_code: 0, ms: 5 }] } });
  const r = buildReceipt(s, HID);
  assert.equal(r.markdown.includes(S), false, r.markdown);
  assert.match(r.markdown, /<local path>/);
  assert.equal(JSON.stringify(r.facts).includes(`k8s.write`), false, 'scopes are a count in the facts');
});

test('tested tree that differs, no commit, and a run without a passing gate say so', () => {
  assert.match(buildReceipt(state({ commit_tree: 'c'.repeat(40) }), HID).markdown, /Tested tree differs from commit aaaaaaa\./);
  assert.match(buildReceipt(state({ commit_sha: null, commit_tree: null }), HID).markdown, /no commit to compare/);
  const failed = buildReceipt(state({ tested_tree: null, test_gate: { status: 'failed', command: 'npm test', exit_code: 1, ms: 9, attempts: 2, runs: [{ status: 'failed', exit_code: 1, ms: 9 }, { status: 'timeout', exit_code: null, ms: 600000 }] } }), HID).markdown;
  assert.match(failed, /attempt 2 timed out after 600\.0 s · Tests failed/);
  assert.match(failed, /Tested tree: none/);
  assert.match(buildReceipt(state({ test_gate: { status: 'skipped', reason: 'no test_command' } }), HID).markdown, /skipped .*not test-verified/);
  assert.match(buildReceipt(state({ test_gate: null }), HID).markdown, /not run by the worker; not test-verified/);
});

test('access tiers in words; a standard run has no guard; critical paths unconfigured is not zero', () => {
  assert.match(buildReceipt(state({ access: 'standard', scopes: null }), HID).markdown, /Standard access[\s\S]*Guard: not used/);
  assert.match(buildReceipt(state({ access: 'full', scopes: null }), HID).markdown, /Full access[\s\S]*Guard \(observe only/);
  assert.match(buildReceipt(state({ change_summary: { files: 1, config: 0, tests: 0, code: 1, docs: 0, critical_paths: null } }), HID).markdown, /no critical paths configured/);
});

test('owner approvals count the approved proposals that became this run', () => {
  const s = state({}, { proposals: [{ id: 'p1', handoff_id: HID, state: 'approved' }, { id: 'p2', handoff_id: HID, state: 'dismissed' }, { id: 'p3', handoff_id: 'other', state: 'approved' }] });
  assert.equal(receiptFacts(s, HID).approvals, 1);
  assert.match(buildReceipt(s, HID).markdown, /Owner approvals: 1\./);
  assert.equal(buildReceipt(s, 'missing'), null);
});

test('guardSummary counts only the guard hook lines, by decision and class', () => {
  const g = guardSummary([
    { kind: 'guard', decision: 'allow', class: 'read' },
    { kind: 'guard', decision: 'allow', class: 'local' },
    { kind: 'guard', decision: 'deny', class: 'write', critical: true, scope: S, target: S },
    { kind: 'guard', decision: 'deny', class: S },
    { kind: 'denial', decision: 'deny', tool: 'Bash' },
    null,
  ]);
  assert.deepEqual(g, { allow: 2, deny: 2, critical: 1, by_class: { local: 1, other: 1, read: 1, write: 1 } });
  assert.equal(JSON.stringify(g).includes(S), false);
});

test('changeSummary counts config, tests, code, docs and critical paths without keeping paths', () => {
  const files = ['src/a.js', 'src/a.test.js', 'tests/b.js', 'package.json', '.github/workflows/ci.yml', 'docs/x.md', 'src/payments/charge.js'];
  assert.deepEqual(changeSummary(files), { files: 7, config: 2, tests: 2, code: 2, docs: 1, critical_paths: null });
  assert.deepEqual(changeSummary(files, { critical_paths: ['src/payments/**'], config_globs: ['package.json'] }), { files: 7, config: 1, tests: 2, code: 3, docs: 1, critical_paths: 1 });
  assert.equal(changeSummary(['a\\b\\c.toml']).config, 1, 'Windows separators');
});

test('publicCommand keeps relative commands and replaces absolute paths', () => {
  assert.equal(publicCommand('npm test -- --reporter=dot'), 'npm test -- --reporter=dot');
  assert.equal(publicCommand('./scripts/test.sh'), './scripts/test.sh');
  assert.equal(publicCommand('/usr/bin/env node t.js'), '<local path> node t.js');
  assert.equal(publicCommand('"C:\\Program Files\\node.exe" t.js'), '<local path> t.js');
  assert.equal(publicCommand('echo `id`'), "echo 'id'");
});

test('quill receipt is registered, needs a run id, and refuses a short or unknown one', async () => {
  const { makeHome, cli } = await import('../cli/helpers.js');
  const { COMMAND_NAMES } = await import('../../src/cli/main.js');
  assert.ok(COMMAND_NAMES.includes('receipt'));
  const fx = makeHome();
  const none = await cli(['receipt'], fx.env);
  assert.equal(none.code, 1);
  assert.match(none.err, /usage: quill receipt <run-id>/);
  assert.match((await cli(['receipt', 'abc'], fx.env)).err, /at least 8 characters/);
  assert.match((await cli(['receipt', 'abcdef0123'], fx.env)).err, /no run starts with abcdef0123/);
  const inRun = await cli(['receipt', 'abcdef0123'], { ...fx.env, QUILL_HANDOFF_ID: 'x' });
  assert.equal(inRun.code, 2, 'a read the agent does not need stays refused inside a run');
});
