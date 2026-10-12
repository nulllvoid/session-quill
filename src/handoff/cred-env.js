// The child environment of an autonomous or full-access run (spec §3, §4.4). The guard is defence
// in depth; the boundary for prod is that the owner's normal credentials do not resolve inside an
// autonomous run, so every credential location a CLI or SDK would read is redirected to a
// read-only profile, a granted scope's profile or an empty stub under `<runDir>/env/`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// One `report` entry per system of the spec §4.4 table.
export const CRED_SYSTEMS = ['kubernetes', 'aws', 'gcp', 'azure', 'databases', 'argo', 'git', 'netrc', 'registries'];

// Nested-session markers and anything that would name a program for git to run or inject git
// config. Every tier removes these (`childEnvFor`).
export const SESSION_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
export const GIT_PROGRAM_VARS = /^(GIT_EXTERNAL_DIFF|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/;
// Provider tokens and prompts that let git push; removed unless push or a PR is granted.
export const CREDENTIAL_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'BITBUCKET_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS'];

// The generic pass (spec §4.4): any inherited name that looks like a secret.
export const SECRET_NAME = /(token|secret|password|passwd|api_?key|credential|auth)/i;

// What the worker, the guard and Claude Code itself need. Never removed, never set by a scope. The
// user profile is never redirected: Claude Code's interactive login lives under it.
const PROTECTED = /^(QUILL_.*|PATH|SystemRoot|ComSpec|PATHEXT|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|CLAUDE_CONFIG_DIR|NODE_(?!AUTH_TOKEN$).*)$/;
// Commit identity is not a secret, though "AUTHOR" matches the generic pattern.
const GIT_IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/;
const ANTHROPIC_AUTH = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/;
const ALWAYS_REMOVED = /^CDPATH$/; // R17: CDPATH sends a relative `cd` outside the checkout.

// Inherited names each system removes in autonomous.
const REMOVE = {
  kubernetes: /^KUBECONFIG$/,
  aws: /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|ROLE_SESSION_NAME|PROFILE|DEFAULT_PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|CONTAINER_CREDENTIALS_FULL_URI|CONTAINER_CREDENTIALS_RELATIVE_URI|CONTAINER_AUTHORIZATION_TOKEN|CONTAINER_AUTHORIZATION_TOKEN_FILE|BEARER_TOKEN_BEDROCK|EC2_METADATA_DISABLED)$/,
  gcp: /^(CLOUDSDK_CONFIG|CLOUDSDK_AUTH_.*|CLOUDSDK_CORE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CREDENTIALS|GOOGLE_CLOUD_KEYFILE_JSON|GCLOUD_KEYFILE_JSON|GOOGLE_OAUTH_ACCESS_TOKEN|GOOGLE_GHA_CREDS_PATH)$/,
  azure: /^(AZURE_CONFIG_DIR|AZURE_CLIENT_.*|AZURE_TENANT_ID|AZURE_USERNAME|AZURE_PASSWORD|AZURE_FEDERATED_TOKEN_FILE|AZURE_ACCESS_TOKEN|ARM_.*)$/,
  databases: /^(PG.*|DATABASE_URL|MYSQL_.*|MONGO.*|REDIS_URL)$/,
  argo: /^ARGOCD_.*$/,
  trackers: /^(JIRA_.*|ATLASSIAN_.*|SLACK_.*)$/,
  // npm reads `npm_config_*` in any case on every platform.
  registries: /^(NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_USERCONFIG|NPM_CONFIG__AUTH.*|DOCKER_CONFIG|DOCKER_AUTH_CONFIG)$/i,
  netrc: /^NETRC$/,
  // Only without push_branch / open_draft_pr.
  git: /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITLAB_TOKEN|BITBUCKET_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|SSH_AGENT_PID|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|GCM_.*)$/,
};
// Kept with push_branch: the owner's git config, helper, provider tokens and ssh agent.
const PUSH_KEEP = REMOVE.git;
// Kept when claude itself authenticates through a cloud provider.
const PROVIDER_KEEP = { aws: /^AWS_/, gcp: /^(GOOGLE_|CLOUDSDK_|GCLOUD_|ANTHROPIC_VERTEX_|CLOUD_ML_REGION$)/ };

