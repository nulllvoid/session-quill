import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, isWithin, INSTALL_ROOT, GUARD_CODE, MAX_GLOB_MATCHES } from '../../src/gate/run-guard.js';
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
file('outside', 'credentials');
// a directory junction (a dir symlink elsewhere) inside the checkout, leading outside every root
fs.symlinkSync(outside, path.join(checkout, 'esc'), 'junction');

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
const MCP_PIN = { scope: 'argo.sync', pin: 'mcp__argocd__sync_application {"applicationName":"pay-stg"}' };
const KUBECTL_ONLY = { name: 'k8s.write', target: 'stg', matchers: { bash: ['kubectl *'] }, fingerprint: 'f-kubectl' };

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
  ['pinned MCP action', call('mcp__argocd__sync_application', { applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, 'allow'],
  ['MCP action outside the pin', call('mcp__argocd__sync_application', { applicationName: 'pay-prod' }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, critical('argo.sync', 'pay-prod')],

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

  // fix round 1, C1: a wildcard cannot hide a link from the readable roots
  ['a literal path through the junction', bash('cat esc/credentials'), {}, denied('outside-readable')],
  ['a * wildcard through the junction', bash('cat esc*/credentials'), {}, denied('outside-readable')],
  ['a ? wildcard through the junction', bash('cat e?c/credentials'), {}, denied('outside-readable')],
  ['a [..] wildcard through the junction', bash('cat e[s]c/credentials'), {}, denied('outside-readable')],
  ['a ** wildcard through the junction', bash('cat **/credentials'), {}, denied('outside-readable')],
  ['a PowerShell wildcard through the junction', pwsh('Get-Content es*/credentials'), {}, denied('outside-readable')],
  ['copying through the junction with a wildcard', bash('cp esc*/credentials copy.txt'), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['a wildcard over plain files', bash('cat src/*.js'), {}, 'allow'],
  ['a ? wildcard over plain files', bash('cat src/a?p.js'), {}, 'allow'],
  // R15's accepted cost: a wildcard beside a link that leads outside is refused even when its
  // pattern would not match the link, and the reason says to list explicit paths
  ['R15: a wildcard beside the junction, pattern aside', bash('cat sr*/app.js'), {}, /^QUILL_DENIED outside-readable: .*list the explicit paths/],
  ['R15: a ? wildcard beside the junction', bash('cat s?c/app.js'), {}, /^QUILL_DENIED outside-readable: .*list the explicit paths/],
  ['R15: a wildcard below a directory that cannot be listed', bash('cat nothere/*.js'), {}, denied('wildcard-unchecked')],

  // fix round 2, C1a: bracket expressions with classes, equivalence classes and collating symbols
  ['C1a: [[=e=]] through the junction', bash('cat [[=e=]]sc/credentials'), {}, denied('outside-readable')],
  ['C1a: [[.e.]] through the junction', bash('cat [[.e.]]sc/credentials'), {}, denied('outside-readable')],
  ['C1a: [[=s=]] inside the word', bash('cat e[[=s=]]c/credentials'), {}, denied('outside-readable')],
  ['C1a: copying with [[=e=]]', bash('cp [[=e=]]sc/credentials src/x.txt'), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['C1a: [[:alpha:]] through the junction', bash('cat [[:alpha:]]sc/credentials'), {}, /^QUILL_DENIED (outside-readable|unparseable): /],

  // fix round 2, C1c: extglob words and shopt
  ['C1c: ?(…) extglob', bash('cat ?(esc)/credentials'), {}, denied('unparseable')],
  ['C1c: @(…) extglob', bash('cat @(esc)/credentials'), {}, denied('unparseable')],
  ['C1c: +(…) extglob', bash('cat +(esc)/credentials'), {}, denied('unparseable')],
  ['C1c: !(…) extglob', bash('cat !(src)/credentials'), {}, denied('unparseable')],
  ['C1c: *(…) extglob', bash('cat *(esc)/credentials'), {}, denied('unparseable')],
  ['C1c: shopt', bash('shopt -s extglob'), {}, denied('unparseable')],
  ['C1c: shopt before a wildcard', bash('shopt -s nocaseglob; cat src/*.js'), {}, denied('unparseable')],
  ['C1c: a subshell still parses', bash('(cd src && ls)'), {}, 'allow'],

  // fix round 1, I1: a shell pin is exactly its command, without environment or wrappers
  ['pin: an environment prefix', bash("ARGOCD_OPTS='--server evil.example' argocd app sync pay-stg"), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: env with an assignment', bash('env ARGOCD_SERVER=evil.example argocd app sync pay-stg'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: env -u', bash('env -u KUBECONFIG argocd app sync pay-stg'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: PowerShell $env: before the command', pwsh("$env:ARGOCD_OPTS='--server evil.example'; argocd app sync pay-stg"), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: export earlier in the chain', bash('export ARGOCD_OPTS=x; argocd app sync pay-stg'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: a wrapper shell', bash('bash -c "argocd app sync pay-stg"'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: input from a file', bash('argocd app sync pay-stg < opts.txt'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['pin: quoting does not change the action', bash('argocd app sync "pay-stg"'), { grant: { actionPins: [PIN] } }, 'allow'],
  ['pin: helm with a context variable', bash('HELM_KUBECONTEXT=prod helm upgrade api ./chart'), { grant: { actionPins: [{ scope: 'k8s.write', pin: 'helm upgrade api ./chart' }] } }, critical('k8s.write', '')],
  ['pin: helm as pinned', bash('helm upgrade api ./chart'), { grant: { actionPins: [{ scope: 'k8s.write', pin: 'helm upgrade api ./chart' }] } }, 'allow'],
  ['pin: kubectl with another kubeconfig', bash('KUBECONFIG=/tmp/rw kubectl --context stg apply -f x.yaml'), { grant: { actionPins: [{ scope: 'k8s.write:stg', pin: 'kubectl --context stg apply -f x.yaml' }] } }, critical('k8s.write', 'stg')],

  // fix round 1, I2: the whole MCP input is the action
  ['MCP pin: a second app field naming another app', call('mcp__argocd__sync_application', { applicationName: 'pay-stg', name: 'pay-prod' }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, critical('argo.sync', 'pay-stg')],
  ['MCP pin: an extra option', call('mcp__argocd__sync_application', { applicationName: 'pay-stg', prune: true }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, critical('argo.sync', 'pay-stg')],
  ['MCP pin: the same input in another key order', call('mcp__argocd__sync_application', { revision: 'abc', applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { actionPins: [{ scope: 'argo.sync', pin: 'mcp__argocd__sync_application {"applicationName":"pay-stg","revision":"abc"}' }] } }, 'allow'],
  ['MCP pin in the old tool-and-target form matches nothing', call('mcp__argocd__sync_application', { applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { actionPins: [{ scope: 'argo.sync', pin: 'mcp__argocd__sync_application pay-stg' }] } }, critical('argo.sync', 'pay-stg')],

  // fix round 1, I3: command patterns cover only the part they match
  ['matchers: a kubectl read does not cover a helm write', bash('helm --kube-context stg uninstall api; kubectl --context stg get pods'), { grant: { scopes: [KUBECTL_ONLY] } }, critical('k8s.write', 'stg')],
  ['matchers: a helm write alone', bash('helm --kube-context stg uninstall api'), { grant: { scopes: [KUBECTL_ONLY] } }, critical('k8s.write', 'stg')],
  ['matchers: kubectl writes they match', bash('kubectl --context stg get pods && kubectl --context stg delete pod api'), { grant: { scopes: [KUBECTL_ONLY] } }, 'allow'],

  // fix round 1, R13: Claude Code and MCP configuration in the checkout
  ['R13: Edit .claude/settings.json', call('Edit', { file_path: path.join(checkout, '.claude', 'settings.json'), old_string: 'x', new_string: 'y' }), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['R13: Write .mcp.json', call('Write', { file_path: path.join(checkout, '.mcp.json'), content: '{}' }), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['R13: Write a Claude agent definition', call('Write', { file_path: path.join(checkout, '.claude', 'agents', 'x.md'), content: 'x' }), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['R13: shell write into .claude', bash('echo x > .claude/settings.local.json'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['R13: Read of .claude/settings.json', call('Read', { file_path: path.join(checkout, '.claude', 'settings.json') }), {}, 'allow'],
  ['R13: Read of .mcp.json', call('Read', { file_path: path.join(checkout, '.mcp.json') }), {}, 'allow'],
  ['R13: full access may change it', call('Write', { file_path: path.join(checkout, '.claude', 'agents', 'x.md'), content: 'x' }), FULL, 'allow', undefined],

  // fix round 1, M1: Glob and Grep patterns that climb out after a wildcard or brace
  ['Glob: .. inside a brace', call('Glob', { pattern: '{..,x}/../../../../home/.aws/*' }), {}, denied('outside-readable')],
  ['Glob: .. after a wildcard', call('Glob', { pattern: 'src/**/../../../../home/.aws/*' }), {}, denied('outside-readable')],
  ['Grep: a glob filter that climbs', call('Grep', { pattern: 'token', glob: '{..,src}/*' }), {}, denied('outside-readable')],
  ['Grep: an ordinary glob filter', call('Grep', { pattern: 'token', glob: '*.js' }), {}, 'allow'],

  // fix round 1, M3: every reading of the tool name must name a trusted server
  ['MCP: a server name that also reads as a trusted one', call('mcp__team_docs__x__get_page', {}, { mcp_server_source: 'project' }), {}, denied('untrusted-mcp-server')],
  ['MCP: a folded name shared by two trusted entries', call('mcp__team_wiki__get_page', {}, { mcp_server_source: 'project' }), { grant: { trustedMcpServers: ['team.wiki', 'team wiki'] } }, denied('untrusted-mcp-server')],
  ['MCP: a name already in tool-name form', call('mcp__team_wiki__get_page', {}, { mcp_server_source: 'project' }), { grant: { trustedMcpServers: ['team_wiki'] } }, 'allow'],

  // fix round 1, M4: a hosts matcher covers an external write in the scope's own name
  ['hosts: a wildcard host pattern', bash('curl -X POST https://api.example.com/v1/items'), { grant: { scopes: [{ name: 'http.write', matchers: { hosts: ['*.example.com'] }, fingerprint: 'f' }] } }, 'allow'],
  ['hosts: another host', bash('curl -X POST https://api.other.com/v1/items'), { grant: { scopes: [{ name: 'http.write', matchers: { hosts: ['*.example.com'] }, fingerprint: 'f' }] } }, critical('http.write', 'api.other.com')],
  ['hosts: a package registry', bash('npm publish'), { grant: { scopes: [{ name: 'package.publish', matchers: { hosts: ['registry.npmjs.org'] }, fingerprint: 'f' }] } }, 'allow'],
  ['hosts: scp has no scope, so a host pattern cannot cover it', bash('scp a.txt files.example.com:/x'), { grant: { scopes: [{ name: 'http.write', matchers: { hosts: ['files.example.com'] }, fingerprint: 'f' }] } }, critical('external.write', 'files.example.com')],

  // fix round 1, M5: a write to the whole checkout says why it is refused
  ['deleting the whole checkout', bash('rm -rf .'), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .* contains .*\.git, which is protected.*Name the files/],

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

test('a path a call names is resolved afresh on every decision', (t) => {
  const later = path.join(checkout, 'later');
  const target = path.join(later, 'credentials');
  assert.equal(run(call('Read', { file_path: target }), {}).decision, 'allow', 'not there yet: inside the checkout');
  fs.symlinkSync(outside, later, 'junction');
  t.after(() => fs.rmSync(later, { force: true }));
  const r = run(call('Read', { file_path: target }), {});
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, denied('outside-readable'));
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

test('a wildcard that matches too many entries is refused rather than checked (C1)', (t) => {
  const big = path.join(checkout, 'big');
  fs.mkdirSync(big);
  t.after(() => fs.rmSync(big, { recursive: true, force: true }));
  for (let i = 0; i <= MAX_GLOB_MATCHES; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
  const r = run(bash('cat big/*'), {});
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, denied('wildcard-too-broad'));
  fs.rmSync(path.join(big, 'f0.txt'));
  assert.equal(run(bash('cat big/*'), {}).decision, 'allow', 'exactly at the cap is still checked');
});

test('protected names ignore case where the file system does (M2)', () => {
  const r = run(call('Write', { file_path: path.join(checkout, '.MCP.JSON'), content: '{}' }), { grant: { permissions: EDIT } });
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.match(r.reason, denied('protected-path'));
  } else {
    assert.equal(r.decision, 'allow', r.reason);
  }
});

test('with the default Quill home under ~/.claude, the checkout and run dir stay writable (R13)', () => {
  const qh2 = path.join(home, '.claude', 'quill');
  const co2 = path.join(qh2, 'handoffs', 'worktrees', 'run9');
  const rd2 = path.join(qh2, 'handoffs', 'runs', 'run9');
  fs.mkdirSync(path.join(co2, 'src'), { recursive: true });
  fs.mkdirSync(rd2, { recursive: true });
  const { QUILL_HOME, ...vars } = VARS;
  const env = { ...ENV, cwd: co2, vars: { ...vars, QUILL_HANDOFF_ID: 'run9' } };
  const grant = grantWith({ permissions: EDIT, readableRoots: [co2, rd2, tmp], writableRoots: [co2, rd2, tmp], protectedPaths: [] });
  const cases = [
    [call('Write', { file_path: path.join(co2, 'src', 'a.js'), content: 'x' }), 'allow'],
    [call('Write', { file_path: path.join(rd2, 'notes.txt'), content: 'x' }), 'allow'],
    [call('Write', { file_path: path.join(co2, '.claude', 'settings.json'), content: '{}' }), 'deny'],
    [call('Write', { file_path: path.join(rd2, 'grant.json'), content: '{}' }), 'deny'],
    [call('Write', { file_path: path.join(qh2, 'memory', 'x.md'), content: 'x' }), 'deny'],
  ];
  for (const [c, want] of cases) {
    const r = decide(c, grant, env);
    assert.equal(r.decision, want, `${c.tool_input.file_path}: ${r.reason}`);
  }
});

test('decide stays quick on every tool call (M7)', () => {
  const grant = grantWith({ permissions: PUSH, scopes: [K8S_STG, ARGO, JIRA], actionPins: [PIN] });
  const calls = ROWS.map((r) => r[1]);
  // best p95 of three passes, so a busy machine does not fail one pass
  let p95 = Infinity;
  for (let pass = 0; pass < 3 && p95 >= 5; pass += 1) {
    const times = [];
    for (let i = 0; i < 1000; i += 1) {
      const t0 = process.hrtime.bigint();
      decide(calls[i % calls.length], grant, ENV);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    p95 = Math.min(p95, times[Math.floor(times.length * 0.95)]);
  }
  assert.ok(p95 < 5, `p95 ${p95.toFixed(3)} ms`);
});

test('a checkout whose own path has brackets: only the supplied text is scanned (C1b, R15)', () => {
  for (const name of ['proj [1]', 'proj[ab]']) {
    const co = dir(name);
    fs.mkdirSync(path.join(co, 'src'), { recursive: true });
    fs.writeFileSync(path.join(co, 'src', 'app.js'), 'x\n');
    fs.symlinkSync(outside, path.join(co, 'esc'), 'junction');
    const env = { ...ENV, cwd: co };
    const grant = grantWith({ readableRoots: [co, runDir, tmp], writableRoots: [runDir, tmp] });
    for (const command of ['cat esc*/credentials', 'cat e?c/credentials', 'cat */credentials']) {
      const r = decide(bash(command), grant, env);
      assert.equal(r.decision, 'deny', `${name}: ${command}: ${r.reason}`);
      assert.match(r.reason, denied('outside-readable'));
    }
    const ok = decide(bash('cat src/*.js'), grant, env);
    assert.equal(ok.decision, 'allow', `${name}: the brackets in the checkout path are literal: ${ok.reason}`);
  }
});

test('Claude configuration behind a link in the checkout stays protected (R13b)', (t) => {
  const co = dir('linked');
  const target = dir('linked', 'config', 'claude');
  fs.writeFileSync(path.join(target, 'settings.json'), '{}');
  fs.symlinkSync(target, path.join(co, '.claude'), 'junction');
  t.after(() => fs.rmSync(path.join(co, '.claude'), { force: true }));
  const env = { ...ENV, cwd: co };
  const grant = grantWith({ permissions: EDIT, readableRoots: [co, runDir, tmp], writableRoots: [co, runDir, tmp] });
  const cases = [
    [call('Write', { file_path: path.join(co, '.claude', 'settings.local.json'), content: '{}' }), /needs a full-access run or a manual edit/],
    [call('Edit', { file_path: path.join(co, '.claude', 'settings.json'), old_string: '{', new_string: '[' }), /needs a full-access run or a manual edit/],
    [bash('echo x > .claude/settings.local.json'), /needs a full-access run or a manual edit/],
    [call('Write', { file_path: path.join(target, 'settings.json'), content: '{}' }), denied('protected-path')],
    [bash('rm -rf config'), denied('protected-path')],
  ];
  for (const [c, want] of cases) {
    const r = decide(c, grant, env);
    assert.equal(r.decision, 'deny', `${JSON.stringify(c.tool_input)}: ${r.reason}`);
    assert.match(r.reason, want);
  }
  const ok = decide(call('Write', { file_path: path.join(co, 'config', 'other.txt'), content: 'x' }), grant, env);
  assert.equal(ok.decision, 'allow', ok.reason);
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
