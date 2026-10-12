// The child environment of an autonomous or full-access run (spec §3, §4.4). The guard is defence
// in depth; the boundary for prod is that the owner's normal credentials do not resolve inside an
// autonomous run, so every credential location a CLI or SDK would read is redirected to a
// read-only profile, a granted scope's profile or an empty stub under `<runDir>/env/`. What no
// redirect can close is listed in `report.residual` (ADR 0026).
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

// Set in no-push runs so gh never falls back to the OS keyring: with an empty GH_CONFIG_DIR and no
// GH_TOKEN, `gh auth token` still returns the owner's keyring token (gh 2.102, checked on Windows).
export const NO_CREDENTIAL_PLACEHOLDER = 'quill-no-credentials';

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
  azure: /^(AZURE_CONFIG_DIR|AZURE_CLIENT_.*|AZURE_TENANT_ID|AZURE_USERNAME|AZURE_PASSWORD|AZURE_FEDERATED_TOKEN_FILE|AZURE_DEVOPS_EXT_PAT|AZURE_.*(TOKEN|_PAT|_KEY|SECRET|PASSWORD).*|AZD_.*|ARM_.*)$/,
  databases: /^(PG.*|DATABASE_URL|MYSQL_.*|MONGO.*|REDIS_URL)$/,
  argo: /^ARGOCD_.*$/,
  trackers: /^(JIRA_.*|ATLASSIAN_.*|SLACK_.*)$/,
  // npm reads `npm_config_*` in any case on every platform.
  registries: /^(NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_USERCONFIG|NPM_CONFIG__AUTH.*|DOCKER_CONFIG|DOCKER_AUTH_CONFIG)$/i,
  netrc: /^NETRC$/,
  // Only without push_branch / open_draft_pr.
  git: /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GITLAB_TOKEN|GLAB_CONFIG_DIR|BITBUCKET_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|SSH_AGENT_PID|GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|GCM_.*)$/,
};
// Kept with push_branch: the owner's git config, helper, provider tokens, gh/glab config and ssh.
const PUSH_KEEP = REMOVE.git;
// Kept when claude itself authenticates through a cloud provider: only what that provider's auth reads.
const PROVIDER_KEEP = {
  aws: /^AWS_/,
  gcp: /^(GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|CLOUDSDK_.*|ANTHROPIC_VERTEX_.*|CLOUD_ML_REGION|VERTEX_REGION_.*)$/,
};
// Inherited ARGOCD_OPTS flags that carry or select credentials; such a value is dropped whole.
const ARGOCD_CREDENTIAL_FLAGS = /(^|\s)(--config|--auth-token|--header|-H|--client-crt|--client-crt-key|--core)(=|\s|$)/;

// Which system a variable name belongs to, so a scope or a read-only table can only set its own.
const OWNER = [
  ['kubernetes', /^KUBE/], ['aws', /^AWS_/], ['gcp', /^(CLOUDSDK_|GOOGLE_|GCLOUD_)/], ['azure', /^(AZURE_|ARM_|AZD_)/],
  ['argo', /^ARGOCD_/], ['git', /^(GIT_|GCM_|SSH_|GH_|GITHUB_|GITLAB_|GLAB_|BITBUCKET_)/], ['netrc', /^NETRC$/],
  ['registries', /^(NPM_|NODE_AUTH_TOKEN$|DOCKER_)/i], ['databases', /^(PG|DATABASE_URL$|MYSQL_|MONGO|REDIS_URL$)/],
];
const SCOPE_SYSTEMS = { 'k8s.write': ['kubernetes'], 'cloud.write': ['aws', 'gcp', 'azure'], 'db.write': ['databases'], 'argo.sync': ['argo'], 'package.publish': ['registries'] };
// Scopes whose credentials are wholly their own system's: they never set a variable no system owns.
const OWNED_ONLY_SCOPES = new Set(['k8s.write', 'cloud.write', 'argo.sync']);
// AWS scope variables that are credentials (a region alone does not make the report `scope`).
const AWS_CREDENTIAL_KEYS = /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|CONTAINER_.*|BEARER_TOKEN_BEDROCK)$/;

