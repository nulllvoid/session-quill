// Which shell commands a granted write scope covers (ruling R25). An allow-list, not a deny-list:
// a Bash or PowerShell call is covered only when it is one simple command, run by the bare name of
// one of the scope's tools, with a write verb that tool lists, every option exactly as the tool
// lists it (no abbreviations), the scope's target named exactly once, and, for http.write, exactly
// one http(s) URL whose host is the scope's host. Anything else is not covered: the guard then
// treats the write as a critical change. When unsure, an option or verb is left off (fail-safe).
//
// The lists are data: the scope catalog (src/config/scopes.js) copies them into each built-in
// scope, the owner may add verbs and options in config.toml (never a NEVER_VERBS verb or a
// NEVER_OPTIONS option), and the grant carries them to the guard as `matchers.commands`.
//
// A tool spec: { verbs: ['apply', 'rollout restart', …] (empty: the tool has no verb),
//   target: { options: [...] } | { positional: true } | { url: true } | null,
//   options: { '<exact name>': 'flag' | 'bool' | 'value' | 'url' },
//   args: 'any' | 'none' | 'one' | 'target' | 'target-revision' | 'url' | 'httpie' (or per verb:
//   { '<verb>': … }), requires?: [names, at least one present], patterns?: { name: regexp source },
//   ps?: true (a PowerShell cmdlet: names compare case-insensitively, `-Name:value` accepted) }
import { parseShell, binName } from './shell-tokens.js';

const PLAIN = '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$';
const DIGITS = '^[0-9]{1,6}$';
const METHOD = '^(POST|PUT|PATCH|DELETE|GET|HEAD)$';
const f = 'flag';
const v = 'value';
const b = 'bool';

