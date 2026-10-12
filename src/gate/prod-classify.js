// Prod classifier for the per-run guard (spec §4.2, research 01 §R-2). Pure and synchronous:
// no fs, no processes, no network. Defence in depth only — credentials are the boundary (§4.4) —
// but fail-safe: whatever might touch prod and cannot be understood is `unparseable` or
// `unknown-prod`, never `local`.
//
// classifyCall({ tool_name, tool_input }, ctx) → { class, scope?, target?, host?, path?, paths?,
//   readPaths?, calls?, reason }
// ctx: { cwd, home?, env?, currentBranch?, defaultBranch?, isProtectedBranch?(name),
//        kubeContext?, awsProfile?, mcpPolicy: { read: string[], write: Record<string,string> },
//        trackerHosts?: string[] }
// Git returns internal pseudo-scopes (ruling R2): git.commit, git.push, git.pr, git.protected.
import path from 'node:path';
import { parseShell, binName, MAX_COMMAND, hasBraceExpansion } from './shell-tokens.js';

const RANK = { local: 0, read: 1, 'external.write': 2, write: 3, 'unknown-prod': 4, unparseable: 5, privileged: 6 };

const r = (cls, reason, extra = {}) => ({ class: cls, ...extra, reason });
const local = (reason = 'local work') => r('local', reason);
const read = (reason, extra) => r('read', reason, extra);
const write = (scope, target, reason) => r('write', reason, { scope, ...(target ? { target } : {}) });
const xwrite = (scope, host, reason, extra = {}) => r('external.write', reason, { ...(scope ? { scope } : {}), ...(host ? { host } : {}), ...extra });
const unknownProd = (reason) => r('unknown-prod', reason);
const unparseable = (reason) => r('unparseable', reason);
const privileged = (reason) => r('privileged', reason);

export function classifyCall(call, ctx) {
  try {
    return classifyInner(call && typeof call === 'object' ? call : {}, ctx && typeof ctx === 'object' ? ctx : {});
  } catch (e) {
    return unparseable(`classifier error: ${e && e.message ? e.message : String(e)}`);
  }
}

const SHELL_TOOLS = { Bash: 'bash', PowerShell: 'powershell', Monitor: 'bash' };
const PATH_TOOLS = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path', Read: 'file_path', NotebookRead: 'notebook_path' };
const DIR_TOOLS = new Set(['Glob', 'Grep', 'LS']);
const LOCAL_TOOLS = new Set(['TodoWrite', 'TodoRead', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ListAgents', 'Skill', 'ToolSearch',
  'BashOutput', 'KillShell', 'KillBash', 'TaskOutput', 'TaskStop', 'SlashCommand', 'SendMessage', 'EnterWorktree', 'ExitWorktree']);

function classifyInner(call, ctx) {
  const tool = call.tool_name;
  const input = call.tool_input;
  if (typeof tool !== 'string' || !tool) return unparseable('tool name missing');
  if (Object.hasOwn(SHELL_TOOLS, tool)) return classifyShell(input && typeof input === 'object' ? input.command : undefined, SHELL_TOOLS[tool], ctx);
  if (tool.startsWith('mcp__')) return classifyMcp(tool, input && typeof input === 'object' ? input : {}, ctx);
  if (Object.hasOwn(PATH_TOOLS, tool)) {
    const p = input && typeof input === 'object' ? input[PATH_TOOLS[tool]] ?? input.path : undefined;
    if (typeof p !== 'string' || !p) return unparseable(`${tool} without a file path`);
    const resolved = resolveLiteral(p, ctx, ctx.cwd);
    if (!resolved) return unparseable(`${tool} path cannot be resolved`);
    return r('local', `${tool} on a file`, { path: resolved });
  }
  if (DIR_TOOLS.has(tool)) {
    const p = input && typeof input === 'object' ? input.path : undefined;
    if (p !== undefined && typeof p !== 'string') return unparseable(`${tool} path is not a string`);
    const resolved = p ? resolveLiteral(p, ctx, ctx.cwd) : ctx.cwd ? normalizeAbs(ctx.cwd, ctx) : undefined;
    if (p && !resolved) return unparseable(`${tool} path cannot be resolved`);
    return r('local', `${tool} search`, resolved ? { path: resolved } : {});
  }
  if (tool === 'WebFetch') {
    const host = input && typeof input === 'object' ? hostOf(input.url) : undefined;
    return read('web fetch (GET)', host ? { host } : {});
  }
  if (tool === 'WebSearch') return read('web search');
  if (LOCAL_TOOLS.has(tool)) return local(`${tool} is a local tool`);
  return unparseable(`unknown tool ${tool}`);
}

// ---------------------------------------------------------------- paths

function isWin(ctx) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(ctx.cwd ?? '') || /^[A-Za-z]:[\\/]/.test(ctx.home ?? '');
}

function envLookup(ctx, name) {
  const up = name.toUpperCase();
  if ((up === 'HOME' || up === 'USERPROFILE') && ctx.home) return ctx.home;
  const env = ctx.env && typeof ctx.env === 'object' ? ctx.env : {};
  if (Object.hasOwn(env, name)) return env[name];
  if (isWin(ctx)) for (const k of Object.keys(env)) if (k.toUpperCase() === up) return env[k];
  if ((up === 'TMPDIR' || up === 'TMP' || up === 'TEMP') && isWin(ctx)) for (const k of Object.keys(env)) if (['TMP', 'TEMP', 'TMPDIR'].includes(k.toUpperCase())) return env[k];
  return undefined;
}

function normalizeAbs(p, ctx) {
  return isWin(ctx) ? path.win32.resolve(p) : path.posix.resolve(p);
}

// Resolves a literal path word (with ~ and well-known variables) against `cwd`; null when it is
// not literal enough to apply roots to.
function resolveLiteral(word, ctx, cwd, kind = 'dyn') {
  if (typeof word !== 'string' || !word) return null;
  let p = word;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (!ctx.home) return null;
    p = ctx.home + p.slice(1);
  }
  if (p.startsWith('~')) return null; // ~user, ~+ and ~- are not resolvable here
  // Win32 device and long-path prefixes, and the local admin share, name the same files
  p = p.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\/, '');
  // PowerShell provider-qualified paths: only the FileSystem provider names a file
  p = p.replace(/^(Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '');
  if (/^[A-Za-z][\w.\\]*::/.test(p) || /^[A-Za-z][A-Za-z0-9_]+:/.test(p)) return null;
  p = p.replace(/^\\\\(localhost|127\.0\.0\.1|\[::1\]|\.)\\([A-Za-z])\$(?=\\|$)/i, '$2:');
  let unresolved = false;
  // a literal word (quoted or plain text) has no expansions; only expand words the shell expands
  if (kind !== 'lit') {
    p = p.replace(/\$\{env:([A-Za-z_][\w]*)\}|\$env:([A-Za-z_][\w]*)|\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)|%([A-Za-z_][\w]*)%/gi, (m, a, b, c, d, e) => {
      const v = envLookup(ctx, a || b || c || d || e);
      if (typeof v !== 'string' || !v) { unresolved = true; return m; }
      return v;
    });
  }
  if (unresolved || (kind !== 'lit' && /[$`]|\$\(|%[A-Za-z_]/.test(p))) return null;
  const win = isWin(ctx);
  if (win) {
    const msys = /^\/([A-Za-z])(\/|$)(.*)$/.exec(p);
    if (msys) p = `${msys[1].toUpperCase()}:\\${msys[3]}`;
    else if (/^\/tmp(\/|$)/.test(p)) {
      const t = envLookup(ctx, 'TEMP') ?? envLookup(ctx, 'TMP');
      if (!t) return null;
      p = t + p.slice(4);
    }
    const base = cwd ?? 'C:\\';
    let r = path.win32.resolve(base, p);
    // Windows ignores trailing dots and spaces and treats name:stream as the same file
    const colon = r.indexOf(':', 2);
    if (colon >= 0) r = r.slice(0, colon);
    r = r.split('\\').map((c, i) => (i === 0 ? c : c.replace(/[. ]+$/, ''))).join('\\');
    return r;
  }
  return path.posix.resolve(cwd ?? '/', p);
}

const NULL_TARGETS = new Set(['/dev/null', 'nul', '$null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'con']);

// ---------------------------------------------------------------- shell

function classifyShell(command, dialect, ctx) {
  if (typeof command !== 'string') return unparseable('command is not a string');
  if (!command.trim()) return unparseable('empty command');
  if (command.length > MAX_COMMAND) return unparseable('command too long to classify');
  if (command.includes('\u0000')) return unparseable('command contains a NUL byte');
  return classifyScript(command, dialect, ctx, 0);
}

function classifyScript(command, dialect, ctx, depth) {
  const parsed = parseShell(command, dialect, depth);
  if (parsed.error) return unparseable(parsed.error);
  const st = { cwd: ctx.cwd ?? null, paths: [], readPaths: [], depth };
  const results = [];
  for (const seg of parsed.segments) results.push(classifySegment(seg, ctx, st));
  return aggregate(results, st);
}

function aggregate(results, st) {
  let best = local('no command reaches prod');
  const calls = [];
  for (const res of results) {
    if (res.class !== 'local') calls.push(strip(res));
    if (RANK[res.class] > RANK[best.class]) best = res;
  }
  const out = strip(best);
  if (st.paths.length) out.paths = [...new Set(st.paths)];
  if (st.readPaths.length) out.readPaths = [...new Set(st.readPaths)];
  if (calls.length) out.calls = calls;
  return out;
}

function strip(res) {
  const o = { class: res.class };
  for (const k of ['scope', 'target', 'host']) if (res[k] !== undefined) o[k] = res[k];
  o.reason = res.reason;
  return o;
}

function classifySegment(seg, ctx, st) {
  if (seg.unparseable) return unparseable(seg.unparseable);
  const h = helpers(seg, ctx, st);
  for (const red of seg.redirects) {
    const op = red.op.replace(/^\d+|^\*/, '');
    if (red.target.startsWith('&') && /^&(\d+|-)$/.test(red.target)) continue;
    if (NULL_TARGETS.has(red.target.toLowerCase())) continue;
    if (op === '<') { if (!h.read(red.target, red.kind)) return unparseable('input file is not a literal path'); continue; }
    if (op === '<<' || op === '<<<' || op === '<<-') continue;
    if (!h.write(red.target, red.kind)) return unparseable('redirect target is not a literal path');
  }
  if (!seg.argv.length) return local('redirect or assignment only');
  const name = binName(seg.argv[0]);
  const res = classifyCommand(name, seg, ctx, h);
  if (h.bad) return unparseable(h.bad);
  if (res.class === 'local' && (!DATA_COMMANDS.has(name) || (name === 'sed' && SED_EXEC_RE.test(seg.argv.slice(1).join(' '))))) {
    const b = backstop(name, seg, ctx);
    if (b) return b;
  }
  return res;
}

// Words that are only data for these programs; anything else that mentions a prod binary with a
// changing verb in its arguments (or its input) may well run it.
const DATA_COMMANDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'write-output', 'write-host', 'write-information',
  'write-verbose', 'write-warning', 'write-error', 'write-debug', 'which', 'where', 'whereis', 'type', 'get-command', 'gcm', 'command', 'man', 'help', 'get-help', 'jq', 'yq', 'sed', 'test', '[', '[[',
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'column', 'less', 'more', 'base64', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'diff', 'cmp', 'comm', 'tee', 'rem', 'true', 'false', ':',
  'get-content', 'gc', 'out-file', 'set-content', 'add-content', 'touch', 'mkdir', 'rm', 'mv', 'cp', 'ls', 'dir', 'find', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink',
  'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'cd', 'pushd', 'popd', 'set-location', 'sl', 'git', 'gh', 'source']);
// GNU sed's `e` command and the s///e flag run shell commands.
const SED_EXEC_RE = /(^|[\s;{}0-9$\/,'"])e(\s|$)|\/[gpiImMw0-9]*e[gpiImMw0-9]*(\s|;|$|'|")/;
let backstopReCache = null;
const backstopRe = () => (backstopReCache ??= new RegExp(`(^|[^A-Za-z0-9_-])(${[...PROD_BINS, 'quill', 'session-quill'].map((b) => b.replace(/-/g, '\\-')).join('|')})(\\.exe|\\.cmd|\\.ps1)?($|[^A-Za-z0-9_.-])`, 'i'));
const NOOP_H = { bad: null, write: () => true, read: () => true, chdir: () => {}, script: () => local('nested script') };

function backstop(name, seg, ctx) {
  const text = [seg.argv.slice(1).join(' '), seg.stdin ?? ''].join(' ');
  if (!backstopRe().test(text)) return null;
  const tokens = text.split(/[\s'"`;&|(){}!,=<>]+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const nm = binName(tokens[i]).replace(/\.ps1$/, '');
    if (!PROD_BINS.includes(nm) && nm !== 'quill' && nm !== 'session-quill') continue;
    const argv = tokens.slice(i);
    const fake = { argv, kinds: argv.map(() => 'lit'), redirects: [], stdin: null, stdinDyn: false, piped: false, env: {}, dialect: 'bash', nested: true };
    const inner = classifyCommand(nm, fake, ctx, NOOP_H);
    if (inner.class === 'privileged') return privileged(`${name} arguments run ${nm}: ${inner.reason}`);
    if (inner.class !== 'local' && inner.class !== 'read') return unknownProd(`${name} arguments mention ${nm} ${argv[1] ?? ''}, which may run it (${inner.reason})`);
  }
  return null;
}

function helpers(seg, ctx, st) {
  const h = {
    bad: null,
    write(word, kind = 'lit') {
      if (kind === 'group' || (kind !== 'lit' && !/[$%~]/.test(String(word)))) { h.bad = 'write target is not literal'; return false; }
      if (/[*?[]/.test(String(word).replace(/^\\\\[?.]\\/, '')) || hasBraceExpansion(word)) { h.bad = `write target has wildcards: ${String(word).slice(0, 80)}`; return false; }
      if (NULL_TARGETS.has(String(word).toLowerCase())) return true;
      const p = st.cwd === null && !isAbsLike(word) ? null : resolveLiteral(word, ctx, st.cwd ?? undefined, kind);
      if (!p) { h.bad = `write target is not a literal path: ${String(word).slice(0, 80)}`; return false; }
      st.paths.push(p);
      return true;
    },
    read(word, kind = 'lit') {
      if (kind === 'group' || (kind !== 'lit' && !/[$%~]/.test(String(word)))) { h.bad = 'read target is not literal'; return false; }
      if (NULL_TARGETS.has(String(word).toLowerCase()) || word === '-') return true;
      const p = st.cwd === null && !isAbsLike(word) ? null : resolveLiteral(word, ctx, st.cwd ?? undefined, kind);
      if (!p) { h.bad = `read target is not a literal path: ${String(word).slice(0, 80)}`; return false; }
      st.readPaths.push(p);
      return true;
    },
    chdir(word, kind) {
      st.cds = (st.cds ?? 0) + 1;
      if (st.cds > 256) { h.bad = 'too many directory changes to follow'; st.cwd = null; return; }
      if (seg.nested || kind !== 'lit' || word === '-') { st.cwd = null; return; }
      const p = word === undefined ? ctx.home ?? null : st.cwd === null && !isAbsLike(word) ? null : resolveLiteral(word, ctx, st.cwd ?? undefined);
      st.cwd = p ?? null;
    },
    script(text, dialect) {
      return classifyScript(text, dialect, ctx, st.depth + 1);
    },
  };
  return h;
}

function isAbsLike(word) {
  return /^([A-Za-z]:[\\/]|\\\\|\/|~)/.test(String(word));
}

// Option scanner: returns positionals (with their kinds) and a map of option → value(s).
function scan(args, kinds, { values = new Set(), booleans = new Set(), longDefault = 'flag', shortValues = '' } = {}) {
  const pos = [];
  const posKinds = [];
  const opts = new Map();
  const set = (k, v, kind) => { if (!opts.has(k)) opts.set(k, []); opts.get(k).push({ v, kind }); };
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === '--') { for (let j = i + 1; j < args.length; j += 1) { pos.push(args[j]); posKinds.push(kinds[j]); } break; }
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=');
      if (eq > 0) { set(t.slice(0, eq), t.slice(eq + 1), kinds[i]); continue; }
      if (values.has(t) || (longDefault === 'value' && !booleans.has(t) && !t.startsWith('--no-') && i + 1 < args.length && !args[i + 1].startsWith('-'))) { set(t, args[i + 1], kinds[i + 1]); i += 1; continue; }
      set(t, true, 'lit');
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) {
      if (values.has(t)) { set(t, args[i + 1], kinds[i + 1]); i += 1; continue; }
      // combined short flags (-fsSL, -XPOST, -nprod)
      let consumed = false;
      for (let c = 1; c < t.length; c += 1) {
        const f = `-${t[c]}`;
        if (values.has(f) || shortValues.includes(t[c])) {
          if (c + 1 < t.length) set(f, t.slice(c + 1), kinds[i]);
          else { set(f, args[i + 1], kinds[i + 1]); i += 1; }
          consumed = true;
          break;
        }
        set(f, true, 'lit');
      }
      if (!consumed && t.length === 2) continue;
      continue;
    }
    pos.push(t);
    posKinds.push(kinds[i]);
  }
  const first = (...names) => { for (const n of names) if (opts.has(n)) return opts.get(n)[0].v; return undefined; };
  const all = (...names) => names.flatMap((n) => (opts.get(n) ?? []));
  const has = (...names) => names.some((n) => opts.has(n));
  return { pos, posKinds, opts, first, all, has };
}

