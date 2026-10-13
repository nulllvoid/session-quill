// Write scopes for autonomous runs (spec §4.3, ADR 0026): the built-in catalog, and the owner's
// `[scopes.<name>]` tables from the user config only (`scopes` is a user-only field, so a
// repository's .quill.toml can never widen what a run may change):
//
//   [scopes."k8s.write"]                  # override or extend a built-in
//   label = "Staging clusters"            # what the Run dialog calls it
//   permits = "…"                         # what it permits, in the owner's words
//   bash = ["kubectl *"]                  # matchers the owner names replace the built-in list
//   env.KUBECONFIG = "/abs/rw-kubeconfig" # credentials the run switches to when it is granted
//
//   [scopes."k8s.write".targets.stg]      # credentials for one target (wins over the scope's own env)
//   env.KUBECONFIG = "env:STG_RW_KUBECONFIG"   # "env:NAME" takes an inherited variable at dispatch
//
//   [scopes."pager.write"]                # an owner scope: MCP tools only, mapped by [mcp_policy.write]
//   mcp = ["mcp__pager__create_incident"]
//   takes_target = false
//
// Matchers are data, not code: `mcp` are MCP tool-name patterns, `bash` command patterns matched
// against the command's own words, `hosts` host patterns for network writes; `*` is the only
// wildcard and `{target}` stands for the granted target. A scope covers a call only when the
// guard classified the call as that scope, the call names exactly that one target with nothing
// that changes where it connects (ruling R24), and one of its matchers fits. Owner scopes cover MCP
// tools only. Literal secrets never come from config.toml (literalSecretReason): they must be
// `env:NAME` references. Invalid entries are ignored with a warning that names the key, never
// the value.

import { SECRET_NAME, credentialSystemOf } from '../handoff/cred-env.js';

// Literal values config.toml never holds (I1): secret-looking names (cred-env SECRET_NAME, or
// ending _PWD / _PASS / _PASSPHRASE), connection URLs of the database and registry systems, URLs
// with a password in them, and Authorization header values. They must be "env:NAME" references.
const SECRET_SUFFIX = /(_PWD|_PASS|_PASSPHRASE|PASSWD)$/i;
const URL_NAME = /_(URL|URI|DSN)$/i;
const URL_PASSWORD = /:\/\/[^/?#@\s]*:[^/?#@\s]*@/;
const AUTH_VALUE = /^\s*(proxy-)?authorization\s*:|\b(bearer|basic|token)\s+[A-Za-z0-9+/=._~-]{8,}/i;
export function literalSecretReason(name, value) {
  if (SECRET_NAME.test(name) || SECRET_SUFFIX.test(name)) return 'looks like a secret';
  if (URL_NAME.test(name) && ['databases', 'registries'].includes(credentialSystemOf(name))) return 'is a connection URL, which usually carries a password';
  if (URL_PASSWORD.test(value)) return 'holds a URL with a password in it';
  if (AUTH_VALUE.test(value)) return 'holds an authorization header or token';
  return null;
}

// Scope names: dotted lower-case words; `git.*` are per-run permissions (ruling R2), never scopes.
export const SCOPE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}(\.[a-z0-9_-]{1,31}){0,3}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// A configured target name; the scope's own pattern decides what a request may name.
export const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/;
const MATCHER_RE = /^[^\x00-\x1f\x7f]{1,200}$/;
const MAX_MATCHERS = 100;
const TEXT_MAX = { label: 80, permits: 300 };
const KEYS = new Set(['label', 'permits', 'mcp', 'bash', 'hosts', 'env', 'targets', 'takes_target']);
// The guard's own classes: a scope with one of these names could never cover anything.
const CLASS_NAMES = new Set(['local', 'read', 'write', 'external.write', 'unknown-prod', 'privileged', 'unparseable']);

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Each binary as typed, and as its Windows executable or shim; a path-invoked binary is not covered.
const bins = (...names) => names.flatMap((b) => [`${b} *`, `${b}.exe *`, `${b}.cmd *`]);
const TOKEN = '[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,126}[A-Za-z0-9_])?';
const PART = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_])?';
const HOST = '(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*';