const KUBECTL = {
  verbs: ['apply', 'create', 'delete', 'patch', 'replace', 'scale', 'annotate', 'label', 'rollout restart', 'rollout undo', 'rollout pause', 'rollout resume', 'set image'],
  target: { options: ['--context'] },
  options: {
    '-n': v, '--namespace': v, '-f': v, '--filename': v, '-k': v, '--kustomize': v, '-l': v, '--selector': v, '-R': f, '--recursive': f, '--force': f, '--grace-period': v,
    '--wait': b, '--timeout': v, '--replicas': v, '-o': v, '--output': v, '--overwrite': b, '--all': b, '--server-side': b, '--field-manager': v, '--force-conflicts': b,
    '--type': v, '-p': v, '--patch': v, '--cascade': v, '-c': v, '--container': v, '--to-revision': v, '--record': b, '--dry-run': v,
  },
  args: 'any',
};
const HELM = {
  verbs: ['upgrade', 'install', 'rollback', 'uninstall'],
  target: { options: ['--kube-context'] },
  options: {
    '-n': v, '--namespace': v, '-f': v, '--values': v, '--set': v, '--set-string': v, '--set-file': v, '--version': v, '--wait': b, '--timeout': v, '--atomic': b,
    '-i': f, '--install': f, '--create-namespace': b, '--reuse-values': b, '--reset-values': b, '--description': v,
  },
  args: 'any',
};
const AWS = {
  verbs: ['s3 cp', 's3 mv', 's3 rm', 's3 sync', 'ecs update-service', 'lambda update-function-code'],
  target: { options: ['--profile'] },
  options: {
    '--region': v, '--recursive': f, '--exclude': v, '--include': v, '--delete': f, '--dryrun': f, '--cluster': v, '--service': v, '--force-new-deployment': f,
    '--desired-count': v, '--function-name': v, '--zip-file': v, '--s3-bucket': v, '--s3-key': v, '--content-type': v, '--cache-control': v, '--no-cli-pager': f,
  },
  args: 'any',
};
const GCLOUD = {
  verbs: ['run deploy', 'run services update', 'app deploy'],
  target: { options: ['--project'] },
  options: { '--region': v, '--image': v, '--source': v, '--platform': v, '--quiet': f, '-q': f, '--no-promote': f, '--version': v },
  args: 'any',
};
const AZ = {
  verbs: ['webapp restart', 'webapp deploy', 'functionapp restart', 'containerapp update'],
  target: { options: ['--subscription'] },
  options: { '-g': v, '--resource-group': v, '-n': v, '--name': v, '--src-path': v, '--type': v, '--image': v, '--yes': f, '-y': f },
  args: 'none',
};
const ARGOCD = {
  verbs: ['app sync', 'app rollback'],
  target: { positional: true },
  options: { '--prune': f, '--force': f, '--timeout': v, '--revision': v, '--async': f, '--retry-limit': v, '--apply-out-of-sync-only': f, '--grpc-web': f, '--server-side': f },
  args: { 'app sync': 'target', 'app rollback': 'target-revision' },
};
const PSQL = {
  verbs: [],
  target: { options: ['-h', '--host'] },
  options: { '-c': v, '--command': v, '-d': v, '--dbname': v, '-U': v, '--username': v, '-p': v, '--port': v, '-X': f, '--no-psqlrc': f, '-q': f, '--quiet': f },
  patterns: { '-d': PLAIN, '--dbname': PLAIN, '-U': PLAIN, '--username': PLAIN, '-p': DIGITS, '--port': DIGITS },
  requires: ['-c', '--command'],
  sql: ['-c', '--command'],
  args: 'none',
};
const MYSQL = {
  verbs: [],
  target: { options: ['-h', '--host'] },
  options: { '-e': v, '--execute': v, '-u': v, '--user': v, '-P': v, '--port': v, '-D': v, '--database': v, '--batch': f },
  patterns: { '-D': PLAIN, '--database': PLAIN, '-u': PLAIN, '--user': PLAIN, '-P': DIGITS, '--port': DIGITS },
  requires: ['-e', '--execute'],
  sql: ['-e', '--execute'],
  args: 'none',
};
const REDIS = { verbs: [], target: { options: ['-h'] }, options: { '-p': v, '-n': v }, patterns: { '-p': DIGITS, '-n': DIGITS }, args: 'any' };
const PULUMI = { verbs: ['up', 'refresh'], target: { options: ['-s', '--stack'] }, options: { '--yes': f, '-y': f, '--skip-preview': f, '-m': v, '--message': v, '--non-interactive': f, '--diff': f }, args: 'none' };
const CDK = { verbs: ['deploy'], target: { options: ['--profile'] }, options: { '--require-approval': v }, args: 'any' };
const SERVERLESS = { verbs: ['deploy', 'deploy function'], target: { options: ['-s', '--stage'] }, options: { '-r': v, '--region': v, '--verbose': f, '--force': f, '-f': v, '--function': v }, args: 'none' };
const CURL = {
  verbs: [],
  target: { url: true },
  options: {
    '-X': v, '--request': v, '-H': v, '--header': v, '-d': v, '--data': v, '--data-raw': v, '--data-binary': v, '--data-urlencode': v, '--json': v, '-F': v, '--form': v,
    '-T': v, '--upload-file': v, '-o': v, '--output': v, '-s': f, '--silent': f, '-S': f, '--show-error': f, '-f': f, '--fail': f, '--fail-with-body': f, '-i': f, '--include': f,
    '--compressed': f, '-m': v, '--max-time': v, '--connect-timeout': v, '--retry': v, '-A': v, '--user-agent': v, '-w': v, '--write-out': v, '-v': f, '--verbose': f, '-G': f, '--get': f,
  },
  patterns: { '-X': METHOD, '--request': METHOD },
  // R26: values that name a file the request reads; every one must be inside the checkout or the run dir
  files: { '-d': 'at', '--data': 'at', '--data-binary': 'at', '--json': 'at', '--data-urlencode': 'urlencode', '-F': 'form', '--form': 'form', '-T': 'path', '--upload-file': 'path', '-H': 'at', '--header': 'at', '-w': 'at', '--write-out': 'at' },
  headers: ['-H', '--header'],
  args: 'url',
};
const HTTPIE = { verbs: [], target: { url: true }, options: { '--json': f, '-j': f, '--form': f, '-f': f, '--check-status': f, '--ignore-stdin': f, '-I': f, '--timeout': v, '-b': f, '--body': f, '-h': f, '--headers': f, '-v': f, '--verbose': f }, args: 'httpie' };
const IWR = {
  ps: true,
  verbs: [],
  target: { url: true },
  options: { '-uri': 'url', '-method': v, '-body': v, '-contenttype': v, '-infile': v, '-outfile': v, '-usebasicparsing': f, '-timeoutsec': v },
  patterns: { '-method': METHOD },
  files: { '-infile': 'path' },
  args: 'url',
};
const NPM = { verbs: ['publish'], target: null, options: { '--access': v, '--tag': v, '--provenance': f, '--dry-run': f }, patterns: { '--access': '^(public|restricted)$' }, args: 'any' };

