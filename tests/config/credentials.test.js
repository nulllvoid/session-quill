import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { credentialSettings } from '../../src/config/credentials.js';
import { loadRepoConfig } from '../../src/config/config.js';
import { parseToml } from '../../src/config/toml.js';

test('credential settings default to no read-only profiles, no kept variables and no API billing', () => {
  assert.deepEqual(credentialSettings({}), { readonly: {}, keepEnv: [], apiBilling: false, warnings: [] });
  assert.deepEqual(credentialSettings(undefined), { readonly: {}, keepEnv: [], apiBilling: false, warnings: [] });
});

test('[prod.readonly], keep_env and api_billing load from TOML', () => {
  const cfg = parseToml([
    '[handoff]',
    'keep_env = ["MY_SERVICE_API_KEY"]',
    'api_billing = true',
    '[prod.readonly]',
    'kubeconfig = "C:/ro.yaml"',
    'aws_profile = "ro"',
    'aws_config_file = "C:/aws/config"',
    'aws_credentials_file = "C:/aws/credentials"',
    'gcloud_config = "C:/gcloud-ro"',
    'google_application_credentials = "C:/ro-key.json"',
    'azure_config_dir = "C:/azure-ro"',
    '[prod.readonly.db_env]',
    'DATABASE_URL = "env:RO_DSN"',
    '[prod.readonly.argocd_env]',
    'ARGOCD_SERVER = "argo.example"',
  ].join('\n'));
  const s = credentialSettings(cfg);
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.keepEnv, ['MY_SERVICE_API_KEY']);
  assert.equal(s.apiBilling, true);
  assert.deepEqual(s.readonly, {
    kubeconfig: 'C:/ro.yaml', aws_profile: 'ro', aws_config_file: 'C:/aws/config', aws_credentials_file: 'C:/aws/credentials',
    gcloud_config: 'C:/gcloud-ro', google_application_credentials: 'C:/ro-key.json', azure_config_dir: 'C:/azure-ro',
    db_env: { DATABASE_URL: 'env:RO_DSN' }, argocd_env: { ARGOCD_SERVER: 'argo.example' },
  });
});

test('invalid values keep the default and warn without echoing the value', () => {
  const s = credentialSettings({
    handoff: { keep_env: 'GH_TOKEN', api_billing: 'yes' },
    prod: { readonly: { kubeconfig: 3, aws_profile: '', db_env: { 'BAD NAME': 'x', GOOD: 7, OK_NAME: 'secret-value' }, argocd_env: 'nope', unknown_key: 'x' } },
  });
  assert.deepEqual(s.keepEnv, []);
  assert.equal(s.apiBilling, false);
  assert.deepEqual(s.readonly, { db_env: { OK_NAME: 'secret-value' } });
  assert.ok(s.warnings.length >= 6, s.warnings.join('\n'));
  assert.ok(s.warnings.every((w) => !w.includes('secret-value') && !w.includes('nope')), 'values are never echoed');
  const mixed = credentialSettings({ handoff: { keep_env: ['A_KEY', 4, 'bad name'] } });
  assert.deepEqual(mixed.keepEnv, ['A_KEY']);
  assert.equal(mixed.warnings.length, 2);
});

test('a repository .quill.toml cannot set [prod] or [handoff]', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, '.quill.toml'), 'project_id = "demo"\n[handoff]\napi_billing = true\nkeep_env = ["GH_TOKEN"]\n[prod.readonly]\nkubeconfig = "/rw.yaml"\n');
  assert.deepEqual(loadRepoConfig(repo), { project_id: 'demo' });
});
