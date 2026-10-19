// Guard decision rows: the brief, per-run permissions, MCP, scopes, roots, wildcards and `..`.
// Not a test file: run-guard-rows.test.js turns every row into a test.
import path from 'node:path';
import { INSTALL_ROOT } from '../../src/gate/run-guard.js';
import {
  home, plugins, qh, runDir, checkout, tmp, install, outside, EDIT, COMMIT, PUSH, PR, bash, pwsh,
  call, q, K8S_STG, ARGO, JIRA, HTTP_API, PIN, MCP_PIN, ARGO_STG, denied, CLIMBS, critical,
  IN_INSTALL
} from './guard-fixture.js';

// [name, call, { grant?, env? }, expected: 'allow' | RegExp for the deny reason, criticalChange?]
// A fifth element, even `undefined`, is compared with the result's criticalChange.
export const BASIC_ROWS = [
  // the brief's rows
  ['kubectl get is a read', bash('kubectl get pods -n pay'), {}, 'allow'],
  ['kubectl apply without a scope is a critical change', bash('kubectl apply -f deploy.yaml'), {}, critical('k8s.write', ''), { scope: 'k8s.write', target: null }],
  ['Read of ~/.aws/config', call('Read', { file_path: path.join(home, '.aws', 'config') }), {}, denied('outside-readable')],
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
  ['the pinned action is allowed', bash('argocd app sync pay-stg'), { grant: { scopes: [ARGO_STG], actionPins: [PIN] } }, 'allow'],
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
  ['pinned MCP action', call('mcp__argocd__sync_application', { applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { scopes: [ARGO_STG], actionPins: [MCP_PIN] } }, 'allow'],
  ['MCP action outside the pin', call('mcp__argocd__sync_application', { applicationName: 'pay-prod' }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, critical('argo.sync', 'pay-prod')],

  // classifier edges
  ['empty command', bash('   '), {}, denied('unparseable')],
  ['Bash without tool_input', { tool_name: 'Bash' }, {}, denied('unparseable')],
  ['deploy script', bash('npm run deploy'), {}, denied('unknown-prod')],
  ['WebFetch is a read', call('WebFetch', { url: 'https://example.com/x', prompt: 'p' }), {}, 'allow'],

  // scopes and pins
  ['a scope with no bash matchers does not cover a shell call', bash('kubectl --context stg apply -f x.yaml'), { grant: { scopes: [{ ...K8S_STG, matchers: { mcp: ['mcp__k8s__*'] } }] } }, critical('k8s.write', 'stg')],
  ['a scope with a target does not cover an unknown target', bash('kubectl apply -f x.yaml'), { grant: { scopes: [K8S_STG] } }, critical('k8s.write', '')],
  ['every write in a chain needs cover', bash('kubectl --context stg apply -f x.yaml && kubectl --context prod delete pod api'), { grant: { scopes: [K8S_STG] } }, /^QUILL_CRITICAL_CHANGE scope=k8s.write target=stg: .*more than one command/],
  ['a write in another scope is not covered', bash('helm --kube-context stg upgrade api ./chart && argocd app sync pay-stg'), { grant: { scopes: [K8S_STG] } }, critical('k8s.write', 'stg')],
  // R25: a scope without a target covers no command of a tool that names one
  ['a granted scope without a target covers no targeted command', bash('argocd app sync pay-prod'), { grant: { scopes: [ARGO] } }, /^QUILL_CRITICAL_CHANGE scope=argo.sync target=pay-prod: .*the scope names no target/],
  ['a pin narrows a granted scope to its action', bash('argocd app sync pay-prod'), { grant: { scopes: [ARGO], actionPins: [PIN] } }, critical('argo.sync', 'pay-prod')],
  ['extra flags are a different action than the pin', bash('argocd app sync pay-stg --prune'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['the pin must be the whole command', bash('argocd app sync pay-stg && argocd app sync pay-prod'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['an http write without a scope', bash('curl -X POST https://api.example.com/v1/items'), {}, critical('http.write', 'api.example.com'), { scope: 'http.write', target: 'api.example.com' }],
  ['an http write to a granted host', bash('curl -X POST https://api.example.com/v1/items'), { grant: { scopes: [HTTP_API] } }, 'allow'],
  ['an http write to another host', bash('curl -X POST https://api.other.com/v1/items'), { grant: { scopes: [HTTP_API] } }, critical('http.write', 'api.other.com')],

  // readable roots
  ['shell read of credentials', bash('cat ~/.aws/config'), {}, denied('outside-readable')],
  ['PowerShell read of credentials', pwsh(`Get-Content ${q(path.join(home, '.aws', 'config'))}`), {}, denied('outside-readable')],
  ['copying credentials into the checkout', bash('cp ~/.aws/config copy.txt'), { grant: { permissions: EDIT } }, denied('outside-readable')],
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

  // fix round 3, P1: `..` after a link is applied physically, as the shell does; fix round 4
  // (R17.1): `..` after a name in one path word is refused outright
  ['P1: link then ..', bash('cat esc/../credentials'), {}, CLIMBS],
  ['P1: wildcard then ..', bash('cat */../credentials'), {}, CLIMBS],
  ['P1: ? wildcard then ..', bash('cat e?c/../credentials'), {}, CLIMBS],
  ['P1: cd into the link, then ..', bash('cd esc && cat ../credentials'), {}, denied('outside-readable')],
  ['P1: write through link then ..', bash('echo x > esc/../x.txt'), { grant: { permissions: EDIT } }, CLIMBS],
  ['R17.1: .. after a name, even over plain directories', bash('cat src/../src/app.js'), {}, CLIMBS],
  ['R17.1: a/..', bash('cat a/..'), {}, CLIMBS],
  ['R17.1: .. after a name in a Read path', call('Read', { file_path: [checkout, 'src', '..', 'src', 'app.js'].join(path.sep) }), {}, denied('unparseable')],
  ['R17.1: cd then a leading .. over plain directories', bash('cd src && cat ../src/app.js'), {}, 'allow'],
  ['R17.1: a leading .. back into the checkout', bash(`cat ../${path.basename(checkout)}/src/app.js`), {}, 'allow'],
  ['R17.1: a leading .. out of the checkout', bash('cat ../../../../outside/credentials'), {}, denied('outside-readable')],
  ['R17.1: .. from a directory that does not exist (the cd failed)', bash('cd nothere; cat ../../../../outside/credentials'), {}, denied('(unparseable|outside-readable)')],
  ['R17.1: .. from a directory that does not exist yet', bash('cd nothere; cat ../src/app.js'), {}, /^QUILL_DENIED unparseable: .*(not an existing directory|does not exist)/],
  ['R17.1: .. from a directory made in the same command', bash('mkdir -p nothere && cd nothere && cat ../src/app.js'), { grant: { permissions: EDIT } }, /^QUILL_DENIED unparseable: .*not an existing directory/],
  ['R17.1: PowerShell .. after a name', pwsh('Get-Content esc\\..\\credentials'), {}, CLIMBS],

  // fix round 4, R17.2 and P1r: directory options take the same `..` rules
  ['P1r: git -C .. from inside the link, clone', bash('cd esc && git -C .. clone https://github.com/x/y zA'), { grant: { permissions: EDIT } }, /^QUILL_DENIED (outside-writable|outside-readable): /],
  ['P1r: git -C .. from inside the link, init', bash('cd esc && git -C .. init zA'), { grant: { permissions: EDIT } }, /^QUILL_DENIED (outside-writable|outside-readable): /],
  ['P1r: git -C esc/.. init', bash('git -C esc/.. init zA'), { grant: { permissions: EDIT } }, CLIMBS],
  ['P1r: git -C .. rm from inside the link', bash('cd esc && git -C .. rm credentials'), { grant: { permissions: EDIT } }, /^QUILL_DENIED (outside-writable|outside-readable): /],
  ['R17.2: git -C a directory outside the readable roots', bash(`git -C ${q(outside)} log`), {}, denied('outside-readable')],
  ['R17.2: git -C a subdirectory', bash('git -C src log'), {}, 'allow'],
  ['R17.2: git -C src clone', bash('git -C src clone https://github.com/x/y zB'), { grant: { permissions: EDIT } }, 'allow'],
  ['R17.2: make -C esc/..', bash('make -C esc/.. test'), {}, CLIMBS],
  ['R17.2: make -C through the link', bash('make -C esc test'), {}, denied('outside-readable')],
  ['R17.2: tar -C esc/..', bash('tar -C esc/.. -cf /tmp/out.tar credentials'), {}, CLIMBS],
  ['R17.2: tar -C home', bash('tar -C ~ -czf /tmp/x.tgz .aws'), {}, denied('outside-readable')],
  ['R17.2: npm --prefix esc/..', bash('npm --prefix esc/.. test'), {}, CLIMBS],
  ['R17.2: pushd esc/..', bash('pushd esc/.. && cat credentials'), {}, CLIMBS],
  ['R17.2: cd -P esc/..', bash('cd -P esc/.. && cat credentials'), {}, denied('unparseable')],
  ['R17.2: Set-Location esc\\..', pwsh('Set-Location esc\\..; Get-Content credentials'), {}, CLIMBS],
  ['R17.2: Push-Location esc\\..', pwsh('Push-Location esc\\..; Get-Content credentials'), {}, CLIMBS],
  ['R17.2: env -C esc/..', bash('env -C esc/.. cat credentials'), {}, CLIMBS],
  ['R17.2: env -C home', bash('env -C ~ cat .aws/config'), {}, denied('outside-readable')],
  ['R17.2: env -C into the link then ..', bash('env -C esc cat ../credentials'), {}, denied('outside-readable')],
  ['R17.2: env -C src', bash('env -C src cat app.js'), {}, 'allow'],
  ['R17.2: env -C keeps the redirect where the shell opens it', bash('env -C src cat app.js > out.txt'), { grant: { permissions: EDIT } }, 'allow'],
  ['R17.2: sudo -D home', bash('sudo -D ~ cat .aws/config'), {}, denied('outside-readable')],
  ['R17.2: a cd inside bash -c ends with it', bash(`cd ~; bash -c ${q(`cd ${checkout.replace(/\\/g, '/')}`)}; cat .aws/config`), {}, denied('outside-readable')],
  ['R17.2: a cd inside bash -c applies inside it', bash(`bash -c 'cd src && cat app.js'`), {}, 'allow'],
  ['R17.2: a cd inside eval lasts', bash(`eval 'cd ~'; cat .aws/config`), {}, denied('outside-readable')],
  ['R17.2: Set-Location inside Invoke-Expression lasts', pwsh(`Invoke-Expression 'Set-Location ~'; Get-Content .aws/config`), {}, denied('outside-readable')],
  ['R17.2: Start-Process -WorkingDirectory', pwsh(`Start-Process -WorkingDirectory ${q(home)} -FilePath cat -ArgumentList .aws/config`), {}, denied('outside-readable')],
  ['R17.2: pwsh -WorkingDirectory', pwsh(`pwsh -WorkingDirectory ${q(home)} -Command 'Get-Content .aws/config'`), {}, denied('outside-readable')],
  ['R17.2: cmd start /D', bash(`cmd /c 'start /D "${home}" type .aws\\config'`), {}, denied('outside-readable')],
  ['R17.2: pwsh -wd:<dir> (colon form)', pwsh(`pwsh -wd:${q(home)} -c 'Get-Content .aws/config'`), {}, denied('outside-readable')],
];