// ---------------------------------------------------------------- dispatch

const SCRIPT_NAME_RE = /deploy|release|publish|apply|migrate|rollout|provision|destroy|\bprod(uction)?\b/i;
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|mts|rb|pl|php)$/i;
const PROD_BINS = ['kubectl', 'helm', 'k9s', 'aws', 'gcloud', 'gsutil', 'bq', 'az', 'argocd', 'psql', 'mysql', 'mongosh', 'mongo', 'redis-cli', 'terraform', 'tofu', 'pulumi', 'cdk', 'serverless', 'sls', 'eksctl', 'sqlcmd'];
const PROD_BIN_RE = new RegExp(`(^|[^A-Za-z0-9_-])(${PROD_BINS.map((b) => b.replace(/-/g, '\\-')).join('|')})(\\.exe)?([^A-Za-z0-9_-]|$)`, 'i');
const SDK_RE = /@aws-sdk|aws-sdk|\bboto3\b|\bbotocore\b|@kubernetes\/client-node|\bkubernetes\b|@google-cloud|google\.cloud|\bgoogleapis\b|@azure\/|\bazure\.(identity|mgmt|storage|cosmos)|\bmysql2?\b|\bpsycopg2?\b|\bpg8000\b|\bsqlalchemy\b|\bmongodb\b|\bpymongo\b|\bioredis\b|\bredis\b|\bsequelize\b|\bknex\b|@prisma\/client|\btypeorm\b|\bpyodbc\b|\bmssql\b|\btedious\b|\bpymysql\b|mysql\.connector|\bcx_Oracle\b|\boracledb\b|\bsnowflake\b|\bclickhouse|\bcassandra\b|\belasticsearch\b|@elastic\/|\bkafka|\bhvac\b|node-vault|\bstripe\b/i;
// Inline code that starts processes or evaluates strings can run anything, however it spells it.
const PROCESS_IN_CODE_RE = /child_process|\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)|\bspawn(Sync)?\s*\(|\bexec(Sync|File|FileSync)?\s*\(|\bPopen\b|\bsystem\s*\(|\beval\s*\(|\b__import__\b|\bimportlib\b|Deno\.(run|Command)|Bun\.(spawn|\$)|\bshell_exec\b|\bpassthru\b|\bproc_open\b|\bpopen\s*\(|IO\.popen|%x[({[]|Runtime\.getRuntime|\bnew Function\s*\(/;
const BACKTICK_LANGS = new Set(['perl', 'ruby', 'php', 'awk']);
const PG_RE = /require\(\s*['"]pg['"]\s*\)|from\s+['"]pg['"]|import\s+pg\b|import\(\s*['"]pg['"]\s*\)/;
const QUILL_IN_CODE_RE = /session-quill|[\\/]bin[\\/]quill\.js|src[\\/]cli[\\/]|['"`]quill(\.cmd|\.ps1)?['"`\s]/i;
const HTTP_LIB_RE = /\b(requests|httpx|axios|aiohttp|urllib\w*|got|superagent|ky|needle|node-fetch|undici|fetch|http\.client|https?|XMLHttpRequest|WebClient|HttpClient|Net::HTTP|Faraday|curl_init)\b/i;
const HTTP_WRITE_IN_CODE_RE = /\b(requests|httpx|session|client|aiohttp|axios|got|superagent|ky|needle|urllib3|http)\s*\.\s*(post|put|patch|delete|request)\s*\(|method\s*[:=]\s*['"`]?(post|put|patch|delete)\b|\bbody\s*:|\bdata\s*=\s*b?['"{]|urlopen\s*\([^)]*data\s*=|Request\s*\([^)]*data\s*=|\bsmtplib\b|\bnodemailer\b|\bnet\.(connect|createConnection)\b|\bsocket\.(socket|create_connection)\b|\bftplib\b|\bparamiko\b/i;

function inlineCode(code, kind, lang) {
  if (kind !== 'lit') return unknownProd(`${lang} inline code is not literal`);
  if (QUILL_IN_CODE_RE.test(code)) return privileged(`${lang} inline code invokes the Quill CLI`);
  if (PROD_BIN_RE.test(code) || SDK_RE.test(code) || PG_RE.test(code)) return unknownProd(`${lang} inline code names a prod binary or SDK client`);
  if (/\b(symlink|symlinkSync|link|linkSync|hardlink_to|symlink_to|CreateSymbolicLink|CreateHardLink)\s*\(/i.test(code)) return unparseable(`${lang} inline code creates links the guard cannot follow`);
  if (PROCESS_IN_CODE_RE.test(code) || (BACKTICK_LANGS.has(lang) && /`[^`]+`/.test(code)) || (lang === 'awk' && /getline|\|\s*"|print[^;]*\|/.test(code))) return unknownProd(`${lang} inline code starts processes or evaluates code the guard cannot follow`);
  if (HTTP_WRITE_IN_CODE_RE.test(code) || (HTTP_LIB_RE.test(code) && /\.\s*(post|put|patch|delete|request|send|upload)\w*\s*\(/i.test(code))) return xwrite('http.write', undefined, `${lang} inline code sends data over the network`);
  return local(`${lang} inline code`);
}

function scriptByName(file, args = [], what = 'script') {
  const base = String(file).replace(/^.*[\\/]/, '');
  if (SCRIPT_NAME_RE.test(base)) return unknownProd(`${what} ${base} looks like a deploy/release step`);
  const firstArg = args.find((x) => !x.startsWith('-'));
  if (firstArg && SCRIPT_NAME_RE.test(firstArg)) return unknownProd(`${what} ${base} ${firstArg} looks like a deploy/release step`);
  return local(`${what} ${base}`);
}

function classifyCommand(name, seg, ctx, h) {
  const argv = seg.argv;
  const kinds = seg.kinds;
  const args = argv.slice(1);
  const ak = kinds.slice(1);
  const ps = seg.dialect === 'powershell';
  const cmdD = seg.dialect === 'cmd';

  // a script run directly (./deploy.sh, .\provision.ps1, scripts/x.py)
  if (seg.script !== undefined) {
    if (seg.scriptKind !== 'lit') return unparseable('script path is not literal');
    return scriptByName(seg.script, seg.scriptArgs ?? []);
  }

  switch (name) {
    case 'kubectl': return kubectl(args, ak, seg, ctx);
    case 'helm': return helm(args, ak, ctx);
    case 'k9s': {
      const s = scan(args, ak, { values: new Set(['--context', '-n', '--namespace', '--kubeconfig', '-c', '--command', '-l', '--logLevel']) });
      if (['version', 'info', 'help'].includes(s.pos[0]) || s.has('-h', '--help')) return read('k9s info');
      return write('k8s.write', s.first('--context') ?? ctx.kubeContext, 'k9s can change any resource');
    }
    case 'aws': return aws(args, ak, seg, ctx, h);
    case 'gcloud': return gcloud(args, ak, ctx);
    case 'gsutil': return gsutil(args, ak, h);
    case 'bq': return bq(args, ak, ctx);
    case 'az': return az(args, ak, ctx);
    case 'argocd': return argocd(args, ak);
    case 'psql': return psql(args, ak, seg, ctx, h);
    case 'mysql': case 'mariadb': return mysql(args, ak, seg, h);
    case 'mongosh': case 'mongo': return mongosh(args, ak, seg);
    case 'redis-cli': return redis(args, ak);
    case 'sqlcmd': return sqlcmd(args, ak, h);
    case 'terraform': case 'tofu': return terraform(args, ak);
    case 'pulumi': return pulumi(args, ak);
    case 'cdk': return cdk(args, ak);
    case 'serverless': case 'sls': return serverless(args, ak);
    case 'eksctl': {
      const s = scan(args, ak, { longDefault: 'value', booleans: new Set(['--approve', '--wait', '--all']) });
      if (['get', 'version', 'info', 'help', 'completion'].includes(s.pos[0]) || (s.pos[0] === 'utils' && /^(describe-|schema)/.test(s.pos[1] ?? ''))) return read('eksctl read');
      return write('cloud.write', s.first('--profile') ?? ctx.awsProfile, `eksctl ${s.pos[0] ?? ''} changes clusters`.trim());
    }
    case 'git': return git(args, ak, seg, ctx, h);
    case 'gh': return gh(args, ak, seg, ctx);
    case 'quill': case 'session-quill': return quill(args);
    case 'node': case 'deno': case 'bun': case 'tsx': case 'ts-node':
      return nodeLike(name, args, ak, seg, ctx, h);
    case 'python': case 'python3': case 'py': case 'pythonw': case 'python2':
      return python(args, ak, seg, ctx, h);
    case 'ruby': case 'perl': case 'php': {
      if ((name === 'perl' || name === 'ruby') && args.some((t) => /^-[a-zA-Z]*i/.test(t) && !t.startsWith('--'))) {
        let codeGiven = false;
        const files = [];
        for (let i = 0; i < args.length; i += 1) {
          if (/^-[a-zA-Z]*[eE]$/.test(args[i])) { codeGiven = true; i += 1; continue; }
          if (args[i].startsWith('-')) continue;
          files.push(i);
        }
        for (const i of codeGiven ? files : files.slice(1)) h.write(args[i], ak[i]);
      }
      const flag = name === 'php' ? '-r' : name === 'perl' ? /^-[a-zA-Z]*[eE]$/ : /^-[a-zA-Z]*e$/;
      for (let i = 0; i < args.length; i += 1) {
        if ((typeof flag === 'string' && args[i] === flag) || (flag instanceof RegExp && flag.test(args[i]))) return inlineCode(args[i + 1] ?? '', ak[i + 1], name);
        if (!args[i].startsWith('-')) return scriptByName(args[i], args.slice(i + 1));
      }
      if (seg.stdin !== null) return seg.stdinDyn ? unknownProd(`${name} input has expansions`) : inlineCode(seg.stdin, 'lit', name);
      if (seg.piped) return unparseable(`code is piped into ${name}`);
      return local(name);
    }
    case 'source': {
      if (!args.length) return local('source');
      if (ak[0] !== 'lit') return unparseable('sourced file is not literal');
      return scriptByName(args[0], args.slice(1));
    }
    case 'cd': case 'chdir': case 'pushd': case 'set-location': case 'sl': case 'push-location': {
      if (ps) {
        const s = psParams(args, ak, { values: ['path', 'literalpath', 'stackname'], switches: ['passthru'] });
        const v = s.get('path') ?? s.get('literalpath') ?? s.pos[0];
        h.chdir(v?.v, v?.kind ?? 'lit');
      } else {
        const t = args.filter((x) => !/^-[LPe@]+$/.test(x) && !(cmdD && /^\/d$/i.test(x)));
        h.chdir(t[0], ak[args.indexOf(t[0])] ?? 'lit');
      }
      return local('change directory');
    }
    case 'popd': case 'pop-location': h.chdir(undefined, 'dyn'); return local('change directory');
    case 'npm': return npm(args, ak);
    case 'yarn': return yarn(args, ak);
    case 'pnpm': return pnpm(args, ak);
    case 'make': case 'gmake': case 'nmake': case 'mingw32-make': case 'just': case 'task': case 'rake': case 'mage': case 'invoke': case 'nx': case 'turbo':
    case 'gradle': case 'gradlew': case 'mvn': case 'mvnw': case 'ant': case 'cake': case 'psake': case 'invoke-build':
      return taskRunner(name, args, ak);
    case 'flyway': case 'liquibase': case 'alembic': case 'sqitch': case 'dbmate': case 'goose': case 'atlas':
      return unknownProd(`${name} runs database migrations`);
    case 'prisma': return args.includes('migrate') || (args[0] === 'db' && args[1] === 'push') ? unknownProd('prisma migration') : local('prisma');
    case 'rails': case 'knex': case 'sequelize': case 'typeorm':
      return args.some((x) => /migrat|db:(push|seed|setup|reset|drop)/.test(x)) ? unknownProd(`${name} database migration`) : local(name);
    case 'docker': case 'podman': case 'nerdctl': return docker(name, args, ak, seg);
    case 'twine': return args.includes('upload') ? xwrite('package.publish', undefined, 'twine upload publishes a package') : local('twine');
    case 'gem': return args[0] === 'push' || args[0] === 'yank' || args[0] === 'owner' ? xwrite('package.publish', 'rubygems.org', `gem ${args[0]} publishes`) : local('gem');
    case 'cargo': return ['publish', 'yank', 'owner'].includes(args[0]) ? xwrite('package.publish', 'crates.io', `cargo ${args[0]} publishes`) : args[0] === 'run' && args.some((x) => SCRIPT_NAME_RE.test(x)) ? unknownProd('cargo run of a deploy/release binary') : local('cargo');
    case 'go': return args[0] === 'run' && args.some((x) => SCRIPT_NAME_RE.test(x)) ? unknownProd('go run of a deploy/release program') : local('go');
    case 'oc': return kubectl(args, ak, seg, ctx);
    case 'ansible': case 'ansible-playbook': case 'skaffold': case 'velero': case 'istioctl': case 'linkerd': case 'flux': case 'vault': case 'consul': case 'nomad': case 'doctl':
    case 'oci': case 'ibmcloud': case 'heroku': case 'supabase': case 'wrangler': case 'drizzle-kit': case 'fly': case 'flyctl': case 'vercel': case 'netlify': case 'railway': case 'glab': case 'hub':
    case 'mysqladmin': case 'dropdb': case 'createdb': case 'pg_restore': case 'pg_ctl': case 'clickhouse-client': case 'clickhouse': case 'cqlsh': case 'mongorestore': case 'mongoimport': case 'cf': case 'kn': case 'rosa':
      return otherProd(name, args);
    case 'poetry': return args.includes('publish') ? xwrite('package.publish', undefined, 'poetry publish') : local('poetry');
    case 'dotnet': return args[0] === 'nuget' && args[1] === 'push' ? xwrite('package.publish', undefined, 'dotnet nuget push') : args[0] === 'ef' && args[1] === 'database' ? unknownProd('dotnet ef database update') : local('dotnet');
    case 'nuget': return args[0]?.toLowerCase() === 'push' ? xwrite('package.publish', undefined, 'nuget push') : local('nuget');
    case 'vsce': case 'ovsx': return args[0] === 'publish' ? xwrite('package.publish', undefined, `${name} publish`) : local(name);
    case 'curl': return ps && !/curl\.exe$/i.test(argv[0]) ? strictest(curl(args, ak, seg, h), iwr(args, ak, h)) : curl(args, ak, seg, h);
    case 'wget': return ps && !/wget\.exe$/i.test(argv[0]) ? strictest(wget(args, ak, h), iwr(args, ak, h)) : wget(args, ak, h);
    case 'http': case 'https': case 'xh': case 'xhs': case 'httpie': return httpie(args, ak, seg, h);
    case 'invoke-restmethod': case 'irm': case 'invoke-webrequest': case 'iwr': return iwr(args, ak, h);
    case 'scp': case 'pscp': return scp(args, ak, h);
    case 'rsync': return rsync(args, ak, h);
    case 'ssh': case 'plink': case 'mosh': {
      if (args.length === 1 && /^-[VG]$/.test(args[0])) return local('ssh info');
      return unknownProd(`${name} runs commands on a remote host`);
    }
    case 'sftp': case 'ftp': case 'lftp': return unknownProd(`${name} transfers files to a remote host`);
    case 'smbclient': return xwrite('http.write', remoteHost(String(args.find((x) => x.startsWith('//')) ?? '').replace(/^\/\/([^/]+).*$/, '$1:')), 'smbclient can upload files');
    case 'openssl': {
      if (['s_client', 's_server'].includes(args[0])) {
        const i = args.indexOf('-connect');
        return xwrite('http.write', i >= 0 ? hostOf(args[i + 1]) : undefined, 'openssl s_client sends its input to a host');
      }
      return local('openssl');
    }
    case 'mshta': case 'rundll32': case 'regsvr32': case 'msbuild': case 'installutil': case 'regasm': case 'regsvcs': case 'add-type':
      return unparseable(`${name} loads or runs code the guard cannot follow`);
    case 'cscript': case 'wscript': {
      const f = args.find((x) => !x.startsWith('//') && !x.startsWith('/'));
      return f ? scriptByName(f) : unparseable(`${name} without a script`);
    }
    case 'invoke-item': case 'ii': {
      const s = psParams(args, ak, { values: ['path', 'literalpath', 'filter', 'include', 'exclude', 'credential'], switches: [] });
      const t = s.get('path') ?? s.get('literalpath') ?? s.pos[0];
      if (!t || t.kind !== 'lit') return unparseable('Invoke-Item target is not literal');
      return /\.(lnk|url|exe|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|wsh|hta|msi|scr|pif)$/i.test(String(t.v)) ? strictest(scriptByName(t.v), unknownProd('Invoke-Item runs a program or shortcut')) : local('open a file');
    }
    case 'register-scheduledtask': case 'new-scheduledtask': case 'set-scheduledtask': case 'start-scheduledtask': case 'schtasks': case 'new-service':
      if (name === 'schtasks' && args.some((x) => /^\/query$/i.test(x))) return local('schtasks /query');
      return unknownProd(`${name} schedules or installs something that runs later`);
    case 'stop-computer': case 'restart-computer': return unknownProd(`${name} shuts down or restarts a machine`);
    case 'stop-process': case 'spps': case 'kill': case 'stop-service': case 'restart-service': case 'start-service': case 'set-service': case 'suspend-service': {
      if (args.some((x) => /^-(computername|cn)$/i.test(x))) return unknownProd(`${name} on a remote computer`);
      return local(name);
    }
    case 'nc': case 'ncat': case 'netcat': case 'socat': case 'telnet': {
      const addr = name === 'socat' ? args.map((x) => /^(?:tcp|udp|ssl|openssl|sctp)[46]?(?:-connect)?:([^:,]+)/i.exec(x)).find(Boolean) : null;
      const host = addr ? addr[1] : args.find((x) => !x.startsWith('-'));
      return xwrite('http.write', host, `${name} can send data to any host`);
    }
    case 'sendmail': case 'mail': case 'mailx': case 'mutt': case 'send-mailmessage':
      return xwrite('http.write', undefined, `${name} sends mail`);
    case 'invoke-command': case 'icm': case 'enter-pssession': case 'etsn': case 'new-pssession': case 'nsn': case 'invoke-wmimethod': case 'invoke-cimmethod': {
      const s = psParams(args, ak, { values: ['computername', 'cn', 'session', 'hostname', 'vmname', 'containerid', 'uri', 'connectionuri', 'credential', 'filepath', 'argumentlist', 'scriptblock', 'name', 'class', 'methodname', 'path'], switches: ['asjob', 'enablenetworkaccess'] });
      if (name.startsWith('invoke-command') || name === 'icm') {
        if (['computername', 'cn', 'session', 'hostname', 'vmname', 'containerid', 'uri', 'connectionuri'].some((p) => s.get(p))) return unknownProd('Invoke-Command on a remote computer');
        const fp = s.get('filepath');
        if (fp) return fp.kind === 'lit' ? scriptByName(fp.v) : unparseable('Invoke-Command -FilePath is not literal');
        return local('Invoke-Command script block (classified separately)');
      }
      return unknownProd(`${name} reaches a remote or management interface`);
    }
    case 'invoke-sqlcmd': return invokeSqlcmd(args, ak, h);
    case 'at': case 'batch': case 'crontab': {
      if (name === 'crontab') {
        const files = args.filter((t, i) => (!t.startsWith('-') || t === '-') && args[i - 1] !== '-u');
        if (!files.length && args.some((t) => /^-[lre]$/.test(t))) return local('crontab inspection');
        if (files.length && files[0] !== '-') return unknownProd('crontab installs a schedule from a file');
      }
      if (name === 'at' && args.includes('-f')) return unknownProd('at runs a script file later');
      if (seg.stdin !== null) { if (seg.stdinDyn) return unparseable(`${name} input has expansions`); return strictest(unknownProd(`${name} schedules commands`), h.script(seg.stdin, 'bash')); }
      return unparseable(`${name} schedules commands the guard cannot see`);
    }
    case 'patch': {
      const s = scan(args, ak, { values: new Set(['-p', '-i', '--input', '-o', '--output', '-d', '--directory', '-r', '--reject-file', '-B', '-D', '-F', '-V', '-z', '-Y', '-g']) });
      const out = s.all('-o', '--output')[0];
      const dir = s.all('-d', '--directory')[0];
      if (out) h.write(out.v, out.kind);
      else if (s.pos[0]) h.write(s.pos[0], s.posKinds[0]);
      else h.write(dir ? dir.v : '.', dir ? dir.kind : 'lit');
      for (const x of s.all('-i', '--input')) h.read(x.v, x.kind);
      return local('patch');
    }
    case 'robocopy': case 'xcopy': {
      const pos = args.map((t, i) => ({ v: t, kind: ak[i] })).filter((x) => !x.v.startsWith('/') && !x.v.startsWith('-'));
      if (pos[0]) h.read(pos[0].v, pos[0].kind);
      if (pos[1]) h.write(pos[1].v, pos[1].kind); else h.write('.', 'lit');
      return local(`${name} files`);
    }
    case 'icacls': case 'takeown': case 'attrib': case 'cacls': {
      const pos = args.map((t, i) => ({ v: t, kind: ak[i] })).filter((x) => !x.v.startsWith('/') && !/^[+-][rahsi]$/i.test(x.v));
      if (!pos.length) return local(name);
      h.write(pos[0].v, pos[0].kind);
      return local(`${name} changes file attributes`);
    }
    case 'fsutil': {
      const sub = args.map((x) => x.toLowerCase());
      if (sub[0] === 'hardlink' && sub[1] === 'create') {
        if (args.length < 4) h.bad = 'fsutil hardlink create without both paths';
        for (const i of [2, 3]) if (args[i] !== undefined) h.write(args[i], ak[i]);
        return local('fsutil hardlink create');
      }
      if (sub[0] === 'fsinfo' || sub.some((x) => x === 'query' || x === 'list' || x === 'queryvalue')) return local('fsutil query');
      return unparseable('fsutil changes file-system state the guard cannot follow');
    }
    case 'link': {
      const pos = args.map((t, i) => ({ v: t, kind: ak[i] })).filter((x) => !x.v.startsWith('-'));
      if (pos.length !== 2) { h.bad = 'link needs a target and a name'; return local('link'); }
      for (const x of pos) h.write(x.v, x.kind);
      return local('link');
    }
    case 'mklink': {
      const pos = args.map((t, i) => ({ v: t, kind: ak[i] })).filter((x) => !x.v.startsWith('/'));
      for (const x of pos) h.write(x.v, x.kind);
      if (pos.length < 2) h.bad = 'mklink without link and target';
      return local('mklink');
    }
    case 'start-transcript': {
      const s = psParams(args, ak, { values: ['path', 'literalpath', 'outputdirectory'], switches: ['append', 'force', 'noclobber', 'includeinvocationheader', 'useminimalheader'] });
      const t = s.get('path') ?? s.get('literalpath') ?? s.get('outputdirectory') ?? s.pos[0];
      if (!t || t.v === true) { h.bad = 'Start-Transcript writes to a default location'; return local('transcript'); }
      h.write(t.v, t.kind);
      return local('transcript');
    }
    case 'alias': {
      let worst = local('alias');
      for (let i = 0; i < args.length; i += 1) {
        const eq = args[i].indexOf('=');
        if (eq <= 0) continue;
        if (ak[i] !== 'lit') return unparseable('alias value is not literal');
        worst = strictest(worst, h.script(args[i].slice(eq + 1), 'bash'));
      }
      return worst;
    }
    case 'set-alias': case 'sal': case 'new-alias': case 'nal': {
      const s = psParams(args, ak, { values: ['name', 'value', 'description', 'option', 'scope'], switches: ['passthru', 'force'] });
      const value = s.get('value') ?? s.pos[s.get('name') ? 0 : 1];
      if (!value) return local('alias');
      if (value.kind !== 'lit') return unparseable('alias value is not literal');
      return h.script(value.v, 'powershell');
    }
    case 'awk': case 'gawk': case 'mawk': case 'nawk': {
      const s = scan(args, ak, { values: new Set(['-F', '-v', '-f', '--file', '--assign', '--field-separator', '-i', '--include', '-l', '--load', '-E', '--exec']) });
      const file = s.first('-f', '--file', '-E', '--exec');
      if (s.all('-i', '--include').some((x) => x.v === 'inplace')) for (let i = file !== undefined ? 0 : 1; i < s.pos.length; i += 1) h.write(s.pos[i], s.posKinds[i]);
      if (file !== undefined) return typeof file === 'string' ? scriptByName(file) : unparseable('awk program file is not literal');
      if (!s.pos.length) return local('awk');
      return inlineCode(s.pos[0], s.posKinds[0], 'awk');
    }
  }

  if (ps || cmdD) {
    const fileRes = psFileCmdlet(name, args, ak, h, cmdD);
    if (fileRes) return fileRes;
  }
  if (!ps) {
    const fileRes = posixFileCommand(name, args, ak, h);
    if (fileRes) return fileRes;
  }
  if (ps && ['get-childitem', 'gci', 'ls', 'dir'].includes(name)) {
    const s = psParams(args, ak, { values: ['path', 'literalpath', 'filter', 'include', 'exclude', 'depth', 'attributes'], switches: ['recurse', 'force', 'name', 'directory', 'file', 'hidden', 'readonly', 'system', 'followsymlink'] });
    const t = s.get('path') ?? s.get('literalpath') ?? s.pos[0];
    if (t && t.v !== true) for (const one of splitPs(t.v)) h.read(one, t.kind);
    return local('list a directory');
  }
  if (ps && ['select-string', 'sls'].includes(name)) {
    const s = psParams(args, ak, { values: ['path', 'literalpath', 'pattern', 'include', 'exclude', 'context', 'encoding', 'culture'], switches: ['simplematch', 'casesensitive', 'quiet', 'list', 'notmatch', 'allmatches', 'raw', 'noemphasis'] });
    const t = s.get('path') ?? s.get('literalpath') ?? s.pos[s.get('pattern') ? 0 : 1];
    if (t && t.v !== true) for (const one of splitPs(t.v)) h.read(one, t.kind);
    return local('search files');
  }
  if (ps && ['get-content', 'gc', 'type', 'cat', 'import-csv', 'ipcsv', 'import-clixml'].includes(name)) {
    const s = psParams(args, ak, { values: ['path', 'literalpath', 'totalcount', 'head', 'tail', 'first', 'encoding', 'delimiter', 'readcount', 'filter', 'include', 'exclude', 'stream', 'header'], switches: ['raw', 'wait', 'force', 'asbytestream'] });
    for (const p of [s.get('path'), s.get('literalpath'), s.pos[0]].filter(Boolean)) for (const one of splitPs(p.v)) h.read(one, p.kind);
    return local('read a file');
  }

  // repo scripts run by path or with a script extension
  if (/[\\/]/.test(argv[0]) || SCRIPT_EXT_RE.test(argv[0])) return scriptByName(argv[0], args);
  return local(`${name} is not a prod binary`);
}

const OTHER_READ = new Set(['get', 'list', 'ls', 'show', 'describe', 'status', 'version', 'help', 'info', 'logs', 'read', 'whoami', 'diff', 'template', 'lint', 'validate', 'check', 'view', 'inspect', 'search', 'render', 'history', 'tail']);

// Prod-capable CLIs outside the spec's list: a recognised read verb is a read, anything else is
// unknown-prod (there is no scope for them yet).
function otherProd(name, args) {
  if (['mysqladmin', 'dropdb', 'createdb', 'pg_restore', 'pg_ctl', 'mongorestore', 'mongoimport'].includes(name)) {
    if (name === 'mysqladmin' && args.length && args.every((x) => x.startsWith('-') || ['status', 'version', 'ping', 'processlist', 'variables', 'extended-status'].includes(x))) return read(`${name} status`);
    return unknownProd(`${name} changes a database`);
  }
  if (['clickhouse-client', 'clickhouse', 'cqlsh'].includes(name)) {
    const i = args.findIndex((x) => x === '-q' || x === '--query' || x === '-e' || x === '--execute');
    if (i >= 0) return sqlReadOnly(args[i + 1] ?? '') ? read(`${name} read-only query`) : write('db.write', undefined, `${name} runs a query that is not read-only`);
    return unknownProd(`${name} input is not visible`);
  }
  const words = args.filter((x) => !x.startsWith('-'));
  if (!words.length && args.some((x) => /^--?(version|help|h)$/.test(x))) return read(`${name} info`);
  if (name === 'vault' && words.some((x) => ['get', 'read', 'login', 'token'].includes(x))) return unknownProd('vault reads secrets or credentials');
  const hit = words.slice(0, 4).find((x) => OTHER_READ.has(x.toLowerCase()) || /^(list|get|describe|show)-/.test(x));
  const writey = words.slice(0, 4).find((x) => GC_WRITE.has(x.toLowerCase()) || MCP_MUTATING.has(x.toLowerCase()) || MCP_WRITE_VERBS.has(x.toLowerCase()) || /^(set|add|remove|delete|put)/.test(x));
  if (hit && (!writey || words.indexOf(hit) < words.indexOf(writey)) && name !== 'ansible' && name !== 'ansible-playbook') return read(`${name} ${hit}`);
  return unknownProd(`${name} ${words[0] ?? ''} is a prod-capable command without a scope`.trim());
}

function strictest(a, b) {
  return RANK[b.class] > RANK[a.class] ? b : a;
}

// ---------------------------------------------------------------- kubernetes

const KUBECTL_VALUES = new Set(['-n', '--namespace', '--context', '--kubeconfig', '-s', '--server', '--cluster', '--user', '--token', '-l', '--selector', '-o', '--output', '--as', '--as-group', '--as-uid',
  '-f', '--filename', '-c', '--container', '--field-selector', '--sort-by', '--tail', '--since', '--since-time', '--request-timeout', '-L', '--label-columns', '--template', '-p', '--patch', '--type',
  '--image', '--replicas', '--for', '--timeout', '-k', '--kustomize', '--chunk-size', '--certificate-authority', '--client-certificate', '--client-key', '--tls-server-name', '--cache-dir', '-v', '--v',
  '--profile', '--subresource', '--max-log-requests', '--limit-bytes', '--grace-period', '--field-manager', '--overrides', '--port', '--address', '--revision', '--to-revision', '--namespace-selector']);
const KUBECTL_READ = new Set(['get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'events', 'diff', 'wait', 'kustomize', 'completion', 'options', 'help']);

function kubectl(args, ak, seg, ctx) {
  const s = scan(args, ak, { values: KUBECTL_VALUES });
  const target = s.first('--context') ?? ctx.kubeContext;
  const [verb, sub] = s.pos;
  const w = (why) => write('k8s.write', target, why);
  if (!verb) return s.has('--version', '-h', '--help') ? read('kubectl info') : w('kubectl without a verb');
  if (s.posKinds[0] !== 'lit') return w('kubectl verb is not literal');
  const dryAll = s.all('--dry-run');
  const dry = dryAll.length ? dryAll[dryAll.length - 1].v : undefined; // kubectl uses the last one
  const dryRun = dry === true || dry === 'client' || dry === 'server';
  if (s.has('--raw')) return w('raw API request (may read secrets or change state)');
  if (verb === 'get') {
    const resources = s.pos.slice(1);
    if (resources.some((x, i) => s.posKinds[i + 1] !== 'lit' && i === 0)) return w('kubectl get of a dynamic resource');
    if (resources.some((x) => x.split(',').some((part) => /^secrets?($|\/|\.)/i.test(part)))) return w('reading secrets');
    return read('kubectl get');
  }
  if (KUBECTL_READ.has(verb)) return read(`kubectl ${verb}`);
  if (verb === 'auth' && (sub === 'can-i' || sub === 'whoami')) return read('kubectl auth check');
  if (verb === 'config' && ['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'].includes(sub)) return read('kubectl config read');
  if (verb === 'rollout' && (sub === 'status' || sub === 'history')) return read(`kubectl rollout ${sub}`);
  if (verb === 'plugin' && sub === 'list') return read('kubectl plugin list');
  if (dryRun && ['apply', 'create', 'run', 'expose', 'set', 'label', 'annotate', 'patch', 'replace', 'scale', 'autoscale', 'delete'].includes(verb)) return read(`kubectl ${verb} --dry-run`);
  return w(`kubectl ${verb} ${['exec', 'cp', 'port-forward', 'debug', 'proxy', 'attach'].includes(verb) ? 'reaches into the cluster' : 'changes the cluster'}`);
}

const HELM_VALUES = new Set(['--kube-context', '-n', '--namespace', '--kubeconfig', '-f', '--values', '--set', '--set-string', '--set-file', '--set-json', '--version', '--repo', '-o', '--output', '--timeout',
  '--post-renderer', '--description', '--registry-config', '--repository-config', '--repository-cache', '--username', '--password', '--ca-file', '--cert-file', '--key-file', '--max', '--revision', '--kube-apiserver', '--kube-token', '--kube-as-user']);
const HELM_READ = new Set(['list', 'ls', 'status', 'get', 'history', 'hist', 'show', 'inspect', 'template', 'lint', 'search', 'version', 'env', 'help', 'completion', 'verify', 'package', 'pull', 'fetch', 'create']);

function helm(args, ak, ctx) {
  const s = scan(args, ak, { values: HELM_VALUES });
  const [verb, sub] = s.pos;
  const target = s.first('--kube-context') ?? ctx.kubeContext;
  if (!verb) return read('helm info');
  if (verb === 'push') return xwrite('package.publish', undefined, 'helm push publishes a chart');
  if (verb === 'get' && !['notes', 'metadata'].includes(sub)) return write('k8s.write', target, `helm get ${sub ?? ''} can reveal secret values`.trim());
  if (HELM_READ.has(verb)) return read(`helm ${verb}`);
  if (verb === 'repo' && ['list', 'ls', 'add', 'update', 'up', 'index'].includes(sub)) return read(`helm repo ${sub}`);
  if ((verb === 'dependency' || verb === 'dep') && ['list', 'ls', 'build', 'update', 'up'].includes(sub)) return read(`helm dependency ${sub}`);
  if (verb === 'plugin' && ['list', 'ls'].includes(sub)) return read('helm plugin list');
  if (verb === 'registry' && sub === 'login') return local('helm registry login');
  return write('k8s.write', target, `helm ${verb} changes the cluster`);
}

// ---------------------------------------------------------------- clouds

const AWS_BOOLEANS = new Set(['--recursive', '--dryrun', '--dry-run', '--quiet', '--delete', '--no-progress', '--follow-symlinks', '--only-show-errors', '--exact-timestamps', '--size-only', '--force',
  '--human-readable', '--summarize', '--debug', '--no-paginate', '--no-verify-ssl', '--no-sign-request', '--no-cli-pager', '--with-decryption', '--follow', '--version', '--help', '--request-payer', '--cli-auto-prompt']);
const AWS_SECRET_GETS = new Set(['get-secret-value', 'get-password-data', 'get-login-password', 'get-login', 'get-authorization-token', 'get-session-token', 'get-federation-token', 'get-credentials-for-identity',
  'get-open-id-token', 'get-open-id-token-for-developer-identity', 'get-cluster-credentials', 'get-cluster-credentials-with-iam', 'get-role-credentials', 'get-access-key-info', 'get-temporary-credentials']);

function aws(args, ak, seg, ctx, h) {
  const s = scan(args, ak, { longDefault: 'value', booleans: AWS_BOOLEANS });
  const target = s.first('--profile') ?? (seg.env.AWS_PROFILE || undefined) ?? ctx.awsProfile;
  const [service, op] = s.pos;
  const w = (why) => write('cloud.write', target, why);
  if (!service || service === 'help' || op === 'help' || s.has('--version')) return read('aws info');
  if (s.posKinds[0] !== 'lit' || (op !== undefined && s.posKinds[1] !== 'lit')) return w('aws command is not literal');
  if (service === 's3') {
    if (op === 'ls' || op === 'presign') return read(`aws s3 ${op}`);
    if (op === 'cp' || op === 'mv' || op === 'sync') {
      const [src, dst] = s.pos.slice(2);
      if (typeof dst === 'string' && /^s3:\/\//i.test(dst)) return xwrite('cloud.write', `s3://${bucketOf(dst)}`, `aws s3 ${op} uploads to a bucket`, target ? { target } : {});
      if (op === 'mv' && typeof src === 'string' && /^s3:\/\//i.test(src)) return w('aws s3 mv deletes the source object');
      if (typeof dst === 'string') h.write(dst, s.posKinds[3]);
      return read(`aws s3 ${op} download`);
    }
    return w(`aws s3 ${op ?? ''} changes buckets`.trim());
  }
  if (service === 'configure') return ['list', 'get', 'list-profiles'].includes(op) || op === undefined ? read('aws configure read') : w('aws configure changes credentials');
  if (!op) return w('aws service without an operation');
  if (AWS_SECRET_GETS.has(op)) return w(`aws ${service} ${op} reads credentials or secrets`);
  if (/^get-parameters?(-by-path)?$/.test(op) && s.has('--with-decryption')) return w('aws ssm parameter read with decryption');
  if (/^(describe-|list-|get-|head-|batch-get-)/.test(op) || op === 'wait') return read(`aws ${service} ${op}`);
  if (service === 'logs' && ['tail', 'filter-log-events', 'start-query', 'get-query-results', 'stop-query'].includes(op)) return read(`aws logs ${op}`);
  if (service === 'dynamodb' && ['scan', 'query'].includes(op)) return read(`aws dynamodb ${op}`);
  if (service === 'cloudtrail' && op === 'lookup-events') return read('aws cloudtrail lookup-events');
  return w(`aws ${service} ${op} is not a read operation`);
}

function bucketOf(url) {
  return String(url).replace(/^s3:\/\//i, '').split('/')[0];
}

const GC_BOOLEANS = new Set(['--quiet', '-q', '--verbose', '--log-http', '--no-user-output-enabled', '--async', '--all', '--recursive', '--help', '-h', '--dry-run', '--force', '--version']);
const GC_READ = new Set(['list', 'describe', 'read', 'tail', 'version', 'info', 'help', 'get-iam-policy', 'get-value', 'get-server-config', 'ls', 'cat', 'du', 'search-all-resources', 'search-all-iam-policies', 'list-tags', 'list-grantable-roles']);
const GC_WRITE = new Set(['create', 'delete', 'update', 'deploy', 'ssh', 'scp', 'reset', 'start', 'stop', 'resize', 'patch', 'apply', 'import', 'export', 'login', 'activate-service-account', 'cp', 'mv', 'rm', 'rsync',
  'execute', 'submit', 'cancel', 'rollback', 'restart', 'enable', 'disable', 'call', 'publish', 'attach', 'detach', 'invoke', 'connect', 'migrate', 'failover', 'promote', 'restore', 'backup', 'clone', 'upgrade', 'scale', 'suspend', 'resume', 'undelete', 'run-command']);

function gcloud(args, ak, ctx) {
  const s = scan(args, ak, { longDefault: 'value', booleans: GC_BOOLEANS });
  const target = s.first('--project') ?? ctx.gcpProject;
  const w = (why) => write('cloud.write', target, why);
  if (!s.pos.length) return s.has('--version', '--help', '-h') ? read('gcloud info') : w('gcloud without a command');
  for (let i = 0; i < s.pos.length; i += 1) {
    const p = s.pos[i];
    if (s.posKinds[i] !== 'lit') return w('gcloud command is not literal');
    if (GC_READ.has(p) || /^(list|describe)-/.test(p)) return read(`gcloud ${s.pos.slice(0, i + 1).join(' ')}`);
    if (GC_WRITE.has(p) || /^(set|add|remove|print|get)-/.test(p) || p === 'set') return w(`gcloud ${s.pos.slice(0, i + 1).join(' ')} changes resources or reads credentials`);
  }
  return w('gcloud command has no recognised read verb');
}

function gsutil(args, ak, h) {
  const s = scan(args, ak, { values: new Set(['-o', '-h', '-u', '-p']) });
  const [op, sub] = s.pos;
  if (!op) return read('gsutil info');
  if (['ls', 'cat', 'stat', 'du', 'hash', 'version', 'help', 'signurl'].includes(op)) return read(`gsutil ${op}`);
  if (['acl', 'defacl', 'iam', 'label', 'lifecycle', 'logging', 'versioning', 'cors', 'web', 'retention', 'requesterpays', 'ubla', 'autoclass', 'rpo', 'pap', 'kms', 'defstorageclass', 'bucketpolicyonly'].includes(op) && sub === 'get') return read(`gsutil ${op} get`);
  if (op === 'notification' && sub === 'list') return read('gsutil notification list');
  if (op === 'cp' || op === 'rsync' || op === 'mv') {
    const files = s.pos.slice(1);
    const dst = files[files.length - 1];
    if (typeof dst === 'string' && /^gs:\/\//i.test(dst)) return xwrite('cloud.write', dst.replace(/^gs:\/\//i, 'gs://').split('/').slice(0, 3).join('/'), `gsutil ${op} uploads to a bucket`);
    if (op === 'mv' && files.slice(0, -1).some((x) => /^gs:\/\//i.test(x))) return write('cloud.write', undefined, 'gsutil mv deletes the source object');
    if (dst) h.write(dst, s.posKinds[s.pos.length - 1]);
    return read(`gsutil ${op} download`);
  }
  return write('cloud.write', undefined, `gsutil ${op} changes storage`);
}

function bq(args, ak, ctx) {
  const s = scan(args, ak, { values: new Set(['--project_id', '--location', '--format', '--dataset_id', '--max_rows', '-n', '--parameter', '--destination_table', '--job_id', '--api']) });
  const target = s.first('--project_id') ?? ctx.gcpProject;
  const [op] = s.pos;
  if (!op) return read('bq info');
  if (['ls', 'show', 'head', 'version', 'help', 'wait', 'info'].includes(op)) return read(`bq ${op}`);
  if (op === 'query') {
    if (s.has('--destination_table', '--replace', '--append_table')) return write('cloud.write', target, 'bq query writes to a table');
    if (s.has('--dry_run')) return read('bq query --dry_run');
    const sql = s.pos.slice(1).join(' ');
    if (!sql) return unknownProd('bq query SQL is not visible');
    if (s.posKinds.slice(1).some((x) => x !== 'lit')) return unknownProd('bq query SQL is not literal');
    return sqlReadOnly(sql) ? read('bq SELECT') : write('db.write', target, 'bq query is not read-only SQL');
  }
  return write('cloud.write', target, `bq ${op} changes datasets`);
}

const AZ_READ = new Set(['list', 'show', 'query', 'version', 'find', 'wait', 'exists', 'tail', 'download', 'help', 'get-versions', 'get-upgrades', 'browse', 'check-name', 'list-locations']);
const AZ_WRITE_RE = /^(create|delete|update|set|start|stop|restart|deallocate|redeploy|reimage|run-command|invoke|ssh|deploy|add|remove|purge|scale|swap|reset|get-access-token|get-credentials|import|upload|sync|login|logout|rotate|renew|assign|grant|revoke|enable|disable|approve|reject|restore|failover|regenerate-key|keys|upgrade|move|copy|generate-sas|execute|apply|patch|attach|detach|cancel|abort|exec|connect|tunnel)$/;

function az(args, ak, ctx) {
  const s = scan(args, ak, { longDefault: 'value', booleans: new Set(['--only-show-errors', '--debug', '--verbose', '--yes', '-y', '--no-wait', '--help', '-h', '--all', '--version']) });
  const target = s.first('--subscription') ?? ctx.azureSubscription;
  const w = (why) => write('cloud.write', target, why);
  if (!s.pos.length) return s.has('--version', '--help', '-h') ? read('az info') : w('az without a command');
  for (let i = 0; i < s.pos.length; i += 1) {
    const p = s.pos[i];
    if (s.posKinds[i] !== 'lit') return w('az command is not literal');
    if (AZ_READ.has(p) || /^(list|show)-/.test(p)) return read(`az ${s.pos.slice(0, i + 1).join(' ')}`);
    if (AZ_WRITE_RE.test(p)) return w(`az ${s.pos.slice(0, i + 1).join(' ')} changes resources or reads credentials`);
  }
  return w('az command has no recognised read verb');
}

const ARGO_BOOLEANS = new Set(['--grpc-web', '--insecure', '--plaintext', '--core', '--prune', '--force', '--dry-run', '--async', '--refresh', '--hard-refresh', '--watch', '--cascade', '--yes', '-y', '--local', '--apply-out-of-sync-only', '--help', '-h', '--upsert']);
const ARGO_APP_READ = new Set(['get', 'list', 'diff', 'history', 'logs', 'manifests', 'resources', 'wait', 'man']);

function argocd(args, ak) {
  const s = scan(args, ak, { longDefault: 'value', booleans: ARGO_BOOLEANS, values: new Set(['-o', '-p', '-N']) });
  const [group, verb, a1, a2] = s.pos;
  const w = (target, why) => write('argo.sync', target, why);
  if (!group || ['version', 'context', 'login', 'logout', 'relogin', 'completion', 'help'].includes(group)) return read(`argocd ${group ?? 'info'}`);
  if (s.posKinds.slice(0, 2).some((x) => x !== 'lit')) return w(undefined, 'argocd command is not literal');
  if (group === 'app') {
    if (ARGO_APP_READ.has(verb)) return read(`argocd app ${verb}`);
    if (verb === 'actions') return a1 === 'list' ? read('argocd app actions list') : w(a2, `argocd app actions ${a1 ?? ''} changes the application`.trim());
    return w(a1, `argocd app ${verb ?? ''} changes the application`.trim());
  }
  if (['proj', 'cluster', 'repo', 'repocreds', 'appset', 'cert', 'gpg', 'account'].includes(group) && ['list', 'get', 'get-user-info', 'can-i', 'windows'].includes(verb)) {
    if (verb === 'windows' && a1 !== 'list') return w(undefined, 'argocd proj windows change');
    return read(`argocd ${group} ${verb}`);
  }
  return w(undefined, `argocd ${group} ${verb ?? ''} changes Argo CD`.trim());
}

// ---------------------------------------------------------------- databases

function stripSql(sql) {
  // drop comments and string literals so keywords inside them do not count
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; out += ' '; continue; }
    if (c === '#' ) { while (i < sql.length && sql[i] !== '\n') i += 1; out += ' '; continue; }
    if (c === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); i = j < 0 ? sql.length : j + 1; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && c === "'") return null; // E'' and MySQL escapes vs standard strings disagree; not read-only
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j += 1;
      }
      out += c === "'" ? "''" : ' x ';
      i = j;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) return null; // dollar-quoted bodies (functions, DO blocks) are never read-only
    }
    out += c;
  }
  return out;
}

const SQL_DML_RE = /\b(insert|update|delete|merge|upsert|replace|truncate|drop|alter|create|grant|revoke|copy|call|do|lock|vacuum|reindex|cluster|refresh|comment|security|set|reset|listen|notify|unlisten|prepare|execute|exec|import|load|handler|rename|attach|detach|checkpoint|discard|reassign|kill|shutdown|flush|install|uninstall|purge|optimize|repair|analyze|into)\b/i;
// A user function whose name says it changes something is not trusted to be read-only.
const SQL_WRITEY_FN_RE = /\b\w*(delete|drop|insert|update|truncate|purge|kill|exec|reset|create|alter|grant|revoke|write|modify|remove|terminate|clean|wipe|apply|migrate|refresh|import|load|send|notify)\w*\s*\(/i;
const SQL_FN_RE = /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|lo_import|lo_export|lo_unlink|lo_create|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_file_write|dblink\w*|nextval|setval|pg_switch_wal|pg_create_restore_point|pg_\w*replication_slot\w*|pg_logical_\w+|pg_promote|pg_wal_replay_\w+|pg_advisory_\w*lock\w*|load_file|sys_exec|sys_eval|xp_\w+|sp_\w+|sleep|benchmark|get_lock|release_lock)\s*\(/i;

// True only when every statement is SELECT / SHOW / EXPLAIN (no ANALYZE) / DESCRIBE / WITH … SELECT.
export function sqlReadOnly(sql) {
  if (typeof sql !== 'string') return false;
  const meta = [];
  const lines = sql.split('\n').filter((line) => {
    const t = line.trim();
    if (t.startsWith('\\')) { meta.push(t); return false; }
    return true;
  });
  for (const m of meta) if (!/^\\(d[A-Za-z+]*|l\+?|conninfo|x|timing|\?|z|encoding)(\s|$)/.test(m)) return false;
  const cleaned = stripSql(lines.join('\n'));
  if (cleaned === null) return false;
  if (cleaned.includes('\\')) return false; // \gexec, \g |cmd, \o, \! … mid-line
  const stmts = cleaned.split(';').map((x) => x.trim()).filter(Boolean);
  if (!stmts.length) return meta.length > 0;
  for (const st of stmts) {
    const first = (/^\(*\s*([A-Za-z]+)/.exec(st) ?? [])[1]?.toLowerCase();
    if (first === 'show' || first === 'describe' || first === 'desc') { if (/\b(into|set)\b/i.test(st)) return false; continue; }
    if (first === 'explain') { if (/\banalyze\b/i.test(st)) return false; continue; }
    if (first !== 'select' && first !== 'with' && first !== 'values' && first !== 'table') return false;
    if (SQL_DML_RE.test(st) || SQL_FN_RE.test(st) || SQL_WRITEY_FN_RE.test(st)) return false;
  }
  return true;
}

function sqlVerdict(sqls, kinds, target, tool) {
  if (kinds.some((x) => x !== 'lit')) return unknownProd(`${tool} SQL is not literal`);
  return sqls.every((x) => sqlReadOnly(x)) ? read(`${tool} read-only SQL`) : write('db.write', target, `${tool} runs SQL that is not read-only`);
}

const PSQL_VALUES = new Set(['-c', '--command', '-f', '--file', '-d', '--dbname', '-h', '--host', '-p', '--port', '-U', '--username', '-v', '--set', '--variable', '-o', '--output', '-L', '--log-file', '-P', '--pset', '-F', '--field-separator', '-R', '--record-separator', '-T', '--table-attr']);

function psql(args, ak, seg, ctx, h) {
  const s = scan(args, ak, { values: PSQL_VALUES });
  const target = s.first('-h', '--host') ?? s.first('-d', '--dbname') ?? ctx.dbEnv;
  for (const o of s.all('-o', '--output', '-L', '--log-file')) {
    if (String(o.v ?? '').trim().startsWith('|')) return unknownProd('psql output is piped into a command');
    h.write(o.v, o.kind);
  }
  if (s.has('-f', '--file')) return unknownProd('psql -f runs a SQL file the guard cannot see');
  const cmds = s.all('-c', '--command');
  if (cmds.length) return sqlVerdict(cmds.map((c) => c.v ?? ''), cmds.map((c) => c.kind), target, 'psql');
  if (s.has('-l', '--list', '-V', '--version', '--help', '-?')) return read('psql info');
  return stdinSql(seg, target, 'psql');
}

function stdinSql(seg, target, tool) {
  if (seg.stdin !== null && !seg.stdinDyn) return sqlVerdict([seg.stdin], ['lit'], target, tool);
  if (seg.redirects.some((x) => x.op.replace(/^\d+/, '') === '<')) return unknownProd(`${tool} reads SQL from a file`);
  return unknownProd(`${tool} SQL is not visible (interactive or piped)`);
}

function mysql(args, ak, seg, h) {
  const s = scan(args, ak, { values: new Set(['-e', '--execute', '-h', '--host', '-u', '--user', '-P', '--port', '-D', '--database', '--defaults-file', '--defaults-extra-file', '-S', '--socket', '--init-command', '--tee']) });
  const target = s.first('-h', '--host') ?? s.first('-D', '--database');
  if (s.has('--init-command')) return unknownProd('mysql --init-command');
  if (s.has('--pager') || args.some((t) => t.startsWith('--pager'))) return unknownProd('mysql --pager runs a command');
  for (const o of s.all('--tee')) h.write(o.v, o.kind);
  const cmds = s.all('-e', '--execute');
  if (cmds.length) return sqlVerdict(cmds.map((c) => c.v ?? ''), cmds.map((c) => c.kind), target, 'mysql');
  if (s.has('-V', '--version', '--help', '-?')) return read('mysql info');
  return stdinSql(seg, target, 'mysql');
}

const MONGO_WRITE_RE = /\b(insert\w*|update\w*|delete\w*|remove|drop\w*|replace\w*|create\w*|rename\w*|bulkWrite|findOneAnd\w+|findAndModify|save|runCommand|adminCommand|eval|shutdownServer|grant\w*|revoke\w*|mapReduce|copyTo|setProfilingLevel|fsyncLock|fsyncUnlock|killOp|load|cloneCollection|compact|reIndex|hideIndex|unhideIndex|enableSharding|shardCollection|moveChunk|stepDown|reconfig)\b|\$out\b|\$merge\b/;
const MONGO_READ_RE = /\b(find|findOne|count|countDocuments|estimatedDocumentCount|aggregate|distinct|getCollectionNames|getCollectionInfos|stats|explain|show|getIndexes|listCollections|hostInfo|serverStatus|version|printjson|getName|isMaster|hello|rs\.status|ping)\b/;

function mongoVerdict(js, kind) {
  if (kind !== 'lit') return unknownProd('mongosh script is not literal');
  if (MONGO_WRITE_RE.test(js)) return write('db.write', undefined, 'mongosh script changes data');
  if (MONGO_READ_RE.test(js)) return read('mongosh read');
  return unknownProd('mongosh script has no recognised read operation');
}

function mongosh(args, ak, seg) {
  const s = scan(args, ak, { values: new Set(['--eval', '--file', '-f', '--host', '--port', '-u', '--username', '-p', '--password', '--authenticationDatabase', '--authenticationMechanism', '--tlsCAFile']) });
  const evals = s.all('--eval');
  if (s.has('--file', '-f') || s.pos.some((x) => /\.js$/i.test(x))) return unknownProd('mongosh runs a script file');
  if (evals.length) {
    let worst = read('mongosh read');
    for (const e of evals) worst = strictest(worst, mongoVerdict(e.v ?? '', e.kind));
    return worst;
  }
  if (s.has('--version', '--help', '-h')) return read('mongosh info');
  if (seg.stdin !== null && !seg.stdinDyn) return mongoVerdict(seg.stdin, 'lit');
  return unknownProd('mongosh input is not visible');
}

const REDIS_READ = new Set(['GET', 'MGET', 'KEYS', 'SCAN', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'STRLEN', 'GETRANGE', 'HGET', 'HGETALL', 'HMGET', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGE',
  'ZREVRANGEBYSCORE', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZRANK', 'ZREVRANK', 'ZSCAN', 'INFO', 'PING', 'DBSIZE', 'TIME', 'ECHO', 'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'XPENDING',
  'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'BITCOUNT', 'BITPOS', 'GETBIT', 'OBJECT', 'DUMP', 'LASTSAVE', 'ROLE', 'LOLWUT', 'COMMAND', 'PUBSUB', 'RANDOMKEY', 'TOUCH', 'SUBSCRIBE', 'PSUBSCRIBE']);
const REDIS_SUB_READ = { CONFIG: ['GET'], CLIENT: ['LIST', 'INFO', 'GETNAME', 'ID'], SLOWLOG: ['GET', 'LEN'], MEMORY: ['USAGE', 'STATS', 'DOCTOR'], CLUSTER: ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID'], LATENCY: ['LATEST', 'HISTORY', 'DOCTOR'], ACL: ['WHOAMI', 'CAT'], MODULE: ['LIST'], FUNCTION: ['LIST'] };

function redis(args, ak) {
  const s = scan(args, ak, { values: new Set(['-h', '-p', '-a', '-n', '-u', '--user', '--pass', '-s', '-r', '-i', '--cacert', '--cert', '--key', '--sni', '--pattern', '--eval', '--rdb', '--intrinsic-latency', '--count', '-d']) });
  if (s.has('--eval', '--pipe', '--functions-rdb')) return unknownProd('redis-cli runs a script or raw protocol');
  const [cmd, sub] = s.pos.map((x) => String(x).toUpperCase());
  if (!cmd) {
    if (s.has('--scan', '--bigkeys', '--memkeys', '--hotkeys', '--stat', '--latency', '--latency-history', '--latency-dist', '--intrinsic-latency', '--rdb', '--version', '-v', '--help')) return read('redis-cli inspection');
    return unknownProd('redis-cli interactive input is not visible');
  }
  if (s.posKinds[0] !== 'lit') return write('db.write', undefined, 'redis command is not literal');
  if (REDIS_READ.has(cmd)) return read(`redis ${cmd}`);
  if (REDIS_SUB_READ[cmd]?.includes(sub)) return read(`redis ${cmd} ${sub}`);
  return write('db.write', s.first('-h'), `redis ${cmd} changes data or server state`);
}

function sqlcmd(args, ak, h) {
  const s = scan(args, ak, { values: new Set(['-Q', '-q', '-i', '-S', '-d', '-U', '-P', '-o', '-v', '-s', '-w', '-h', '-l', '-t', '-H', '-W', '-f', '-c', '-k', '-a', '-x']) });
  if (s.has('-i')) return unknownProd('sqlcmd -i runs a SQL file');
  for (const o of s.all('-o')) h.write(o.v, o.kind);
  const qs = s.all('-Q', '-q');
  if (qs.length) return sqlVerdict(qs.map((x) => x.v ?? ''), qs.map((x) => x.kind), s.first('-S'), 'sqlcmd');
  if (s.has('-?')) return read('sqlcmd help');
  return unknownProd('sqlcmd input is not visible');
}

function invokeSqlcmd(args, ak, h) {
  const s = psParams(args, ak, { values: ['query', 'inputfile', 'serverinstance', 'database', 'username', 'password', 'credential', 'querytimeout', 'connectionstring', 'variable', 'outputas', 'hostname', 'accesstoken'], switches: ['trustservercertificate', 'encrypt', 'includesqlusererrors', 'abortonerror'] });
  if (s.get('inputfile')) return unknownProd('Invoke-Sqlcmd -InputFile runs a SQL file');
  const q = s.get('query') ?? s.pos[0];
  if (!q) return unknownProd('Invoke-Sqlcmd query is not visible');
  return sqlVerdict([q.v], [q.kind], s.get('serverinstance')?.v, 'Invoke-Sqlcmd');
}

// ---------------------------------------------------------------- infrastructure as code

function terraform(args, ak) {
  const s = scan(args, ak, {});
  const [verb, sub] = s.pos;
  if (!verb) return read('terraform info');
  if (['plan', 'show', 'output', 'validate', 'fmt', 'version', 'providers', 'graph', 'init', 'get', 'console', 'help', 'metadata', 'modules'].includes(verb)) return read(`terraform ${verb}`);
  if (verb === 'state' && ['list', 'show', 'pull'].includes(sub)) return read(`terraform state ${sub}`);
  if (verb === 'workspace' && ['list', 'show', 'select'].includes(sub)) return read(`terraform workspace ${sub}`);
  return write('deploy', undefined, `terraform ${verb} changes infrastructure`);
}

function pulumi(args, ak) {
  const s = scan(args, ak, { values: new Set(['-s', '--stack', '-C', '--cwd']) });
  const [verb, sub] = s.pos;
  const target = s.first('-s', '--stack');
  if (!verb) return read('pulumi info');
  if (['preview', 'pre', 'whoami', 'version', 'about', 'logs', 'help'].includes(verb)) return read(`pulumi ${verb}`);
  if (verb === 'stack' && (sub === undefined || ['ls', 'output', 'select', 'history', 'export', 'graph'].includes(sub))) return read(`pulumi stack ${sub ?? ''}`.trim());
  if (verb === 'config' && (sub === undefined || ['get', 'ls'].includes(sub))) return read('pulumi config read');
  if (verb === 'plugin' && sub === 'ls') return read('pulumi plugin ls');
  return write('deploy', target, `pulumi ${verb} changes infrastructure`);
}

function cdk(args, ak) {
  const s = scan(args, ak, { values: new Set(['-a', '--app', '--profile', '-c', '--context', '-o', '--output', '--role-arn', '-r']) });
  const [verb] = s.pos;
  if (!verb || ['synth', 'synthesize', 'diff', 'ls', 'list', 'doctor', 'docs', 'doc', 'version', 'context', 'notices', 'metadata', 'acknowledge', 'ack', 'init', 'help'].includes(verb)) return read(`cdk ${verb ?? 'info'}`);
  return write('deploy', s.first('--profile'), `cdk ${verb} changes infrastructure`);
}

function serverless(args, ak) {
  const s = scan(args, ak, { values: new Set(['-s', '--stage', '-r', '--region', '-f', '--function', '-p', '--path', '-d', '--data', '-c', '--config', '--aws-profile']) });
  const [verb, sub] = s.pos;
  const target = s.first('-s', '--stage');
  if (!verb || ['print', 'info', 'package', 'help', 'version', 'logs', 'metrics'].includes(verb)) return read(`serverless ${verb ?? 'info'}`);
  if (verb === 'invoke' && sub === 'local') return read('serverless invoke local');
  if (verb === 'plugin' && ['list', 'search'].includes(sub)) return read('serverless plugin list');
  return write('deploy', target, `serverless ${verb} changes a deployed service`);
}

// ---------------------------------------------------------------- git and GitHub

function defaultProtected(ctx) {
  return (name) => {
    if (typeof name !== 'string' || !name) return true;
    if (['main', 'master', 'trunk', 'develop'].includes(name) || /^release\//.test(name)) return true;
    return !!ctx.defaultBranch && name === ctx.defaultBranch;
  };
}

function isProtected(ctx, name) {
  const fn = typeof ctx.isProtectedBranch === 'function' ? ctx.isProtectedBranch : defaultProtected(ctx);
  try { return !!fn(name); } catch { return true; }
}

const GIT_GLOBAL_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const GIT_EXEC_CONFIG_RE = /^(core\.(sshcommand|pager|editor|hookspath|fsmonitor|gitproxy|askpass)|credential\..*|diff\..*\.(textconv|command)|diff\.external|merge\..*\.driver|filter\..*|sequence\.editor|gpg\..*program|pager\..*|uploadpack\..*|alias\..*|remote\..*\.(receivepack|uploadpack|vcs)|protocol\..*|url\..*|include\.path|includeif\..*\.path|submodule\..*\.update|init\.templatedir|(merge|diff)tool\..*\.(cmd|path)|core\.(attributesfile|excludesfile|worktree)|safe\.directory)$/i;
const GIT_LOCAL = new Set(['status', 'log', 'diff', 'show', 'branch', 'checkout', 'switch', 'add', 'rm', 'mv', 'restore', 'reset', 'stash', 'fetch', 'pull', 'clone', 'init', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'blame', 'grep', 'remote', 'tag', 'config', 'worktree', 'clean', 'describe', 'shortlog', 'reflog', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref',
  'symbolic-ref', 'notes', 'bisect', 'apply', 'format-patch', 'archive', 'bundle', 'sparse-checkout', 'gc', 'fsck', 'prune', 'count-objects', 'var', 'version', 'help', 'diff-tree', 'diff-index',
  'diff-files', 'whatchanged', 'range-diff', 'cherry', 'check-ignore', 'check-attr', 'check-ref-format', 'hash-object', 'write-tree', 'mktree', 'merge-file', 'maintenance', 'update-index', 'read-tree',
  'difftool', 'mergetool', 'request-pull', 'show-branch', 'verify-commit', 'verify-tag', 'interpret-trailers', 'column', 'stripspace', 'rerere', 'replace', 'commit-graph', 'multi-pack-index', 'repack',
  'pack-refs', 'unpack-objects', 'index-pack', 'pack-objects', 'update-ref', 'commit-tree', 'mailinfo', 'mailsplit', 'get-tar-commit-id', 'submodule', 'lfs']);
const GIT_COMMIT = new Set(['commit', 'revert', 'am', 'cherry-pick', 'rebase', 'merge']);

function git(args, ak, seg, ctx, h) {
  let i = 0;
  let pushConfig = false;
  while (i < args.length && args[i].startsWith('-')) {
    const t = args[i];
    if (t === '-c' || t.startsWith('-c')) {
      const kv = t === '-c' ? args[i + 1] : t.slice(2);
      const key = String(kv ?? '').split('=')[0];
      if (GIT_EXEC_CONFIG_RE.test(key)) return unparseable(`git -c ${key} can run arbitrary commands`);
      if (/^(push|remote|branch)\./i.test(key)) pushConfig = true;
      i += t === '-c' ? 2 : 1;
      continue;
    }
    if (t.startsWith('--exec-path')) return unparseable('git --exec-path changes which programs git runs');
    if (t === '--config-env') { const key = String(args[i + 1] ?? '').split('=')[0]; if (GIT_EXEC_CONFIG_RE.test(key)) return unparseable(`git --config-env ${key}`); }
    if (GIT_GLOBAL_VALUES.has(t)) { i += 2; continue; }
    i += 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const restK = ak.slice(i + 1);
  if (sub === undefined) return local('git info');
  if (ak[i] !== 'lit') return unparseable('git subcommand is not literal');
  if (rest.some((t) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(t))) return unparseable(`git ${sub} with a custom remote program`);
  if (sub === 'remote' && ['set-url', 'add', 'set-head', 'rename'].includes(rest.find((x) => !x.startsWith('-')))) return unparseable(`git remote ${rest.find((x) => !x.startsWith('-'))} changes where pushes go`);
  if (sub === 'config') {
    const cs = scan(rest, restK, { values: new Set(['-f', '--file', '--blob', '--type', '--default', '--comment']) });
    const reading = cs.has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--unset', '--unset-all', '--remove-section', '--rename-section', '-e', '--edit') || (cs.pos[0] && ['get', 'list'].includes(cs.pos[0]) );
    const key = cs.pos[0] === 'set' ? cs.pos[1] : cs.pos[0];
    const writing = !reading && (cs.pos.length >= 2 || cs.has('--add', '--replace-all'));
    if (cs.has('-e', '--edit')) return unparseable('git config --edit opens an editor');
    if (writing && GIT_EXEC_CONFIG_RE.test(String(key ?? ''))) return unparseable(`git config ${key} can make git run arbitrary commands`);
    if (writing && /^(push|remote|branch)\./i.test(String(key ?? ''))) return unparseable(`git config ${key} changes where pushes go`);
    return local('git config');
  }
  if (sub === 'clone') {
    const cs = scan(rest, restK, { values: new Set(['-u', '--upload-pack', '-c', '--config', '-b', '--branch', '-o', '--origin', '--depth', '--reference', '--separate-git-dir', '--template', '-j', '--jobs', '--filter', '--shallow-since', '--shallow-exclude', '--server-option']) });
    if (cs.has('-u', '--upload-pack', '--template')) return unparseable('git clone with a custom upload-pack or template');
    for (const c of cs.all('-c', '--config')) if (GIT_EXEC_CONFIG_RE.test(String(c.v ?? '').split('=')[0])) return unparseable('git clone --config can run arbitrary commands');
    if (cs.pos[1] !== undefined) h.write(cs.pos[1], cs.posKinds[1]);
    else if (cs.pos[0] !== undefined) h.write(String(cs.pos[0]).replace(/[\\/]+$/, '').replace(/^.*[\\/:]/, '').replace(/\.git$/, '') || '.', cs.posKinds[0]);
    for (const d of cs.all('--separate-git-dir')) h.write(d.v, d.kind);
    return local('git clone');
  }
  if (sub === 'push') return pushConfig ? write('git.protected', undefined, 'git push with push/remote configuration overrides') : gitPush(rest, restK, ctx);
  if (sub === 'lfs' && rest[0] === 'push') return gitPush(rest.slice(1), restK.slice(1), ctx);
  if (sub === 'send-email') return xwrite('http.write', undefined, 'git send-email sends mail');
  if (sub === 'svn' && rest[0] === 'dcommit') return xwrite('http.write', undefined, 'git svn dcommit');
  if (sub === 'filter-branch' || sub === 'filter-repo') return unparseable(`git ${sub} rewrites history with arbitrary filters`);
  if (sub === 'submodule' && rest.includes('foreach')) {
    const cmd = rest[rest.length - 1];
    if (restK[rest.length - 1] !== 'lit') return unparseable('git submodule foreach command is not literal');
    return h.script(cmd, 'bash');
  }
  if (sub === 'bisect' && rest[0] === 'run') {
    const inner = rest.slice(1);
    if (!inner.length) return local('git bisect');
    if (restK.slice(1).some((x) => x !== 'lit')) return unparseable('git bisect run command is not literal');
    return h.script(inner.map((x) => (/^[\w./:=@%+,-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(' '), 'bash');
  }
  if (sub === 'rebase' || sub === 'difftool') {
    for (let j = 0; j < rest.length; j += 1) {
      const t = rest[j];
      let cmd = null;
      if (t === '-x' || t === '--exec' || t === '--extcmd' || t === '-t' && sub === 'difftool') cmd = { v: rest[j + 1], k: restK[j + 1] };
      else if (t.startsWith('--exec=') || t.startsWith('--extcmd=')) cmd = { v: t.slice(t.indexOf('=') + 1), k: restK[j] };
      if (cmd) {
        if (cmd.k !== 'lit' || typeof cmd.v !== 'string') return unparseable(`git ${sub} exec command is not literal`);
        const inner = h.script(cmd.v, 'bash');
        if (inner.class !== 'local') return inner;
      }
    }
  }
  if (sub === 'rm') for (let j = 0; j < rest.length; j += 1) if (!rest[j].startsWith('-')) h.write(rest[j], restK[j]);
  if (sub === 'merge') {
    if (rest.some((x) => x === '--abort' || x === '--quit')) return local('git merge --abort');
    if (ctx.currentBranch && isProtected(ctx, ctx.currentBranch)) return write('git.protected', ctx.currentBranch, 'git merge into a protected branch');
    return write('git.commit', undefined, 'git merge creates a commit');
  }
  if (GIT_COMMIT.has(sub)) {
    if (sub === 'rebase' && rest.some((x) => x === '--abort' || x === '--quit' || x === '--show-current-patch')) return local('git rebase --abort');
    if ((sub === 'cherry-pick' || sub === 'revert' || sub === 'am') && rest.some((x) => x === '--abort' || x === '--quit' || x === '--skip')) return local(`git ${sub} --abort`);
    return write('git.commit', undefined, `git ${sub} creates commits`);
  }
  if (GIT_LOCAL.has(sub)) return local(`git ${sub}`);
  return unparseable(`unknown git subcommand ${sub} (could be a repository alias)`);
}

const PUSH_VALUES = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec', '--recurse-submodules', '--signed']);

function gitPush(args, ak, ctx) {
  const prot = (target, why) => write('git.protected', target, why);
  const s = scan(args, ak, { values: PUSH_VALUES });
  if (s.has('--receive-pack', '--exec')) return unparseable('git push with a custom receive-pack');
  if (s.has('-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--branches', '--prune', '--tags', '--follow-tags', '-d', '--delete')) return prot(undefined, 'forced, mirrored, deleting or tag push');
  if (s.posKinds.some((x) => x !== 'lit')) return prot(undefined, 'push target is not literal');
  const refspecs = s.pos.slice(1);
  const targets = [];
  if (!refspecs.length) {
    if (!ctx.currentBranch) return prot(undefined, 'push target unknown (current branch not known)');
    targets.push(ctx.currentBranch);
  }
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return prot(spec.slice(1), 'a + refspec forces the push');
    const colon = spec.indexOf(':');
    let dst = colon >= 0 ? spec.slice(colon + 1) : spec;
    const src = colon >= 0 ? spec.slice(0, colon) : spec;
    if (colon >= 0 && !src) return prot(dst, 'deleting a remote branch');
    if (/@\{/.test(dst)) return prot(dst, 'push to a reflog or upstream shorthand');
    if (dst === 'HEAD' || dst === '@') {
      if (!ctx.currentBranch) return prot(undefined, 'push of HEAD with an unknown current branch');
      dst = ctx.currentBranch;
    }
    if (/^refs\/tags\//.test(dst)) return prot(dst, 'tag push');
    dst = dst.replace(/^refs\/heads\//, '');
    targets.push(dst);
  }
  for (const t of targets) if (isProtected(ctx, t)) return prot(t, `push to protected branch ${t}`);
  return write('git.push', targets[0], `git push to ${targets.join(', ')}`);
}

const GH_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks', 'watch', 'download', 'get', 'search', 'browse', 'clone', 'checkout', 'ls']);

function gh(args, ak, seg, ctx) {
  const s = scan(args, ak, { values: new Set(['-R', '--repo', '--hostname', '-X', '--method', '-f', '--field', '-F', '--raw-field', '--input', '-H', '--header', '-t', '--title', '-b', '--body', '-B', '--base', '--head', '-l', '--label', '-a', '--assignee', '-r', '--reviewer', '-m', '--milestone', '-q', '--jq', '--template', '-L', '--limit', '-s', '--state', '-w', '--web', '--body-file', '-T', '-p', '--project', '--json']) });
  const [group, verb] = s.pos;
  const host = s.first('--hostname') ?? 'github.com';
  const ext = (why) => xwrite('http.write', host, why);
  if (!group || group === 'help' || group === 'version' || s.has('--version')) return read('gh info');
  if (s.posKinds.slice(0, 2).some((x) => x !== 'lit')) return ext('gh command is not literal');
  if (group === 'api') {
    const method = String(s.first('-X', '--method') ?? '').toUpperCase();
    const fields = s.has('-f', '--field', '-F', '--raw-field', '--input');
    const apiHost = host === 'github.com' ? 'api.github.com' : host;
    if ((method === '' && !fields) || method === 'GET' || method === 'HEAD') {
      if (fields && method === '') return xwrite('http.write', apiHost, 'gh api with fields sends a POST');
      return read('gh api GET', { host: apiHost });
    }
    return xwrite('http.write', apiHost, `gh api ${method || 'POST'}`);
  }
  if (group === 'pr') {
    if (verb === 'create') {
      const off = args.some((t) => /^(--draft|-d)=/.test(t) && !/=(true|1|yes)$/i.test(t));
      return s.has('--draft', '-d') && !off ? write('git.pr', undefined, 'gh pr create --draft') : write('git.protected', undefined, 'gh pr create without --draft');
    }
    if (verb === 'merge') return write('git.protected', undefined, 'gh pr merge');
    if (verb === 'review') return s.has('--approve', '-a') ? write('git.protected', undefined, 'gh pr review --approve') : write('git.pr', undefined, 'gh pr review');
    if (['edit', 'comment', 'ready', 'close', 'reopen', 'lock', 'unlock'].includes(verb)) return write('git.pr', undefined, `gh pr ${verb}`);
  }
  if (group === 'repo' && verb === 'sync') return write('git.protected', undefined, 'gh repo sync updates a default branch');
  if (group === 'release' && ['create', 'upload', 'edit', 'delete', 'delete-asset'].includes(verb)) return xwrite('package.publish', host, `gh release ${verb}`);
  if (group === 'auth') return verb === 'status' ? read('gh auth status') : ext(`gh auth ${verb ?? ''}`.trim());
  if (group === 'search' || group === 'browse' || group === 'status') return read(`gh ${group}`);
  if (GH_READ_VERBS.has(verb)) return read(`gh ${group} ${verb}`);
  return ext(`gh ${group} ${verb ?? ''} changes GitHub`.trim());
}

// ---------------------------------------------------------------- Quill CLI

const QUILL_READ = { status: null, doctor: null, ticket: ['show', 'list', 'children'], agent: ['list', 'show', 'suggestions'], handoff: ['list'], repo: ['list'] };

const QUILL_READ_FLAGS = new Set(['--json', '--statusline', '--session', '--status', '--ticket']);

function quill(args) {
  const sub = args[0];
  if (sub === undefined || sub.startsWith('-')) return privileged('Quill CLI outside the read-only subcommands');
  if (!Object.hasOwn(QUILL_READ, sub)) return privileged(`quill ${sub} is not a read-only subcommand`);
  const bad = args.find((t) => t.startsWith('-') && !QUILL_READ_FLAGS.has(t.replace(/=.*$/, '')));
  if (bad) return privileged(`quill ${sub} with flag ${bad} is not a documented read form`);
  const allowed = QUILL_READ[sub];
  if (allowed === null || allowed.includes(args[1])) return local(`quill ${sub} ${args[1] ?? ''}`.trim());
  return privileged(`quill ${sub} ${args[1] ?? ''} is not a read-only subcommand`.trim());
}

// bin/quill.js and friends: quill, quill.js/.mjs/.cjs (any case, trailing slashes), src/cli/*,
// anything inside a session-quill package.
function isQuillScript(p) {
  const t = String(p).replace(/[\\/]+$/, '');
  const base = t.replace(/^.*[\\/]/, '').toLowerCase();
  return /^quill(\.[cm]?js)?$/.test(base) || /(^|[\\/])src[\\/]cli([\\/.]|$)/i.test(t) || /(^|[\\/])session-quill([\\/]|$)/i.test(t);
}

const NODE_VALUES = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title', '--stack-size', '--max-old-space-size', '--inspect-port', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--watch-path']);

function nodeLike(name, args, ak, seg, ctx, h) {
  if (name === 'deno' && args[0] === 'eval') return inlineCode(args.slice(1).filter((x) => !x.startsWith('-')).join(' '), ak.slice(1).some((x) => x !== 'lit') ? 'dyn' : 'lit', 'deno');
  if (name === 'bun') {
    if (args[0] === 'publish') return xwrite('package.publish', undefined, 'bun publish');
    if (args[0] === 'run') return args[1] ? scriptByName(args[1], args.slice(2), 'package script') : local('bun run');
    if (args.includes('-g') || args.includes('--global')) return unknownProd('bun -g changes tools outside the checkout');
    if (['install', 'i', 'add', 'remove', 'rm', 'update', 'link', 'unlink', 'pm', 'init', 'create', 'upgrade', 'build', 'test', 'outdated', 'audit', 'repl', 'x'].includes(args[0])) return local(`bun ${args[0]}`);
  }
  let i = name === 'deno' && args[0] === 'run' ? 1 : 0;
  for (; i < args.length; i += 1) {
    const t = args[i];
    if (t === '-e' || t === '--eval' || t === '-p' || t === '--print') return inlineCode(args[i + 1] ?? '', ak[i + 1], name);
    if (t.startsWith('--eval=') || t.startsWith('--print=')) return inlineCode(t.slice(t.indexOf('=') + 1), ak[i], name);
    if (t === '-') {
      const inFile = seg.redirects.find((x) => x.op.replace(/^\d+/, '') === '<');
      if (inFile) {
        if (inFile.kind !== 'lit') return unparseable(`${name} reads its script from a dynamic path`);
        const b = inFile.target.replace(/^.*[\\/]/, '').toLowerCase();
        if (b === 'quill.js' || b === 'quill') return quill(args.slice(i + 1));
        return scriptByName(inFile.target, args.slice(i + 1));
      }
      break;
    }
    if (t.startsWith('-')) {
      const v = NODE_VALUES.has(t) ? args[i + 1] : /^--(require|import|loader|experimental-loader)=/.test(t) ? t.slice(t.indexOf('=') + 1) : null;
      if (/^(-r|--require|--import|--loader|--experimental-loader)(=|$)/.test(t) && typeof v === 'string') {
        if (isQuillScript(v)) return privileged(`${name} preloads the Quill CLI`);
        if (SDK_RE.test(v) || v === 'pg' || v.startsWith('pg/')) return unknownProd(`${name} preloads a prod SDK client`);
      }
      if (NODE_VALUES.has(t)) i += 1;
      continue;
    }
    if (ak[i] !== 'lit') return unparseable(`${name} script path is not literal`);
    const base = t.replace(/^.*[\\/]/, '').toLowerCase();
    if (isQuillScript(t)) return quill(args.slice(i + 1));
    return scriptByName(t, args.slice(i + 1));
  }
  if (seg.stdin !== null) return seg.stdinDyn ? unknownProd(`${name} input has expansions`) : inlineCode(seg.stdin, 'lit', name);
  if (seg.piped) return unparseable(`code is piped into ${name}`);
  return local(name);
}

function python(args, ak, seg, ctx, h) {
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === '-c') return inlineCode(args[i + 1] ?? '', ak[i + 1], 'python');
    if (t === '-m') {
      const mod = args[i + 1] ?? '';
      if (mod === 'awscli' || mod === 'aws') return aws(args.slice(i + 2), ak.slice(i + 2), seg, ctx, h);
      if (['alembic', 'flyway', 'yoyo', 'django'].includes(mod) && args.slice(i + 2).some((x) => /migrat/.test(x))) return unknownProd(`python -m ${mod} migration`);
      if (['twine'].includes(mod) && args.includes('upload')) return xwrite('package.publish', undefined, 'twine upload');
      if (SCRIPT_NAME_RE.test(mod)) return unknownProd(`python -m ${mod} looks like a deploy/release step`);
      return local(`python -m ${mod}`);
    }
    if (t === '-') break;
    if (t.startsWith('-')) { if (t === '-W' || t === '-X' || t === '-Q') i += 1; continue; }
    if (ak[i] !== 'lit') return unparseable('python script path is not literal');
    return scriptByName(t, args.slice(i + 1));
  }
  if (seg.stdin !== null) return seg.stdinDyn ? unknownProd('python input has expansions') : inlineCode(seg.stdin, 'lit', 'python');
  if (seg.piped) return unparseable('code is piped into python');
  return local('python');
}

// ---------------------------------------------------------------- package managers and task runners

function npm(args, ak) {
  const s = scan(args, ak, { values: new Set(['--prefix', '-w', '--workspace', '--registry', '--userconfig', '--cache', '--loglevel', '--tag', '--otp', '--access', '-C']) });
  const [sub, a1, a2] = s.pos;
  if (!sub) return local('npm');
  if (s.has('-g', '--global', '--location') || (sub === 'link' && !a1)) return unknownProd(`npm ${sub} -g changes tools outside the checkout`);
  if (['publish', 'unpublish', 'deprecate', 'undeprecate'].includes(sub)) return xwrite('package.publish', 'registry.npmjs.org', `npm ${sub}`);
  if ((sub === 'dist-tag' || sub === 'dist-tags') && ['add', 'rm'].includes(a1)) return xwrite('package.publish', 'registry.npmjs.org', 'npm dist-tag change');
  if (sub === 'owner' && ['add', 'rm'].includes(a1)) return xwrite('package.publish', 'registry.npmjs.org', 'npm owner change');
  if (sub === 'access' && !['list', 'get', 'ls'].includes(a1)) return xwrite('package.publish', 'registry.npmjs.org', 'npm access change');
  if (sub === 'version' && a1 && !s.has('--no-git-tag-version')) return write('git.commit', undefined, 'npm version commits and tags');
  if (['run', 'run-script', 'rum', 'urn'].includes(sub)) return a1 ? scriptByName(a1, [], 'package script') : local('npm run');
  if (sub === 'pkg' && a1 === 'set') return local('npm pkg set');
  void a2;
  return local(`npm ${sub}`);
}

const YARN_BUILTINS = new Set(['add', 'install', 'remove', 'upgrade', 'up', 'why', 'info', 'init', 'cache', 'config', 'set', 'plugin', 'link', 'unlink', 'pack', 'audit', 'outdated', 'global', 'bin', 'constraints',
  'dedupe', 'explain', 'node', 'rebuild', 'patch', 'patch-commit', 'stage', 'unplug', 'upgrade-interactive', 'create', 'login', 'logout', 'licenses', 'list', 'autoclean', 'check', 'generate-lock-entry', 'import',
  'policy', 'help', 'version', 'test', 'start', 'dlx', 'exec', 'search', 'sdks']);

function yarn(args, ak) {
  const s = scan(args, ak, { values: new Set(['--cwd', '--registry', '--cache-folder', '--modules-folder']) });
  const [sub, a1, a2] = s.pos;
  if (!sub) return local('yarn install');
  if (sub === 'global') return unknownProd('yarn global changes tools outside the checkout');
  if (sub === 'publish' || (sub === 'npm' && (a1 === 'publish' || (a1 === 'tag' && ['add', 'remove'].includes(a2))))) return xwrite('package.publish', 'registry.npmjs.org', 'yarn publish');
  if (sub === 'owner' || (sub === 'tag' && ['add', 'remove', 'rm'].includes(a1)) || sub === 'team') return xwrite('package.publish', 'registry.npmjs.org', `yarn ${sub}`);
  if (sub === 'run') return a1 ? scriptByName(a1, [], 'package script') : local('yarn run');
  if (sub === 'workspace') return a2 ? (a2 === 'publish' || (a2 === 'npm' && s.pos[3] === 'publish') ? xwrite('package.publish', 'registry.npmjs.org', 'yarn workspace publish') : YARN_BUILTINS.has(a2) && a2 !== 'run' ? local(`yarn workspace ${a2}`) : scriptByName(a2 === 'run' ? s.pos[3] ?? '' : a2, [], 'package script')) : local('yarn workspace');
  if (sub === 'workspaces') return s.pos.slice(1).some((x) => SCRIPT_NAME_RE.test(x)) ? unknownProd('yarn workspaces runs a deploy/release script') : local('yarn workspaces');
  if (YARN_BUILTINS.has(sub)) return local(`yarn ${sub}`);
  return scriptByName(sub, [], 'package script');
}

const PNPM_BUILTINS = new Set(['add', 'install', 'i', 'update', 'up', 'remove', 'rm', 'un', 'uninstall', 'link', 'ln', 'unlink', 'import', 'rebuild', 'rb', 'prune', 'fetch', 'install-test', 'it', 'patch',
  'patch-commit', 'patch-remove', 'audit', 'list', 'ls', 'outdated', 'why', 'licenses', 'test', 't', 'start', 'store', 'root', 'bin', 'setup', 'init', 'config', 'c', 'env', 'create', 'pack',
  'dedupe', 'doctor', 'server', 'help', 'exec', 'dlx', 'recursive', 'approve-builds', 'self-update']);

function pnpm(args, ak) {
  const s = scan(args, ak, { values: new Set(['--filter', '-F', '-C', '--dir', '--workspace-dir', '--reporter', '--loglevel']) });
  const [sub, a1] = s.pos;
  if (!sub) return local('pnpm');
  if (s.has('-g', '--global')) return unknownProd(`pnpm ${sub} -g changes tools outside the checkout`);
  if (sub === 'publish') return xwrite('package.publish', 'registry.npmjs.org', 'pnpm publish');
  if (sub === 'run' || sub === 'run-script') return a1 ? scriptByName(a1, [], 'package script') : local('pnpm run');
  if (PNPM_BUILTINS.has(sub)) return local(`pnpm ${sub}`);
  return scriptByName(sub, [], 'package script');
}

function taskRunner(name, args, ak) {
  const values = new Set(['-C', '-f', '--file', '--makefile', '-j', '--jobs', '-I', '-o', '-W', '-l', '-p', '--project', '-D', '-P', '--settings-file', '-s', '--justfile', '-d', '--working-directory', '-t', '--taskfile']);
  const s = scan(args, ak, { values });
  const targets = s.pos.filter((x) => !/^[A-Za-z_][\w.]*=/.test(x));
  const hit = s.pos.find((x) => SCRIPT_NAME_RE.test(x)); // includes VAR=value overrides such as DEPLOY=1
  if (hit) return unknownProd(`${name} ${hit} looks like a deploy/release step`);
  if (s.posKinds.some((x) => x !== 'lit')) return unparseable(`${name} target is not literal`);
  return local(`${name} ${targets.join(' ')}`.trim());
}

// ---------------------------------------------------------------- containers

const DOCKER_READ = new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'events', 'port', 'diff', 'history', 'search', 'help']);

function docker(name, args, ak, seg) {
  const s = scan(args, ak, { values: new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '-t', '--tag', '-f', '--file', '--platform', '-o', '--output', '--builder', '--target', '--build-arg', '-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '-w', '--workdir', '--network', '--entrypoint', '-u', '--user', '--label', '--cache-from', '--cache-to', '--secret', '--ssh', '--progress', '--format']) });
  const [sub, a1] = s.pos;
  const remoteHost = s.first('-H', '--host') ?? seg.env.DOCKER_HOST;
  const remote = typeof remoteHost === 'string' && !/^(unix|npipe):\/\//i.test(remoteHost);
  if (!sub) return local(name);
  const pushes = sub === 'push' || (sub === 'image' && a1 === 'push') || (sub === 'manifest' && a1 === 'push') || (sub === 'compose' && s.pos.includes('push'))
    || (sub === 'buildx' && (s.has('--push') || String(s.first('-o', '--output') ?? '').includes('registry') || (a1 === 'imagetools' && s.pos[2] === 'create')))
    || (sub === 'build' && s.has('--push')) || (sub === 'trust' && a1 === 'sign');
  if (pushes) return xwrite('package.publish', undefined, `${name} pushes an image`);
  if (remote && !DOCKER_READ.has(sub) && !(['container', 'image', 'volume', 'network'].includes(sub) && ['ls', 'list', 'inspect'].includes(a1))) return unknownProd(`${name} on a remote engine (${remoteHost})`);
  return local(`${name} ${sub}`);
}

// ---------------------------------------------------------------- network

function hostOf(url) {
  if (typeof url !== 'string' || !url) return undefined;
  let u = url.trim();
  if (/[$`]/.test(u)) return undefined;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(u);
  let auth = m ? m[1] : u.split(/[/?#]/)[0];
  auth = auth.replace(/^[^@]*@/, '');
  if (auth.startsWith('[')) return auth.slice(0, auth.indexOf(']') + 1) || undefined;
  auth = auth.replace(/:\d*$/, '');
  if (!auth || !/^[A-Za-z0-9.-]+$/.test(auth)) return undefined;
  return auth.toLowerCase();
}

const CURL_VALUES = new Set(['-H', '--header', '-o', '--output', '-A', '--user-agent', '-e', '--referer', '-u', '--user', '-b', '--cookie', '-c', '--cookie-jar', '-m', '--max-time', '--connect-timeout', '-w',
  '--write-out', '-x', '--proxy', '--cacert', '--capath', '--cert', '-E', '--key', '-r', '--range', '-U', '--proxy-user', '--resolve', '--retry', '--retry-delay', '--retry-max-time', '-K', '--config', '--url',
  '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string', '-T', '--upload-file', '--limit-rate', '-Y', '-y',
  '--interface', '--dns-servers', '--oauth2-bearer', '--aws-sigv4', '-z', '--time-cond', '--max-filesize', '--unix-socket', '--abstract-unix-socket', '--variable', '--trace', '--trace-ascii', '--stderr',
  '-D', '--dump-header', '--output-dir', '--ciphers', '--pinnedpubkey', '--request-target', '--connect-to', '-Q', '--quote', '--mail-from', '--mail-rcpt', '--mail-auth', '--keepalive-time', '--local-port',
  '--noproxy', '--proto', '--proto-redir', '--socks5', '--socks5-hostname', '--netrc-file', '--service-name', '--parallel-max', '--rate', '-P', '--ftp-port', '-t', '--telnet-option', '--expand-url', '--expand-data']);
const CURL_DATA = ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string', '-T', '--upload-file', '-Q', '--quote', '--mail-rcpt', '--expand-data'];

function hiddenArgs(ak) {
  return ak.some((x) => x === 'split' || x === 'group');
}

function curl(args, ak, seg, h) {
  const s = scan(args, ak, { values: CURL_VALUES });
  if (hiddenArgs(ak)) return xwrite('http.write', hostOf(s.pos[0]), 'curl arguments come from an unquoted expansion');
  const urls = [...s.all('--url', '--expand-url').map((x) => x.v), ...s.pos];
  const host = hostOf(urls.find((x) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(x))) ?? urls[0]);
  for (const o of s.all('-o', '--output', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--stderr')) if (o.v !== '-') h.write(o.v, o.kind);
  for (const o of s.all('--output-dir')) h.write(o.v, o.kind);
  if (s.has('-K', '--config')) return xwrite('http.write', host, 'curl reads options from a config file');
  if (urls.some((x) => /^(gopher|dict|telnet|smtps?|ldaps?|mqtt|tftp):/i.test(String(x)))) return xwrite('http.write', host, 'curl protocol that can send commands');
  if (s.all('-H', '--header').some((x) => /x-http-method(-override)?\s*:\s*(post|put|patch|delete)/i.test(String(x.v)))) return xwrite('http.write', host, 'curl overrides the method in a header');
  if (urls.some((x) => /[?&]_method=(post|put|patch|delete)/i.test(String(x)))) return xwrite('http.write', host, 'curl overrides the method in the query');
  const method = String(s.first('-X', '--request') ?? '').toUpperCase();
  const data = s.has(...CURL_DATA);
  if (s.has('-G', '--get') && s.all(...CURL_DATA).some((x) => String(x.v ?? '').startsWith('@'))) return xwrite('http.write', host, 'curl --get sends a file\'s contents');
  if (method && method !== 'GET' && method !== 'HEAD') return xwrite('http.write', host, `curl ${method}`);
  if (data && !(s.has('-G', '--get') && !s.has('-F', '--form', '--form-string', '-T', '--upload-file', '-Q', '--quote', '--mail-rcpt'))) return xwrite('http.write', host, 'curl sends a body');
  return read('curl GET', host ? { host } : {});
}

function wget(args, ak, h) {
  const s = scan(args, ak, { values: new Set(['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix', '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--header', '-U', '--user-agent', '--user', '--password', '-e', '--execute', '-i', '--input-file', '-t', '--tries', '-T', '--timeout', '-w', '--wait', '-Q', '--quota', '-l', '--level']) });
  const host = hostOf(s.pos[0]);
  if (hiddenArgs(ak)) return xwrite('http.write', host, 'wget arguments come from an unquoted expansion');
  for (const o of s.all('-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix')) if (o.v !== '-') h.write(o.v, o.kind);
  const method = String(s.first('--method') ?? '').toUpperCase();
  if (s.has('--post-data', '--post-file', '--body-data', '--body-file', '-e', '--execute') || (method && method !== 'GET' && method !== 'HEAD')) return xwrite('http.write', host, 'wget sends data');
  return read('wget GET', host ? { host } : {});
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'PURGE']);

function httpie(args, ak, seg, h) {
  const s = scan(args, ak, { values: new Set(['-a', '--auth', '-A', '--auth-type', '-o', '--output', '--session', '--session-read-only', '--verify', '--cert', '--cert-key', '--proxy', '--timeout', '-p', '--print', '--pretty', '-s', '--style', '--format-options', '--boundary', '--max-redirects', '--default-scheme', '--ssl', '--ciphers', '--response-charset', '--response-mime', '--unsorted', '--sorted']) });
  for (const o of s.all('-o', '--output')) h.write(o.v, o.kind);
  if (hiddenArgs(ak)) return xwrite('http.write', undefined, 'httpie arguments come from an unquoted expansion');
  if (s.has('--offline')) return local('httpie --offline builds the request without sending it');
  let pos = s.pos;
  let method = '';
  if (pos[0] && HTTP_METHODS.has(pos[0].toUpperCase())) { method = pos[0].toUpperCase(); pos = pos.slice(1); }
  const host = hostOf(/^:/.test(pos[0] ?? '') ? 'localhost' : pos[0]);
  const items = pos.slice(1);
  const data = items.some((x) => /^[^=:@]*(:=@|=@|:=|@|=)(?!=)/.test(x) && !/^[^=]*==/.test(x));
  const piped = seg.piped && !s.has('--ignore-stdin', '-I');
  if ((method && method !== 'GET' && method !== 'HEAD') || data || piped) return xwrite('http.write', host, 'httpie sends a body');
  return read('httpie GET', host ? { host } : {});
}

// PowerShell parameters: case-insensitive prefix match against the cmdlet's known names.
// `a, b` and `a ,b` are one PowerShell array argument split across tokens.
function mergePsArrays(args, ak) {
  const A = [];
  const K = [];
  for (let i = 0; i < args.length; i += 1) {
    let t = args[i];
    let kind = ak[i];
    while (i + 1 < args.length && (t.endsWith(',') || args[i + 1].startsWith(',')) && !args[i + 1].startsWith('-')) {
      i += 1;
      t += args[i];
      if (ak[i] !== 'lit') kind = ak[i] === 'group' ? 'dyn' : ak[i];
    }
    A.push(t);
    K.push(kind);
  }
  return [A, K];
}

function psParams(rawArgs, rawAk, { values = [], switches = [] }) {
  const [args, ak] = mergePsArrays(rawArgs, rawAk);
  const named = new Map();
  const pos = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) {
      let p = t.slice(1).toLowerCase();
      let inline;
      const colon = p.indexOf(':');
      if (colon > 0) { inline = t.slice(colon + 2); p = p.slice(0, colon); }
      const sw = switches.find((x) => x === p) ?? (values.includes(p) ? undefined : switches.find((x) => x.startsWith(p)));
      if (sw && !values.includes(p)) { named.set(sw, { v: true, kind: 'lit' }); continue; }
      const val = values.find((x) => x === p) ?? values.find((x) => x.startsWith(p));
      if (val) {
        if (inline !== undefined) named.set(val, { v: inline, kind: ak[i] });
        else { named.set(val, { v: args[i + 1], kind: ak[i + 1] ?? 'dyn' }); i += 1; }
        continue;
      }
      named.set(p, { v: true, kind: 'lit' });
      continue;
    }
    pos.push({ v: t, kind: ak[i] });
  }
  return { pos, get: (n) => named.get(n), named };
}

function splitPs(v) {
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

const IWR_VALUES = ['uri', 'method', 'custommethod', 'body', 'infile', 'form', 'outfile', 'headers', 'contenttype', 'credential', 'websession', 'sessionvariable', 'useragent', 'proxy', 'proxycredential', 'timeoutsec', 'maximumredirection', 'maximumretrycount', 'retryintervalsec', 'certificate', 'certificatethumbprint', 'token', 'authentication', 'transferencoding', 'responseheaderstvariable', 'statuscodevariable', 'httpversion', 'sslprotocol', 'connectiontimeoutseconds', 'operationtimeoutseconds'];
const IWR_SWITCHES = ['usebasicparsing', 'usedefaultcredentials', 'disablekeepalive', 'passthru', 'skipcertificatecheck', 'skipheadervalidation', 'skiphttperrorcheck', 'allowunencryptedauthentication', 'noproxy', 'preservefileauthorizationmetadata', 'resume', 'allowinsecureredirect', 'preserveauthorizationonredirect', 'followrellink'];

function iwr(args, ak, h) {
  const s = psParams(args, ak, { values: IWR_VALUES, switches: IWR_SWITCHES });
  const uri = s.get('uri') ?? s.pos[0];
  if (s.pos.length > 1 || s.pos.some((x) => x.kind === 'split' && x !== uri)) return xwrite('http.write', uri ? hostOf(uri.v) : undefined, 'web request has unbound positional arguments');
  const host = uri ? hostOf(uri.v) : undefined;
  const out = s.get('outfile');
  if (out && out.v !== true) h.write(out.v, out.kind);
  const method = String(s.get('method')?.v ?? s.get('custommethod')?.v ?? '').toUpperCase();
  if (s.get('body') || s.get('infile') || s.get('form') || (method && method !== 'GET' && method !== 'HEAD' && method !== 'DEFAULT')) return xwrite('http.write', host, 'web request sends a body or a non-GET method');
  return read('web request GET', host ? { host } : {});
}

const REMOTE_RE = /^(?:[^@\s/\\:]+@)?([^:\s/\\]{2,}):/;

function remoteHost(arg) {
  if (typeof arg !== 'string') return undefined;
  if (/^[A-Za-z]:[\\/]/.test(arg)) return undefined;
  const scheme = /^(?:scp|sftp|rsync):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(arg);
  if (scheme) return scheme[1];
  const m = REMOTE_RE.exec(arg);
  return m ? m[1] : undefined;
}

function scp(args, ak, h) {
  const s = scan(args, ak, { values: new Set(['-P', '-i', '-o', '-F', '-c', '-l', '-S', '-J', '-D', '-X']) });
  if (s.has('-S')) return unparseable('scp -S runs a custom program');
  if (s.pos.length < 2) return unknownProd('scp without source and destination');
  const dst = s.pos[s.pos.length - 1];
  const dh = remoteHost(dst);
  if (dh) return xwrite(undefined, dh, 'scp copies files to a remote host');
  if (s.pos.slice(0, -1).some((x) => remoteHost(x))) { h.write(dst, s.posKinds[s.pos.length - 1]); return read('scp download', { host: remoteHost(s.pos.find((x) => remoteHost(x))) }); }
  h.write(dst, s.posKinds[s.pos.length - 1]);
  return local('scp between local paths');
}

function rsync(args, ak, h) {
  const s = scan(args, ak, { values: new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--password-file', '--port', '--rsync-path', '--exclude-from', '--include-from', '--files-from', '--backup-dir', '--suffix', '--chmod', '--chown', '-T', '--temp-dir', '--log-file', '--bwlimit', '--timeout', '--compare-dest', '--copy-dest', '--link-dest']) });
  if (s.has('--rsync-path')) return unparseable('rsync --rsync-path runs a custom program');
  const rsh = s.first('-e', '--rsh');
  if (typeof rsh === 'string' && !/^ssh(\s|$)/.test(rsh)) return unparseable('rsync with a custom remote shell');
  if (s.pos.length < 2) return unknownProd('rsync without source and destination');
  const dst = s.pos[s.pos.length - 1];
  const dh = remoteHost(dst);
  if (dh) return xwrite(undefined, dh, 'rsync copies files to a remote host');
  if (s.pos.slice(0, -1).some((x) => remoteHost(x))) {
    if (s.has('--remove-source-files')) return xwrite(undefined, remoteHost(s.pos.find((x) => remoteHost(x))), 'rsync removes remote source files');
    h.write(dst, s.posKinds[s.pos.length - 1]);
    return read('rsync download');
  }
  h.write(dst, s.posKinds[s.pos.length - 1]);
  return local('rsync between local paths');
}

// ---------------------------------------------------------------- file commands (write roots)

function posixFileCommand(name, args, ak, h) {
  const opt = (t) => t.startsWith('-') && t !== '-';
  const positional = () => { const out = []; let end = false; for (let i = 0; i < args.length; i += 1) { if (!end && args[i] === '--') { end = true; continue; } if (end || !opt(args[i])) out.push(i); } return out; };
  switch (name) {
    case 'rm': case 'rmdir': case 'unlink': case 'shred': case 'touch': case 'mkdir': case 'tee': case 'truncate': {
      const skipNext = { touch: ['-d', '-t', '-r'], mkdir: ['-m'], truncate: ['-s', '-r'], shred: ['-n', '-s'] }[name] ?? [];
      for (let i = 0; i < args.length; i += 1) {
        if (skipNext.includes(args[i])) { i += 1; continue; }
        if (opt(args[i])) continue;
        h.write(args[i], ak[i]);
      }
      return local(`${name} files`);
    }
    case 'mv': case 'cp': case 'install': case 'ln': {
      let tdir = null;
      const pos = [];
      for (let i = 0; i < args.length; i += 1) {
        const t = args[i];
        if (t === '-t' || t === '--target-directory') { tdir = i + 1; i += 1; continue; }
        if (t.startsWith('--target-directory=')) { h.write(t.slice(19), ak[i]); tdir = -1; continue; }
        if (t === '-S' || t === '--suffix' || t === '-m' || t === '-o' || t === '-g') { i += 1; continue; }
        if (opt(t)) continue;
        pos.push(i);
      }
      if (tdir !== null && tdir >= 0) h.write(args[tdir], ak[tdir]);
      if (name === 'mv') for (const i of pos) h.write(args[i], ak[i]);
      else if (pos.length) {
        const dstIdx = tdir !== null ? null : pos.length > 1 ? pos[pos.length - 1] : name === 'ln' ? null : null;
        if (dstIdx !== null) h.write(args[dstIdx], ak[dstIdx]);
        if (name === 'ln' && pos.length === 1 && tdir === null) h.write(String(args[pos[0]]).replace(/^.*[\\/]/, ''), ak[pos[0]]);
        if (name === 'ln') for (const i of pos) h.write(args[i], ak[i]); // writes through a link land on its target
        const linking = name === 'cp' && args.some((t) => t === '--link' || t === '--symbolic-link' || (/^-[a-zA-Z]+$/.test(t) && /[ls]/.test(t)));
        // cp -l/-s makes links: a later write through the copy lands on the source
        if (name === 'cp') for (const i of pos.slice(0, tdir !== null ? pos.length : -1)) (linking ? h.write : h.read)(args[i], ak[i]);
      }
      return local(`${name} files`);
    }
    case 'chmod': case 'chown': case 'chgrp': {
      const pos = positional();
      for (const i of pos.slice(1)) h.write(args[i], ak[i]);
      return local(`${name} files`);
    }
    case 'dd':
      for (let i = 0; i < args.length; i += 1) {
        if (args[i].startsWith('of=')) h.write(args[i].slice(3), ak[i]);
        if (args[i].startsWith('if=')) h.read(args[i].slice(3), ak[i]);
      }
      return local('dd');
    case 'sed': case 'perl-i': {
      const inPlace = args.some((t) => /^-[a-zA-Z]*i/.test(t) && !t.startsWith('--') || t.startsWith('--in-place'));
      if (!inPlace) return null;
      let scriptGiven = false;
      const files = [];
      for (let i = 0; i < args.length; i += 1) {
        const t = args[i];
        if (t === '-e' || t === '--expression' || t === '-f' || t === '--file') { scriptGiven = true; i += 1; continue; }
        if (t === '-l' || t === '--line-length') { i += 1; continue; }
        if (opt(t)) continue;
        files.push(i);
      }
      for (const i of scriptGiven ? files : files.slice(1)) h.write(args[i], ak[i]);
      return local('sed in place');
    }
    case 'tar': {
      const mode = (args[0] && !args[0].startsWith('-') ? args[0] : args.filter((t) => /^-[A-Za-z]+$/.test(t)).join('')).replace(/-/g, '');
      const s = scan(args, ak, { values: new Set(['-f', '--file', '-C', '--directory', '-T', '--files-from', '-X', '--exclude-from']) });
      const file = s.all('-f', '--file')[0];
      const dir = s.all('-C', '--directory')[0];
      if (/[cru]/.test(mode) || s.has('--create', '--append', '--update')) { if (file && file.v !== '-') h.write(file.v, file.kind); }
      if (/x/.test(mode) || s.has('--extract', '--get')) { if (dir) h.write(dir.v, dir.kind); else h.write('.', 'lit'); }
      return local('tar');
    }
    case 'unzip': {
      const s = scan(args, ak, { values: new Set(['-d', '-x', '-P']) });
      const dir = s.all('-d')[0];
      if (s.has('-l', '-t', '-v', '-Z')) return local('unzip listing');
      if (dir) h.write(dir.v, dir.kind); else h.write('.', 'lit');
      return local('unzip');
    }
    case 'find': {
      const starts = [];
      for (let i = 0; i < args.length; i += 1) { if (/^[-(!]/.test(args[i])) break; starts.push(i); }
      for (const i of starts) h.read(args[i], ak[i]);
      if (args.includes('-delete')) {
        if (!starts.length) h.write('.', 'lit');
        for (const i of starts) h.write(args[i], ak[i]);
      }
      return local('find');
    }
    case 'grep': case 'egrep': case 'fgrep': case 'rg': case 'ag': case 'ack': case 'findstr': {
      if (name === 'rg' && args.some((t) => t === '--pre' || t.startsWith('--pre='))) { h.bad = 'rg --pre runs a program on each file'; return local('rg'); }
      const s = scan(args, ak, { values: new Set([...(name === 'rg' ? ['-g', '-t', '-T', '-r', '-E', '-j', '-M'] : []), '-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context', '--include', '--exclude', '--exclude-dir', '--label', '--glob', '--iglob', '--type', '--type-not', '--replace', '--encoding', '--threads', '--max-columns', '--ignore-file', '--max-depth', '-d', '-D']) });
      for (const x of s.all('-f', '--file', '--ignore-file')) h.read(x.v, x.kind);
      const patternGiven = s.has('-e', '--regexp', '-f', '--file');
      const files = s.pos.map((v, i) => ({ v, kind: s.posKinds[i] })).filter((x) => !(name === 'findstr' && x.v.startsWith('/')));
      for (const x of patternGiven ? files : files.slice(1)) h.read(x.v, x.kind);
      return local(`${name} searches files`);
    }
    case 'ls': case 'dir': case 'tree': case 'du': case 'stat': case 'file': case 'exa': case 'eza': {
      for (let i = 0; i < args.length; i += 1) if (!opt(args[i])) h.read(args[i], ak[i]);
      return local(`${name} lists files`);
    }
    case 'cat': case 'head': case 'tail': case 'less': case 'more': case 'base64': case 'xxd': case 'od': case 'hexdump': case 'strings': case 'nl': case 'wc': {
      for (let i = 0; i < args.length; i += 1) {
        if (['-n', '-c', '--lines', '--bytes', '-w', '-s', '-l', '-o', '-x'].includes(args[i]) && i + 1 < args.length && /^[+-]?\d/.test(args[i + 1])) { i += 1; continue; }
        if (opt(args[i])) continue;
        h.read(args[i], ak[i]);
      }
      return local(`${name} reads files`);
    }
    default: return null;
  }
}

const PS_FILE = {
  'remove-item': { write: [0], params: ['path', 'literalpath'] },
  'set-content': { write: [0], params: ['path', 'literalpath'] },
  'add-content': { write: [0], params: ['path', 'literalpath'] },
  'clear-content': { write: [0], params: ['path', 'literalpath'] },
  'out-file': { write: [0], params: ['filepath', 'literalpath', 'path'] },
  'new-item': { write: [0], params: ['path'] },
  'copy-item': { write: [1], params: ['destination'], readPos: [0], readParams: ['path', 'literalpath'] },
  'move-item': { write: [0, 1], params: ['path', 'literalpath', 'destination'] },
  'rename-item': { write: [0], params: ['path', 'literalpath'], rename: true },
  'tee-object': { write: [0], params: ['filepath', 'literalpath', 'path'] },
  'export-csv': { write: [0], params: ['path', 'literalpath'] },
  'export-clixml': { write: [0], params: ['path', 'literalpath'] },
  'expand-archive': { write: [1], params: ['destinationpath'], readPos: [0], readParams: ['path', 'literalpath'] },
  'compress-archive': { write: [1], params: ['destinationpath'] },
  'set-acl': { write: [0], params: ['path', 'literalpath'] },
  'set-itemproperty': { write: [0], params: ['path', 'literalpath'] },
};
const PS_ALIASES = { ri: 'remove-item', rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', sc: 'set-content', ac: 'add-content', clc: 'clear-content',
  ni: 'new-item', mkdir: 'new-item', md: 'new-item', copy: 'copy-item', cp: 'copy-item', cpi: 'copy-item', move: 'move-item', mv: 'move-item', mi: 'move-item', ren: 'rename-item', rni: 'rename-item',
  tee: 'tee-object', epcsv: 'export-csv', sp: 'set-itemproperty' };
const PS_FILE_VALUES = ['path', 'literalpath', 'destination', 'filepath', 'destinationpath', 'value', 'target', 'encoding', 'filter', 'include', 'exclude', 'credential', 'stream', 'itemtype', 'type', 'name', 'newname',
  'inputobject', 'width', 'delimiter', 'tosession', 'fromsession', 'aclobject', 'compressionlevel', 'variable', 'depth', 'property', 'propertytype', 'useculture', 'quotefields', 'usequotes'];
const PS_FILE_SWITCHES = ['recurse', 'force', 'whatif', 'confirm', 'passthru', 'nonewline', 'append', 'noclobber', 'asbytestream', 'container', 'notypeinformation', 'includetypeinformation', 'update'];

function psFileCmdlet(name, args, ak, h, cmdD) {
  if (cmdD) {
    const pos = args.map((t, i) => ({ v: t, kind: ak[i] })).filter((x) => !x.v.startsWith('/'));
    if (['del', 'erase', 'rd', 'rmdir', 'md', 'mkdir'].includes(name)) { for (const p of pos) h.write(p.v, p.kind); return local(`${name} files`); }
    if (name === 'dir') { for (const p of pos) h.read(p.v, p.kind); return local('dir'); }
    if (name === 'copy' || name === 'xcopy' || name === 'robocopy') { if (pos.length > 1) h.write(pos[name === 'robocopy' ? 1 : pos.length - 1].v, pos[name === 'robocopy' ? 1 : pos.length - 1].kind); return local(`${name} files`); }
    if (name === 'move') { for (const p of pos) h.write(p.v, p.kind); return local('move files'); }
    if (name === 'ren' || name === 'rename') { if (pos[0]) h.write(pos[0].v, pos[0].kind); return local('rename'); }
    if (name === 'type') { for (const p of pos) h.read(p.v, p.kind); return local('type'); }
    return null;
  }
  const canon = PS_FILE[name] ? name : PS_ALIASES[name];
  const spec = canon && PS_FILE[canon];
  if (!spec) return null;
  const s = psParams(args, ak, { values: PS_FILE_VALUES, switches: PS_FILE_SWITCHES });
  const writes = [];
  for (const p of spec.params) if (s.get(p) && s.get(p).v !== true) writes.push(s.get(p));
  // positional slots that are not already bound by name
  const slots = s.pos;
  const named0 = spec.params.some((p) => s.get(p) && ['path', 'literalpath', 'filepath'].includes(p));
  for (const idx of spec.write) {
    const slot = named0 && canon !== 'copy-item' && canon !== 'expand-archive' && canon !== 'compress-archive' ? idx - 1 : idx;
    if (idx === 0 && named0) continue;
    if (slots[slot]) writes.push(slots[slot]);
  }
  const itemType = String(s.get('itemtype')?.v ?? s.get('type')?.v ?? '').toLowerCase();
  if (canon === 'new-item' && itemType && ['symboliclink', 'junction', 'hardlink'].some((x) => x.startsWith(itemType))) {
    const t = s.get('target') ?? s.get('value');
    if (!t || t.v === true) h.bad = 'link without a literal target';
    else for (const one of splitPs(t.v)) h.write(one, t.kind);
  }
  if (canon === 'new-item' && s.get('name') && s.get('name').v !== true) {
    const base = writes[0] ?? { v: '.', kind: 'lit' };
    writes.splice(0, writes.length, { v: `${base.v}/${s.get('name').v}`, kind: base.kind === 'lit' && s.get('name').kind === 'lit' ? 'lit' : 'dyn' });
  }
  if (spec.rename) {
    const target = writes[0];
    const nn = s.get('newname') ?? slots[target === slots[0] ? 1 : 0];
    if (target && nn && nn.v !== true) writes.push({ v: `${String(target.v).replace(/[\\/][^\\/]*$/, '') || '.'}/${nn.v}`, kind: nn.kind === 'lit' && target.kind === 'lit' ? 'lit' : 'dyn' });
  }
  for (const wv of writes) for (const one of splitPs(wv.v)) h.write(one, wv.kind);
  for (const p of spec.readParams ?? []) if (s.get(p) && s.get(p).v !== true) for (const one of splitPs(s.get(p).v)) h.read(one, s.get(p).kind);
  if (!(spec.readParams ?? []).some((p) => s.get(p))) for (const idx of spec.readPos ?? []) if (slots[idx]) for (const one of splitPs(slots[idx].v)) h.read(one, slots[idx].kind);
  if (!writes.length && canon !== 'remove-item') return local(`${canon}`);
  if (!writes.length) { h.bad = 'Remove-Item without a literal path'; }
  return local(`${canon} files`);
}

// ---------------------------------------------------------------- MCP

const MCP_READ_VERBS = new Set(['get', 'list', 'search', 'fetch', 'read', 'describe', 'lookup', 'view', 'find', 'show', 'count', 'status', 'logs']);
const MCP_WRITE_VERBS = new Set(['create', 'update', 'edit', 'delete', 'remove', 'send', 'post', 'reply', 'forward', 'transition', 'add', 'schedule', 'share', 'trash', 'merge', 'sync', 'apply', 'rollback',
  'terminate', 'restart', 'scale', 'deploy', 'publish', 'upload', 'copy', 'move', 'label', 'mark', 'respond', 'complete', 'approve', 'assign', 'invite', 'set']);
// Words that change state even though they are not in the spec's write-verb list.
const MCP_MUTATING = new Set(['purge', 'drop', 'truncate', 'destroy', 'kill', 'reset', 'modify', 'replace', 'push', 'insert', 'upsert', 'save', 'put', 'patch', 'grant', 'revoke', 'enable', 'disable',
  'stop', 'start', 'restore', 'import', 'submit', 'trigger', 'invoke', 'call', 'write', 'undelete', 'archive', 'unarchive', 'notify', 'comment', 'cancel', 'abort', 'reboot', 'shutdown', 'resize', 'rename',
  'clear', 'flush', 'wipe', 'erase', 'unlink', 'link', 'attach', 'detach', 'lock', 'unlock', 'block', 'unblock', 'ban', 'unban', 'pause', 'resume', 'suspend', 'promote', 'demote', 'rotate', 'renew',
  'transfer', 'pay', 'refund', 'charge', 'book', 'reserve', 'order', 'buy', 'sell', 'untrash', 'unlabel', 'unmark', 'accept', 'reject', 'dismiss', 'close', 'reopen', 'merge', 'commit', 'release']);

function globMatch(pattern, name) {
  if (typeof pattern !== 'string') return false;
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

function mcpWords(tool) {
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((x) => x.toLowerCase());
}

function classifyMcp(name, input, ctx) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return unparseable('malformed MCP tool name');
  const [, server, tool] = m;
  const policy = ctx.mcpPolicy && typeof ctx.mcpPolicy === 'object' ? ctx.mcpPolicy : {};
  const writes = policy.write && typeof policy.write === 'object' ? policy.write : {};
  for (const [pat, scopeSpec] of Object.entries(writes)) {
    if (globMatch(pat, name)) {
      const spec = String(scopeSpec ?? '');
      const colon = spec.indexOf(':');
      return write(colon > 0 ? spec.slice(0, colon) : spec || `mcp.write`, colon > 0 ? spec.slice(colon + 1) : spec ? undefined : server, 'owner MCP write override');
    }
  }
  const reads = Array.isArray(policy.read) ? policy.read : [];
  if (reads.some((p) => globMatch(p, name))) return read('owner MCP read override');
  if (tool === 'slack_send_message_draft' && /slack/i.test(server) && !server.includes('__')) return read('built-in MCP read override (Slack draft)');
  let hasRead = false;
  let hasWrite = false;
  let unknown = null;
  let mutating = null;
  for (const w of mcpWords(tool)) {
    if (w === 'query' || w === 'execute' || w === 'sql' || w.startsWith('run') || w.startsWith('exec')) { unknown = w; break; }
    if (MCP_WRITE_VERBS.has(w)) hasWrite = true;
    else if (MCP_MUTATING.has(w)) mutating = mutating ?? w;
    else if (MCP_READ_VERBS.has(w)) hasRead = true;
  }
  if (unknown) return unknownProd(`MCP tool ${tool} (verb ${unknown}) is unavailable for policy`);
  if (hasWrite) return mcpScope(server, tool, input);
  if (mutating) return /atlassian|jira|confluence|slack|argo/i.test(server) ? mcpScope(server, tool, input) : unknownProd(`MCP tool ${tool} (${mutating}) changes state; unavailable for policy`);
  if (hasRead) return read(`MCP read ${tool}`);
  return unknownProd(`MCP tool ${tool} has no recognised verb; unavailable for policy`);
}

function str(v) {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
}

function mcpScope(server, tool, input) {
  const s = server.toLowerCase();
  const t = tool.toLowerCase();
  if (/atlassian|jira|confluence/.test(s)) {
    if (/confluence/.test(t) || /confluence/.test(s) || /page/.test(t)) return write('confluence.write', str(input.pageId) ?? str(input.spaceId), `MCP ${tool} changes Confluence`);
    return write('jira.write', str(input.issueIdOrKey) ?? str(input.issueKey) ?? str(input.key), `MCP ${tool} changes Jira`);
  }
  if (/slack/.test(s)) return write('slack.post', str(input.channel_id) ?? str(input.channel), `MCP ${tool} posts to Slack`);
  if (/argo/.test(s)) return write('argo.sync', str(input.applicationName) ?? str(input.appName) ?? str(input.application) ?? str(input.name), `MCP ${tool} changes an Argo CD application`);
  return write('mcp.write', server, `MCP ${tool} is a write`);
}