/** The built-in tool lists of each scope that has shell commands. */
export const BUILTIN_COMMANDS = Object.freeze({
  'k8s.write': { kubectl: KUBECTL, helm: HELM },
  'cloud.write': { aws: AWS, gcloud: GCLOUD, az: AZ },
  'db.write': { psql: PSQL, mysql: MYSQL, 'redis-cli': REDIS },
  deploy: { pulumi: PULUMI, cdk: CDK, serverless: SERVERLESS, sls: SERVERLESS },
  'argo.sync': { argocd: ARGOCD },
  'http.write': { curl: CURL, http: HTTPIE, https: HTTPIE, 'invoke-restmethod': IWR, irm: IWR, 'invoke-webrequest': IWR, iwr: IWR },
  'package.publish': {
    npm: NPM,
    pnpm: { ...NPM, options: { ...NPM.options, '--no-git-checks': f } },
    yarn: { verbs: ['npm publish'], target: null, options: { '--access': v, '--tag': v }, patterns: NPM.patterns, args: 'any' },
    docker: { verbs: ['push'], target: null, options: {}, args: 'image' },
    podman: { verbs: ['push'], target: null, options: {}, args: 'image' },
    twine: { verbs: ['upload'], target: null, options: { '--skip-existing': f, '--non-interactive': f }, args: 'any' },
    gem: { verbs: ['push'], target: null, options: {}, args: 'one' },
    cargo: { verbs: ['publish'], target: null, options: { '--allow-dirty': f, '-p': v, '--package': v, '--no-verify': f }, args: 'none' },
    poetry: { verbs: ['publish'], target: null, options: { '--build': f }, args: 'none' },
  },
});

// Subcommands that rewrite what a target means (its context, profile, endpoint, credentials) or
// log in somewhere else. No scope ever covers them, and the owner cannot add them.
export const NEVER_VERBS = Object.freeze({
  kubectl: ['config', 'proxy', 'port-forward', 'exec', 'cp', 'debug', 'attach', 'plugin'],
  helm: ['repo', 'registry', 'plugin', 'env'],
  aws: ['configure', 'sso', 'login'],
  gcloud: ['config', 'auth', 'init'],
  az: ['account', 'config', 'cloud', 'login', 'logout', 'extension'],
  argocd: ['context', 'login', 'logout', 'relogin', 'account', 'cluster', 'repo', 'repocreds', 'proj', 'cert', 'gpg'],
  gh: ['auth', 'config', 'extension', 'alias'],
  docker: ['login', 'logout', 'context', 'config'],
  podman: ['login', 'logout'],
  npm: ['config', 'login', 'logout', 'adduser', 'set', 'owner', 'token', 'access'],
  pnpm: ['config', 'login', 'logout', 'set'],
  yarn: ['config', 'login', 'logout', 'set'],
  pulumi: ['login', 'logout', 'config', 'stack'],
  serverless: ['config', 'login', 'logout'],
  sls: ['config', 'login', 'logout'],
});

