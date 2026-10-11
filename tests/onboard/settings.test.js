import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { onboardSettings, DEFAULT_CLONE_HOSTS } from '../../src/onboard/settings.js';
import { resolveTracker } from '../../src/config/config.js';

const HOME = path.resolve('/home/me');

test('onboarding is off by default, clones go under the home folder, and the default hosts are the big forges', () => {
  const s = onboardSettings(undefined, { home: HOME });
  assert.deepEqual(s, { import_assigned: false, auto_clone_dir: path.join(HOME, 'quill-repos'), clone_hosts: DEFAULT_CLONE_HOSTS, repo_map: {}, warnings: [] });
});

test('onboarding settings are validated: hosts lower-cased, ~ expanded, repo_map keys checked', () => {
  const s = onboardSettings({ import_assigned: true, auto_clone_dir: '~/src', clone_hosts: ['GitHub.com', 'git.internal.example', 'not a host'], repo_map: { PROJ: 'backend', 'PROJ/Payments': 'git@github.com:acme/pay.git', 'acme/app': 'app', 'bad key!': 'x', EMPTY: ' ' } }, { home: HOME });
  assert.equal(s.import_assigned, true);
  assert.equal(s.auto_clone_dir, path.join(HOME, 'src'));
  assert.deepEqual(s.clone_hosts, ['github.com', 'git.internal.example']);
  assert.deepEqual(s.repo_map, { proj: 'backend', 'proj/payments': 'git@github.com:acme/pay.git', 'acme/app': 'app' });
  assert.equal(s.warnings.length, 2);
  const rel = onboardSettings({ auto_clone_dir: 'relative/dir', clone_hosts: 'github.com' }, { home: HOME });
  assert.equal(rel.auto_clone_dir, path.join(HOME, 'quill-repos'));
  assert.deepEqual(rel.clone_hosts, DEFAULT_CLONE_HOSTS);
  assert.equal(rel.warnings.length, 2);
});

test('a [tracker] table holding only onboarding settings turns on no key recognition', () => {
  assert.equal(resolveTracker({ tracker: { import_assigned: true, clone_hosts: ['github.com'], auto_clone_dir: '~/x', repo_map: { PROJ: 'a' } } }), null);
});

test('repo_map remotes with credentials are refused, and remotes are kept in normal form', () => {
  const s = onboardSettings({ repo_map: { A: 'https://user:pw@github.com/acme/a.git', B: 'https://tok@github.com/acme/b', C: 'https://github.com/acme/c/', D: 'backend' } }, { home: HOME });
  assert.deepEqual(s.repo_map, { c: 'https://github.com/acme/c.git', d: 'backend' });
  assert.equal(s.warnings.filter((w) => /carries credentials/.test(w)).length, 2);
  assert.ok(s.warnings.every((w) => !w.includes('pw') && !w.includes('tok@')), 'the secret never reaches a warning');
});
