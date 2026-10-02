import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadUserConfig, saveUserConfig, loadRepoConfig, resolveConfig, defaultUserConfig, resolveGateMode, resolveTracker,
} from '../../src/config/config.js';
import { buildRuntimeIdentity } from '../../src/config/runtime.js';
import { ensureMachineId, loadStoreMeta, writeStoreMeta, createStoreMeta } from '../../src/config/store.js';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-home-'));
  return { QUILL_HOME: home };
}

test('loadUserConfig returns defaults when no file exists and saves round trip', () => {
  const env = tmpHome();
  const cfg = loadUserConfig(env);
  assert.equal(cfg.key_prefix, 'LOCAL');
  assert.equal(cfg.gate_enabled, true);
  assert.equal(cfg.approval_phrases_enabled, false);
  assert.equal(cfg.sync_interval_hours, 2);
  assert.equal(cfg.stale_days, 5);
  assert.equal(cfg.default_category, 'research');
  cfg.store_path = '/tmp/Quill';
  cfg.projects = { demo: { name: 'Demo', repo_id: 'demo' } };
  saveUserConfig(cfg, env);
  const again = loadUserConfig(env);
  assert.equal(again.store_path, '/tmp/Quill');
  assert.equal(again.projects.demo.name, 'Demo');
});

test('loadRepoConfig finds the nearest .quill.toml walking up from cwd', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  fs.writeFileSync(path.join(repo, '.quill.toml'), 'project_id = "demo"\ncategory = "feature"\nrepo_id = "demo"\n');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  const found = loadRepoConfig(path.join(repo, 'src', 'deep'));
  assert.deepEqual(found, { project_id: 'demo', category: 'feature', repo_id: 'demo' });
  assert.equal(loadRepoConfig(os.tmpdir()), null);
});

test('resolveConfig precedence is cli > session > repo > user and repo cannot weaken ownership', () => {
  const user = { ...defaultUserConfig(), default_category: 'research', projects: { u: {} }, key_prefix: 'LOCAL' };
  const r = resolveConfig({
    cli: { category: 'bugfix' },
    session: { project_id: 's' },
    repo: { project_id: 'r', category: 'feature', owner_machine_id: 'evil', handoff_permissions: { push_branch: true } },
    user,
  });
  assert.equal(r.category, 'bugfix');
  assert.equal(r.project_id, 's');
  assert.equal(r.key_prefix, 'LOCAL');
  assert.equal(r.owner_machine_id, undefined);
  assert.equal(r.handoff_permissions, undefined);
  assert.equal(resolveConfig({ user }).category, 'research');
});

test('ensureMachineId persists one UUID; store meta round trips', () => {
  const env = tmpHome();
  const a = ensureMachineId(env);
  const b = ensureMachineId(env);
  assert.equal(a, b);
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'st-store-'));
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: a, timezone: 'UTC' });
  assert.equal(meta.schema_version, 1);
  writeStoreMeta(store, meta);
  assert.deepEqual(loadStoreMeta(store), meta);
  assert.equal(loadStoreMeta(fs.mkdtempSync(path.join(os.tmpdir(), 'st-empty-'))), null);
});

test('gate mode defaults to nudge; legacy gate_enabled = false means off; invalid values fail closed to strict', () => {
  assert.equal(defaultUserConfig().gate.mode, 'nudge');
  assert.deepEqual(resolveGateMode(defaultUserConfig()), { mode: 'nudge', warnings: [] });
  assert.equal(resolveGateMode({ gate_enabled: false, gate: { mode: 'strict' } }).mode, 'off');
  const bad = resolveGateMode({ gate: { mode: 'loose' } });
  assert.equal(bad.mode, 'strict');
  assert.match(bad.warnings[0], /loose/);
});

test('a repository can tighten the gate mode but never loosen it', () => {
  assert.equal(resolveGateMode({ gate: { mode: 'nudge' } }, { gate: { mode: 'strict' } }).mode, 'strict');
  assert.equal(resolveGateMode({ gate: { mode: 'strict' } }, { gate: { mode: 'off' } }).mode, 'strict');
  assert.equal(resolveGateMode({ gate: { mode: 'nudge' } }, { gate: { mode: 'off' } }).mode, 'nudge');
});

test('tracker config merges repository over user values and is validated', () => {
  assert.equal(resolveTracker(defaultUserConfig(), null), null);
  const t = resolveTracker({ tracker: { system: 'jira', domain: 'https://example.atlassian.net' } }, { tracker: { prefixes: ['PMLA'] } });
  assert.deepEqual([t.system, t.domain, t.prefixes], ['jira', 'https://example.atlassian.net', ['PMLA']]);
  assert.throws(() => resolveTracker({}, { tracker: { key_pattern: '(a+)+' } }), /backtracking/);
});

test('a .quill.toml [tracker] table with a literal-string pattern loads end to end', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  fs.writeFileSync(path.join(repo, '.quill.toml'), "project_id = \"demo\"\n\n[tracker]\nsystem = \"jira\"\nkey_pattern = '\\b([A-Z][A-Z0-9]+-\\d+)\\b'\nprefixes = [\"PMLA\"]\n\n[gate]\nmode = \"strict\"\n");
  const cfg = loadRepoConfig(repo);
  assert.equal(resolveTracker({}, cfg).key_pattern, '\\b([A-Z][A-Z0-9]+-\\d+)\\b');
  assert.equal(resolveGateMode({}, cfg).mode, 'strict');
});

test('buildRuntimeIdentity resolves per-repository scopes and reports invalid config without failing', () => {
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  fs.writeFileSync(path.join(good, '.quill.toml'), 'project_id = "web"\n[tracker]\nprefixes = ["WEB"]\n[gate]\nmode = "strict"\n');
  fs.writeFileSync(path.join(bad, '.quill.toml'), "[tracker]\nkey_pattern = '(a+)+'\n");
  const config = { ...defaultUserConfig(), store_path: '/q', default_project: 'demo', projects: { demo: {} }, tracker: { system: 'jira', domain: 'https://example.atlassian.net' }, repos: { web: { project_id: 'web-old', canonical_path: good }, api: { project_id: 'api', canonical_path: bad }, ghost: { project_id: 'x' } } };
  const { identity, warnings } = buildRuntimeIdentity({ storeMeta: { store_id: 'S', owner_machine_id: 'M' }, config });
  assert.equal(identity.gate_mode, 'nudge');
  assert.equal(identity.tracker.system, 'jira');
  assert.equal(identity.default_project_id, 'demo');
  assert.equal(identity.repos.length, 2, 'repositories without a canonical path are skipped');
  const web = identity.repos.find((r) => r.repo_id === 'web');
  assert.deepEqual([web.path, web.project_id, web.gate_mode, web.tracker.prefixes, web.tracker.system], [path.resolve(good), 'web', 'strict', ['WEB'], 'jira']);
  const api = identity.repos.find((r) => r.repo_id === 'api');
  assert.equal(api.tracker, null);
  assert.match(warnings.join('\n'), /api: .*backtracking/);
});