// Options that change where a tool connects or which target it acts on. The owner cannot add them.
export const NEVER_OPTIONS = Object.freeze({
  kubectl: ['--kubeconfig', '--cluster', '--server', '-s', '--user', '--token', '--as', '--as-group', '--as-uid', '--username', '--password', '--certificate-authority', '--client-certificate', '--client-key', '--tls-server-name', '--insecure-skip-tls-verify', '--context'],
  helm: ['--kubeconfig', '--kube-apiserver', '--kube-token', '--kube-as-user', '--kube-as-group', '--kube-ca-file', '--kube-tls-server-name', '--kube-insecure-skip-tls-verify', '--kube-context'],
  aws: ['--endpoint-url', '--profile', '--ca-bundle'],
  gcloud: ['--configuration', '--account', '--impersonate-service-account', '--access-token-file', '--credential-file-override', '--flags-file', '--project'],
  az: ['--subscription'],
  argocd: ['--server', '--auth-token', '--config', '--context', '--core', '--kube-context', '--port-forward', '--port-forward-namespace', '-H', '--header', '-N', '--app-namespace', '-p', '--project', '-l', '--selector', '--grpc-web-root-path', '--plaintext', '--insecure'],
  psql: ['-h', '--host', '--set', '-v', '--variable', '-f', '--file'],
  mysql: ['-h', '--host', '--defaults-file', '--defaults-extra-file', '--defaults-group-suffix', '--login-path', '-S', '--socket', '--init-command'],
  'redis-cli': ['-h', '-u', '-s', '--uri'],
  pulumi: ['-C', '--cwd', '--config-file', '-s', '--stack'],
  cdk: ['--profile', '--role-arn', '-r', '--app', '-a'],
  serverless: ['--aws-profile', '-c', '--config', '-s', '--stage'],
  sls: ['--aws-profile', '-c', '--config', '-s', '--stage'],
  curl: ['--url', '--expand-url', '--connect-to', '--resolve', '-x', '--proxy', '--preproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--proxy1.0', '-K', '--config', '--next', '-:', '--unix-socket', '--abstract-unix-socket', '--doh-url', '--dns-servers', '--haproxy-protocol', '--request-target', '-L', '--location'],
  http: ['--proxy'],
  https: ['--proxy'],
  'invoke-restmethod': ['-proxy', '-proxycredential', '-proxyusedefaultcredentials'],
  irm: ['-proxy', '-proxycredential', '-proxyusedefaultcredentials'],
  'invoke-webrequest': ['-proxy', '-proxycredential', '-proxyusedefaultcredentials'],
  iwr: ['-proxy', '-proxycredential', '-proxyusedefaultcredentials'],
  npm: ['--registry', '--userconfig', '--globalconfig'],
  pnpm: ['--registry', '--userconfig'],
  yarn: ['--registry'],
  twine: ['--repository', '-r', '--repository-url', '--config-file'],
  cargo: ['--registry', '--index', '--config'],
  poetry: ['--repository', '-r'],
});

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const isOption = (t) => t.length > 1 && t.startsWith('-') && !/^-\d/.test(t);

// Why `raw` is not exactly one http(s) URL on the scope's host and default port, or null.
function urlProblem(raw, host) {
  if (typeof host !== 'string' || !host) return 'the scope names no host';
  if (/[{}[\]\s\\]/.test(raw)) return `the URL ${raw.slice(0, 80)} has globs, brackets, spaces or backslashes`;
  let u;
  try { u = new URL(raw); } catch { return `${raw.slice(0, 80)} is not a full http(s) URL`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol} is not http or https`;
  if (!/^https?:\/\//i.test(raw)) return `${raw.slice(0, 80)} is not a full http(s) URL`;
  if (u.username || u.password) return 'the URL carries a user name or password';
  if (u.port) return 'the URL names a port';
  let want;
  try { want = new URL(`http://${host}`).hostname; } catch { return 'the scope host is not a host name'; }
  const norm = (h) => h.toLowerCase().replace(/\.$/, '');
  return norm(u.hostname) === norm(want) ? null : `the URL goes to ${u.hostname.slice(0, 80)}, not ${host}`;
}

/**
 * Why `command` is not covered by a scope with these tool lists and this target, or null when it is
 * as far as the command text can tell (commandCheck adds the files and registry hosts the guard
 * must still check).
 * @param {string} command  the Bash or PowerShell text
 * @param {'bash'|'powershell'} dialect
 * @param {{ commands: object, target?: string|null, scope?: string }} opts
 */
