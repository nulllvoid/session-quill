import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, isWithin, INSTALL_ROOT, GUARD_CODE } from '../../src/gate/run-guard.js';
import { writeGrant, readGrant } from '../../src/handoff/grant.js';

// A throwaway machine: home with credentials and Claude settings, a Quill home with memory and
// this run's directory, the run's checkout (a worktree under the Quill home, as the worker makes
// it), a temp dir, an install root with guard code, and somewhere outside every root.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-guard-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const at = (...p) => path.join(base, ...p);
const dir = (...p) => { const d = at(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const file = (...p) => { const f = at(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x\n'); return f; };

const home = dir('home');
file('home', '.aws', 'credentials');
file('home', '.claude', 'settings.json');
const plugins = dir('home', '.claude', 'plugins');
file('home', '.claude', 'plugins', 'p1', 'SKILL.md');
const qh = dir('quill');
file('quill', 'memory', '_quarantine.md');
const runDir = dir('quill', 'handoffs', 'runs', 'run1');
file('quill', 'handoffs', 'runs', 'run1', 'context', 'repo.md');
const checkout = dir('quill', 'handoffs', 'worktrees', 'run1');
file('quill', 'handoffs', 'worktrees', 'run1', 'src', 'app.js');
file('quill', 'handoffs', 'worktrees', 'run1', '.git', 'config');
dir('quill', 'handoffs', 'worktrees', 'run1', '.git', 'hooks');
file('quill', 'handoffs', 'worktrees', 'run1', '.claude', 'settings.json');
const tmp = dir('tmp');
const install = dir('install');
file('install', 'src', 'gate', 'run-guard.js');
file('install', 'src', 'handoff', 'grant.js');
file('install', 'src', 'lib', 'x.js');
const outside = dir('outside');
file('outside', 'secret.txt');

const VARS = { USERPROFILE: home, HOME: home, QUILL_HOME: qh, QUILL_HANDOFF_ID: 'run1', TEMP: tmp, TMP: tmp, TMPDIR: tmp, QUILL_HANDOFF_GUARD: 'enforce' };
const ENV = { cwd: checkout, vars: VARS, currentBranch: 'feat/x', defaultBranch: 'main', installRoot: install };

const RO = { read_source: true };
const EDIT = { read_source: true, edit_source: true };
const COMMIT = { ...EDIT, commit: true };
const PUSH = { ...COMMIT, push_branch: true };
const PR = { ...PUSH, open_draft_pr: true };

function grantWith(over = {}) {
  const edits = !!(over.permissions && over.permissions.edit_source);
  return {
    access: 'autonomous',
    permissions: RO,
    scopes: [],
    actionPins: [],
    readableRoots: [checkout, runDir, path.join(runDir, 'context'), tmp, plugins],
    writableRoots: edits ? [checkout, runDir, tmp] : [runDir, tmp],
    protectedPaths: [path.join(install, 'src', 'gate'), path.join(install, 'bin', 'quill-guard.js'), qh, path.join(home, '.claude'), path.join(home, '.claude.json')],
    mcpPolicy: { read: [], write: {} },
    trustedMcpServers: ['team_docs'],
    trackerHosts: [],
    ...over,
  };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const pwsh = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const call = (tool_name, tool_input, extra = {}) => ({ tool_name, tool_input, ...extra });
const q = (p) => `'${p}'`;

const K8S_STG = { name: 'k8s.write', target: 'stg', matchers: { bash: ['kubectl *', 'helm *'], mcp: [], hosts: [] }, fingerprint: 'f-k8s' };
const ARGO = { name: 'argo.sync', matchers: { bash: ['argocd app *'], mcp: ['mcp__argocd__*'], hosts: [] }, fingerprint: 'f-argo' };
const JIRA = { name: 'jira.write', matchers: { mcp: ['mcp__claude_ai_Atlassian__*'], bash: [], hosts: [] }, fingerprint: 'f-jira' };
const HTTP_API = { name: 'http.write', target: 'api.example.com', matchers: { hosts: ['api.example.com'], bash: [], mcp: [] }, fingerprint: 'f-http' };
const PIN = { scope: 'argo.sync', pin: 'argocd app sync pay-stg' };

const CRITICAL_TAIL = 'Record it in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.';
const denied = (code) => new RegExp(`^QUILL_DENIED ${code}: `);
const critical = (scope, target) => new RegExp(`^QUILL_CRITICAL_CHANGE scope=${scope.replace(/\./g, '\\.')} target=${target === undefined ? '' : target.replace(/\./g, '\\.')}`);

// Install root used as the checkout (Review Focus 2): edits must work, the guard code must not change.
const IN_INSTALL = {
  env: { cwd: install, installRoot: install },
  grant: { permissions: EDIT, readableRoots: [install, runDir, tmp], writableRoots: [install, runDir, tmp], protectedPaths: [] },
};
const FULL = { grant: { access: 'full' }, env: { vars: { ...VARS, QUILL_HANDOFF_GUARD: 'observe' } } };

// [name, call, { grant?, env? }, expected: 'allow' | RegExp for the deny reason, criticalChange?]
// A fifth element, even `undefined`, is compared with the result's criticalChange.
const ROWS = [
  // the brief's rows
  ['kubectl get is a read', bash('kubectl get pods -n pay'), {}, 'allow'],
  ['kubectl apply without a scope is a critical change', bash('kubectl apply -f deploy.yaml'), {}, critical('k8s.write', ''), { scope: 'k8s.write', target: null }],
  ['Read of ~/.aws/credentials', call('Read', { file_path: path.join(home, '.aws', 'credentials') }), {}, denied('outside-readable')],
  ['Read inside the checkout', call('Read', { file_path: path.join(checkout, 'src', 'app.js') }), {}, 'allow'],
  ['Edit inside the checkout without edit_source', call('Edit', { file_path: path.join(checkout, 'src', 'app.js'), old_string: 'x', new_string: 'y' }), {}, denied('no-edit-permission')],
  ['Edit inside the checkout with edit_source', call('Edit', { file_path: path.join(checkout, 'src', 'app.js'), old_string: 'x', new_string: 'y' }), { grant: { permissions: EDIT } }, 'allow'],
  ['Edit of the guard when the checkout is the install root', call('Edit', { file_path: path.join(install, 'src', 'gate', 'run-guard.js'), old_string: 'x', new_string: 'y' }), IN_INSTALL, denied('protected-path')],
  ['Write to quillHome memory', call('Write', { file_path: path.join(qh, 'memory', 'x.md'), content: 'x' }), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['Write to the run dir scratch', call('Write', { file_path: path.join(runDir, 'scratch.txt'), content: 'x' }), {}, 'allow'],
  ['git commit without commit', bash('git commit -m wip'), { grant: { permissions: EDIT } }, denied('no-commit-permission')],
  ['git push to a feature branch with push_branch', bash('git push origin feat/x'), { grant: { permissions: PUSH } }, 'allow'],
  ['git push to main with push_branch', bash('git push origin main'), { grant: { permissions: PUSH } }, denied('protected-branch')],
  ['quill agent run is privileged', bash('quill agent run PMO-1 --recipe fix'), {}, denied('quill-privileged')],
  ['MCP server from the project source, not trusted', call('mcp__repo_db__get_rows', { table: 't' }, { mcp_server_source: 'project' }), {}, denied('untrusted-mcp-server')],
  ['unparseable command', bash('$CMD apply -f x.yaml'), {}, denied('unparseable')],
  ['scope k8s.write:stg covers its own context', bash('kubectl --context stg apply -f x.yaml'), { grant: { scopes: [K8S_STG] } }, 'allow'],
  ['scope k8s.write:stg does not cover prod', bash('kubectl --context prod apply -f x.yaml'), { grant: { scopes: [K8S_STG] } }, critical('k8s.write', 'prod'), { scope: 'k8s.write', target: 'prod' }],
  ['the pinned action is allowed', bash('argocd app sync pay-stg'), { grant: { actionPins: [PIN] } }, 'allow'],
  ['another action in the pinned scope is a critical change', bash('argocd app sync pay-prod'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-prod'), { scope: 'argo.sync', target: 'pay-prod' }],

  // per-run permissions and branches (R2)
  ['git commit with commit', bash('git commit -m wip'), { grant: { permissions: COMMIT } }, 'allow'],
  ['git push without push_branch', bash('git push origin feat/x'), { grant: { permissions: COMMIT } }, denied('no-push-permission')],
  ['bare git push goes to the current branch', bash('git push'), { grant: { permissions: PUSH } }, 'allow'],
  ['bare git push with an unknown branch', bash('git push'), { grant: { permissions: PUSH }, env: { currentBranch: undefined } }, denied('protected-branch')],
  ['git push to the repository default branch', bash('git push origin production'), { grant: { permissions: PUSH }, env: { defaultBranch: 'production' } }, denied('protected-branch')],
  ['force push', bash('git push --force origin feat/x'), { grant: { permissions: PUSH } }, denied('protected-branch')],
  ['draft PR without open_draft_pr', bash('gh pr create --draft --title t --body b'), { grant: { permissions: PUSH } }, denied('no-pr-permission')],
  ['draft PR with open_draft_pr', bash('gh pr create --draft --title t --body b'), { grant: { permissions: PR } }, 'allow'],
  ['a PR that is not a draft', bash('gh pr create --title t --body b'), { grant: { permissions: PR } }, denied('protected-branch')],
  ['read-only quill commands are fine', bash('quill status'), {}, 'allow'],

  // MCP
  ['trusted project MCP server', call('mcp__team_docs__get_page', { id: '1' }, { mcp_server_source: 'project' }), {}, 'allow'],
  ['trusted server named as in .mcp.json', call('mcp__team_wiki__get_page', { id: '1' }, { mcp_server_source: 'project' }), { grant: { trustedMcpServers: ['team.wiki'] } }, 'allow'],
  ['no source given: the server is not checked', call('mcp__repo_db__get_rows', { table: 't' }), {}, 'allow'],
  ['claude.ai connector read', call('mcp__claude_ai_Atlassian__getJiraIssue', { issueIdOrKey: 'PMO-1' }, { mcp_server_source: 'claudeai' }), {}, 'allow'],
  ['the MCP source is checked before the call is', call('mcp__repo_db__delete_rows', {}, { mcp_server_source: 'local' }), { grant: { scopes: [JIRA] } }, denied('untrusted-mcp-server')],
  ['MCP write without a scope', call('mcp__claude_ai_Atlassian__editJiraIssue', { issueIdOrKey: 'PMO-1' }, { mcp_server_source: 'claudeai' }), {}, critical('jira.write', 'PMO-1'), { scope: 'jira.write', target: 'PMO-1' }],
  ['MCP write in a granted scope', call('mcp__claude_ai_Atlassian__editJiraIssue', { issueIdOrKey: 'PMO-1' }, { mcp_server_source: 'claudeai' }), { grant: { scopes: [JIRA] } }, 'allow'],
  ['MCP tool with an unknown verb', call('mcp__warehouse__run_query', { sql: 'select 1' }, { mcp_server_source: 'user' }), {}, denied('unknown-prod')],
  ['pinned MCP action', call('mcp__argocd__sync_application', { applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { actionPins: [{ scope: 'argo.sync', pin: 'mcp__argocd__sync_application pay-stg' }] } }, 'allow'],
  ['MCP action outside the pin', call('mcp__argocd__sync_application', { applicationName: 'pay-prod' }, { mcp_server_source: 'user' }), { grant: { actionPins: [{ scope: 'argo.sync', pin: 'mcp__argocd__sync_application pay-stg' }] } }, critical('argo.sync', 'pay-prod')],

  // classifier edges
  ['empty command', bash('   '), {}, denied('unparseable')],
  ['Bash without tool_input', { tool_name: 'Bash' }, {}, denied('unparseable')],
  ['deploy script', bash('npm run deploy'), {}, denied('unknown-prod')],
  ['WebFetch is a read', call('WebFetch', { url: 'https://example.com/x', prompt: 'p' }), {}, 'allow'],

  // scopes and pins
  ['a scope with no bash matchers does not cover a shell call', bash('kubectl --context stg apply -f x.yaml'), { grant: { scopes: [{ ...K8S_STG, matchers: { mcp: ['mcp__k8s__*'] } }] } }, critical('k8s.write', 'stg')],
  ['a scope with a target does not cover an unknown target', bash('kubectl apply -f x.yaml'), { grant: { scopes: [K8S_STG] } }, critical('k8s.write', '')],
  ['every write in a chain needs cover', bash('kubectl --context stg apply -f x.yaml && kubectl --context prod delete pod api'), { grant: { scopes: [K8S_STG] } }, critical('k8s.write', 'prod')],
  ['a write in another scope is not covered', bash('helm --kube-context stg upgrade api ./chart && argocd app sync pay-stg'), { grant: { scopes: [K8S_STG] } }, critical('argo.sync', 'pay-stg')],
  ['a granted scope without a pin covers other targets', bash('argocd app sync pay-prod'), { grant: { scopes: [ARGO] } }, 'allow'],
  ['a pin narrows a granted scope to its action', bash('argocd app sync pay-prod'), { grant: { scopes: [ARGO], actionPins: [PIN] } }, critical('argo.sync', 'pay-prod')],
  ['extra flags are a different action than the pin', bash('argocd app sync pay-stg --prune'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['the pin must be the whole command', bash('argocd app sync pay-stg && argocd app sync pay-prod'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['an http write without a scope', bash('curl -X POST https://api.example.com/v1/items'), {}, critical('http.write', 'api.example.com'), { scope: 'http.write', target: 'api.example.com' }],
  ['an http write to a granted host', bash('curl -X POST https://api.example.com/v1/items'), { grant: { scopes: [HTTP_API] } }, 'allow'],
  ['an http write to another host', bash('curl -X POST https://api.other.com/v1/items'), { grant: { scopes: [HTTP_API] } }, critical('http.write', 'api.other.com')],

  // readable roots
  ['shell read of credentials', bash('cat ~/.aws/credentials'), {}, denied('outside-readable')],
  ['PowerShell read of credentials', pwsh(`Get-Content ${q(path.join(home, '.aws', 'credentials'))}`), {}, denied('outside-readable')],
  ['copying credentials into the checkout', bash('cp ~/.aws/credentials stolen.txt'), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['relative Read resolves against cwd', call('Read', { file_path: path.join('src', 'app.js') }), {}, 'allow'],
  ['Read of the memory quarantine', call('Read', { file_path: path.join(qh, 'memory', '_quarantine.md') }), {}, denied('outside-readable')],
  ['Read of the run context snapshot', call('Read', { file_path: path.join(runDir, 'context', 'repo.md') }), {}, 'allow'],
  ['Read inside a plugin dir', call('Read', { file_path: path.join(plugins, 'p1', 'SKILL.md') }), {}, 'allow'],
  ['Read of Claude settings next to the plugin dir', call('Read', { file_path: path.join(home, '.claude', 'settings.json') }), {}, denied('outside-readable')],
  ['Grep outside the readable roots', call('Grep', { pattern: 'token', path: home }), {}, denied('outside-readable')],
  ['Glob with an absolute pattern outside the roots', call('Glob', { pattern: `${path.join(home, '.aws').replace(/\\/g, '/')}/*` }), {}, denied('outside-readable')],
  ['Glob with a pattern climbing out of the checkout', call('Glob', { pattern: '../../../../home/.aws/*' }), {}, denied('outside-readable')],
  ['Glob inside the checkout', call('Glob', { pattern: 'src/**/*.js' }), {}, 'allow'],

  // writable roots and protected paths
  ['Write to quillHome even when the grant lists no protected paths', call('Write', { file_path: path.join(qh, 'memory', 'x.md'), content: 'x' }), { grant: { permissions: EDIT, protectedPaths: [] } }, denied('protected-path')],
  ['Write to temp', bash(`echo hi > ${q(path.join(tmp, 'x.txt'))}`), {}, 'allow'],
  ['Write to the grant', call('Write', { file_path: path.join(runDir, 'grant.json'), content: '{}' }), {}, denied('protected-path')],
  ['redirect into the run settings', bash(`echo {} > ${q(path.join(runDir, 'run-settings.json'))}`), {}, denied('protected-path')],
  ['Write to the run ledger', call('Write', { file_path: path.join(runDir, 'ledger.jsonl'), content: '' }), {}, denied('protected-path')],
  ['Write to the credential stubs', call('Write', { file_path: path.join(runDir, 'env', 'kubeconfig'), content: '' }), {}, denied('protected-path')],
  ['deleting the run dir', bash(`rm -rf ${q(runDir)}`), {}, denied('protected-path')],
  ['Edit of .git/config in the checkout', call('Edit', { file_path: path.join(checkout, '.git', 'config'), old_string: 'x', new_string: 'y' }), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['Write of a git hook', call('Write', { file_path: path.join(checkout, '.git', 'hooks', 'pre-commit'), content: 'x' }), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['Write of Claude settings in the checkout', call('Write', { file_path: path.join(checkout, '.claude', 'settings.local.json'), content: '{}' }), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['replacing the checkout .claude dir', bash(`mv ${q(path.join(tmp, 'c'))} .claude`), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['Write outside every root', call('Write', { file_path: path.join(outside, 'x.txt'), content: 'x' }), { grant: { permissions: EDIT } }, denied('outside-writable')],
  ['Write next to a writable root with the same prefix', call('Write', { file_path: `${tmp}-other${path.sep}x.txt`, content: 'x' }), { grant: { permissions: EDIT } }, denied('outside-writable')],
  ['Write to home credentials', call('Write', { file_path: path.join(home, '.aws', 'config'), content: 'x' }), { grant: { permissions: EDIT, writableRoots: [home, checkout, runDir, tmp] } }, denied('protected-path')],
  ['edit_source is enforced even when the grant lists the checkout as writable', call('Write', { file_path: path.join(checkout, 'x.txt'), content: 'x' }), { grant: { writableRoots: [checkout, runDir, tmp] } }, denied('no-edit-permission')],

  // Review Focus 2: the checkout is the install root
  ['an ordinary file in the install-root checkout', call('Edit', { file_path: path.join(install, 'src', 'lib', 'x.js'), old_string: 'x', new_string: 'y' }), IN_INSTALL, 'allow'],
  ['the guard hook entry in the install root', call('Write', { file_path: path.join(install, 'bin', 'quill-guard.js'), content: 'x' }), IN_INSTALL, denied('protected-path')],
  ['grant.js in the install root', call('Edit', { file_path: path.join(install, 'src', 'handoff', 'grant.js'), old_string: 'x', new_string: 'y' }), IN_INSTALL, denied('protected-path')],
  ['a module the guard loads', call('Edit', { file_path: path.join(install, 'src', 'lib', 'paths.js'), old_string: 'x', new_string: 'y' }), IN_INSTALL, denied('protected-path')],
  ['deleting a directory that holds the guard', bash('rm -rf src'), IN_INSTALL, denied('protected-path')],
  ['moving the guard away', bash('mv src/gate src/gate-old'), IN_INSTALL, denied('protected-path')],
  ['the real install root keeps its guard', call('Edit', { file_path: path.join(INSTALL_ROOT, 'src', 'gate', 'run-guard.js'), old_string: 'x', new_string: 'y' }), { env: { cwd: INSTALL_ROOT, installRoot: undefined }, grant: { permissions: EDIT, readableRoots: [INSTALL_ROOT, runDir, tmp], writableRoots: [INSTALL_ROOT, runDir, tmp], protectedPaths: [] } }, denied('protected-path')],
  ['the real install root stays editable', call('Edit', { file_path: path.join(INSTALL_ROOT, 'src', 'lib', 'text.js'), old_string: 'x', new_string: 'y' }), { env: { cwd: INSTALL_ROOT, installRoot: undefined }, grant: { permissions: EDIT, readableRoots: [INSTALL_ROOT, runDir, tmp], writableRoots: [INSTALL_ROOT, runDir, tmp], protectedPaths: [] } }, 'allow'],

  // full access: observe only
  ['full: a cluster write is allowed and recorded', bash('kubectl apply -f deploy.yaml'), FULL, 'allow', { scope: 'k8s.write', target: null }],
  ['full: a push to main is allowed and recorded', bash('git push origin main'), FULL, 'allow', { scope: 'git.protected', target: 'main' }],
  ['full: quill commands are allowed and recorded', bash('quill agent run PMO-1'), FULL, 'allow', { scope: 'privileged', target: null }],
  ['full: reading credentials is allowed', call('Read', { file_path: path.join(home, '.aws', 'credentials') }), FULL, 'allow', undefined],
  ['full: an untrusted MCP server is allowed', call('mcp__repo_db__get_rows', {}, { mcp_server_source: 'project' }), FULL, 'allow', undefined],
  ['full: a read records nothing', bash('kubectl get pods'), FULL, 'allow', undefined],
  ['full without the observe guard is enforced', bash('kubectl apply -f deploy.yaml'), { grant: { access: 'full' } }, critical('k8s.write', '')],
  ['observe guard with an autonomous grant is enforced', bash('kubectl apply -f deploy.yaml'), { env: FULL.env }, critical('k8s.write', '')],
];

function run(c, opts = {}) {
  const env = { ...ENV, ...(opts.env ?? {}) };
  return decide(c, grantWith(opts.grant ?? {}), env);
}

for (const row of ROWS) {
  const [name, c, opts, expected] = row;
  test(name, () => {
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
    if (expected === 'allow') continue;
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

test('roots: a path equal to a root is inside it, a sibling sharing its prefix is not', () => {
  const root = path.join(base, 'repo');
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(path.join(root, 'a', 'b'), root), true);
  assert.equal(isWithin(`${root}-other`, root), false);
  assert.equal(isWithin(path.join(`${root}-other`, 'x'), root), false);
  assert.equal(isWithin(path.join(root, 'A'), root.toUpperCase()), process.platform === 'win32');
});

test('roots compare case-insensitively on Windows', { skip: process.platform !== 'win32' && 'case-sensitive file system' }, () => {
  const upper = path.join(install.toUpperCase(), 'SRC', 'Gate', 'RUN-GUARD.JS');
  const r = run(call('Edit', { file_path: upper, old_string: 'x', new_string: 'y' }), IN_INSTALL);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, denied('protected-path'));
  const ok = run(call('Read', { file_path: path.join(checkout.toUpperCase(), 'SRC', 'APP.JS') }), {});
  assert.equal(ok.decision, 'allow', ok.reason);
});

test('a junction or directory link inside the checkout cannot reach outside the roots (R10)', (t) => {
  const escape = path.join(checkout, 'escape');
  const guard = path.join(checkout, 'guardlink');
  fs.symlinkSync(outside, escape, 'junction');
  fs.symlinkSync(path.join(install, 'src', 'gate'), guard, 'junction');
  t.after(() => { fs.rmSync(escape, { force: true }); fs.rmSync(guard, { force: true }); });
  const edit = { grant: { permissions: EDIT } };
  const cases = [
    [call('Write', { file_path: path.join(escape, 'new.txt'), content: 'x' }), edit, 'outside-writable'],
    [call('Read', { file_path: path.join(escape, 'secret.txt') }), {}, 'outside-readable'],
    [bash('echo x > escape/new.txt'), edit, 'outside-writable'],
    [bash('cat escape/secret.txt'), {}, 'outside-readable'],
    [call('Write', { file_path: path.join(guard, 'run-guard.js'), content: 'x' }), edit, 'protected-path'],
  ];
  for (const [c, opts, code] of cases) {
    const r = run(c, opts);
    assert.equal(r.decision, 'deny', `${JSON.stringify(c)}: ${r.reason}`);
    assert.match(r.reason, denied(code));
  }
});

test('a dangling link is followed to where writing through it would land (R10)', (t) => {
  const link = path.join(checkout, 'dangling');
  fs.symlinkSync(path.join(outside, 'not-yet'), link, 'junction');
  t.after(() => fs.rmSync(link, { force: true }));
  const r = run(call('Write', { file_path: path.join(link, 'x.txt'), content: 'x' }), { grant: { permissions: EDIT } });
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, denied('outside-writable'));
});

test('a file symlink to a credential is neither readable nor writable (R10)', (t) => {
  const link = path.join(checkout, 'creds.txt');
  try {
    fs.symlinkSync(path.join(home, '.aws', 'credentials'), link, 'file');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return t.skip('this account may not create file symlinks');
    throw err;
  }
  t.after(() => fs.rmSync(link, { force: true }));
  const read = run(call('Read', { file_path: link }), {});
  assert.match(read.reason, denied('outside-readable'));
  const write = run(call('Write', { file_path: link, content: 'x' }), { grant: { permissions: EDIT } });
  assert.match(write.reason, denied('protected-path'));
});

test('GUARD_CODE covers every local module the guard loads', () => {
  const entries = ['src/gate/run-guard.js', 'src/handoff/grant.js', 'bin/quill-guard.js'].map((p) => path.join(INSTALL_ROOT, p)).filter((p) => fs.existsSync(p));
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) stack.push(path.resolve(path.dirname(f), m[1]));
  }
  assert.ok(seen.size >= 4, `walked ${seen.size} modules`);
  for (const f of seen) assert.ok(GUARD_CODE.some((g) => isWithin(f, path.join(INSTALL_ROOT, g))), `${path.relative(INSTALL_ROOT, f)} is not in GUARD_CODE`);
});