// Which system a variable name belongs to, so a scope or a read-only table can only set its own.
const OWNER = [
  ['kubernetes', /^KUBE/], ['aws', /^AWS_/], ['gcp', /^(CLOUDSDK_|GOOGLE_|GCLOUD_)/], ['azure', /^(AZURE_|ARM_)/],
  ['argo', /^ARGOCD_/], ['git', /^(GIT_|GCM_|SSH_|GH_|GITHUB_|GITLAB_|BITBUCKET_)/], ['netrc', /^NETRC$/],
  ['registries', /^(NPM_|NODE_AUTH_TOKEN$|DOCKER_)/i], ['databases', /^(PG|DATABASE_URL$|MYSQL_|MONGO|REDIS_URL$)/],
];
const SCOPE_SYSTEMS = { 'k8s.write': ['kubernetes'], 'cloud.write': ['aws', 'gcp', 'azure'], 'db.write': ['databases'], 'argo.sync': ['argo'], 'package.publish': ['registries'] };

const truthy = (v) => v != null && !/^(|0|false|no|off)$/i.test(String(v).trim());

function gitConfigValue(v) {
  return `"${String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The owner's commit identity, read the way git would without system config. Failure → omitted.
export function readGitUser(env) {
  const get = (key) => {
    try {
      const out = execFileSync('git', ['config', '--global', '--get', key], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      return out.trim() || null;
    } catch { return null; }
  };
  return { name: get('user.name'), email: get('user.email') };
}

function iniSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (m) { current = { name: m[1].trim().replace(/\s+/g, ' '), lines: [] }; sections.push(current); } else if (current) current.lines.push(line);
  }
  for (const s of sections) while (s.lines.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop();
  return sections;
}
const readText = (file) => { try { return file ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; } };

// Only `profile`'s section (and the sso-session it names) from the AWS files; no other profile's
// keys ever reach the run. `found` is false when neither file has the profile.
function awsProfileFiles(profile, configFile, credentialsFile) {
  const cfg = iniSections(readText(configFile));
  const creds = iniSections(readText(credentialsFile));
  const cfgSection = cfg.find((s) => s.name === `profile ${profile}` || (profile === 'default' && s.name === 'default'));
  const credSection = creds.find((s) => s.name === profile);
  let config = '';
  if (cfgSection) {
    config = `[${profile === 'default' ? 'default' : `profile ${profile}`}]\n${cfgSection.lines.join('\n')}\n`;
    const sso = cfgSection.lines.map((l) => l.match(/^\s*sso_session\s*=\s*(.+?)\s*$/)).find(Boolean);
    const ssoSection = sso && cfg.find((s) => s.name === `sso-session ${sso[1]}`);
    if (ssoSection) config += `\n[sso-session ${sso[1]}]\n${ssoSection.lines.join('\n')}\n`;
  }
  const credentials = credSection ? `[${profile}]\n${credSection.lines.join('\n')}\n` : '';
  return { config, credentials, found: Boolean(cfgSection || credSection) };
}

/**
 * Build a run's child environment.
 *
 * `full` keeps the owner's environment (R7), removing only what every tier removes (nested-session
 * markers, git program/config overrides); every system reports `owner` and no stub is written.
 *
 * `autonomous`, in order:
 * 1. Remove from the inherited variables: session markers, git program vars, `CDPATH`, each
 *    system's credential variables (spec §4.4 table), `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
 *    `CLAUDE_CODE_OAUTH_TOKEN` unless `apiBilling` (either silently drops claude.ai connectors; Claude
 *    Code then signs in from the owner's login, which is why `HOME`, `USERPROFILE`, `APPDATA`,
 *    `LOCALAPPDATA` are never redirected and `CLAUDE_CONFIG_DIR` is kept), and finally the generic
 *    pass: any name matching SECRET_NAME. `keepEnv` exempts names from the generic pass only: a
 *    redirected system's credentials come from `readonly`, a scope, push or `apiBilling`.
 *    Always kept: `QUILL_*`, `PATH`, `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, the profile
 *    variables above, `NODE_*` except `NODE_AUTH_TOKEN`, and git commit identity.
 * 2. Set each system to its read-only profile (referenced by path; the AWS files alone are
 *    written, holding only the read-only profile's section) or an empty stub under `<runDir>/env/`
 *    (dirs 0700, files 0600 where the OS supports modes). Git gets a global config that copies
 *    only `user.name` / `user.email` and empties `credential.helper`, plus `GIT_CONFIG_NOSYSTEM=1`
 *    (Git for Windows sets its helper at system level), `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`
 *    and `GCM_INTERACTIVE=never`.
 * 3. Apply granted `scopes` (`[{ name, target, env }]`, already resolved): a scope sets only its
 *    own system's variables and variables no system owns, never a protected one.
 *
 * `push_branch` / `open_draft_pr` keep the owner's git config, helper, provider tokens and ssh agent.
 * With `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` set, claude itself needs that cloud's
 * credentials, so that provider's variables stay as the owner has them (`report[aws|gcp] = 'owner'`)
 * and `report.provider = 'shared'`: the agent can use those credentials too.
 *
 * On win32 names match case-insensitively, and setting a variable removes every other casing of it.
 * `platform` is the argument, never `process.platform`, so both are testable on any host. Values
 * are never logged. `gitUser` is `{ name, email }`, a function returning that, or omitted to read
 * the owner's global git config.
 *
 * @returns {{ env: Record<string,string>, stubs: string[], report: Record<string,'readonly'|'stub'|'scope'|'owner'> }}
 */
export function buildChildEnv({ baseEnv = {}, access, permissions = {}, scopes = [], readonly = {}, runDir, platform = process.platform, keepEnv = [], apiBilling = false, gitUser } = {}) {
  readonly = readonly ?? {};
  permissions = permissions ?? {};
  const win = platform === 'win32';
  const re = (rx) => (win && !rx.flags.includes('i') ? new RegExp(rx.source, `${rx.flags}i`) : rx);
  const test = (rx, name) => re(rx).test(name);
  const same = (a, b) => (win ? a.toUpperCase() === b.toUpperCase() : a === b);
  const env = { ...baseEnv };
  const get = (name) => { const k = Object.keys(baseEnv).find((x) => same(x, name)); return k === undefined ? undefined : baseEnv[k]; };
  const del = (name) => { for (const k of Object.keys(env)) if (same(k, name)) delete env[k]; };
  const set = (name, value) => { del(name); env[name] = value; };

  for (const k of Object.keys(env)) if (SESSION_MARKERS.some((m) => same(k, m)) || test(GIT_PROGRAM_VARS, k)) delete env[k];
  if (access === 'full') return { env, stubs: [], report: Object.fromEntries(CRED_SYSTEMS.map((s) => [s, 'owner'])) };
  if (access !== 'autonomous') throw new Error(`buildChildEnv: access "${access}" is not autonomous or full`);
  if (typeof runDir !== 'string' || !runDir) throw new Error('buildChildEnv: autonomous access needs a runDir for its stubs');

  const push = Boolean(permissions.push_branch || permissions.open_draft_pr);
  const provider = { aws: truthy(get('CLAUDE_CODE_USE_BEDROCK')), gcp: truthy(get('CLAUDE_CODE_USE_VERTEX')) };
  const keep = new Set((keepEnv ?? []).map((n) => (win ? n.toUpperCase() : n)));
  const kept = (name) => keep.has(win ? name.toUpperCase() : name);
  const resolveValue = (v) => (v.startsWith('env:') ? get(v.slice(4)) : v);
  const user = typeof gitUser === 'function' ? gitUser() : gitUser === undefined ? (push ? null : readGitUser(baseEnv)) : gitUser;

  // 1. Removals over the inherited variables.
  for (const k of Object.keys(env)) {
    if (test(PROTECTED, k)) continue;
    const exempt = (push && test(PUSH_KEEP, k)) || (provider.aws && test(PROVIDER_KEEP.aws, k)) || (provider.gcp && test(PROVIDER_KEEP.gcp, k)) || (apiBilling && test(ANTHROPIC_AUTH, k));
    if (exempt) continue;
    const listed = test(ALWAYS_REMOVED, k) || test(ANTHROPIC_AUTH, k) || Object.entries(REMOVE).some(([sys, rx]) => (sys !== 'git' || !push) && test(rx, k));
    if (listed || (SECRET_NAME.test(k) && !kept(k) && !test(GIT_IDENTITY, k))) delete env[k];
  }

  // 2. Redirects.
  const stubs = [];
  const envDir = path.join(runDir, 'env');
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(envDir, 0o700); } catch { /* modes unsupported */ }
  const stubFile = (name, content = '') => {
    const p = path.join(envDir, name);
    fs.writeFileSync(p, content, { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* modes unsupported */ }
    stubs.push(p);
    return p;
  };
  const stubDir = (name) => {
    const p = path.join(envDir, name);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    stubs.push(p);
    return p;
  };
  const ownerOf = (name) => { const hit = OWNER.find(([, rx]) => test(rx, name)); return hit ? hit[0] : null; };
  const settable = (name, systems) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !test(PROTECTED, name) && !test(ANTHROPIC_AUTH, name) && !test(ALWAYS_REMOVED, name) && !test(GIT_PROGRAM_VARS, name) && !SESSION_MARKERS.some((m) => same(name, m)) && (ownerOf(name) === null || systems.includes(ownerOf(name)));
  const report = {};

  if (readonly.kubeconfig) { set('KUBECONFIG', readonly.kubeconfig); report.kubernetes = 'readonly'; } else { set('KUBECONFIG', stubFile('kubeconfig')); report.kubernetes = 'stub'; }

  const home = win ? get('USERPROFILE') : get('HOME');
  const awsDefault = (file) => (home ? path.join(home, '.aws', file) : null);
  const writeAws = (profile, configFile, credentialsFile) => {
    const files = profile ? awsProfileFiles(profile, configFile ?? awsDefault('config'), credentialsFile ?? awsDefault('credentials')) : { config: '', credentials: '', found: false };
    set('AWS_CONFIG_FILE', stubFile('aws-config', files.found ? files.config : ''));
    set('AWS_SHARED_CREDENTIALS_FILE', stubFile('aws-credentials', files.found ? files.credentials : ''));
    if (files.found) set('AWS_PROFILE', profile); else del('AWS_PROFILE');
    return files.found;
  };
  if (provider.aws) report.aws = 'owner';
  else {
    report.aws = writeAws(readonly.aws_profile, readonly.aws_config_file, readonly.aws_credentials_file) ? 'readonly' : 'stub';
    set('AWS_EC2_METADATA_DISABLED', 'true');
  }

  if (provider.gcp) report.gcp = 'owner';
  else {
    set('CLOUDSDK_CONFIG', readonly.gcloud_config ?? stubDir('gcloud'));
    if (readonly.google_application_credentials) set('GOOGLE_APPLICATION_CREDENTIALS', readonly.google_application_credentials);
    report.gcp = readonly.gcloud_config || readonly.google_application_credentials ? 'readonly' : 'stub';
  }

  set('AZURE_CONFIG_DIR', readonly.azure_config_dir ?? stubDir('azure'));
  report.azure = readonly.azure_config_dir ? 'readonly' : 'stub';

  set('PGPASSFILE', stubFile('pgpass'));
  set('PGSERVICEFILE', stubFile('pg_service.conf'));
  const applyTable = (table, system) => {
    let any = false;
    for (const [name, raw] of Object.entries(table ?? {})) {
      const value = typeof raw === 'string' ? resolveValue(raw) : undefined;
      if (typeof value === 'string' && settable(name, [system])) { set(name, value); any = true; }
    }
    return any;
  };
  report.databases = applyTable(readonly.db_env, 'databases') ? 'readonly' : 'stub';
  report.argo = applyTable(readonly.argocd_env, 'argo') ? 'readonly' : 'stub';

  set('NETRC', stubFile('netrc'));
  report.netrc = 'stub';
  set('NPM_CONFIG_USERCONFIG', stubFile('npmrc'));
  set('DOCKER_CONFIG', stubDir('docker'));
  report.registries = 'stub';

  set('GIT_TERMINAL_PROMPT', '0');
  set('GCM_INTERACTIVE', 'never');
  if (push) report.git = 'owner';
  else {
    let text = '';
    const fields = [['name', user && user.name], ['email', user && user.email]].filter(([, v]) => typeof v === 'string' && v.trim());
    if (fields.length) text += `[user]\n${fields.map(([k, v]) => `\t${k} = ${gitConfigValue(v)}\n`).join('')}`;
    text += '[credential]\n\thelper =\n';
    set('GIT_CONFIG_GLOBAL', stubFile('gitconfig', text));
    set('GIT_CONFIG_NOSYSTEM', '1');
    set('GIT_ASKPASS', 'echo');
    report.git = 'stub';
  }

  // 3. Granted scopes override their own system's entries only.
  for (const scope of scopes ?? []) {
    if (!scope || typeof scope.name !== 'string') continue;
    const name = scope.name.split(':')[0];
    const systems = SCOPE_SYSTEMS[name] ?? [];
    const senv = scope.env && typeof scope.env === 'object' ? scope.env : {};
    const awsKeys = Object.keys(senv).filter((k) => test(/^AWS_/, k));
    if (systems.includes('aws') && awsKeys.length && !provider.aws) {
      const pick = (k) => { const hit = awsKeys.find((x) => same(x, k)); return hit === undefined ? undefined : senv[hit]; };
      const profile = pick('AWS_PROFILE');
      let applied = profile ? writeAws(profile, pick('AWS_CONFIG_FILE'), pick('AWS_SHARED_CREDENTIALS_FILE')) : false;
      for (const k of awsKeys) {
        if (['AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'].some((x) => same(k, x)) || typeof senv[k] !== 'string') continue;
        set(k, senv[k]);
        applied = true;
      }
      if (applied) report.aws = 'scope';
    }
    for (const [k, v] of Object.entries(senv)) {
      if (typeof v !== 'string' || test(/^AWS_/, k) || !settable(k, systems)) continue;
      const owner = ownerOf(k);
      if (owner && provider[owner]) continue;
      set(k, v);
      if (owner) report[owner] = 'scope';
    }
  }

  if (provider.aws || provider.gcp) report.provider = 'shared';
  return { env, stubs: [...new Set(stubs)], report };
}
