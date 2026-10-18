import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinAction, pinMatches, pinOfChange } from '../../src/handoff/action-pin.js';
import { canonicalJson } from '../../src/handoff/grant.js';

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const JIRA = 'mcp__atlassian__transitionJiraIssue';

test('argocd: a pin with --prune does not match the same sync without it; flag order is free', () => {
  const pin = pinAction({ tool: 'Bash', action: 'argocd app sync pay-stg --prune' });
  assert.equal(pin.kind, 'bash');
  assert.deepEqual([pin.binary, pin.verb, pin.resource, pin.flags], ['argocd', 'app sync', 'pay-stg', ['--prune']]);
  assert.equal(pinMatches(pin, bash('argocd app sync pay-stg')), false);
  assert.equal(pinMatches(pin, bash('argocd app sync --prune pay-stg')), true);
  assert.equal(pinMatches(pin, bash('argocd app sync pay-prod --prune')), false, 'the app must match exactly');
  const bare = pinAction({ tool: 'Bash', action: 'argocd app sync pay-stg' });
  assert.notEqual(bare.normalized, pin.normalized);
});

test('kubectl: options before or after the verb normalise to the same pin', () => {
  const pin = pinAction({ tool: 'Bash', action: 'kubectl --context stg -n pay rollout restart deploy/api' });
  assert.deepEqual([pin.binary, pin.verb, pin.resource, pin.context, pin.namespace], ['kubectl', 'rollout restart', 'deploy/api', 'stg', 'pay']);
  assert.equal(pinMatches(pin, bash('kubectl rollout restart deploy/api -n pay --context stg')), true);
  assert.equal(pinMatches(pin, bash('kubectl rollout restart deploy/api --namespace=pay --context=stg')), true);
  assert.equal(pinMatches(pin, bash('kubectl rollout restart deploy/api -n pay --context prod')), false, 'context must match exactly');
  assert.equal(pinMatches(pin, bash('kubectl rollout restart deploy/api -n other --context stg')), false, 'namespace must match exactly');
  assert.equal(pinMatches(pin, bash('kubectl rollout restart deploy/web -n pay --context stg')), false);
  assert.equal(pinMatches(pin, bash('kubectl rollout undo deploy/api -n pay --context stg')), false);
});

test('free-form values are kept exact and repeated options keep their order', () => {
  const pin = pinAction({ tool: 'Bash', action: 'kubectl --context stg set image deploy/api api=reg/api:1.2.3' });
  assert.equal(pinMatches(pin, bash('kubectl --context stg set image deploy/api api=reg/api:1.2.4')), false);
  const helm = pinAction({ tool: 'Bash', action: 'helm upgrade pay ./chart --kube-context stg --set a=1 --set a=2' });
  assert.equal(pinMatches(helm, bash('helm upgrade pay ./chart --set a=1 --kube-context stg --set a=2')), true);
  assert.equal(pinMatches(helm, bash('helm upgrade pay ./chart --kube-context stg --set a=2 --set a=1')), false);
});

test('a tool or option the tables do not know keeps its exact word order', () => {
  const pin = pinAction({ tool: 'Bash', action: 'mytool --x 1 deploy prod' });
  assert.equal(pin.binary, 'mytool');
  assert.equal(pinMatches(pin, bash('mytool --x 1 deploy prod')), true);
  assert.equal(pinMatches(pin, bash("mytool --x '1' deploy prod")), true, 'quoting aside');
  assert.equal(pinMatches(pin, bash('mytool deploy prod --x 1')), false);
  const unknownOpt = pinAction({ tool: 'Bash', action: 'kubectl --context stg --kubeconfig /x rollout restart deploy/api' });
  assert.equal(pinMatches(unknownOpt, bash('kubectl rollout restart deploy/api --context stg --kubeconfig /x')), false);
});