// Non-credential git settings copied into the run's global config, so line endings, long paths and
// TLS behave as in the owner's checkout (Git for Windows sets several at system level).
const GIT_COPY = /^(core\.(autocrlf|eol|safecrlf|longpaths|symlinks|ignorecase|filemode|fscache)|http\.(sslbackend|sslcainfo|sslcapath|schannelcheckrevoke|schanneluseSSLcainfo)|init\.defaultbranch)$/i;

const truthy = (v) => v != null && !/^(|0|false|no|off)$/i.test(String(v).trim());
// Quoting for values a POSIX-style shell or shlex splits (GIT_SSH_COMMAND runs through Git's sh on
// every platform; argocd splits ARGOCD_OPTS with shlex).
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function gitConfigValue(v) {
  return `"${String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The owner's commit identity and GIT_COPY settings from system and global config. Two short git
// calls, cached per worker for 10 minutes (keyed by the variables that locate the files), so a run
// start does not block the worker each time. Failure → omitted.
const GIT_CACHE_MS = 10 * 60_000;
const gitCache = new Map();
export function readOwnerGitConfig(env, { now = Date.now() } = {}) {
  const key = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'PROGRAMDATA'].map((k) => env[k] ?? '').join('\0');
  const hit = gitCache.get(key);
  if (hit && now - hit.at < GIT_CACHE_MS) return hit.value;
  const values = {};
  // `git config --system` reads the system file even under GIT_CONFIG_NOSYSTEM, which git itself honours.
  for (const scope of truthy(env.GIT_CONFIG_NOSYSTEM) ? ['--global'] : ['--system', '--global']) {
    let out = '';
    try {
      out = execFileSync('git', ['config', scope, '--includes', '--get-regexp', '^(user|core|http|init)\\.'], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    } catch { /* no such file, or git missing */ }
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const i = line.indexOf(' ');
      const k = (i < 0 ? line : line.slice(0, i)).toLowerCase();
      if (k === 'user.name' || k === 'user.email' || GIT_COPY.test(k)) values[k] = i < 0 ? 'true' : line.slice(i + 1);
    }
  }
  const { 'user.name': name = null, 'user.email': email = null, ...config } = values;
  const value = { name, email, config };
  gitCache.set(key, { at: now, value });
  return value;
}

function gitStub(user) {
  const sections = new Map();
  const add = (k, v) => {
    const dot = k.indexOf('.');
    const section = k.slice(0, dot).toLowerCase();
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(`\t${k.slice(dot + 1)} = ${gitConfigValue(v)}\n`);
  };
  for (const f of ['name', 'email']) if (user && typeof user[f] === 'string' && user[f].trim()) add(`user.${f}`, user[f]);
  for (const [k, v] of Object.entries((user && user.config) || {})) if (GIT_COPY.test(k) && typeof v === 'string') add(k, v);
  let text = '';
  for (const [section, lines] of sections) text += `[${section}]\n${lines.join('')}`;
  return `${text}[credential]\n\thelper =\n`;
}

// Sections of an AWS-style INI file. A header may carry a trailing `#`/`;` comment. Fail closed:
// any line that starts with `[` ends the current section even when it does not parse as a header,
// so no line of another profile is ever appended to the one being copied.
function iniSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().startsWith('[')) {
      const m = line.match(/^\s*\[([^\]]*)\]\s*(?:[#;].*)?$/);
      current = m ? { name: m[1].trim().replace(/\s+/g, ' '), lines: [] } : null;
      if (current) sections.push(current);
    } else if (current) current.lines.push(line);
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
  let sso = false;
  if (cfgSection) {
    config = `[${profile === 'default' ? 'default' : `profile ${profile}`}]\n${cfgSection.lines.join('\n')}\n`;
    sso = cfgSection.lines.some((l) => /^\s*sso_/.test(l));
    const ref = cfgSection.lines.map((l) => l.match(/^\s*sso_session\s*=\s*(.+?)\s*$/)).find(Boolean);
    const ssoSection = ref && cfg.find((s) => s.name === `sso-session ${ref[1]}`);
    if (ssoSection) config += `\n[sso-session ${ref[1]}]\n${ssoSection.lines.join('\n')}\n`;
  }
  const credentials = credSection ? `[${profile}]\n${credSection.lines.join('\n')}\n` : '';
  return { config, credentials, found: Boolean(cfgSection || credSection), sso };
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
 * 2. `<runDir>/env/` is recreated empty, then each system points at its read-only profile
 *    (referenced by path; the AWS files alone are written, holding only the read-only profile's
 *    section) or an empty stub (dirs 0700, files 0600 where the OS supports modes):
 *    - GCP: `CLOUDSDK_CONFIG`, and `GOOGLE_APPLICATION_CREDENTIALS` → the read-only key, else the
 *      read-only config's ADC file, else an empty file (Node and Go client libraries read the default
 *      ADC file from APPDATA / ~/.config, not from CLOUDSDK_CONFIG; an invalid explicit file stops
 *      them instead of falling back).
 *    - Azure: `AZURE_CONFIG_DIR`, `AZD_CONFIG_DIR`, `AZURE_TOKEN_CREDENTIALS=AzureCliCredential`.
 *    - Argo: `ARGOCD_OPTS` gains `--config <empty stub>` unless the read-only table sets ARGOCD_OPTS.
 *    - Git without push: a global config holding `user.*`, a short allowlist of non-credential
 *      settings (GIT_COPY) and `credential.helper =`; command-scope config (`GIT_CONFIG_COUNT`) that
 *      empties `credential.helper` again after the checkout's own `.git/config` and sets
 *      `core.sshCommand`; `GIT_SSH_COMMAND` with no config file, no agent, batch mode and an empty
 *      identity file; `GIT_CONFIG_NOSYSTEM=1` (Git for Windows sets its helper at system level);
 *      `GIT_ASKPASS=echo`; empty `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR`; and `GH_TOKEN` /
 *      `GH_ENTERPRISE_TOKEN` set to a placeholder so gh never reads the keyring.
 *      `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` are set with or without push.
 * 3. Apply granted `scopes` (`[{ name, target, env }]`, already resolved): a scope sets only its
 *    own system's variables, never a protected one; k8s.write, cloud.write and argo.sync never set
 *    a variable no system owns. An AWS scope profile that is not found leaves the earlier files in
 *    place. Ignored scope entries are named (never their values) in `report.scope_errors`.
 *
 * `push_branch` / `open_draft_pr` keep the owner's git config, helper, provider tokens, gh/glab
 * config and ssh. With `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` set, claude itself
 * needs that cloud's credentials, so that provider's auth variables stay as the owner has them
 * (`report[aws|gcp] = 'owner'`) and `report.provider = 'shared'`: the agent can use them too.
 *
 * `report.residual` lists owner credentials that still resolve and that no variable redirects
 * (direct ssh, ~/.netrc via libcurl, the Az PowerShell context, an OS credential store reachable
 * through a credential helper, the AWS SSO token cache); each entry is a short sentence.
 *
 * On win32 names match case-insensitively, and setting a variable removes every other casing of it.
 * `platform` is the argument, never `process.platform`, so both are testable on any host. Values
 * are never logged. `gitUser` is `{ name, email, config }`, a function returning that, or omitted
 * to read the owner's system and global git config (readOwnerGitConfig).
 *
 * @returns {{ env: Record<string,string>, stubs: string[], report: Record<string, any> }}
 *   report: one of 'readonly' | 'stub' | 'scope' | 'owner' per CRED_SYSTEMS entry, plus
 *   `provider?: 'shared'`, `residual: string[]` (autonomous), `scope_errors?: string[]`.
 */
export function buildChildEnv({ baseEnv = {}, access, permissions = {}, scopes = [], readonly = {}, runDir, platform = process.platform, keepEnv = [], apiBilling = false, gitUser } = {}) {
  readonly = readonly ?? {};
  permissions = permissions ?? {};
  const win = platform === 'win32';
  const pathApi = win ? path.win32 : path.posix;
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
  const user = typeof gitUser === 'function' ? gitUser() : gitUser === undefined ? (push ? null : readOwnerGitConfig(baseEnv)) : gitUser;
  const inheritedArgoOpts = get('ARGOCD_OPTS');

  // 1. Removals over the inherited variables.
  for (const k of Object.keys(env)) {
    if (test(PROTECTED, k)) continue;
    const exempt = (push && test(PUSH_KEEP, k)) || (provider.aws && test(PROVIDER_KEEP.aws, k)) || (provider.gcp && test(PROVIDER_KEEP.gcp, k)) || (apiBilling && test(ANTHROPIC_AUTH, k));
    if (exempt) continue;
    const listed = test(ALWAYS_REMOVED, k) || test(ANTHROPIC_AUTH, k) || Object.entries(REMOVE).some(([sys, rx]) => (sys !== 'git' || !push) && test(rx, k));
    if (listed || (SECRET_NAME.test(k) && !kept(k) && !test(GIT_IDENTITY, k))) delete env[k];
  }

  // 2. Redirects, into a fresh stub directory (an earlier attempt's files never carry over).
  const stubs = [];
  const envDir = path.join(runDir, 'env');
  fs.rmSync(envDir, { recursive: true, force: true });
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
  const scopeErrors = [];
  let awsSso = false;

  if (readonly.kubeconfig) { set('KUBECONFIG', readonly.kubeconfig); report.kubernetes = 'readonly'; } else { set('KUBECONFIG', stubFile('kubeconfig')); report.kubernetes = 'stub'; }

  const homes = [...new Set((win ? [get('USERPROFILE'), get('HOME')] : [get('HOME')]).filter((h) => typeof h === 'string' && h))];
  const awsDefault = (file) => (homes[0] ? pathApi.join(homes[0], '.aws', file) : null);
  // Writes the AWS stubs for `profile`; `onlyIfFound` leaves earlier files alone when it is missing.
  const writeAws = (profile, configFile, credentialsFile, { onlyIfFound = false } = {}) => {
    const files = profile ? awsProfileFiles(profile, configFile ?? awsDefault('config'), credentialsFile ?? awsDefault('credentials')) : { config: '', credentials: '', found: false, sso: false };
    if (onlyIfFound && !files.found) return false;
    set('AWS_CONFIG_FILE', stubFile('aws-config', files.found ? files.config : ''));
    set('AWS_SHARED_CREDENTIALS_FILE', stubFile('aws-credentials', files.found ? files.credentials : ''));
    if (files.found) set('AWS_PROFILE', profile); else del('AWS_PROFILE');
    awsSso = files.found && files.sso;
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
    const roAdc = readonly.gcloud_config ? pathApi.join(readonly.gcloud_config, 'application_default_credentials.json') : null;
    set('GOOGLE_APPLICATION_CREDENTIALS', readonly.google_application_credentials ?? (roAdc && fs.existsSync(roAdc) ? roAdc : stubFile('gcloud-adc.json')));
    report.gcp = readonly.gcloud_config || readonly.google_application_credentials ? 'readonly' : 'stub';
  }

  set('AZURE_CONFIG_DIR', readonly.azure_config_dir ?? stubDir('azure'));
  set('AZD_CONFIG_DIR', stubDir('azd'));
  set('AZURE_TOKEN_CREDENTIALS', 'AzureCliCredential');
  report.azure = readonly.azure_config_dir ? 'readonly' : 'stub';

  set('PGPASSFILE', stubFile('pgpass'));
  set('PGSERVICEFILE', stubFile('pg_service.conf'));
  const applyTable = (table, system) => {
    const names = [];
    for (const [name, raw] of Object.entries(table ?? {})) {
      const value = typeof raw === 'string' ? resolveValue(raw) : undefined;
      if (typeof value === 'string' && settable(name, [system])) { set(name, value); names.push(name); }
    }
    return names;
  };
  report.databases = applyTable(readonly.db_env, 'databases').length ? 'readonly' : 'stub';
  const argoNames = applyTable(readonly.argocd_env, 'argo');
  report.argo = argoNames.length ? 'readonly' : 'stub';
  if (!argoNames.some((n) => same(n, 'ARGOCD_OPTS'))) {
    const carried = typeof inheritedArgoOpts === 'string' && inheritedArgoOpts.trim() && !ARGOCD_CREDENTIAL_FLAGS.test(inheritedArgoOpts) ? `${inheritedArgoOpts.trim()} ` : '';
    set('ARGOCD_OPTS', `${carried}--config ${shQuote(stubFile('argocd-config'))}`);
  }

  set('NETRC', stubFile('netrc'));
  report.netrc = 'stub';
  set('NPM_CONFIG_USERCONFIG', stubFile('npmrc'));
  set('DOCKER_CONFIG', stubDir('docker'));
  report.registries = 'stub';

  set('GIT_TERMINAL_PROMPT', '0');
  set('GCM_INTERACTIVE', 'never');
  if (push) report.git = 'owner';
  else {
    const sshCommand = `ssh -F none -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -i ${shQuote(stubFile('no-ssh-key'))}`;
    set('GIT_CONFIG_GLOBAL', stubFile('gitconfig', gitStub(user)));
    set('GIT_CONFIG_NOSYSTEM', '1');
    set('GIT_CONFIG_COUNT', '2');
    set('GIT_CONFIG_KEY_0', 'credential.helper');
    set('GIT_CONFIG_VALUE_0', '');
    set('GIT_CONFIG_KEY_1', 'core.sshCommand');
    set('GIT_CONFIG_VALUE_1', sshCommand);
    set('GIT_SSH_COMMAND', sshCommand);
    set('GIT_ASKPASS', 'echo');
    set('GH_CONFIG_DIR', stubDir('gh'));
    set('GLAB_CONFIG_DIR', stubDir('glab'));
    set('GH_TOKEN', NO_CREDENTIAL_PLACEHOLDER);
    set('GH_ENTERPRISE_TOKEN', NO_CREDENTIAL_PLACEHOLDER);
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
      let fromScope = false;
      if (profile) {
        fromScope = writeAws(profile, pick('AWS_CONFIG_FILE'), pick('AWS_SHARED_CREDENTIALS_FILE'), { onlyIfFound: true });
        if (!fromScope) scopeErrors.push(`${name}: AWS profile not found; the earlier AWS settings stay`);
      }
      for (const k of awsKeys) {
        if (['AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'].some((x) => same(k, x)) || typeof senv[k] !== 'string') continue;
        set(k, senv[k]);
        if (test(AWS_CREDENTIAL_KEYS, k)) fromScope = true;
      }
      if (fromScope) report.aws = 'scope';
    } else if (awsKeys.length) scopeErrors.push(`${name}: AWS variables ignored`);
    for (const [k, v] of Object.entries(senv)) {
      if (typeof v !== 'string' || test(/^AWS_/, k)) continue;
      const owner = ownerOf(k);
      if (!settable(k, systems) || (owner === null && OWNED_ONLY_SCOPES.has(name))) { scopeErrors.push(`${name}: ${k} is not this scope's to set; ignored`); continue; }
      if (owner && provider[owner]) continue;
      set(k, v);
      if (owner) report[owner] = 'scope';
    }
  }

  if (provider.aws || provider.gcp) report.provider = 'shared';
  report.residual = residuals({ homes, localAppData: get('LOCALAPPDATA'), pathApi, platform, awsSso });
  if (scopeErrors.length) report.scope_errors = scopeErrors;
  return { env, stubs: [...new Set(stubs)], report };
}

// Owner credentials no environment variable can redirect (spec §2 residual risk, ADR 0026). Only
// locations that exist are listed; the guard is the remaining layer for each.
function residuals({ homes, localAppData, pathApi, platform, awsSso }) {
  const exists = (...parts) => { try { return fs.existsSync(pathApi.join(...parts)); } catch { return false; } };
  const anyHome = (...parts) => homes.some((h) => exists(h, ...parts));
  const out = [];
  if (anyHome('.ssh')) out.push('ssh: ssh, scp and rsync run directly still read the keys and config in ~/.ssh');
  if (anyHome('.netrc') || anyHome('_netrc')) out.push('netrc: curl and git over https read ~/.netrc from the user profile');
  if (anyHome('.Azure') || (localAppData && exists(localAppData, '.IdentityService'))) out.push('azure: the Az PowerShell context and token cache in the user profile');
  if (awsSso && anyHome('.aws', 'sso', 'cache')) out.push("aws: the read-only profile uses SSO, and the owner's SSO token cache can request other roles");
  if (platform === 'win32') out.push('git: a credential helper run directly (git credential-manager) reads Windows Credential Manager');
  if (platform === 'darwin') out.push('git: a credential helper run directly (git credential-osxkeychain) reads the login keychain');
  return out;
}
