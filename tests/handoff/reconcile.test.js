import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAttempts } from '../../src/handoff/reconcile.js';

const use = (tool, input_summary) => ({ kind: 'tool_use', tool, input_summary });

test('an attempt whose tool appears in the ledger is seen; one with no call is claimed-no-call', () => {
  const ledger = [use('Bash', 'kubectl get pods -n prod'), use('mcp__datadog__query', '{}')];
  const { attempts, added } = reconcileAttempts([
    { route: 'cluster', tool: 'kubectl', target: 'pods', outcome: 'worked', reason: '', evidence: '' },
    { route: 'metrics', tool: 'mcp__datadog__query', target: 'cpu', outcome: 'worked', reason: '', evidence: '' },
    { route: 'logs', tool: 'splunk', target: 'errors', outcome: 'worked', reason: '', evidence: '' },
  ], ledger);
  assert.deepEqual(attempts.map((a) => a.verified), ['seen', 'seen', 'claimed-no-call']);
  assert.deepEqual(added, []);
});

test('binaries are matched inside chained shell commands, ignoring paths and .exe', () => {
  const ledger = [use('Bash', 'cd /srv && C:\\tools\\gh.exe pr list | head')];
  const { attempts } = reconcileAttempts([{ route: 'prs', tool: 'gh', target: '', outcome: 'worked' }, { route: 'x', tool: 'cd', target: '', outcome: 'worked' }, { route: 'y', tool: 'Bash', target: '', outcome: 'worked' }], ledger);
  assert.deepEqual(attempts.map((a) => a.verified), ['seen', 'seen', 'seen']);
});

test('a ledger denial the agent did not report is added as a refused attempt', () => {
  const ledger = [
    use('Bash', 'kubectl delete pod x'),
    { kind: 'denial', tool: 'Bash', input_summary: 'kubectl delete pod x', decision: 'deny', outcome: 'listed in permission_denials' },
    { kind: 'guard', tool: 'Bash', input_summary: 'kubectl delete pod x', decision: 'deny', is_error: true },
    { kind: 'denial', tool: 'mcp__jira__edit', input_summary: '{}', decision: 'deny' },
  ];
  const { attempts, added } = reconcileAttempts([{ route: 'pods', tool: 'kubectl', target: 'x', outcome: 'refused', reason: 'denied' }], ledger);
  assert.equal(attempts[0].verified, 'seen');
  assert.equal(added.length, 1, 'only the denial the agent did not report; guard and denial of one call are one entry');
  assert.equal(added[0].tool, 'mcp__jira__edit');
  assert.equal(added[0].outcome, 'refused');
  assert.equal(added[0].added, true);
});

test('tolerates missing input', () => {
  assert.deepEqual(reconcileAttempts(undefined, undefined), { attempts: [], added: [] });
  assert.equal(reconcileAttempts([{ route: 'r', tool: '', outcome: 'skipped' }], []).attempts[0].verified, 'unverifiable');
});