test('a pin is one plain command: env prefixes, wrappers, chains and paths pin nothing and match nothing', () => {
  for (const action of ['KUBECONFIG=/rw kubectl --context stg rollout restart deploy/api', 'sudo kubectl --context stg rollout restart deploy/api', 'env A=1 kubectl --context stg rollout restart deploy/api', 'bash -c "kubectl --context stg rollout restart deploy/api"', 'kubectl --context stg rollout restart deploy/api && kubectl --context prod rollout restart deploy/api', 'kubectl --context stg rollout restart deploy/api > out.txt', '/usr/bin/kubectl --context stg rollout restart deploy/api', 'kubectl --context $CTX rollout restart deploy/api', '', '   ']) {
    assert.equal(pinAction({ tool: 'Bash', action }), null, action);
  }
  const pin = pinAction({ tool: 'Bash', action: 'kubectl --context stg rollout restart deploy/api' });
  for (const command of ['KUBECONFIG=/rw kubectl --context stg rollout restart deploy/api', 'sudo kubectl --context stg rollout restart deploy/api', 'kubectl --context stg rollout restart deploy/api; echo done', 'timeout 5 kubectl --context stg rollout restart deploy/api']) {
    assert.equal(pinMatches(pin, bash(command)), false, command);
  }
  assert.equal(pinMatches(null, bash('kubectl --context stg rollout restart deploy/api')), false);
  assert.equal(pinMatches(pin, { tool_name: 'Bash', tool_input: {} }), false);
});

test('the guard form is the exact command as written (R40)', () => {
  const pin = pinAction({ tool: 'Bash', action: '  kubectl --context stg -n pay rollout restart deploy/api  ' });
  assert.equal(pin.guard, 'kubectl --context stg -n pay rollout restart deploy/api');
});

test('MCP: transitionJiraIssue pins the issue id; the whole input must match, in any key order', () => {
  const pin = pinAction({ tool: JIRA, action: { issueIdOrKey: 'PMO-1', transition: 'Done' } });
  assert.equal(pin.kind, 'mcp');
  assert.equal(pin.tool_name, JIRA);
  assert.deepEqual(pin.ids, { issueIdOrKey: 'PMO-1' });
  assert.equal(pin.guard, `${JIRA} ${canonicalJson({ issueIdOrKey: 'PMO-1', transition: 'Done' })}`);
  assert.equal(pinMatches(pin, { tool_name: JIRA, tool_input: { transition: 'Done', issueIdOrKey: 'PMO-1' } }), true);
  assert.equal(pinMatches(pin, { tool_name: JIRA, tool_input: { issueIdOrKey: 'PMO-2', transition: 'Done' } }), false);
  assert.equal(pinMatches(pin, { tool_name: JIRA, tool_input: { issueIdOrKey: 'PMO-1', transition: 'Closed' } }), false);
  assert.equal(pinMatches(pin, { tool_name: 'mcp__atlassian__editJiraIssue', tool_input: { issueIdOrKey: 'PMO-1', transition: 'Done' } }), false);
  assert.equal(pinMatches(pin, bash('kubectl get pods')), false);
  // A JSON text input pins the same as the object.
  assert.equal(pinAction({ tool: JIRA, action: '{"transition":"Done","issueIdOrKey":"PMO-1"}' }).normalized, pin.normalized);
});

test('pinOfChange reads a critical_changes entry: a tool call as `<tool> <JSON>`, otherwise a shell command', () => {
  const mcp = pinOfChange({ action: `${JIRA} {"issueIdOrKey":"PMO-1","transition":"Done"}` });
  assert.equal(mcp.kind, 'mcp');
  assert.deepEqual(mcp.ids, { issueIdOrKey: 'PMO-1' });
  const sh = pinOfChange({ action: 'argocd app sync pay-stg --prune' });
  assert.equal(sh.kind, 'bash');
  assert.equal(pinOfChange({ action: 'Please sync the app; then restart the pods' }), null);
  assert.equal(pinOfChange({ action: `${JIRA} not json` }), null);
  assert.equal(pinOfChange({}), null);
  assert.equal(pinOfChange(null), null);
});

