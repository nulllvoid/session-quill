import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildChildEnv, readOwnerGitConfig, CRED_SYSTEMS, NO_CREDENTIAL_PLACEHOLDER } from '../../src/handoff/cred-env.js';
import { childEnvFor } from '../../src/handoff/runner.js';

// Synthetic values only: nothing here comes from this machine's environment.
const BASE = Object.freeze({
  KUBECONFIG: 'C:/u/.kube/config',
  AWS_ACCESS_KEY_ID: 'x',
  AWS_PROFILE: 'prod',
  GOOGLE_APPLICATION_CREDENTIALS: 'k.json',
  PGPASSWORD: 'p',
  DATABASE_URL: 'postgres://owner@db/prod',
  GH_TOKEN: 't',
  NPM_TOKEN: 'n',
  MY_SERVICE_API_KEY: 'z',
  ANTHROPIC_API_KEY: 'a',
  PATH: '/usr/bin',
  HOME: '/home/owner',
});
const OWNER = { name: 'Owner Name', email: 'owner@example.test' };
const NONE = { read_source: true, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };

function tmpRun() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quill-cred-'));
}
function build(t, opts = {}) {
  const runDir = tmpRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const out = buildChildEnv({ baseEnv: BASE, access: 'autonomous', permissions: NONE, scopes: [], readonly: {}, runDir, platform: 'linux', gitUser: OWNER, ...opts, ...(opts.runDir ? {} : { runDir }) });
  return { ...out, runDir: opts.runDir ?? runDir };
}
const has = (env, k) => Object.prototype.hasOwnProperty.call(env, k);
const under = (p, dir) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir, 'env').toLowerCase() + path.sep);
const isEmptyFile = (p) => fs.statSync(p).isFile() && fs.statSync(p).size === 0;
const isEmptyDir = (p) => fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;