/**
 * The built-in catalog (spec §4.3). Per scope: `label`, `permits`, `target` (null when the scope
 * takes none, else `{ label, pattern }`), `credentials` ('required': its CLI cannot write without
 * the scope's own credentials, so a grant without them is refused; 'optional': connectors or the
 * target alone may do; 'none': connectors only), `uses` (what it works through when no
 * credentials are configured), `hint` (the variables to configure), and the matchers.
 */
export const BUILTIN_SCOPES = Object.freeze({
  'jira.write': {
    label: 'Jira: change issues',
    permits: 'Create, edit, transition, link and comment on Jira issues through a connected Atlassian or Jira tool.',
    target: null, credentials: 'none', uses: 'your connected Atlassian or Jira tool', hint: null,
    mcp: ['mcp__*__createJiraIssue', 'mcp__*__editJiraIssue', 'mcp__*__transitionJiraIssue', 'mcp__*__addCommentToJiraIssue', 'mcp__*__addWorklogToJiraIssue', 'mcp__*__createIssueLink',
      'mcp__*jira*__*create*', 'mcp__*jira*__*update*', 'mcp__*jira*__*edit*', 'mcp__*jira*__*transition*', 'mcp__*jira*__*comment*'],
    bash: [], hosts: [],
  },
  'confluence.write': {
    label: 'Confluence: change pages',
    permits: 'Create and update Confluence pages and their comments through a connected Atlassian or Confluence tool.',
    target: null, credentials: 'none', uses: 'your connected Atlassian or Confluence tool', hint: null,
    mcp: ['mcp__*__createConfluencePage', 'mcp__*__updateConfluencePage', 'mcp__*__createConfluenceFooterComment', 'mcp__*__createConfluenceInlineComment',
      'mcp__*confluence*__*create*', 'mcp__*confluence*__*update*'],
    bash: [], hosts: [],
  },
  'slack.post': {
    label: 'Slack: post messages',
    permits: 'Send and schedule Slack messages and create or update canvases through a connected Slack tool. Drafts never need this scope.',
    target: null, credentials: 'none', uses: 'your connected Slack tool', hint: null,
    mcp: ['mcp__*__slack_send_message', 'mcp__*__slack_schedule_message', 'mcp__*__slack_create_canvas', 'mcp__*__slack_update_canvas',
      'mcp__*slack*__*send*', 'mcp__*slack*__*post*', 'mcp__*slack*__*schedule*', 'mcp__*slack*__*canvas*'],
    bash: [], hosts: [],
  },
  'k8s.write': {
    label: 'Kubernetes: change a cluster',
    permits: 'kubectl and helm commands that change resources (apply, delete, scale, exec, rollout, install …), only when the command names this context with --context or --kube-context.',
    target: { label: 'Context', pattern: `^${TOKEN}$` }, credentials: 'required', uses: null, hint: 'env.KUBECONFIG',
    mcp: [], bash: bins('kubectl', 'helm'), hosts: [],
  },
  'argo.sync': {
    label: 'Argo CD: sync or change an application',
    permits: 'Sync or roll back this Argo CD application through a connected Argo CD tool (its sync and rollback tools) or argocd app sync / argocd app rollback.',
    target: { label: 'Application', pattern: `^${PART}(?:/${PART})?$` }, credentials: 'optional', uses: 'your connected Argo CD tool', hint: 'env.ARGOCD_AUTH_TOKEN and env.ARGOCD_SERVER',
    mcp: ['mcp__*argo*__*sync*', 'mcp__*argo*__*rollback*'], bash: ['argocd', 'argocd.exe'].flatMap((b) => [`${b} app sync *`, `${b} app rollback *`]), hosts: [],
  },
  'cloud.write': {
    label: 'Cloud: change resources',
    permits: 'aws and eksctl with --profile, gcloud with --project, bq with --project_id and az with --subscription that change resources, only when the command names this one target once (gsutil names none, so it is never covered).',
    target: { label: 'Profile, project or subscription', pattern: `^${TOKEN}$` }, credentials: 'required', uses: null, hint: 'env.AWS_PROFILE (with env.AWS_CONFIG_FILE), env.CLOUDSDK_CONFIG or env.AZURE_CONFIG_DIR',
    mcp: [], bash: bins('aws', 'gcloud', 'gsutil', 'bq', 'az', 'eksctl'), hosts: [],
  },
  'db.write': {
    label: 'Databases: write data',
    permits: 'SQL and commands that change data (psql, mysql, mongosh, redis-cli, bq), only when the command names this host or database (-h / -d).',
    target: { label: 'Host or database', pattern: `^${PART}$` }, credentials: 'required', uses: null, hint: 'env.PGSERVICEFILE, env.DATABASE_URL (as env:NAME) or MYSQL_* variables',
    mcp: [], bash: bins('psql', 'mysql', 'mongosh', 'redis-cli', 'bq', 'clickhouse-client', 'clickhouse', 'cqlsh'), hosts: [],
  },
  deploy: {
    label: 'Deploy: change infrastructure',
    permits: 'pulumi, cdk and serverless commands that deploy, only when the command names this stack, profile or stage. terraform names no target, so it is never covered.',
    target: { label: 'Stack, profile or stage', pattern: `^${TOKEN}(?:/${TOKEN}){0,2}$` }, credentials: 'optional', uses: 'the credentials the deploy tool finds (pair it with cloud.write for cloud credentials)', hint: 'env (for example PULUMI_ACCESS_TOKEN as env:NAME)',
    mcp: [], bash: bins('pulumi', 'cdk', 'serverless', 'sls'), hosts: [],
  },
  'http.write': {
    label: 'HTTP: send data to one host',
    permits: 'POST, PUT, PATCH and DELETE requests and uploads with curl, wget, HTTPie or Invoke-WebRequest to exactly this host, on its default port, with no proxy, user name or password in the URL.',
    target: { label: 'Host', pattern: `^${HOST}$` }, credentials: 'optional', uses: 'no stored credentials (the request itself carries what it needs)', hint: 'env',
    mcp: [], bash: [], hosts: ['{target}'],
  },
  'package.publish': {
    label: 'Packages: publish',
    permits: 'Publish packages and images: npm, yarn, pnpm and bun publish, docker and podman push, twine, gem, cargo, poetry, NuGet, VS Code extensions, helm push and GitHub releases.',
    target: null, credentials: 'required', uses: null, hint: 'env.NPM_CONFIG_USERCONFIG, env.NODE_AUTH_TOKEN (as env:NAME) or env.DOCKER_CONFIG',
    mcp: [],
    bash: [...bins('npm', 'yarn', 'pnpm', 'bun', 'docker', 'podman', 'twine', 'gem', 'cargo', 'poetry', 'dotnet', 'nuget', 'vsce', 'ovsx', 'helm', 'gh'), 'python* -m twine *', 'py* -m twine *'],
    hosts: [],
  },
});