// M8: frozen normalised and guard forms. A change here changes what earlier proposals pinned:
// update these only on purpose, with a note on what happens to proposals already made.
test('golden: normalized and guard forms of the brief\'s examples are frozen', () => {
  const golden = [
    ['Bash', 'argocd app sync pay-stg --prune', '{"args":["pay-stg"],"binary":"argocd","context":null,"flags":["--prune"],"kind":"bash","namespace":null,"values":[],"verb":"app sync"}', 'argocd app sync pay-stg --prune'],
    ['Bash', 'argocd app sync pay-stg', '{"args":["pay-stg"],"binary":"argocd","context":null,"flags":[],"kind":"bash","namespace":null,"values":[],"verb":"app sync"}', 'argocd app sync pay-stg'],
    ['Bash', 'kubectl --context stg -n pay rollout restart deploy/api', '{"args":["deploy/api"],"binary":"kubectl","context":"stg","flags":[],"kind":"bash","namespace":"pay","values":[],"verb":"rollout restart"}', 'kubectl --context stg -n pay rollout restart deploy/api'],
    ['Bash', 'kubectl rollout restart deploy/api -n pay --context stg', '{"args":["deploy/api"],"binary":"kubectl","context":"stg","flags":[],"kind":"bash","namespace":"pay","values":[],"verb":"rollout restart"}', 'kubectl rollout restart deploy/api -n pay --context stg'],
    ['Bash', 'mytool --x 1 deploy prod', '{"binary":"mytool","exact":["--x","1","deploy","prod"],"kind":"bash"}', 'mytool --x 1 deploy prod'],
    [JIRA, { issueIdOrKey: 'PMO-1', transition: 'Done' }, '{"input":{"issueIdOrKey":"PMO-1","transition":"Done"},"kind":"mcp","tool_name":"mcp__atlassian__transitionJiraIssue"}', 'mcp__atlassian__transitionJiraIssue {"issueIdOrKey":"PMO-1","transition":"Done"}'],
  ];
  for (const [tool, action, normalized, guard] of golden) {
    const pin = pinAction({ tool, action });
    assert.deepEqual([pin.normalized, pin.guard], [normalized, guard], String(action));
  }
});

test('an action with a control, format or bidi character is never pinned (nothing is stripped)', () => {
  const hidden = [0x07, 0x200b, 0x200e, 0x202e, 0x2066, 0xfeff, 0xad, 0x61c, 0x2028, 0x85].map((c) => String.fromCodePoint(c));
  for (const ch of hidden) {
    const code = ch.codePointAt(0).toString(16);
    assert.equal(pinAction({ tool: 'Bash', action: `kubectl --context stg rollout restart 'deploy/api${ch}'` }), null, `shell U+${code}`);
    assert.equal(pinAction({ tool: JIRA, action: { issueIdOrKey: `PMO-1${ch}`, transition: 'Done' } }), null, `mcp value U+${code}`);
    assert.equal(pinAction({ tool: JIRA, action: { [`issue${ch}`]: 'PMO-1' } }), null, `mcp key U+${code}`);
    assert.equal(pinOfChange({ action: `${JIRA} {"issueIdOrKey":"PMO-1\\u${code.padStart(4, '0')}"}` }), null, `escaped in JSON U+${code}`);
  }
  // ANSI-C quoting can spell a hidden character with plain ASCII.
  assert.equal(pinAction({ tool: 'Bash', action: "kubectl --context stg rollout restart $'deploy/api\\u202e'" }), null);
});

test('pins carry the target the scope binds: context, Argo app, host or the identifying MCP argument', () => {
  assert.equal(pinAction({ tool: 'Bash', action: 'kubectl --context stg -n pay rollout restart deploy/api' }).target, 'stg');
  assert.equal(pinAction({ tool: 'Bash', action: 'helm upgrade pay ./chart --kube-context stg' }).target, 'stg');
  assert.equal(pinAction({ tool: 'Bash', action: 'argocd app sync pay-stg --prune' }).target, 'pay-stg');
  assert.equal(pinAction({ tool: 'Bash', action: 'curl -X POST https://Hooks.Example.com/x' }).target, 'hooks.example.com');
  assert.equal(pinAction({ tool: 'Bash', action: 'mytool deploy prod' }).target, undefined, 'an exact pin names no target the tables can read');
});