export function commandProblem(command, dialect, opts = {}) {
  return commandCheck(command, dialect, opts).why;
}

/**
 * The full check (R25, R26): { why: string|null, files: string[], hosts: string[] }. `files` are the
 * paths the command reads through option values (curl @file, -T, -F, HTTPie @ items, -InFile), as
 * written: the guard requires each to resolve inside the checkout or the run dir. `hosts` are
 * registry hosts an image push names: the guard requires each to match the scope's `hosts`.
 */
export function commandCheck(command, dialect, opts = {}) {
  const out = { why: null, files: [], hosts: [] };
  out.why = commandShape(command, dialect, opts, out);
  return out;
}

/**
 * The one plain command a text holds (R25's shape, shared with action pins): { argv, bin, word }
 * or { why }. Plain means one literal command run by the bare name of its tool: no chain, pipe,
 * redirect, stdin, background, environment assignment, wrapper (`env`, `sudo`, `bash -c` …) or
 * expansion.
 * @param {string} command
 * @param {'bash'|'powershell'} dialect
 */
export function plainCommand(command, dialect) {
  if (typeof command !== 'string' || !command.trim()) return { why: 'there is no command' };
  const parsed = parseShell(command.trim(), dialect);
  if (parsed.error) return { why: 'the command cannot be read' };
  if (parsed.segments.some((s) => s.cwdMark)) return { why: 'it runs inside another shell or directory' };
  const segs = parsed.segments;
  if (segs.length !== 1) return { why: 'it is more than one command (run a covered write as a command of its own)' };
  const s = segs[0];
  if (s.unparseable) return { why: 'the command cannot be read' };
  if (Object.keys(s.env ?? {}).length) return { why: 'it sets an environment variable' };
  if (!Array.isArray(s.argv) || !s.argv.length) return { why: 'there is no command' };
  if (Array.isArray(s.assign) && s.assign.length !== s.argv.length) return { why: 'a wrapper command runs it' };
  if ((s.redirects ?? []).length || s.piped || s.nested || s.stdin !== null || s.stdinDyn || s.funcDef || s.sep === '&') return { why: 'it redirects, pipes, reads stdin or runs in the background' };
  if ((s.kinds ?? []).some((k) => k !== 'lit')) return { why: 'part of the command is not literal' };
  const word = s.argv[0];
  if (/[\\/]/.test(word)) return { why: `${word.slice(0, 80)} is run by a path, not by its bare name` };
  return { argv: s.argv.slice(), bin: binName(word), word };
}

function commandShape(command, dialect, { commands, target = null, scope = 'this scope' } = {}, out = { files: [], hosts: [] }) {
  const plain = plainCommand(command, dialect);
  if (plain.why) return plain.why;
  const { bin, word } = plain;
  const tools = commands && typeof commands === 'object' ? commands : {};
  if (!Object.hasOwn(tools, bin)) return `${bin} is not a tool ${scope} covers`;
  if (dialect === 'powershell' && (bin === 'curl' || bin === 'wget') && !/\.exe$/i.test(word)) return `${bin} is Invoke-WebRequest in PowerShell; run ${bin}.exe`;
  return toolProblem(bin, tools[bin], plain.argv.slice(1), target, out);
}

