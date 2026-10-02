import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShell } from '../../src/gate/shell-grammar.js';

const allowedBash = ['pwd', 'git status', 'git status --short', 'git status --short --branch', 'git status --porcelain', 'ls', 'ls src', 'ls src tests', 'cat README.md', 'cat docs/PRD.md', 'cat C:/repo/README.md'];
const deniedBash = [
  'git status --short=1', 'git status -s', 'git status --short --short', 'git log', 'ls -la', 'cat a | grep b', 'pwd; rm -rf x', 'echo $(pwd)',
  'cat ../x', 'cat ./../x', 'git status # ok', 'pwd\nrm x', 'cat *.md', 'FOO=1 pwd', 'cat > out.txt', 'cat < in.txt', 'pwd && ls', 'ls ~',
  'cat "README.md"', "cat 'README.md'", 'cat -', 'cat --help', ' pwd', 'pwd ', 'rm -rf /', 'npm test', 'node script.js', 'ls `pwd`', 'cat {a,b}',
  'cat a?', 'cat [ab]', 'pwd !', '',
];

for (const cmd of allowedBash) {
  test(`bash allows: ${JSON.stringify(cmd)}`, () => {
    assert.equal(classifyShell(cmd, { shell: 'bash' }).allowed, true, cmd);
  });
}
for (const cmd of deniedBash) {
  test(`bash denies: ${JSON.stringify(cmd)}`, () => {
    const r = classifyShell(cmd, { shell: 'bash' });
    assert.equal(r.allowed, false, cmd);
    assert.ok(r.reason, 'reason provided');
  });
}

const allowedPs = ['Get-Location', 'Get-ChildItem', 'Get-ChildItem src', 'Get-Content README.md', 'Get-Content -Path README.md'];
const deniedPs = ['Get-Content -Path README.md -Raw', 'Get-Content -Path a -Path b', 'Get-ChildItem -Recurse', 'Get-Location | Out-File x', 'Remove-Item x', 'Get-Content $env:HOME', 'Get-Content ..\\x', 'Get-Content README.md; rm x', 'gci', 'Get-Content -Path', 'Get-Location extra'];

for (const cmd of allowedPs) {
  test(`powershell allows: ${JSON.stringify(cmd)}`, () => {
    assert.equal(classifyShell(cmd, { shell: 'powershell' }).allowed, true, cmd);
  });
}
for (const cmd of deniedPs) {
  test(`powershell denies: ${JSON.stringify(cmd)}`, () => {
    assert.equal(classifyShell(cmd, { shell: 'powershell' }).allowed, false, cmd);
  });
}

test('unknown shell is denied', () => {
  assert.equal(classifyShell('pwd', { shell: 'zsh' }).allowed, false);
});
