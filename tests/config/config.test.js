import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadUserConfig, saveUserConfig, loadRepoConfig, resolveConfig, defaultUserConfig,
} from '../../src/config/config.js';
import { ensureMachineId, loadStoreMeta, writeStoreMeta, createStoreMeta } from '../../src/config/store.js';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-home-'));
  return { TRACKER_HOME: home };
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
  cfg.store_path = '/tmp/Tracker';
  cfg.projects = { demo: { name: 'Demo', repo_id: 'demo' } };
  saveUserConfig(cfg, env);
  const again = loadUserConfig(env);
  assert.equal(again.store_path, '/tmp/Tracker');
  assert.equal(again.projects.demo.name, 'Demo');
});

test('loadRepoConfig finds the nearest .tracker.toml walking up from cwd', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  fs.writeFileSync(path.join(repo, '.tracker.toml'), 'project_id = "demo"\ncategory = "feature"\nrepo_id = "demo"\n');
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
  const meta = createStoreMeta({ store_name: 'Tracker', owner_machine_id: a, timezone: 'UTC' });
  assert.equal(meta.schema_version, 1);
  writeStoreMeta(store, meta);
  assert.deepEqual(loadStoreMeta(store), meta);
  assert.equal(loadStoreMeta(fs.mkdtempSync(path.join(os.tmpdir(), 'st-empty-'))), null);
});