function toolProblem(bin, spec, args, target, out) {
  if (!spec || typeof spec !== 'object') return `${bin} has no usable command list`;
  const ps = spec.ps === true;
  const key = (n) => (ps ? n.toLowerCase() : n);
  const options = Object.fromEntries(Object.entries(spec.options ?? {}).map(([k, kind]) => [key(k), kind]));
  const targetOpts = new Set((spec.target && spec.target.options ? spec.target.options : []).map(key));
  const patterns = Object.fromEntries(Object.entries(spec.patterns ?? {}).map(([k, p]) => [key(k), p]));
  const positionals = [];
  const targets = [];
  const urls = [];
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === '--' || t === '--%') return `${t} ends the options`;
    if (!isOption(t)) { positionals.push(t); continue; }
    const sep = ps ? t.indexOf(':', 1) : t.indexOf('=');
    let name = sep > 0 ? t.slice(0, sep) : t;
    let val = sep > 0 ? t.slice(sep + 1) : undefined;
    name = key(name);
    const kind = targetOpts.has(name) ? 'target' : Object.hasOwn(options, name) ? options[name] : null;
    if (!kind) return `option ${name.slice(0, 60)} is not on the ${bin} list (options are matched exactly, never abbreviated)`;
    if (kind === 'flag' && val !== undefined) return `${name} takes no value`;
    if (kind === 'bool' && val !== undefined && !/^(true|false)$/.test(val)) return `${name} takes only true or false`;
    if (kind === 'value' || kind === 'target' || kind === 'url') {
      if (val === undefined) {
        val = args[i + 1];
        if (val === undefined) return `${name} has no value`;
        if (isOption(val)) return `${name} is followed by another option`;
        i += 1;
      }
      if (Object.hasOwn(patterns, name) && !new RegExp(patterns[name], 'i').test(val)) return `${name} ${val.slice(0, 60)} is not a plain value`;
      if (kind === 'target') targets.push(val);
      const problem = valueProblem(spec, name, val, target, out, key);
      if (problem) return problem;
      if (kind === 'url') urls.push(val);
    }
    seen.add(name);
  }
  // The verb: the longest listed verb the leading words spell out.
  let rest = positionals;
  let verb = '';
  const verbs = Array.isArray(spec.verbs) ? spec.verbs : [];
  const never = Object.hasOwn(NEVER_VERBS, bin) ? NEVER_VERBS[bin] : [];
  if (positionals.length && never.includes(positionals[0])) return `${bin} ${positionals[0]} changes what a target means and is never covered`;
  if (verbs.length) {
    const hit = verbs.map((x) => x.split(' ')).filter((w) => w.length <= positionals.length && w.every((x, j) => positionals[j] === x)).sort((a, c) => c.length - a.length)[0];
    if (!hit) return `${bin} ${positionals.slice(0, 2).join(' ')} is not a write this scope covers`.replace(/\s+is not/, ' is not');
    verb = hit.join(' ');
    rest = positionals.slice(hit.length);
  }
  if (Array.isArray(spec.requires) && spec.requires.length && !spec.requires.some((n) => seen.has(key(n)))) return `${bin} must carry its statement in ${spec.requires.join(' or ')}`;
  const t = spec.target ?? null;
  if (t && t.options) {
    if (typeof target !== 'string' || !target) return 'the scope names no target';
    if (targets.length !== 1) return `${[...targetOpts].join(' or ')} must be given exactly once`;
    if (targets[0] !== target) return `the command names ${targets[0].slice(0, 60)}, not ${target}`;
  }
  const args2 = spec.args && typeof spec.args === 'object' ? spec.args[verb] ?? 'none' : spec.args ?? 'none';
  switch (args2) {
    case 'any': break;
    case 'none': if (rest.length) return `${bin} ${verb} takes no further arguments here`.replace(/\s+takes/, ' takes'); break;
    case 'one': if (rest.length !== 1) return `${bin} ${verb} must name exactly one item`; break;
    case 'image': {
      if (rest.length !== 1) return `${bin} ${verb} must name exactly one image`;
      // A registry host is the first part when it has a dot, a colon or is localhost (docker's rule).
      const first = rest[0].split('/')[0];
      if (rest[0].includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) out.hosts.push(first.toLowerCase());
      break;
    }
    case 'target':
    case 'target-revision': {
      if (typeof target !== 'string' || !target) return 'the scope names no target';
      const max = args2 === 'target' ? 1 : 2;
      if (rest.length < 1 || rest.length > max) return `${bin} ${verb} must name exactly one ${args2 === 'target' ? 'item' : 'item and at most a revision'}`;
      if (rest[0] !== target) return `the command names ${rest[0].slice(0, 60)}, not ${target}`;
      if (rest.length === 2 && !/^[0-9]{1,9}$/.test(rest[1])) return 'the revision is not a number';
      break;
    }
    case 'url':
    case 'httpie': {
      let items = rest;
      if (args2 === 'httpie' && items[0] && HTTP_METHODS.has(items[0].toUpperCase())) items = items.slice(1);
      const all = args2 === 'httpie' ? [...urls, ...items.slice(0, 1)] : [...urls, ...items];
      if (all.length !== 1) return 'the command must name exactly one URL';
      const why = urlProblem(all[0], target);
      if (why) return why;
      if (args2 === 'httpie') for (const item of items.slice(1)) { const p = httpieItem(item, target, out); if (p) return p; }
      break;
    }
    default: return `${bin} has an unknown argument rule`;
  }
  if (t && t.positional && args2 !== 'target' && args2 !== 'target-revision') return `${bin} ${verb} does not name its target`;
  return null;
}

