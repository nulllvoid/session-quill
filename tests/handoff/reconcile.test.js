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

// Lines in the shape bin/quill-guard.js writes (task 8): tool_name, decision, and in observe mode
// enforce_decision. Only decision 'deny' is a refusal: observe mode (full access) refuses nothing.
const guardLine = (over) => ({ kind: 'guard', ts: '2026-10-13T00:00:00.000Z', tool_name: 'Bash', class: 'local', input_excerpt: '{}', ...over });

test('guard lines: only decision deny is a refusal, never allow or an observe-mode enforce_decision', () => {
  const ledger = [
    use('Bash', 'kubectl get pods'),
    guardLine({ decision: 'allow', reason: 'allowed: no command reaches prod', input_summary: 'kubectl get pods', tool_use_id: 't1' }),
    use('Bash', 'kubectl delete pod x'),
    guardLine({ decision: 'allow', reason: 'full access (observe only): x', enforce_decision: 'deny', enforce_reason: 'QUILL_CRITICAL_CHANGE scope=k8s.write target=prod: x', input_summary: 'kubectl delete pod x', tool_use_id: 't2' }),
    use('Bash', 'git push --force'),
    guardLine({ decision: 'deny', reason: 'QUILL_DENIED protected-branch: x', input_summary: 'git push --force', tool_use_id: 't3' }),
    guardLine({ tool_name: 'mcp__jira__edit', decision: 'deny', reason: 'QUILL_CRITICAL_CHANGE scope=jira.write target=unknown: x', input_summary: '{}', tool_use_id: 't4' }),
  ];
  const { attempts, added } = reconcileAttempts([
    { route: 'jira', tool: 'mcp__jira__edit', target: 'X-1', outcome: 'refused' },
    { route: 'push', tool: 'git', target: 'origin', outcome: 'refused' },
  ], ledger);
  assert.deepEqual(attempts.map((a) => a.verified), ['seen', 'seen'], 'tool_name and the shell binary from the guard line count as calls');
  assert.deepEqual(added, []);
  const { added: unreported } = reconcileAttempts([], ledger);
  assert.deepEqual(unreported.map((a) => [a.tool, a.target, a.reason]), [['Bash', 'git push --force', 'blocked by the Quill guard'], ['mcp__jira__edit', '{}', 'blocked by the Quill guard']]);
});

test('the guard line and the stream lines of one refused call are one refusal, matched by tool_use_id', () => {
  const ledger = [
    { kind: 'tool_use', tool: 'Write', input_summary: 'src/a.js', tool_use_id: 't9' },
    guardLine({ tool_name: 'Write', decision: 'deny', reason: 'QUILL_DENIED no-edit-permission: x', input_summary: 'C:/work/src/a.js', tool_use_id: 't9' }),
    { kind: 'guard', tool: 'Write', input_summary: 'src/a.js', decision: 'deny', is_error: true, tool_use_id: 't9' },
    { kind: 'denial', tool: 'Write', input_summary: 'src/a.js', decision: 'deny', tool_use_id: 't9' },
    // an older line without tool_use_id still dedupes by tool and summary
    { kind: 'guard', tool: 'Bash', input_summary: 'rm -rf build', decision: 'deny', is_error: true },
    { kind: 'denial', tool: 'Bash', input_summary: 'rm -rf build', decision: 'deny' },
  ];
  const { added } = reconcileAttempts([], ledger);
  assert.deepEqual(added.map((a) => a.tool), ['Write', 'Bash']);
});
