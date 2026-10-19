import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedStage } from '../../src/handoff/stage.js';

test('recordedStage follows worker-observed facts, highest first', () => {
  assert.equal(recordedStage({}), 'investigated');
  assert.equal(recordedStage({ test_gate: { status: 'skipped' } }), 'investigated');
  assert.equal(recordedStage({ test_gate: { status: 'failed' } }), 'investigated');
  assert.equal(recordedStage({ test_gate: { status: 'passed' } }), 'tested');
  assert.equal(recordedStage({ test_gate: { status: 'passed' }, commit_sha: 'abc' }), 'committed');
  assert.equal(recordedStage({ commit_sha: 'abc' }), 'committed');
  assert.equal(recordedStage({ commit_sha: 'abc', pushed_branch: 'quill/x' }), 'pushed');
  assert.equal(recordedStage({ branch: 'quill/x' }), 'investigated', 'a requested branch is not a push');
  assert.equal(recordedStage({ commit_sha: 'abc', pushed_branch: 'quill/x', pr_url: 'https://x/pr/1' }), 'pr_opened');
  assert.equal(recordedStage(null), 'investigated');
});
