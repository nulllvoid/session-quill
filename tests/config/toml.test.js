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
  assert.throws(() => parseToml('[[arr]]\nx = 1'), (e) => e.code === 'toml-unsupported');
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