// R26.1: client commands a SQL string must not start a statement with (mysql), checked after the
// start or a semicolon; any backslash (psql meta-commands, mysql \! and \G) is refused outright.
const SQL_CLIENT_COMMANDS = /(^|;)\s*(system|connect|source|tee|notee|pager|nopager|warnings|nowarning|delimiter|edit|rehash|charset|prompt|resetconnection|query_attributes|ego|go|print)\b/i;
// R26.3: headers that pick another backend or host.
const HOST_HEADERS = new Set(['host', 'x-forwarded-host', ':authority', 'forwarded', 'x-host', 'x-original-host']);

function headerProblem(name, value, target) {
  const n = String(name).trim().toLowerCase();
  if (HOST_HEADERS.has(n)) return `the ${n} header picks another host`;
  const m = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+/i.exec(String(value));
  if (m && urlProblem(m[0], target)) return `the ${n} header names another host`;
  return null;
}

// A file a value names; '-' (stdin) and '.' are never covered.
function fileRef(file, out) {
  if (!file || file === '-' || file === '.') return 'the request reads stdin';
  out.files.push(file);
  return null;
}

// What one allow-listed option value may carry (R26).
function valueProblem(spec, name, val, target, out, key) {
  if (Array.isArray(spec.sql) && spec.sql.map(key).includes(name)) {
    if (val.includes('\\')) return 'the SQL has a backslash (a client meta-command)';
    if (SQL_CLIENT_COMMANDS.test(val)) return 'the SQL runs a client command';
  }
  const files = Object.fromEntries(Object.entries(spec.files ?? {}).map(([k, x]) => [key(k), x]));
  const how = Object.hasOwn(files, name) ? files[name] : null;
  if (how === 'at' && val.startsWith('@')) { const p = fileRef(val.slice(1), out); if (p) return p; }
  if (how === 'path') { const p = fileRef(val, out); if (p) return p; }
  if (how === 'urlencode') {
    const at = val.indexOf('@');
    const eq = val.indexOf('=');
    if (at >= 0 && (eq < 0 || at < eq)) { const p = fileRef(val.slice(at + 1), out); if (p) return p; }
  }
  if (how === 'form') {
    const eq = val.indexOf('=');
    const rest = eq >= 0 ? val.slice(eq + 1) : '';
    if (rest.startsWith('@') || rest.startsWith('<')) { const p = fileRef(rest.slice(1).split(';')[0], out); if (p) return p; }
  }
  if (Array.isArray(spec.headers) && spec.headers.map(key).includes(name) && !val.startsWith('@')) {
    const colon = val.indexOf(':');
    if (colon <= 0) return `${name} ${val.slice(0, 40)} is not a header`;
    const p = headerProblem(val.slice(0, colon), val.slice(colon + 1), target);
    if (p) return p;
  }
  return null;
}

// One HTTPie request item: a header (Name:value), data (=, :=, ==) or a file (@, =@, :=@).
function httpieItem(item, target, out) {
  if (item.startsWith('@')) return fileRef(item.slice(1), out);
  const m = /^((?:\\.|[^:=@\\])*)(:=@|=@|:=|==|=|@|:)([\s\S]*)$/.exec(item);
  if (!m) return `${item.slice(0, 40)} is not an HTTPie request item`;
  const [, name, sep, rest] = m;
  if (sep.endsWith('@')) return fileRef(rest, out);
  if (sep === ':') return headerProblem(name, rest, target);
  return null;
}