const label = (name, key) => `[scopes."${name}"] ${key}`;

function matcherList(name, key, v, warnings) {
  if (!Array.isArray(v)) { warnings.push(`${label(name, key)} must be a list of patterns; ignored`); return undefined; }
  const out = [];
  v.slice(0, MAX_MATCHERS).forEach((p, i) => {
    if (typeof p !== 'string' || !MATCHER_RE.test(p) || (key === 'mcp' && !p.startsWith('mcp__'))) warnings.push(`${label(name, key)}[${i}] is not ${key === 'mcp' ? 'an MCP tool pattern (mcp__…)' : 'a pattern'}; ignored`);
    else if (!out.includes(p)) out.push(p);
  });
  if (v.length > MAX_MATCHERS) warnings.push(`${label(name, key)} has more than ${MAX_MATCHERS} patterns; the rest are ignored`);
  return out;
}

function envTable(where, v, warnings) {
  if (!isTable(v)) { warnings.push(`${where} env must be a table of variable names; ignored`); return {}; }
  const out = {};
  for (const [k, value] of Object.entries(v)) {
    if (!ENV_NAME.test(k)) { warnings.push(`${where} env: an entry is not a variable name; ignored`); continue; }
    if (typeof value !== 'string' || !value.trim()) { warnings.push(`${where} env.${k} must be a non-empty string; ignored`); continue; }
    const ref = value.startsWith('env:');
    if (ref && !ENV_NAME.test(value.slice(4))) { warnings.push(`${where} env.${k} names no variable after env:; ignored`); continue; }
    // config.toml is not a secret store: a secret-looking value must come from the environment.
    const secret = ref ? null : literalSecretReason(k, value);
    if (secret) { warnings.push(`${where} env.${k} ${secret}: give it as "env:NAME" (a variable the worker inherits), never a literal; ignored`); continue; }
    out[k] = value;
  }
  return out;
}