test('autonomous with no read-only profiles redirects every credential location to empty run-dir stubs', (t) => {
  const { env, stubs, report, runDir } = build(t);
  assert.ok(under(env.KUBECONFIG, runDir) && isEmptyFile(env.KUBECONFIG), 'KUBECONFIG is an empty stub under the run dir');
  for (const k of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) assert.ok(under(env[k], runDir) && isEmptyFile(env[k]), k);
  assert.equal(has(env, 'AWS_ACCESS_KEY_ID'), false);
  assert.equal(has(env, 'AWS_PROFILE'), false, 'no profile resolves when none is configured');
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
  assert.ok(under(env.CLOUDSDK_CONFIG, runDir) && isEmptyDir(env.CLOUDSDK_CONFIG), 'CLOUDSDK_CONFIG is an empty dir');
  assert.ok(under(env.GOOGLE_APPLICATION_CREDENTIALS, runDir) && isEmptyFile(env.GOOGLE_APPLICATION_CREDENTIALS), 'ADC points at an empty file, so client libraries cannot fall back to the default ADC file');
  assert.ok(under(env.AZURE_CONFIG_DIR, runDir) && isEmptyDir(env.AZURE_CONFIG_DIR), 'AZURE_CONFIG_DIR is an empty dir');
  assert.ok(under(env.AZD_CONFIG_DIR, runDir) && isEmptyDir(env.AZD_CONFIG_DIR), 'AZD_CONFIG_DIR is an empty dir');
  assert.equal(env.AZURE_TOKEN_CREDENTIALS, 'AzureCliCredential');
  for (const k of ['PGPASSWORD', 'DATABASE_URL', 'NPM_TOKEN', 'MY_SERVICE_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(has(env, k), false, `${k} removed`);
  assert.equal(env.GH_TOKEN, NO_CREDENTIAL_PLACEHOLDER, "the owner's GH_TOKEN is replaced by a placeholder that keeps gh off the keyring");
  for (const k of ['PGPASSFILE', 'PGSERVICEFILE', 'NETRC', 'NPM_CONFIG_USERCONFIG']) assert.ok(under(env[k], runDir) && isEmptyFile(env[k]), `${k} is an empty stub`);
  assert.ok(under(env.DOCKER_CONFIG, runDir) && isEmptyDir(env.DOCKER_CONFIG), 'DOCKER_CONFIG is an empty dir');
  assert.ok(under(env.GIT_CONFIG_GLOBAL, runDir));
  const gitconfig = fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8');
  assert.match(gitconfig, /\[credential\]\s*\n\s*helper =\s*\n/, 'the credential helper is set to empty');
  assert.match(gitconfig, /name = "Owner Name"/);
  assert.match(gitconfig, /email = "owner@example\.test"/);
  assert.deepEqual([env.GIT_CONFIG_NOSYSTEM, env.GCM_INTERACTIVE, env.GIT_TERMINAL_PROMPT, env.GIT_ASKPASS], ['1', 'never', '0', 'echo']);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/owner', 'the profile is never redirected: Claude Code logs in from it');
  for (const s of stubs) assert.ok(under(s, runDir), 'every stub lives under <runDir>/env');
  assert.equal(stubs.length, 17);
  assert.deepEqual(Object.keys(report).filter((k) => k !== 'residual' && k !== 'removed').sort(), [...CRED_SYSTEMS].sort());
  // ADR 0041: the inherited names removed, sorted; names only (tests/handoff/run-env.test.js has every path).
  assert.deepEqual(report.removed, ['ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'DATABASE_URL', 'GH_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'MY_SERVICE_API_KEY', 'NPM_TOKEN', 'PGPASSWORD']);
  assert.deepEqual(report.residual, [], 'nothing residual when the profile holds none of the known locations');
  for (const sys of CRED_SYSTEMS) assert.equal(report[sys], 'stub', sys);
  assert.equal(has(report, 'provider'), false);
});

test('stubs are owner-only where the OS supports it', { skip: process.platform === 'win32' && 'POSIX modes only' }, (t) => {
  const { env, runDir } = build(t);
  assert.equal(fs.statSync(path.join(runDir, 'env')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(env.KUBECONFIG).mode & 0o777, 0o600);
  assert.equal(fs.statSync(env.DOCKER_CONFIG).mode & 0o777, 0o700);
});

test('a git user that cannot be read is omitted, and quoting cannot break out of the stub', (t) => {
  const none = build(t, { gitUser: () => null });
  const text = fs.readFileSync(none.env.GIT_CONFIG_GLOBAL, 'utf8');
  assert.doesNotMatch(text, /\[user\]/);
  assert.match(text, /helper =/);
  const odd = build(t, { gitUser: { name: 'A "B" \\ C\n[credential]\nhelper = store', email: '' } });
  const oddText = fs.readFileSync(odd.env.GIT_CONFIG_GLOBAL, 'utf8');
  assert.equal(oddText.match(/^\s*helper\b/gm).length, 1, 'a name cannot add a second helper line');
  assert.match(oddText, /name = "A \\"B\\" \\\\ C \[credential\] helper = store"/);
});

test('read-only kubeconfig is referenced by path', (t) => {
  const { env, report, stubs } = build(t, { readonly: { kubeconfig: 'C:/ro.yaml' } });
  assert.equal(env.KUBECONFIG, 'C:/ro.yaml');
  assert.equal(report.kubernetes, 'readonly');
  assert.ok(!stubs.some((s) => /kubeconfig$/.test(s)), 'no kube stub when a profile is configured');
});

test('a granted k8s.write scope provides its own kubeconfig and touches nothing else', (t) => {
  const scopes = [{ name: 'k8s.write', target: 'stg', env: { KUBECONFIG: 'C:/stg-rw.yaml', AWS_PROFILE: 'admin', PATH: '/evil' } }];
  const { env, report } = build(t, { readonly: { kubeconfig: 'C:/ro.yaml' }, scopes });
  assert.equal(env.KUBECONFIG, 'C:/stg-rw.yaml');
  assert.equal(report.kubernetes, 'scope');
  assert.equal(has(env, 'AWS_PROFILE'), false, 'a kubernetes scope cannot set another system');
  assert.equal(env.PATH, '/usr/bin', 'nor a protected variable');
  assert.equal(report.aws, 'stub');
  const named = build(t, { scopes: [{ name: 'k8s.write:stg', env: { KUBECONFIG: 'C:/stg-rw.yaml' } }] });
  assert.equal(named.env.KUBECONFIG, 'C:/stg-rw.yaml', 'a name that still carries its target is understood');
});

test('push_branch keeps the owner git config, helper, tokens and ssh agent', (t) => {
  const base = { ...BASE, GITHUB_TOKEN: 'g', SSH_AUTH_SOCK: '/tmp/agent', SSH_AGENT_PID: '9', GIT_CONFIG_GLOBAL: '/home/owner/.gitconfig-work', GIT_SSH_COMMAND: 'ssh -i /home/owner/.ssh/deploy', GH_CONFIG_DIR: '/home/owner/.config/gh-work' };
  const { env, report, stubs } = build(t, { baseEnv: base, permissions: { ...NONE, edit_source: true, commit: true, push_branch: true } });
  assert.equal(env.GIT_CONFIG_GLOBAL, '/home/owner/.gitconfig-work', "the owner's own value, not a stub");
  assert.equal(has(env, 'GIT_CONFIG_NOSYSTEM'), false, 'the system-level helper still applies');
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR']) assert.equal(env[k], base[k], k);
  assert.equal(has(env, 'GIT_CONFIG_COUNT'), false, 'no command-scope reset of the owner helper');
  assert.equal(report.git, 'owner');
  assert.ok(!stubs.some((s) => /gitconfig$/.test(s)));
  assert.equal(has(env, 'NPM_TOKEN'), false, 'push does not bring other tokens back');
  const noPush = build(t, { baseEnv: { ...base } });
  for (const k of ['GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID']) assert.equal(has(noPush.env, k), false, `${k} removed without push`);
  for (const k of ['GIT_SSH_COMMAND', 'GH_CONFIG_DIR']) assert.notEqual(noPush.env[k], base[k], `${k} redirected without push`);
  assert.notEqual(noPush.env.GIT_CONFIG_GLOBAL, base.GIT_CONFIG_GLOBAL);
});

test('[handoff] keep_env keeps a named variable through the generic pass', (t) => {
  const { env } = build(t, { keepEnv: ['MY_SERVICE_API_KEY'] });
  assert.equal(env.MY_SERVICE_API_KEY, 'z');
  assert.equal(has(env, 'NPM_TOKEN'), false, 'only the named one');
});

test('Anthropic credentials are removed unless [handoff] api_billing = true', (t) => {
  const base = { ...BASE, ANTHROPIC_AUTH_TOKEN: 'b', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CONFIG_DIR: '/home/owner/.claude-alt', USERPROFILE: 'C:/Users/owner', APPDATA: 'C:/Users/owner/AppData/Roaming', LOCALAPPDATA: 'C:/Users/owner/AppData/Local' };
  const off = build(t, { baseEnv: base });
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(has(off.env, k), false, `${k} removed`);
  for (const k of ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(off.env[k], base[k], `${k} kept: Claude Code authenticates from the owner's login`);
  const on = build(t, { baseEnv: base, apiBilling: true });
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(on.env[k], base[k], `${k} kept with api_billing`);
});

test('worker and guard variables survive; CDPATH, NODE_AUTH_TOKEN and nested-session markers do not', (t) => {
  const base = { ...BASE, QUILL_HOME: '/q', QUILL_HANDOFF_ID: 'h1', QUILL_HANDOFF_GRANT_SHA256: 'abc', SystemRoot: 'C:/Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', TEMP: '/t', TMP: '/t', NODE_OPTIONS: '--max-old-space-size=4096', NODE_AUTH_TOKEN: 'na', CDPATH: '/elsewhere', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', GIT_EXTERNAL_DIFF: 'pwn', GIT_CONFIG_COUNT: '1', JIRA_URL: 'https://jira', SLACK_WEBHOOK: 'w', ARGOCD_SERVER: 'argo', MYSQL_HOST: 'm', MONGO_URI: 'mo', REDIS_URL: 'r', PGHOST: 'h', AZURE_CLIENT_ID: 'c', ARM_SUBSCRIPTION_ID: 's', SOME_PASSWD: 'p', XYZ_SECRET: 's' };
  const { env } = build(t, { baseEnv: base });
  assert.equal(env.GIT_CONFIG_COUNT, '2', "the inherited command-scope config is replaced by the run's own");
  for (const k of ['QUILL_HOME', 'QUILL_HANDOFF_ID', 'QUILL_HANDOFF_GRANT_SHA256', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'NODE_OPTIONS']) assert.equal(env[k], base[k], `${k} kept`);
  for (const k of ['NODE_AUTH_TOKEN', 'CDPATH', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'GIT_EXTERNAL_DIFF', 'JIRA_URL', 'SLACK_WEBHOOK', 'ARGOCD_SERVER', 'MYSQL_HOST', 'MONGO_URI', 'REDIS_URL', 'PGHOST', 'AZURE_CLIENT_ID', 'ARM_SUBSCRIPTION_ID', 'SOME_PASSWD', 'XYZ_SECRET']) assert.equal(has(env, k), false, `${k} removed`);
});

test('the generic pass never removes what the redirect sets', (t) => {
  const { env } = build(t, { readonly: { google_application_credentials: 'C:/ro-key.json', db_env: { DATABASE_URL: 'postgres://ro@db/prod', PGPASSWORD: 'ro' }, argocd_env: { ARGOCD_AUTH_TOKEN: 'ro-argo', ARGOCD_SERVER: 'argo.example' } } });
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, 'C:/ro-key.json');
  assert.equal(env.DATABASE_URL, 'postgres://ro@db/prod');
  assert.equal(env.PGPASSWORD, 'ro');
  assert.equal(env.ARGOCD_AUTH_TOKEN, 'ro-argo');
  assert.equal(env.GIT_ASKPASS, 'echo');
  assert.ok(env.AWS_SHARED_CREDENTIALS_FILE && env.PGPASSFILE);
});

test('read-only db_env and argocd_env may reference an inherited variable by name', (t) => {
  const base = { ...BASE, RO_DSN: 'postgres://ro@db/prod', RO_ARGO: 'ro-argo' };
  const { env, report } = build(t, { baseEnv: base, readonly: { db_env: { DATABASE_URL: 'env:RO_DSN', PGUSER: 'reader' }, argocd_env: { ARGOCD_AUTH_TOKEN: 'env:RO_ARGO', ARGOCD_SERVER: 'env:MISSING' } } });
  assert.equal(env.DATABASE_URL, base.RO_DSN);
  assert.equal(env.PGUSER, 'reader');
  assert.equal(env.ARGOCD_AUTH_TOKEN, base.RO_ARGO);
  assert.equal(has(env, 'ARGOCD_SERVER'), false, 'a reference to nothing sets nothing');
  assert.deepEqual([report.databases, report.argo], ['readonly', 'readonly']);
});

test('read-only GCP and Azure profiles are referenced by path, never copied', (t) => {
  const { env, report, stubs } = build(t, { readonly: { gcloud_config: 'C:/ro-gcloud', azure_config_dir: 'C:/ro-azure' } });
  assert.deepEqual([env.CLOUDSDK_CONFIG, env.AZURE_CONFIG_DIR], ['C:/ro-gcloud', 'C:/ro-azure']);
  assert.deepEqual([report.gcp, report.azure], ['readonly', 'readonly']);
  assert.ok(!stubs.some((s) => ['gcloud', 'azure'].includes(path.basename(s))), 'no config-dir stubs');
  assert.equal(path.basename(env.GOOGLE_APPLICATION_CREDENTIALS), 'gcloud-adc.json', 'a read-only config without its own ADC file still blocks the default ADC file');
  const ro = tmpRun();
  t.after(() => fs.rmSync(ro, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ro, 'application_default_credentials.json'), '{}');
  const withAdc = build(t, { readonly: { gcloud_config: ro }, platform: process.platform });
  assert.equal(withAdc.env.GOOGLE_APPLICATION_CREDENTIALS, path.join(ro, 'application_default_credentials.json'), "the read-only config's own ADC file, by path");
});

test('AWS stubs carry only the read-only profile section, and stay empty when it is missing', (t) => {
  const src = tmpRun();
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  const config = path.join(src, 'config');
  const creds = path.join(src, 'credentials');
  fs.writeFileSync(config, '[default]\nregion = us-east-1\n\n[profile ro]\nregion = eu-west-1\nsso_session = corp\n\n[profile admin]\nregion = eu-west-1\n\n[sso-session corp]\nsso_start_url = https://corp.example/start\n');
  fs.writeFileSync(creds, '[default]\naws_secret_access_key = OWNER-SECRET\n[ro]\naws_access_key_id = RO-ID\naws_secret_access_key = RO-SECRET\n[admin]\naws_secret_access_key = ADMIN-SECRET\n');
  const { env, report } = build(t, { readonly: { aws_profile: 'ro', aws_config_file: config, aws_credentials_file: creds } });
  assert.equal(env.AWS_PROFILE, 'ro');
  assert.equal(report.aws, 'readonly');
  const c = fs.readFileSync(env.AWS_CONFIG_FILE, 'utf8');
  const k = fs.readFileSync(env.AWS_SHARED_CREDENTIALS_FILE, 'utf8');
  assert.match(c, /\[profile ro\]/);
  assert.match(c, /\[sso-session corp\]/, 'the sso session the profile names comes along');
  assert.doesNotMatch(c, /\[default\]|admin/);
  assert.match(k, /RO-SECRET/);
  assert.doesNotMatch(k, /OWNER-SECRET|ADMIN-SECRET/);
  const missing = build(t, { readonly: { aws_profile: 'nope', aws_config_file: config, aws_credentials_file: creds } });
  assert.equal(missing.report.aws, 'stub');
  assert.equal(has(missing.env, 'AWS_PROFILE'), false);
  assert.ok(isEmptyFile(missing.env.AWS_CONFIG_FILE) && isEmptyFile(missing.env.AWS_SHARED_CREDENTIALS_FILE));
  const scoped = build(t, { readonly: { aws_profile: 'ro', aws_config_file: config, aws_credentials_file: creds }, scopes: [{ name: 'cloud.write', target: 'admin', env: { AWS_PROFILE: 'admin', AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: creds, AWS_REGION: 'eu-west-1' } }] });
  assert.equal(scoped.env.AWS_PROFILE, 'admin');
  assert.equal(scoped.env.AWS_REGION, 'eu-west-1');
  assert.equal(scoped.report.aws, 'scope');
  assert.notEqual(scoped.env.AWS_SHARED_CREDENTIALS_FILE, creds, 'the scope profile is copied, not the whole file');
  const sk = fs.readFileSync(scoped.env.AWS_SHARED_CREDENTIALS_FILE, 'utf8');
  assert.match(sk, /ADMIN-SECRET/);
  assert.doesNotMatch(sk, /OWNER-SECRET|RO-SECRET/);
  assert.deepEqual([scoped.report.gcp, scoped.report.azure], ['stub', 'stub'], 'cloud.write reports only the clouds it carries');
});

test('a cloud.write scope for GCP or a db.write scope reports its own system', (t) => {
  const { env, report } = build(t, { scopes: [{ name: 'cloud.write', target: 'proj', env: { CLOUDSDK_CONFIG: 'C:/rw-gcloud' } }, { name: 'db.write', target: 'stg', env: { DATABASE_URL: 'postgres://rw@db/stg', KUBECONFIG: 'C:/sneaky.yaml' } }, { name: 'package.publish', target: null, env: { NPM_TOKEN: 'pub' } }, { name: 'deploy', target: 'stg', env: { DEPLOY_TOKEN: 'd' } }] });
  assert.equal(env.CLOUDSDK_CONFIG, 'C:/rw-gcloud');
  assert.equal(env.DATABASE_URL, 'postgres://rw@db/stg');
  assert.notEqual(env.KUBECONFIG, 'C:/sneaky.yaml', 'a db scope cannot set the kubeconfig');
  assert.equal(env.NPM_TOKEN, 'pub');
  assert.equal(env.DEPLOY_TOKEN, 'd');
  assert.deepEqual([report.gcp, report.aws, report.databases, report.registries, report.kubernetes], ['scope', 'stub', 'scope', 'scope', 'stub']);
});

test('Bedrock or Vertex: the provider credentials stay for claude itself and the report says they are shared', (t) => {
  const bedrock = build(t, { baseEnv: { ...BASE, CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 's', AWS_BEARER_TOKEN_BEDROCK: 'bt', AWS_REGION: 'us-east-1' } });
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']) assert.equal(has(bedrock.env, k), true, k);
  assert.equal(has(bedrock.env, 'AWS_CONFIG_FILE'), false);
  assert.deepEqual([bedrock.report.aws, bedrock.report.provider], ['owner', 'shared']);
  assert.notEqual(bedrock.env.GOOGLE_APPLICATION_CREDENTIALS, 'k.json', 'only that provider');
  const vertex = build(t, { baseEnv: { ...BASE, CLAUDE_CODE_USE_VERTEX: 'true', ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUDSDK_CONFIG: '/home/owner/.config/gcloud', GOOGLE_API_KEY: 'g', GOOGLE_CLOUD_PROJECT: 'proj' } });
  assert.equal(has(vertex.env, 'GOOGLE_API_KEY'), false, 'only what Vertex auth reads is shared');
  assert.equal(vertex.env.GOOGLE_CLOUD_PROJECT, 'proj');
  assert.equal(vertex.env.GOOGLE_APPLICATION_CREDENTIALS, 'k.json');
  assert.equal(vertex.env.CLOUDSDK_CONFIG, '/home/owner/.config/gcloud');
  assert.deepEqual([vertex.report.gcp, vertex.report.provider], ['owner', 'shared']);
  assert.equal(has(vertex.env, 'AWS_ACCESS_KEY_ID'), false);
  const off = build(t, { baseEnv: { ...BASE, CLAUDE_CODE_USE_BEDROCK: '0' } });
  assert.equal(has(off.report, 'provider'), false, '"0" is not set');
});

test('full access keeps the owner environment, removing only what today removes', (t) => {
  const runDir = tmpRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const base = { ...BASE, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const { env, stubs, report } = buildChildEnv({ baseEnv: base, access: 'full', permissions: NONE, runDir, platform: 'linux' });
  const expected = { ...BASE };
  assert.deepEqual(env, expected);
  assert.deepEqual(stubs, []);
  for (const sys of CRED_SYSTEMS) assert.equal(report[sys], 'owner', sys);
  assert.equal(fs.existsSync(path.join(runDir, 'env')), false, 'no stubs written');
  const withGit = { ...base, GIT_EXTERNAL_DIFF: 'pwn' };
  assert.deepEqual(buildChildEnv({ baseEnv: withGit, access: 'full', permissions: NONE, runDir, platform: 'linux' }).env, childEnvFor(NONE, withGit, {}, { keepCredentials: true }), 'same as the keepCredentials path');
});

test('Windows: names match case-insensitively and each set variable has exactly one key', (t) => {
  const base = { Path: 'C:\\bin', aws_profile: 'prod', Aws_Access_Key_Id: 'x', kubeconfig: 'C:/u/.kube/config', Gh_Token: 't', cdpath: 'C:/x', Git_Config_Global: 'C:/u/.gitconfig', SystemRoot: 'C:\\Windows', UserProfile: 'C:\\Users\\owner', claudecode: '1', Quill_Home: 'C:/q' };
  const { env } = build(t, { baseEnv: base, platform: 'win32' });
  assert.equal(env.Path, 'C:\\bin');
  assert.equal(env.UserProfile, 'C:\\Users\\owner');
  assert.equal(env.Quill_Home, 'C:/q');
  for (const k of ['aws_profile', 'Aws_Access_Key_Id', 'Gh_Token', 'cdpath', 'claudecode']) assert.equal(has(env, k), false, `${k} removed`);
  const keys = Object.keys(env).map((k) => k.toUpperCase());
  for (const k of ['KUBECONFIG', 'GIT_CONFIG_GLOBAL', 'AWS_CONFIG_FILE']) assert.equal(keys.filter((x) => x === k).length, 1, `one ${k}`);
  assert.equal(has(env, 'KUBECONFIG'), true);
  const kept = build(t, { baseEnv: { ...base, my_service_api_key: 'z' }, platform: 'win32', keepEnv: ['MY_SERVICE_API_KEY'] });
  assert.equal(kept.env.my_service_api_key, 'z', 'keep_env matches any casing');
  const posix = build(t, { baseEnv: base, platform: 'linux' });
  assert.equal(posix.env.aws_profile, 'prod', 'on POSIX a lower-case name is a different variable');
});

test('autonomous needs a run dir; childEnvFor delegates for autonomous and full only', (t) => {
  assert.throws(() => buildChildEnv({ baseEnv: BASE, access: 'autonomous', permissions: NONE, platform: 'linux', gitUser: OWNER }), /runDir/);
  const runDir = tmpRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const auto = childEnvFor(NONE, BASE, { QUILL_HANDOFF_ID: 'h1' }, { access: 'autonomous', runDir, platform: 'linux', gitUser: OWNER, keepEnv: ['MY_SERVICE_API_KEY'] });
  assert.equal(auto.QUILL_HANDOFF_ID, 'h1');
  assert.equal(auto.MY_SERVICE_API_KEY, 'z');
  assert.ok(under(auto.KUBECONFIG, runDir));
  const full = childEnvFor(NONE, BASE, {}, { access: 'full', runDir, platform: 'linux' });
  assert.equal(full.GH_TOKEN, 't');
  const { GH_TOKEN: _gh, ...today } = BASE;
  for (const access of ['standard', 'settings', undefined]) {
    assert.deepEqual(childEnvFor(NONE, BASE, {}, { access }), { ...today, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }, `${access} keeps today's behaviour`);
  }
});

// Fix round 1 (task-9-findings-r1.md).

test('C1: AWS headers with comments, odd spacing or unparsable brackets never leak another profile', (t) => {
  const src = tmpRun();
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  const config = path.join(src, 'config');
  const creds = path.join(src, 'credentials');
  fs.writeFileSync(config, '[ profile ro ]\nregion = eu-west-1\n[profile admin] # prod admin\nrole_arn = arn:aws:iam::1:role/SYNTH-ADMIN\n[profile ro-admin]\nrole_arn = arn:aws:iam::1:role/SYNTH-RO-ADMIN\n');
  fs.writeFileSync(creds, '[ro]\naws_secret_access_key = SYNTH-RO\n[admin] ; prod\naws_secret_access_key = SYNTH-ADMIN-SECRET\n[ro]x\naws_session_token = SYNTH-BROKEN\n[ro-admin]\naws_secret_access_key = SYNTH-RO-ADMIN\n');
  const { env, report } = build(t, { readonly: { aws_profile: 'ro', aws_config_file: config, aws_credentials_file: creds } });
  const c = fs.readFileSync(env.AWS_CONFIG_FILE, 'utf8');
  const k = fs.readFileSync(env.AWS_SHARED_CREDENTIALS_FILE, 'utf8');
  assert.equal(report.aws, 'readonly');
  assert.match(c, /^\[profile ro\]\nregion = eu-west-1\n$/);
  assert.match(k, /^\[ro\]\naws_secret_access_key = SYNTH-RO\n$/, 'only the read-only section; an unparsable "[" line ends it');
  for (const leak of ['SYNTH-ADMIN', 'SYNTH-RO-ADMIN', 'SYNTH-BROKEN']) assert.ok(!c.includes(leak) && !k.includes(leak), leak);
});

test('C3: argocd gets an empty --config and never carries an inherited ARGOCD_OPTS', (t) => {
  const plain = build(t, { baseEnv: { ...BASE, ARGOCD_OPTS: '--grpc-web' } });
  const m = plain.env.ARGOCD_OPTS.match(/^--config '([^']+)'$/);
  assert.ok(m, 'an inherited value is dropped, even without credential flags');
  assert.ok(under(m[1], plain.runDir) && isEmptyFile(m[1]));
  assert.equal(plain.report.argo, 'stub');
  // argocd shlex-unquotes ARGOCD_OPTS, so quoted credential flags must not survive (review N1)
  for (const opts of ["'--auth-token' SYNTH", '"--auth-token" SYNTH', '--grpc-web --auth-token SYNTH', '--config /home/owner/.config/argocd/config', '--header Authorization:SYNTH', '-H x']) {
    const out = build(t, { baseEnv: { ...BASE, ARGOCD_OPTS: opts, ARGOCD_AUTH_TOKEN: 'SYNTH' } });
    assert.match(out.env.ARGOCD_OPTS, /^--config '[^']+'$/, `${opts.split(' ')[0]} drops the inherited value`);
    assert.equal(has(out.env, 'ARGOCD_AUTH_TOKEN'), false);
  }
  const ro = build(t, { readonly: { argocd_env: { ARGOCD_AUTH_TOKEN: 'ro', ARGOCD_SERVER: 'argo.example' } } });
  assert.match(ro.env.ARGOCD_OPTS, /^--config '/, 'a read-only token still never falls back to the owner config');
  const own = build(t, { readonly: { argocd_env: { ARGOCD_OPTS: '--config /ro/argocd.yaml' } } });
  assert.equal(own.env.ARGOCD_OPTS, '--config /ro/argocd.yaml', 'a read-only ARGOCD_OPTS wins');
});

test('I1: gh and glab get empty config dirs and gh a placeholder token without push', (t) => {
  const { env, runDir } = build(t, { baseEnv: { ...BASE, GH_ENTERPRISE_TOKEN: 'e', GH_CONFIG_DIR: '/home/owner/.config/gh', GLAB_CONFIG_DIR: '/home/owner/.config/glab-cli' } });
  for (const k of ['GH_CONFIG_DIR', 'GLAB_CONFIG_DIR']) assert.ok(under(env[k], runDir) && isEmptyDir(env[k]), k);
  assert.deepEqual([env.GH_TOKEN, env.GH_ENTERPRISE_TOKEN], [NO_CREDENTIAL_PLACEHOLDER, NO_CREDENTIAL_PLACEHOLDER]);
});

test('I2: git over ssh uses no config, agent or default key without push', (t) => {
  const runDir = path.join(tmpRun(), "it's here");
  t.after(() => fs.rmSync(path.dirname(runDir), { recursive: true, force: true }));
  const { env } = build(t, { runDir, baseEnv: { ...BASE, GIT_SSH: '/usr/bin/ssh-wrapper', GIT_SSH_VARIANT: 'ssh', SSH_ASKPASS: '/bin/ask' } });
  const m = env.GIT_SSH_COMMAND.match(/^ssh -F none -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -i '(.+)'$/);
  assert.ok(m, 'the redirected ssh command');
  assert.equal(m[1].replace(/'\\''/g, "'"), path.join(runDir, 'env', 'no-ssh-key'), 'the identity path is shell-quoted');
  assert.ok(isEmptyFile(path.join(runDir, 'env', 'no-ssh-key')), 'an existing empty identity, so ssh adds no default key');
  for (const k of ['GIT_SSH', 'GIT_SSH_VARIANT', 'SSH_ASKPASS']) assert.equal(has(env, k), false, k);
});

test('I3: command-scope config resets a credential helper from the checkout config (real git)', (t) => {
  const work = tmpRun();
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const base = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, TEMP: work, TMP: work, HOME: work, USERPROFILE: work };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  const git = (args, env, input) => execFileSync('git', args, { cwd: repo, env, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  fs.mkdirSync(repo);
  git(['init', '-q'], { ...base, GIT_CONFIG_NOSYSTEM: '1' });
  git(['config', 'credential.helper', '!f() { echo username=synth; echo password=SYNTH-LOCAL; }; f'], { ...base, GIT_CONFIG_NOSYSTEM: '1' });
  git(['config', 'credential.https://example.invalid.helper', '!f() { echo username=synth; echo password=SYNTH-URL; }; f'], { ...base, GIT_CONFIG_NOSYSTEM: '1' });
  const { env } = buildChildEnv({ baseEnv: base, access: 'autonomous', permissions: NONE, runDir: work, platform: process.platform, gitUser: OWNER });
  assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_KEY_1], ['2', 'credential.helper', '', 'core.sshCommand']);
  assert.equal(env.GIT_CONFIG_VALUE_1, env.GIT_SSH_COMMAND);
  let out = '';
  try { out = git(['credential', 'fill'], env, 'protocol=https\nhost=example.invalid\npath=x\n\n'); } catch (err) { out = String(err.stdout ?? ''); }
  assert.doesNotMatch(out, /SYNTH-/, 'neither the local nor the URL-specific helper answers');
});

test('I4: Azure developer CLI, DevOps PAT and token variables are covered', (t) => {
  const { env } = build(t, { baseEnv: { ...BASE, AZURE_DEVOPS_EXT_PAT: 'p', AZURE_STORAGE_KEY: 'k', AZURE_OPENAI_API_KEY: 'o', AZD_CONFIG_DIR: '/home/owner/.azd', AZURE_TOKEN_CREDENTIALS: 'dev', AZURE_LOCATION: 'westeurope' } });
  for (const k of ['AZURE_DEVOPS_EXT_PAT', 'AZURE_STORAGE_KEY', 'AZURE_OPENAI_API_KEY']) assert.equal(has(env, k), false, k);
  assert.notEqual(env.AZD_CONFIG_DIR, '/home/owner/.azd');
  assert.equal(env.AZURE_TOKEN_CREDENTIALS, 'AzureCliCredential');
  assert.equal(env.AZURE_LOCATION, 'westeurope', 'non-credential settings stay');
});

test('I6: an AWS scope reports scope only when its credentials are in effect', (t) => {
  const src = tmpRun();
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  const config = path.join(src, 'config');
  const creds = path.join(src, 'credentials');
  fs.writeFileSync(config, '[profile ro]\nregion = eu-west-1\n');
  fs.writeFileSync(creds, '[ro]\naws_secret_access_key = SYNTH-RO\n');
  const readonly = { aws_profile: 'ro', aws_config_file: config, aws_credentials_file: creds };
  const typo = build(t, { readonly, scopes: [{ name: 'cloud.write', target: 'x', env: { AWS_PROFILE: 'typo', AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: creds } }] });
  assert.equal(typo.report.aws, 'readonly', 'the read-only profile is still what resolves');
  assert.equal(typo.env.AWS_PROFILE, 'ro');
  assert.match(fs.readFileSync(typo.env.AWS_SHARED_CREDENTIALS_FILE, 'utf8'), /SYNTH-RO/);
  assert.deepEqual(typo.report.scope_errors, ['cloud.write: AWS profile not found; the earlier AWS settings stay']);
  const region = build(t, { scopes: [{ name: 'cloud.write', target: 'x', env: { AWS_REGION: 'eu-west-1' } }] });
  assert.equal(region.env.AWS_REGION, 'eu-west-1');
  assert.equal(region.report.aws, 'stub', 'a region alone is not a credential');
  const keys = build(t, { scopes: [{ name: 'cloud.write', target: 'x', env: { AWS_ACCESS_KEY_ID: 'SYNTH-ID', AWS_SECRET_ACCESS_KEY: 'SYNTH-S' } }] });
  assert.equal(keys.report.aws, 'scope');
});

test('M2: a reused run dir starts from empty stubs', (t) => {
  const runDir = tmpRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(runDir, 'env', 'gcloud'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'env', 'gcloud', 'credentials.db'), 'SYNTH');
  fs.writeFileSync(path.join(runDir, 'env', 'leftover'), 'SYNTH');
  const { env } = build(t, { runDir });
  assert.ok(isEmptyDir(env.CLOUDSDK_CONFIG));
  assert.equal(fs.existsSync(path.join(runDir, 'env', 'leftover')), false);
});

test('M3/M4: the owner git config is read once, and only non-credential settings reach the stub', (t) => {
  const home = tmpRun();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const global = path.join(home, 'gitconfig');
  fs.writeFileSync(global, '[user]\n\tname = Synth Owner\n[core]\n\tautocrlf = true\n\tlongpaths = true\n[credential]\n\thelper = store\n[http]\n\textraHeader = Authorization: SYNTH\n');
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: path.join(home, 'no-system-config') };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const first = readOwnerGitConfig(env);
  assert.equal(first.name, 'Synth Owner');
  assert.deepEqual(first.config, { 'core.autocrlf': 'true', 'core.longpaths': 'true' });
  fs.writeFileSync(global, '[user]\n\tname = Changed\n');
  assert.equal(readOwnerGitConfig(env), first, 'cached: no second git call');
  assert.equal(readOwnerGitConfig(env, { now: Date.now() + 11 * 60_000 }).name, 'Changed', 'refreshed after the cache period');
  const sys = path.join(home, 'system-config');
  fs.writeFileSync(sys, '[core]\n\tsymlinks = true\n');
  assert.equal(readOwnerGitConfig({ ...env, GIT_CONFIG_SYSTEM: sys }).config['core.symlinks'], 'true', 'system settings are copied');
  assert.equal(readOwnerGitConfig({ ...env, GIT_CONFIG_SYSTEM: sys, GIT_CONFIG_NOSYSTEM: '1' }).config['core.symlinks'], undefined, 'unless the owner turned system config off');
  const { env: child } = build(t, { gitUser: { ...first, config: { ...first.config, 'credential.helper': 'store', 'http.extraheader': 'SYNTH' } } });
  const text = fs.readFileSync(child.GIT_CONFIG_GLOBAL, 'utf8');
  assert.match(text, /\[core\]\n\tautocrlf = "true"\n\tlongpaths = "true"\n/);
  assert.doesNotMatch(text, /SYNTH|store/);
});

test('M6: kubernetes, cloud and argo scopes never set a variable no system owns', (t) => {
  const { env, report } = build(t, { scopes: [{ name: 'k8s.write', target: 'stg', env: { KUBECONFIG: 'C:/stg-rw.yaml', DEPLOY_TOKEN: 'SYNTH' } }, { name: 'deploy', target: 'stg', env: { RELEASE_TOKEN: 'r' } }] });
  assert.equal(has(env, 'DEPLOY_TOKEN'), false);
  assert.equal(env.RELEASE_TOKEN, 'r', 'a deploy scope may');
  assert.deepEqual(report.scope_errors, ["k8s.write: DEPLOY_TOKEN is not this scope's to set; ignored"]);
});

test('report.residual lists owner credentials that exist and no variable can redirect', (t) => {
  const home = tmpRun();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const d of ['.ssh', '.Azure', path.join('.aws', 'sso', 'cache')]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, '.netrc'), '');
  fs.writeFileSync(path.join(home, 'aws-config'), '[profile ro]\nsso_session = corp\n[sso-session corp]\nsso_start_url = https://corp.example/start\n');
  const { report } = build(t, { baseEnv: { ...BASE, HOME: home }, readonly: { aws_profile: 'ro', aws_config_file: path.join(home, 'aws-config') } });
  assert.deepEqual(report.residual.map((r) => r.split(':')[0]), ['ssh', 'netrc', 'azure', 'aws']);
  const win = build(t, { baseEnv: { PATH: 'C:\\bin', USERPROFILE: home }, platform: 'win32' });
  assert.ok(win.report.residual.some((r) => /Windows Credential Manager/.test(r)));
  // a win32 build joins paths the Windows way, which names this temp home only on Windows
  if (process.platform === 'win32') assert.ok(win.report.residual.some((r) => r.startsWith('ssh:')), 'USERPROFILE is the profile on Windows');
  // macOS and Linux: HOME is the profile, and USERPROFILE (set by some tools) is not
  const posix = build(t, { baseEnv: { PATH: '/usr/bin', USERPROFILE: home }, platform: 'darwin' });
  assert.equal(posix.report.residual.some((r) => r.startsWith('ssh:')), false, 'USERPROFILE is not the profile on macOS or Linux');
  assert.ok(posix.report.residual.some((r) => /login keychain/.test(r)));
  assert.ok(build(t, { baseEnv: { PATH: '/usr/bin', HOME: home }, platform: 'darwin' }).report.residual.some((r) => r.startsWith('ssh:')), 'HOME is the profile on macOS');
});

test('a cloud.write scope with Azure client credentials is not forced onto the CLI credential (review N3)', (t) => {
  const { env, report } = build(t, { scopes: [{ name: 'cloud.write', target: 'stg', env: { AZURE_CLIENT_ID: 'SYNTH-ID', AZURE_CLIENT_SECRET: 'SYNTH-S', AZURE_TENANT_ID: 'SYNTH-T' } }] });
  assert.equal(report.azure, 'scope');
  assert.equal(has(env, 'AZURE_TOKEN_CREDENTIALS'), false);
  assert.equal(env.AZURE_CLIENT_ID, 'SYNTH-ID');
  assert.equal(build(t).env.AZURE_TOKEN_CREDENTIALS, 'AzureCliCredential', 'without a scope the CLI-only chain stays');
});
