// Guard decision rows: directory changes, archives, cmd, hidden command text, links, copies, renames, pins, configuration, full access and read-only git.
// Not a test file: run-guard-rows.test.js turns every row into a test.
import path from 'node:path';
import {
  home, checkout, tmp, outside, VARS, EDIT, COMMIT, PUSH, bash, pwsh, call, q, K8S_STG, PIN,
  MCP_PIN, ARGO_STG, KUBECTL_ONLY, denied, OUT_W, critical, CMD_ONLY, FULL
} from './guard-fixture.js';

// [name, call, { grant?, env? }, expected: 'allow' | RegExp for the deny reason, criticalChange?]
// A fifth element, even `undefined`, is compared with the result's criticalChange.
export const SHELL_ROWS = [
  // fix round 5, R18: a cd that may fail while later commands still run
  ['R18: a failed cd, then a read', bash(`cd ~; cd ${q(path.join(checkout, 'nothere'))}; cat .aws/config`), {}, /^QUILL_DENIED unparseable: .*does not exist/],
  ['R18: a failed cd with ||', bash('cd nothere || cat src/app.js'), {}, /^QUILL_DENIED unparseable: .*does not exist/],
  ['R18: a failed cd, then a newline', bash('cd nothere\ncat src/app.js'), {}, /^QUILL_DENIED unparseable: .*does not exist/],
  ['R18: a failed cd, && and then ;', bash('cd nothere && true; cat src/app.js'), {}, /^QUILL_DENIED unparseable: .*does not exist/],
  ['R18: a failed Set-Location', pwsh('Set-Location nothere; Get-Content src\\app.js'), {}, /^QUILL_DENIED unparseable: .*does not exist/],
  ['R18: a cd to a file', bash('cd src/app.js; cat x'), {}, /^QUILL_DENIED unparseable: .*does not exist/],
  ['R18: a cd joined by && to the rest', bash('cd nothere && cat app.js'), {}, 'allow'],
  ['R18: a cd that exists', bash('cd src; cat app.js'), {}, 'allow'],
  ['R18: a cd as the last command', bash('cat src/app.js; cd nothere'), {}, 'allow'],

  // fix round 5, R19.2: only plain directory changes are followed
  ['R19.2: cd -', bash('cd ~; cd -; cat src/app.js'), {}, denied('unparseable')],
  ['R19.2: cd -P', bash('cd -P src && cat app.js'), {}, denied('unparseable')],
  ['R19.2: cd -L', bash('cd -L src && cat app.js'), {}, denied('unparseable')],
  ['R19.2: cd -e', bash('cd -e src && cat app.js'), {}, denied('unparseable')],
  ['R19.2: cd -L -- ~', bash('cd -L -- ~ && cat .aws/config'), {}, denied('unparseable')],
  ['R19.2: cd -- ~ resolves ~', bash('cd -- ~ && cat .aws/config'), {}, denied('outside-readable')],
  ['R19.2: pushd -- ~ resolves ~', bash('pushd -- ~ && cat .aws/config'), {}, denied('outside-readable')],
  ['R19.2: cd -- src', bash('cd -- src && cat app.js'), {}, 'allow'],
  ['R19.2: pushd +1', bash(`cd ~ && pushd ${q(checkout)} && pushd +1 && cat .aws/config`), {}, denied('unparseable')],
  ['R19.2: pushd -0', bash(`cd ~ && pushd ${q(checkout)} && pushd -0 && cat .aws/config`), {}, denied('unparseable')],
  ['R19.2: pushd without a directory', bash('pushd && cat src/app.js'), {}, denied('unparseable')],
  ['R19.2: popd', bash('pushd src && popd && cat src/app.js'), {}, denied('unparseable')],
  ['R19.2: Pop-Location', pwsh('Push-Location src; Pop-Location; Get-Content src\\app.js'), {}, denied('unparseable')],
  ['R19.2: cd to a variable', bash('cd "$HOME" && cat .aws/config'), {}, denied('unparseable')],
  ['R19.2: cd to OLDPWD', bash('cd $OLDPWD && cat x'), {}, denied('unparseable')],
  ['R19.2: cd with a wildcard', bash('cd sr* && cat app.js'), {}, denied('unparseable')],
  ['R19.2: Set-Location -StackName', pwsh('Set-Location -StackName s; Get-Content x'), {}, denied('unparseable')],
  ['R19.2: Set-Location -', pwsh('Set-Location -; Get-Content x'), {}, denied('unparseable')],

  // fix round 5, R19.3: a directory change in a pipeline element or a background job
  ['R19.3: cd in a pipeline', bash(`cd ~; cd ${q(checkout)} | true; cat .aws/config`), {}, denied('unparseable')],
  ['R19.3: cd in a background job', bash(`cd ~; cd ${q(checkout)} & cat .aws/config`), {}, denied('unparseable')],
  ['R19.3: cd after a pipe', bash('true | cd src; cat app.js'), {}, denied('unparseable')],

  // fix round 5, R19.4: tar
  ['R19.4: tar extract with two -C', bash(`tar -xf ${q(path.join(tmp, 'a.tar'))} -C src -C ~/.ssh`), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['R19.4: tar extract with two --directory', bash(`tar -xf ${q(path.join(tmp, 'a.tar'))} --directory=src --directory=${q(path.join(home, '.ssh'))}`), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['R19.4: tar cf to a protected name', bash('tar cf .mcp.json src'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['R19.4: tar cf in a read-only run', bash('tar cf out.tar src'), {}, denied('no-edit-permission')],
  ['R19.4: tar xvf reads its archive', bash(`tar xvf ${q(path.join(home, '.aws', 'x.tar'))}`), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['R19.4: tar -tf reads its archive', bash(`tar -tf ${q(path.join(home, '.aws', 'x.tar'))}`), {}, denied('outside-readable')],
  ['R19.4: tar czf into temp', bash(`tar czf ${q(path.join(tmp, 'out.tgz'))} src`), {}, 'allow'],
  ['R19.4: tar with a bundle it does not follow', bash('tar cbf 20 out.tar src'), {}, denied('unparseable')],

  // fix round 5, R19.5: cmd move with one operand
  ['R19.5: cmd move, one operand, read-only run', bash(`cmd /c 'move "${path.join(tmp, 'note.txt')}"'`), { winOnly: CMD_ONLY }, denied('no-edit-permission')],

  // fix round 5, R19.6: hidden command text
  ['R19.6: trap pushing to main', bash("trap 'git push origin HEAD:main' EXIT"), { grant: { permissions: PUSH } }, denied('protected-branch')],
  ['R19.6: trap copying credentials', bash("trap 'cp ~/.aws/config src/x' EXIT; true"), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['R19.6: trap changing directory', bash("trap 'cd ~' DEBUG; cat .aws/config"), {}, denied('unparseable')],
  ['R19.6: a cd after a trap', bash("trap 'cat .aws/config' EXIT; cd ~"), {}, denied('unparseable')],
  ['R19.6: trap text that is not literal', bash('trap "$CMD" EXIT'), {}, denied('unparseable')],
  ['R19.6: trap reset and listing', bash("trap - EXIT; trap -p; trap '' INT"), {}, 'allow'],
  ['R19.6: trap with a plain read', bash("trap 'cat src/app.js' EXIT"), {}, 'allow'],
  ['R19.6: named coproc', bash('coproc x { kubectl delete ns y; }'), {}, denied('unparseable')],
  ['R19.6: named coproc copying credentials', bash('coproc X { cp ~/.aws/config src/x; }'), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['R19.6: coproc', bash('coproc kubectl get pods'), {}, denied('unparseable')],
  ['R19.6: BASH_ENV', bash('BASH_ENV=/dev/stdin bash -c true'), {}, denied('unparseable')],
  ['R19.6: export ENV', bash('export ENV=/tmp/x; sh -c true'), {}, denied('unparseable')],
  ['R19.6: PROMPT_COMMAND', bash('PROMPT_COMMAND=x bash -i -c true'), {}, denied('unparseable')],
  ['R19.6: SHELLOPTS', bash('export SHELLOPTS'), {}, denied('unparseable')],
  ['R19.6: BASHOPTS', bash('BASHOPTS=extglob bash -c true'), {}, denied('unparseable')],
  ['R19.6: PS4 with a command substitution', bash("PS4='$(touch x)' bash -x -c true"), {}, denied('unparseable')],
  ['R19.6: PS4 plain', bash("PS4='+ ' bash -x -c true"), {}, 'allow'],

  // fix round 5, found while doing R19: directory changes the classifier cannot place in time
  ['R19: a function body changing directory', bash('f() { cd ~; }; cd src; f; cat .aws/config'), {}, denied('unparseable')],
  ['R19: a function keyword body changing directory', bash('function f { cd ~; }; f; cat .aws/config'), {}, denied('unparseable')],
  ['R19: a sourced file may change directory', bash('source x.sh; cat .aws/config'), {}, denied('unparseable')],
  ['R19: a sourced file is read', bash(`source ${q(path.join(home, '.aws', 'config'))}`), {}, denied('outside-readable')],
  ['R19: a PowerShell script may change location', pwsh('& .\\x.ps1; Get-Content .aws\\config'), {}, denied('unparseable')],

  // fix round 4, R17.3: CDPATH
  ['OOS-C1: CDPATH prefix on cd', bash(`CDPATH=${q(home)} cd .aws && cat credentials`), {}, denied('unparseable')],
  ['OOS-C1: export CDPATH', bash(`export CDPATH=${q(home)}; cd .aws; cat credentials`), {}, denied('unparseable')],
  ['OOS-C1: CDPATH assignment', bash(`CDPATH=${q(home)}; cd .aws && cat credentials`), {}, denied('unparseable')],
  ['OOS-C1: export a CDPATH set elsewhere', bash('export CDPATH; cd .aws'), {}, denied('unparseable')],
  ['OOS-C1: PowerShell $env:CDPATH', pwsh(`$env:CDPATH = ${q(home)}; bash -c 'cd .aws && cat credentials'`), {}, denied('unparseable')],
  ['OOS-C1: CDPATH in the hook environment', bash('cd .aws && cat credentials'), { env: { vars: { ...VARS, CDPATH: home } } }, denied('unparseable')],

  // fix round 4, R17.4: a symbolic link's target is resolved where the link is
  ['OOS-C2: ln -s with the link one level up', bash('cd src && ln -s ../outside ../lnk && cat ../lnk/credentials'), { grant: { permissions: EDIT } }, OUT_W],
  ['R17.4: ln -s into a subdirectory with a climbing target', bash('ln -s ../../outside src/lnk'), { grant: { permissions: EDIT } }, OUT_W],
  ['R17.4: ln -s with a target beside the link', bash('ln -s app.js src/app2.js'), { grant: { permissions: EDIT } }, 'allow'],
  ['R17.4: ln -s with a relative target into the checkout', bash('ln -s ../src/app.js src/again.js'), { grant: { permissions: EDIT } }, 'allow'],
  ['R17.4: ln -s into an existing directory', bash('ln -s ../../outside src'), { grant: { permissions: EDIT } }, OUT_W],
  ['R17.4: New-Item SymbolicLink with a target relative to the link', pwsh('New-Item -ItemType SymbolicLink -Path src\\lnk -Target ..\\..\\outside'), { grant: { permissions: EDIT } }, OUT_W],
  ['R17.4: mklink with a target relative to the link', bash(`cmd /c 'mklink /D src\\lnk ..\\..\\outside'`), { grant: { permissions: EDIT }, winOnly: CMD_ONLY }, OUT_W],

  // fix round 4, R17.5: cmd copy concatenation
  ['OOS-C3: copy a+<outside file>', bash(`cmd /c 'copy /b src\\app.js+"${path.join(outside, 'credentials')}" out.txt'`), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['OOS-C3: copy a+<outside file> from PowerShell', pwsh(`cmd /c "copy /b src\\app.js+\`"${path.join(outside, 'credentials')}\`" out.txt"`), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['OOS-C3: copy a + b with spaces', bash(`cmd /c 'copy src\\app.js + "${path.join(outside, 'credentials')}" /b out.txt'`), { grant: { permissions: EDIT }, winOnly: CMD_ONLY }, denied('outside-readable')],
  ['OOS-C3: copy a+b with no destination writes into a', bash(`cmd /c 'copy src\\app.js+"${path.join(outside, 'credentials')}"'`), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['OOS-C3: copy a+b of plain files', bash(`cmd /c 'copy /b src\\app.js+src\\app.js out.txt'`), { grant: { permissions: EDIT } }, 'allow'],

  // fix round 4, R17.6: copies and moves with no destination land in the current directory
  ['OOS-I: Copy-Item .mcp.json, no destination', pwsh(`Copy-Item ${q(path.join(tmp, '.mcp.json'))}`), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['OOS-I: Copy-Item -Recurse .claude, no destination', pwsh(`Copy-Item -Path ${q(path.join(tmp, 'stage', '.claude'))} -Recurse -Force`), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['OOS-I: cmd copy .mcp.json, one operand', bash(`cmd /c 'copy "${path.join(tmp, '.mcp.json')}"'`), { grant: { permissions: EDIT }, winOnly: CMD_ONLY }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['OOS-I: Move-Item, no destination, read-only run', pwsh(`Move-Item ${q(path.join(tmp, 'note3.txt'))}`), {}, denied('no-edit-permission')],
  ['OOS-I: Copy-Item, no destination, read-only run', pwsh(`Copy-Item ${q(path.join(tmp, 'note2.txt'))}`), {}, denied('no-edit-permission')],
  ['OOS-I: cmd copy, one operand, read-only run', bash(`cmd /c 'copy "${path.join(tmp, 'note.txt')}"'`), { winOnly: CMD_ONLY }, denied('no-edit-permission')],
  ['OOS-I: xcopy, one operand', bash(`cmd /c 'xcopy "${path.join(tmp, 'stage')}" /E /I'`), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['OOS-I: robocopy without a destination', bash(`robocopy ${q(path.join(tmp, 'stage'))}`), {}, /^QUILL_DENIED (no-edit-permission|protected-path): /],
  ['R17.6: Copy-Item -Path with a positional destination', pwsh(`Copy-Item -Path ${q(path.join(tmp, '.mcp.json'))} .mcp.json`), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['R17.6: Copy-Item into a named destination', pwsh(`Copy-Item ${q(path.join(tmp, 'note2.txt'))} -Destination src\\note2.txt`), { grant: { permissions: EDIT } }, 'allow'],
  ['R17.6: Compress-Archive reads its sources', pwsh(`Compress-Archive -Path ${q(path.join(home, '.aws'))} ${q(path.join(tmp, 'x.zip'))}`), {}, denied('outside-readable')],

  // fix round 4, R17.7 and P2r: a new name with a path in it
  ['P2r: Rename-Item -NewName an absolute path', pwsh(`Rename-Item -Path y -NewName ${q(path.join(checkout, '.mcp.json'))}`), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['P2r: Rename-Item to an absolute path, positional', pwsh(`Rename-Item y ${q(path.join(checkout, '.claude'))}`), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['P2r: Rename-Item -NewName with a directory', pwsh('Rename-Item x -NewName .\\.claude'), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['P2r: cmd ren to a path', bash(`cmd /c 'ren x sub\\.claude'`), { grant: { permissions: EDIT } }, denied('unparseable')],
  ['P2r: Rename-Item to a plain name', pwsh('Rename-Item -Path src\\app.js -NewName app2.js'), { grant: { permissions: EDIT } }, 'allow'],

  // fix round 3, N3: cmd's DOS wildcards < > "
  ['N3: cmd < wildcard beside the junction', bash(`cmd /c 'type "es<"'`), {}, denied('outside-readable')],
  ['N3: cmd > wildcard beside the junction', pwsh('cmd /c "type cred^>ntials"'), {}, denied('outside-readable')],
  ['N3: cmd copy reads its source', bash(`cmd /c 'copy "es>" out.txt'`), { grant: { permissions: EDIT } }, denied('outside-readable')],
  ['N3: cmd > wildcard over plain files', bash(`cmd /c 'type "src\\app.j>"'`), { winOnly: CMD_ONLY }, 'allow'],

  // fix round 3, P2: a rename's destination is a write path
  ['P2: cmd ren to .claude', bash('cmd /c ren x .claude'), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['P2: cmd rename to .mcp.json', bash('cmd /c rename x.json .mcp.json'), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .*needs a full-access run or a manual edit/],
  ['P2: Rename-Item to .claude', pwsh('Rename-Item x .claude'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['P2: Rename-Item -NewName .mcp.json in a subdirectory', pwsh('Rename-Item -Path src\\app.js -NewName .mcp.json'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['P2: Move-Item to .claude', pwsh('Move-Item x .claude'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['P2: cmd move to .claude', bash('cmd /c move x .claude'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['P2: mv to .mcp.json', bash('mv x.json .mcp.json'), { grant: { permissions: EDIT } }, denied('protected-path')],
  ['P2: an ordinary rename', bash('cmd /c ren src\\app.js app2.js'), { grant: { permissions: EDIT } }, 'allow'],

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
  ['pin: quoting does not change the action', bash('argocd app sync "pay-stg"'), { grant: { scopes: [ARGO_STG], actionPins: [PIN] } }, 'allow'],
  ['pin: helm with a context variable', bash('HELM_KUBECONTEXT=prod helm upgrade api ./chart'), { grant: { actionPins: [{ scope: 'k8s.write', pin: 'helm upgrade api ./chart' }] } }, critical('k8s.write', '')],
  ['pin: helm as pinned', bash('helm upgrade api ./chart --kube-context stg'), { grant: { scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write:stg', pin: 'helm upgrade api ./chart --kube-context stg' }] } }, 'allow'],
  ['pin: helm without its context is not covered by the scope', bash('helm upgrade api ./chart'), { grant: { scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write', pin: 'helm upgrade api ./chart' }] } }, critical('k8s.write', '')],
  ['pin: kubectl with another kubeconfig', bash('KUBECONFIG=/tmp/rw kubectl --context stg apply -f x.yaml'), { grant: { actionPins: [{ scope: 'k8s.write:stg', pin: 'kubectl --context stg apply -f x.yaml' }] } }, critical('k8s.write', 'stg')],

  // fix round 1, I2: the whole MCP input is the action
  ['MCP pin: a second app field naming another app', call('mcp__argocd__sync_application', { applicationName: 'pay-stg', name: 'pay-prod' }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, critical('argo.sync', 'pay-stg')],
  ['MCP pin: an extra option', call('mcp__argocd__sync_application', { applicationName: 'pay-stg', prune: true }, { mcp_server_source: 'user' }), { grant: { actionPins: [MCP_PIN] } }, critical('argo.sync', 'pay-stg')],
  ['MCP pin: the same input in another key order', call('mcp__argocd__sync_application', { revision: 'abc', applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { scopes: [ARGO_STG], actionPins: [{ scope: 'argo.sync', pin: 'mcp__argocd__sync_application {"applicationName":"pay-stg","revision":"abc"}' }] } }, 'allow'],

  // R48: a pin equal to each proposal-time bypass is refused, because no granted scope covers it
  ['R48: a pin without a granted scope allows nothing', bash('argocd app sync pay-stg'), { grant: { actionPins: [PIN] } }, critical('argo.sync', 'pay-stg')],
  ['R48: duplicate --context, pinned', bash('kubectl --context stg --context prod rollout restart deploy/api'), { grant: { scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write:stg', pin: 'kubectl --context stg --context prod rollout restart deploy/api' }] } }, /^QUILL_CRITICAL_CHANGE scope=k8s\.write target=stg: .*exactly once/],
  ['R48: an unknown option carrying the target word, pinned', bash('kubectl --context prod --v 9 -n stg rollout restart deploy/api'), { grant: { scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write', pin: 'kubectl --context prod --v 9 -n stg rollout restart deploy/api' }] } }, critical('k8s.write', 'prod')],
  ['R48: duplicate namespace, pinned', bash('kubectl --context stg -n pay --namespace prod rollout restart deploy/api'), { grant: { scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write:stg', pin: 'kubectl --context stg -n pay --namespace prod rollout restart deploy/api' }] } }, /^QUILL_CRITICAL_CHANGE scope=k8s\.write target=stg: .*more than once/],
  ['R48: two Argo apps, pinned', bash('argocd app sync pay-stg pay-prod'), { grant: { scopes: [ARGO_STG], actionPins: [{ scope: 'argo.sync:pay-stg', pin: 'argocd app sync pay-stg pay-prod' }] } }, critical('argo.sync', 'pay-stg')],
  ['R48: --app-namespace naming the target, pinned', bash('argocd app sync pay-prod --app-namespace pay-stg'), { grant: { scopes: [ARGO_STG], actionPins: [{ scope: 'argo.sync', pin: 'argocd app sync pay-prod --app-namespace pay-stg' }] } }, critical('argo.sync', 'pay-prod')],
  ['R48: the brief\'s argocd pin with --prune is allowed', bash('argocd app sync pay-stg --prune'), { grant: { scopes: [ARGO_STG], actionPins: [{ scope: 'argo.sync:pay-stg', pin: 'argocd app sync pay-stg --prune' }] } }, 'allow'],
  ['R48: the brief\'s kubectl pin is allowed', bash('kubectl --context stg -n pay rollout restart deploy/api'), { grant: { scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write:stg', pin: 'kubectl --context stg -n pay rollout restart deploy/api' }] } }, 'allow'],
  ['R48: duplicate namespace without a pin is not covered either', bash('kubectl --context stg -n pay -n prod rollout restart deploy/api'), { grant: { scopes: [K8S_STG] } }, /^QUILL_CRITICAL_CHANGE scope=k8s\.write target=stg: .*more than once/],
  ['MCP pin in the old tool-and-target form matches nothing', call('mcp__argocd__sync_application', { applicationName: 'pay-stg' }, { mcp_server_source: 'user' }), { grant: { actionPins: [{ scope: 'argo.sync', pin: 'mcp__argocd__sync_application pay-stg' }] } }, critical('argo.sync', 'pay-stg')],

  // fix round 1, I3: command patterns cover only the part they match
  ['matchers: a kubectl read does not cover a helm write', bash('helm --kube-context stg uninstall api; kubectl --context stg get pods'), { grant: { scopes: [KUBECTL_ONLY] } }, critical('k8s.write', 'stg')],
  ['matchers: a helm write alone', bash('helm --kube-context stg uninstall api'), { grant: { scopes: [KUBECTL_ONLY] } }, critical('k8s.write', 'stg')],
  ['matchers: kubectl writes they match', bash('kubectl --context stg delete pod api'), { grant: { scopes: [KUBECTL_ONLY] } }, 'allow'],
  ['R25: a covered write must be a command of its own', bash('kubectl --context stg get pods && kubectl --context stg delete pod api'), { grant: { scopes: [KUBECTL_ONLY] } }, critical('k8s.write', 'stg')],

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
  ['hosts: a wildcard host pattern', bash('curl -X POST https://api.example.com/v1/items'), { grant: { scopes: [{ name: 'http.write', target: 'api.example.com', matchers: { hosts: ['*.example.com'] }, fingerprint: 'f' }] } }, 'allow'],
  ['R25: http.write with no host covers nothing', bash('curl -X POST https://api.example.com/v1/items'), { grant: { scopes: [{ name: 'http.write', matchers: { hosts: ['*.example.com'] }, fingerprint: 'f' }] } }, critical('http.write', 'api.example.com')],
  ['hosts: another host', bash('curl -X POST https://api.other.com/v1/items'), { grant: { scopes: [{ name: 'http.write', matchers: { hosts: ['*.example.com'] }, fingerprint: 'f' }] } }, critical('http.write', 'api.other.com')],
  ['hosts: a package registry', bash('npm publish'), { grant: { scopes: [{ name: 'package.publish', matchers: { hosts: ['registry.npmjs.org'] }, fingerprint: 'f' }] } }, 'allow'],
  ['hosts: scp has no scope, so a host pattern cannot cover it', bash('scp a.txt files.example.com:/x'), { grant: { scopes: [{ name: 'http.write', matchers: { hosts: ['files.example.com'] }, fingerprint: 'f' }] } }, critical('external.write', 'files.example.com')],

  // fix round 1, M5: a write to the whole checkout says why it is refused
  ['deleting the whole checkout', bash('rm -rf .'), { grant: { permissions: EDIT } }, /^QUILL_DENIED protected-path: .* contains .*\.git, which is protected.*Name the files/],

  // full access: observe only
  ['full: a cluster write is allowed and recorded', bash('kubectl apply -f deploy.yaml'), FULL, 'allow', { scope: 'k8s.write', target: null, ambiguous: true }],
  ['full (N2): a write naming one context is recorded with it', bash('kubectl --context prod apply -f deploy.yaml'), FULL, 'allow', { scope: 'k8s.write', target: 'prod' }],
  ['full (N2): a write naming two contexts is recorded with none', bash('kubectl --context stg --context prod apply -f deploy.yaml'), FULL, 'allow', { scope: 'k8s.write', target: null, ambiguous: true }],
  ['full: a push to main is allowed and recorded', bash('git push origin main'), FULL, 'allow', { scope: 'git.protected', target: 'main' }],
  ['full: quill commands are allowed and recorded', bash('quill agent run PMO-1'), FULL, 'allow', { scope: 'privileged', target: null }],
  ['full: reading credentials is allowed', call('Read', { file_path: path.join(home, '.aws', 'config') }), FULL, 'allow', undefined],
  ['full: an untrusted MCP server is allowed', call('mcp__repo_db__get_rows', {}, { mcp_server_source: 'project' }), FULL, 'allow', undefined],
  ['full: a read records nothing', bash('kubectl get pods'), FULL, 'allow', undefined],
  ['full without the observe guard is enforced', bash('kubectl apply -f deploy.yaml'), { grant: { access: 'full' } }, critical('k8s.write', '')],
  ['observe guard with an autonomous grant is enforced', bash('kubectl apply -f deploy.yaml'), { env: FULL.env }, critical('k8s.write', '')],

  // I1 / R58: a read-only run uses git only through read-only forms; anything that writes the shared
  // repository's refs, objects, config, hooks or index needs commit, and ref writes keep the
  // protected-branch rule
  ...[
    'git status', 'git log --oneline -5', 'git show HEAD', 'git diff HEAD~1', 'git blame src/app.js', 'git grep -n foo', 'git ls-files', 'git ls-tree HEAD',
    'git cat-file -p HEAD', 'git rev-parse HEAD', 'git rev-list --count HEAD', 'git describe --tags', 'git branch', 'git branch -a', "git branch --list 'feat/*'",
    'git branch --contains HEAD', 'git branch --show-current', 'git branch -vv', 'git tag', "git tag -l 'v1*'", 'git tag --points-at HEAD', 'git remote -v', 'git remote show origin',
    'git config --get user.email', 'git config --list', 'git config user.email', 'git fetch', 'git fetch origin', 'git fetch origin main', 'git fetch --all --prune',
    'git reflog', 'git reflog show HEAD', 'git stash list', 'git stash show', 'git notes list', 'git notes show HEAD', 'git worktree list', 'git symbolic-ref HEAD',
    'git replace -l', 'git hash-object src/app.js', 'git clean -n', 'git apply --check x.patch', 'git submodule status', 'git lfs ls-files', 'git bisect log', 'git fsck',
    'git sparse-checkout list', 'git log --stat -- src',
  ].map((cmd) => [`I1: read-only form: ${cmd}`, bash(cmd), {}, 'allow']),
  ...[
    'git update-ref refs/heads/feat/y HEAD', 'git commit-tree HEAD^{tree} -m x', 'git hash-object -w src/app.js', 'git mktree', 'git write-tree',
    'git branch feat/y', 'git branch -f feat/y HEAD', 'git branch -D feat/y', 'git branch -d feat/y', 'git branch -m feat/y', 'git branch -M feat/a feat/b', 'git branch -c feat/y', 'git branch -C feat/a feat/b', 'git branch -u origin/feat/x',
    'git tag v1', 'git tag -a v1 -m x', 'git tag -d v1', 'git tag -f v1', 'git gc --prune=now', 'git gc', 'git prune', 'git repack -ad', 'git pack-refs --all', 'git prune-packed',
    'git reflog expire --expire=now --all', 'git reflog delete HEAD@{1}', 'git pull', 'git pull --rebase origin feat/x', 'git replace HEAD HEAD~1', 'git replace -d HEAD',
    'git notes add -m x', 'git notes remove HEAD', 'git stash', 'git stash push -m x', 'git stash pop', 'git stash drop', 'git stash clear', 'git symbolic-ref HEAD refs/heads/feat/y',
    'git worktree remove ../other', 'git worktree prune', 'git worktree move a b', 'git config user.email x@example.com', 'git config --unset user.email', 'git config --add a.b c',
    'git config set user.email x@example.com', 'git config --remove-section foo', 'git fetch origin feat/y:feat/y', 'git fetch origin +refs/heads/*:refs/tags/*', 'git fetch --prune-tags', 'git fetch --update-head-ok origin',
    'git add -A', 'git add src/app.js', 'git mv src/app.js src/b.js', 'git checkout feat/y', 'git checkout HEAD~1 -- src/app.js', 'git switch feat/y', 'git switch -c feat/y', 'git switch --detach HEAD~1',
    'git reset --hard HEAD~1', 'git reset', 'git reset -- src/app.js', 'git restore --staged src/app.js', 'git update-index --add src/app.js', 'git read-tree HEAD',
    'git apply --index x.patch', 'git apply --cached x.patch', 'git maintenance run', 'git commit-graph write', 'git multi-pack-index write', 'git unpack-objects',
    'git submodule update --init', 'git submodule sync', 'git lfs install', 'git lfs pull', 'git bisect start', 'git bisect good', 'git sparse-checkout set src', 'git rerere forget src/app.js',
    'git mergetool', 'git bundle unbundle x.bundle', 'git remote prune origin', 'git remote remove upstream', 'git fsck --lost-found',
  ].map((cmd) => [`I1: needs commit: ${cmd}`, bash(cmd), {}, denied('no-commit-permission')]),
  ['I1: git add without commit in an edit run', bash('git add -A'), { grant: { permissions: EDIT } }, denied('no-commit-permission')],
  ...['git checkout -- src/app.js', 'git restore src/app.js', 'git restore --worktree src/app.js', 'git clean -fd', 'git apply x.patch'].flatMap((cmd) => [
    [`I1: changes the checkout's files: ${cmd}`, bash(cmd), {}, denied('no-edit-permission')],
    [`I1: changes the checkout's files with edit_source: ${cmd}`, bash(cmd), { grant: { permissions: EDIT } }, 'allow'],
  ]),
  ...[
    'git update-ref refs/heads/feat/y HEAD', 'git branch feat/y', 'git branch -f feat/y HEAD', 'git branch -D feat/y', 'git tag v1', 'git stash', 'git add -A', 'git pull', 'git reset --hard HEAD~1',
    'git checkout feat/y', 'git switch -c feat/y', 'git fetch origin feat/y:feat/y', 'git config user.email x@example.com', 'git gc', 'git notes add -m x',
  ].map((cmd) => [`I1: with commit: ${cmd}`, bash(cmd), { grant: { permissions: COMMIT } }, 'allow']),
  ...[
    'git update-ref refs/heads/main HEAD', 'git update-ref main HEAD', 'git update-ref -d refs/heads/release/1.2', 'git update-ref --stdin', 'git branch -f main HEAD', 'git branch -D main', 'git branch -d develop',
    'git branch -m main', 'git branch -M feat/x main', 'git branch main', 'git branch -c main', 'git fetch origin main:main', 'git fetch . HEAD:main', 'git fetch origin +main:refs/heads/main',
    'git checkout main', 'git checkout -B main', 'git switch main', 'git switch -C main', 'git symbolic-ref HEAD refs/heads/main', 'git pull origin main:main', 'git stash branch main',
  ].map((cmd) => [`I1: protected branch: ${cmd}`, bash(cmd), { grant: { permissions: COMMIT } }, denied('protected-branch')]),
  ['I1: pull into a protected current branch', bash('git pull'), { grant: { permissions: COMMIT }, env: { currentBranch: 'main' } }, denied('protected-branch')],
  ['I1: reset of a protected current branch', bash('git reset --hard HEAD~3'), { grant: { permissions: COMMIT }, env: { currentBranch: 'main' } }, denied('protected-branch')],
  ['I1: update-ref of HEAD on a protected current branch', bash('git update-ref HEAD HEAD~1'), { grant: { permissions: COMMIT }, env: { currentBranch: 'main' } }, denied('protected-branch')],
  ['I1: commit on a protected current branch', bash('git commit -m x'), { grant: { permissions: COMMIT }, env: { currentBranch: 'main' } }, denied('protected-branch')],
  ['I1: global git config is never written', bash('git config --global user.email x@example.com'), { grant: { permissions: COMMIT } }, denied('unparseable')],
  ['I1: git grep that opens files in a program', bash('git grep -Ovim foo'), {}, denied('unparseable')],
  ['I1: git log --output writes a file in the checkout', bash('git log --output=log.txt'), {}, denied('no-edit-permission')],
  ['I1: git format-patch writes into the checkout', bash('git format-patch -1'), {}, denied('no-edit-permission')],
  ['I1: git format-patch to stdout', bash('git format-patch -1 --stdout'), {}, 'allow'],
  ['I1: git format-patch into the temp dir', bash(`git format-patch -1 -o ${q(path.join(tmp, 'patches'))}`), {}, 'allow'],

  // T16-deferred guard rows: a pin equal to the call does not widen what the granted scope covers
  ['R48: an argocd pin naming another server is not covered by the scope', bash('argocd app sync pay-stg --server argo-prod.example'), { grant: { scopes: [ARGO_STG], actionPins: [{ scope: 'argo.sync:pay-stg', pin: 'argocd app sync pay-stg --server argo-prod.example' }] } }, critical('argo.sync', 'pay-stg')],
];
