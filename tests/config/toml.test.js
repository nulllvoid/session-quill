import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, stringifyToml } from '../../src/config/toml.js';

const SAMPLE = `# user config
store_path = "C:\\\\Users\\\\me\\\\Quill"
gate_enabled = true
stale_days = 5
phrases = ["approved", "lgtm"]

[projects.session-quill]
name = "Session Quill"
repo_id = "session-quill"

[repos.session-quill]
project_id = "session-quill"
deployment_environments = ["production"]
`;

test('parseToml handles strings, numbers, booleans, arrays and nested tables', () => {
  const cfg = parseToml(SAMPLE);
  assert.equal(cfg.store_path, 'C:\\Users\\me\\Quill');
  assert.equal(cfg.gate_enabled, true);
  assert.equal(cfg.stale_days, 5);
  assert.deepEqual(cfg.phrases, ['approved', 'lgtm']);
  assert.equal(cfg.projects['session-quill'].name, 'Session Quill');
  assert.deepEqual(cfg.repos['session-quill'].deployment_environments, ['production']);
});

test('parseToml rejects unsupported syntax with a diagnostic instead of lossy parsing', () => {
  assert.throws(() => parseToml('x = { inline = 1 }'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('[[arr.nested]]\nx = 1'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('x = 1979-05-27'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('x = "unterminated'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('just words'), (e) => e.code === 'toml-unsupported');
});

test('stringifyToml round-trips through parseToml', () => {
  const cfg = parseToml(SAMPLE);
  const text = stringifyToml(cfg);
  assert.deepEqual(parseToml(text), cfg);
});

test('stringifyToml preserves authored comments when given the previous text', () => {
  const cfg = parseToml(SAMPLE);
  cfg.stale_days = 7;
  const text = stringifyToml(cfg, { preserve: SAMPLE });
  assert.match(text, /^# user config/m);
  assert.match(text, /stale_days = 7/);
  assert.equal(parseToml(text).stale_days, 7);
});

test('parseToml accepts single-quoted literal strings without escape processing', () => {
  const cfg = parseToml("[tracker]\nkey_pattern = '\\b([A-Z][A-Z0-9]+-\\d+)\\b'  # regex\nprefixes = ['PMLA', \"PC\"]\nnote = 'a # not a comment'\n");
  assert.equal(cfg.tracker.key_pattern, '\\b([A-Z][A-Z0-9]+-\\d+)\\b');
  assert.deepEqual(cfg.tracker.prefixes, ['PMLA', 'PC']);
  assert.equal(cfg.tracker.note, 'a # not a comment');
  assert.throws(() => parseToml("x = 'it's'"), /literal string/);
  assert.throws(() => parseToml("x = ['open]"), /unterminated/);
});

test('top-level array tables parse in order and round-trip through stringifyToml', () => {
  const text = 'store_path = "/q"\n\n[[schedule]]\nname = "reconcile"\nevery = "2h"\njob = "reconcile"\n\n[[schedule]]\nname = "evening"\ncron = "30 19 * * 1-5"\njob = "reconcile"\nenabled = false\n';
  const cfg = parseToml(text);
  assert.deepEqual(cfg.schedule, [{ name: 'reconcile', every: '2h', job: 'reconcile' }, { name: 'evening', cron: '30 19 * * 1-5', job: 'reconcile', enabled: false }]);
  assert.deepEqual(parseToml(stringifyToml(cfg)), cfg);
  assert.throws(() => parseToml('schedule = ["x"]\n[[schedule]]\nname = "a"\n'), /collides/);
  assert.throws(() => parseToml('[[a.b]]\n'), /top-level/);
  assert.throws(() => parseToml('[[schedule]\n'), /malformed/);
});

test('quoted keys hold names a bare key cannot, such as owner/repo, and round-trip', () => {
  const cfg = parseToml('[tracker.repo_map]\nPROJ = "backend"\n"PROJ/Payments" = "payments"\n"acme/app" = "git@github.com:acme/app.git" # mapped\n');
  assert.deepEqual(cfg.tracker.repo_map, { PROJ: 'backend', 'PROJ/Payments': 'payments', 'acme/app': 'git@github.com:acme/app.git' });
  const text = stringifyToml(cfg);
  assert.match(text, /^"acme\/app" = "git@github.com:acme\/app.git"$/m);
  assert.match(text, /^PROJ = "backend"$/m);
  assert.deepEqual(parseToml(text), cfg);
  assert.throws(() => parseToml('"unterminated = 1'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('"" = "x"'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('"a\\"b" = "x"'), (e) => e.code === 'toml-unsupported');
});

// Scope tables (Task 11, review M8): quoted table-name parts and dotted keys, and their round trip.
test('quoted table-name parts and dotted keys parse; the writer quotes what needs quoting', () => {
  const text = '[scopes."k8s.write"]\nenv.KUBECONFIG = "/k/rw"\n"x.y".z = "q"\n\n[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "/k/stg"\n';
  const parsed = parseToml(text);
  assert.deepEqual(parsed.scopes['k8s.write'], { env: { KUBECONFIG: '/k/rw' }, 'x.y': { z: 'q' }, targets: { stg: { env: { KUBECONFIG: '/k/stg' } } } });
  assert.deepEqual(parseToml(stringifyToml(parsed)), parsed);
  assert.match(stringifyToml(parsed), /^\[scopes\."k8s\.write"\.targets\.stg\.env\]$/m);
  // what parsed before still parses the same
  assert.deepEqual(parseToml('[repos."owner/repo"]\na = "x=y" # c\n"q=r" = 1\n'), { repos: { 'owner/repo': { a: 'x=y', 'q=r': 1 } } });
});

test('names that reach an object prototype are refused anywhere in a key path', () => {
  for (const t of ['[scopes.__proto__]\nx = "y"\n', 'a.__proto__.b = "y"\n', '[a."constructor"]\nx = 1\n', 'prototype = 1\n']) {
    assert.throws(() => parseToml(t), (e) => e.code === 'toml-unsupported', t);
  }
  assert.equal({}.b, undefined);
  assert.equal({}.x, undefined);
});
