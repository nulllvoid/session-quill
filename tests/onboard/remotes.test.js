import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemote, remoteKey, checkCloneUrl, repoUrlFromLink, cloneFolderName, safeFolderName, normalizeRemote } from '../../src/onboard/remotes.js';

const HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

test('https and ssh forms of one repository share a remote key', () => {
  const key = 'github.com/acme/app';
  for (const url of ['https://github.com/acme/app', 'https://github.com/Acme/App.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app/', 'http://github.com/acme/app.git', 'https://x-token@github.com/acme/app.git']) {
    assert.equal(remoteKey(url), key, url);
  }
  assert.equal(remoteKey('git@gitlab.com:group/sub/proj.git'), 'gitlab.com/group/sub/proj');
  assert.equal(remoteKey('C:/repos/app'), null);
  assert.equal(remoteKey(''), null);
});

test('only https and ssh addresses on an allowed host can be cloned', () => {
  assert.deepEqual(checkCloneUrl('https://github.com/acme/app.git', HOSTS).segments, ['acme', 'app']);
  assert.equal(checkCloneUrl('git@gitlab.com:group/sub/proj.git', HOSTS).name, 'proj');
  assert.equal(checkCloneUrl('ssh://git@bitbucket.org/team/repo.git', HOSTS).protocol, 'ssh');
  const refused = (url, code) => assert.throws(() => checkCloneUrl(url, HOSTS), (e) => e.code === code, url);
  refused('https://evil.example/acme/app.git', 'clone-host-refused');
  refused('https://github.com.evil.example/acme/app.git', 'clone-host-refused');
  refused('https://user:secret@github.com/acme/app.git', 'clone-credentials');
  refused('https://token@github.com/acme/app.git', 'clone-credentials');
  refused('ssh://git:pw@github.com/acme/app.git', 'clone-credentials');
  refused('file:///etc/passwd', 'clone-transport-refused');
  refused('FILE://C:/repo', 'clone-transport-refused');
  refused('ext::sh -c touch% /tmp/pwned', 'clone-url-invalid');
  refused('ext::ssh', 'clone-transport-refused');
  refused('fd::17', 'clone-transport-refused');
  refused('http://github.com/acme/app.git', 'clone-transport-refused');
  refused('git://github.com/acme/app.git', 'clone-transport-refused');
  refused('--upload-pack=touch /tmp/x', 'clone-url-invalid');
  refused('-u', 'clone-url-invalid');
  refused('https://github.com/--upload-pack=x/app.git', 'clone-url-invalid');
  refused('https://github.com/acme/-app', 'clone-url-invalid');
  refused('https://github.com/acme/../app', 'clone-url-invalid');
  refused('https://github.com/acme/%2e%2e', 'clone-url-invalid');
  refused('https://github.com/acme', 'clone-url-invalid');
  refused('https://github.com/acme/app?x=1', 'clone-url-invalid');
  refused('git@github.com:/abs/path.git', 'clone-url-invalid');
  refused('git@github.com:acme/app.git;touch x', 'clone-url-invalid');
  refused('/local/path/repo', 'clone-url-invalid');
  refused('../repo', 'clone-url-invalid');
  refused('C:\\repos\\app', 'clone-url-invalid');
  refused('', 'clone-url-invalid');
  refused(`https://github.com/acme/${'a'.repeat(400)}`, 'clone-url-invalid');
});

test('tracker links on an allowed forge name their repository', () => {
  assert.equal(repoUrlFromLink('https://github.com/acme/app/pull/42', HOSTS), 'https://github.com/acme/app.git');
  assert.equal(repoUrlFromLink('https://gitlab.com/group/sub/proj/-/merge_requests/3', HOSTS), 'https://gitlab.com/group/sub/proj.git');
  assert.equal(repoUrlFromLink('https://bitbucket.org/team/repo/pull-requests/9', HOSTS), 'https://bitbucket.org/team/repo.git');
  assert.equal(repoUrlFromLink('https://example.atlassian.net/browse/PROJ-1', HOSTS), null);
  assert.equal(repoUrlFromLink('http://github.com/acme/app', HOSTS), null);
  assert.equal(repoUrlFromLink('https://github.com/acme', HOSTS), null);
  assert.equal(repoUrlFromLink('not a url', HOSTS), null);
});

test('clone folder names are safe on every platform', () => {
  assert.equal(cloneFolderName(parseRemote('https://github.com/acme/My.App.git')), 'My.App');
  assert.equal(cloneFolderName(parseRemote('git@github.com:acme/hidden-.git')), 'hidden');
  assert.throws(() => cloneFolderName(parseRemote('https://github.com/acme/CON')), (e) => e.code === 'clone-url-invalid');
});

test('folder names are cleaned again after the cut and never a device name with an extension', () => {
  assert.equal(safeFolderName(`${'a'.repeat(63)}.git-x`), 'a'.repeat(63));
  assert.equal(safeFolderName(`${'b'.repeat(63)}-tail`), 'b'.repeat(63));
  for (const bad of ['con.txt', 'NUL.git', 'com1.repo', 'lpt9', 'aux', '...', '-']) assert.throws(() => safeFolderName(bad), (e) => e.code === 'clone-url-invalid', bad);
  assert.equal(safeFolderName('console'), 'console');
});

test('remotes are kept in a normal form with no userinfo beyond the ssh login', () => {
  assert.equal(normalizeRemote('https://github.com/Acme/App/'), 'https://github.com/Acme/App.git');
  assert.equal(normalizeRemote('git@github.com:acme/app'), 'git@github.com:acme/app.git');
  assert.equal(normalizeRemote('ssh://git@host.example:2222/a/b.git'), 'ssh://git@host.example:2222/a/b.git');
  assert.equal(normalizeRemote('https://token@github.com/acme/app'), null);
  assert.equal(normalizeRemote('file:///x'), null);
});