/**
 * The owner's `[scopes]` tables, validated: `{ tables: { name: { label?, permits?, mcp?, bash?,
 * hosts?, env?, targets?, takes_target? } }, warnings }`. Built-ins are not merged here.
 */
export function scopeSettings(config = {}) {
  const warnings = [];
  const tables = {};
  const raw = config && config.scopes;
  if (raw === undefined || raw === null) return { tables, warnings };
  if (!isTable(raw)) return { tables, warnings: ['[scopes] must be a table of scope tables; ignored'] };
  for (const [name, t] of Object.entries(raw)) {
    if (!SCOPE_NAME_RE.test(name) || name.startsWith('git.') || CLASS_NAMES.has(name)) { warnings.push(`[scopes] ${!SCOPE_NAME_RE.test(name) ? 'an entry is not a scope name such as "k8s.write"' : name.startsWith('git.') ? `"${name}" is a per-run permission (commit, push, PR), never a scope` : `"${name}" is one of the guard's classes, not a scope`}; ignored`); continue; }
    if (!isTable(t)) { warnings.push(`[scopes."${name}"] must be a table; ignored`); continue; }
    const out = {};
    for (const [key, v] of Object.entries(t)) {
      if (!KEYS.has(key)) { warnings.push(`${label(name, key)} is not a scope setting; ignored`); continue; }
      if (key === 'label' || key === 'permits') {
        if (typeof v === 'string' && v.trim() && v.length <= TEXT_MAX[key] && !/[\x00-\x1f\x7f]/.test(v)) out[key] = v.trim();
        else warnings.push(`${label(name, key)} must be one line of at most ${TEXT_MAX[key]} characters; ignored`);
      } else if (key === 'mcp' || key === 'bash' || key === 'hosts') {
        // The guard gives commands and hosts only built-in scope names, so an owner scope can only
        // ever cover MCP tools that [mcp_policy.write] maps to it (review M2).
        if (key !== 'mcp' && !Object.hasOwn(BUILTIN_SCOPES, name)) { warnings.push(`${label(name, key)}: an owner scope covers MCP tools only (map them with [mcp_policy.write]); ignored`); continue; }
        const list = matcherList(name, key, v, warnings);
        if (list) out[key] = list;
      } else if (key === 'env') {
        out.env = envTable(`[scopes."${name}"]`, v, warnings);
      } else if (key === 'takes_target') {
        if (typeof v !== 'boolean') warnings.push(`${label(name, key)} must be true or false; ignored`);
        else if (Object.hasOwn(BUILTIN_SCOPES, name)) warnings.push(`${label(name, key)} cannot change a built-in scope; ignored`);
        else out.takes_target = v;
      } else if (key === 'targets') {
        if (!isTable(v)) { warnings.push(`${label(name, key)} must hold one table per target; ignored`); continue; }
        out.targets = {};
        for (const [target, tt] of Object.entries(v)) {
          const where = `[scopes."${name}".targets]`;
          if (!TARGET_NAME_RE.test(target) || target.includes('..')) { warnings.push(`${where} an entry is not a target name; ignored`); continue; }
          if (!isTable(tt)) { warnings.push(`${where} "${target}" must be a table; ignored`); continue; }
          for (const k of Object.keys(tt)) if (k !== 'env') warnings.push(`${where} "${target}" ${k} is not a target setting; ignored`);
          out.targets[target] = { env: tt.env === undefined ? {} : envTable(`[scopes."${name}".targets."${target}"]`, tt.env, warnings) };
        }
      }
    }
    tables[name] = out;
  }
  return { tables, warnings };
}
