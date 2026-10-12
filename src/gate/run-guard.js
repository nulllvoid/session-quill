// Per-run guard decisions (spec §4.1–4.3, §7.5). Turns a classification from prod-classify.js and
// the run's frozen grant (src/handoff/grant.js) into allow or deny, with a reason that tells the
// agent what to do instead. Synchronous, and side-effect free apart from realpath/lstat lookups:
// every path is compared after links are resolved (ruling R10), which is what stops a junction or
// symlink inside the checkout from reaching past the run's roots.
//
// Order of checks in enforce mode (the first that fails decides the reason):
//   1. MCP server source  — an untrusted server is refused whatever the call is
//   2. unparseable        — nothing else about the command can be trusted
//   3. quill-privileged   — Quill's own mutating commands are never available in a run
//   4. readable roots, then writable roots and protected paths (file boundary, links resolved)
//   5. git per-run permissions and protected branches (ADR 0017, ruling R2)
//   6. unknown-prod       — cannot be proposed as a scoped change because it has no scope
//   7. scopes and action pins — an uncovered write is a QUILL_CRITICAL_CHANGE
// Hard denials come before critical changes: proposing an action the run could never take anyway
// (wrong path, protected branch, privileged) would only send the owner an unusable proposal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCall } from './prod-classify.js';
import { tokenize } from './shell-tokens.js';
import { quillHome, handoffRunDir } from '../lib/paths.js';
import { isProtectedBranch } from '../handoff/permissions.js';

// The Quill install this guard runs from.
export const INSTALL_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// The guard's code and every local module it loads, relative to the install root. A run never
// changes them, even when its checkout is the install root (Review Focus 2). A test walks the
// guard's imports to keep this list complete.
export const GUARD_CODE = ['src/gate', 'bin/quill-guard.js', 'src/handoff/grant.js', 'src/handoff/permissions.js', 'src/lib/paths.js', 'src/lib/errors.js', 'src/lib/atomic-fs.js'];
// The worker's own files in the run dir: the rest of the run dir is scratch.
const RUN_DIR_FILES = ['grant.json', 'run-settings.json', 'ledger.jsonl', 'env'];
// Claude's settings and the credential locations under home (spec §4.2): never readable, never writable.
const HOME_SECRETS = ['.claude', '.claude.json', '.claude.json.backup', '.kube', '.aws', '.config/gcloud', '.azure', '.ssh', '.netrc', '_netrc', '.pgpass', '.docker/config.json', '.git-credentials'];
const TRUSTED_MCP_SOURCES = new Set(['claudeai', 'user', 'plugin']);
const SHELLS = { Bash: 'bash', Monitor: 'bash', PowerShell: 'powershell' };
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EFFECT_CLASSES = new Set(['write', 'external.write', 'privileged', 'unknown-prod']);
const WIN = process.platform === 'win32';
const MAX_LINK_HOPS = 32;

const CRITICAL_TAIL = 'Record it in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.';
const REASONS = {
  tampered: () => "QUILL_DENIED grant-tampered: this run's grant file is missing or no longer matches the hash recorded when the run was queued, so only local commands that touch no files are allowed. Stop changing things, report the problem in the result and finish.",
  untrustedMcp: (server, source) => `QUILL_DENIED untrusted-mcp-server: MCP server ${server} comes from the ${source} configuration and is not in [handoff] trusted_mcp_servers, so this run cannot use it. Use a connector or command that is available, and record the route you tried in attempts.`,
  unparseable: (why) => `QUILL_DENIED unparseable: the guard could not read this command (${why}); rewrite it as one plain command without variables, eval, wrappers or globs in write targets.`,
  privileged: (why) => `QUILL_DENIED quill-privileged: ${why}. A run may use only Quill's read commands (status, ticket show|list|children, agent list|show|suggestions, handoff list, repo list, doctor); put what you wanted Quill to do in the result instead.`,
  outsideReadable: (p) => `QUILL_DENIED outside-readable: ${p ?? 'this location'} is outside what this run may read (its checkout, run directory, context snapshot, temp directory and plugin directories). Work from those, and record in attempts what you could not reach.`,
  protectedPath: (p) => `QUILL_DENIED protected-path: ${p} is protected (Quill's guard and store, this run's grant, settings, ledger and credential stubs, Claude settings, git internals or credentials) and cannot change in a run. Leave it as it is and continue with the rest of the task.`,
  noEdit: (p) => `QUILL_DENIED no-edit-permission: this run may read ${p} but not change it; edit_source is not granted for this run. Write scratch files under the run directory or the temp directory, and describe the change you would make in the result.`,
  outsideWritable: (p) => `QUILL_DENIED outside-writable: ${p ?? 'this location'} is outside what this run may change (the checkout when editing is granted, the run directory and the temp directory). Write there instead, or describe the change in the result.`,
  noCommit: () => 'QUILL_DENIED no-commit-permission: git commits need the commit permission, which this run does not have. Leave the changes uncommitted and describe them in the result.',
  noPush: () => 'QUILL_DENIED no-push-permission: git push needs the push_branch permission, which this run does not have. Leave the commits local and say in the result that they need pushing.',
  noPr: () => 'QUILL_DENIED no-pr-permission: creating or changing a pull request needs the open_draft_pr permission, which this run does not have. Put the title and description you would use in the result.',
  protectedBranch: (why) => `QUILL_DENIED protected-branch: ${why}. Pushing to the default or a protected branch, force and tag pushes, deleting branches, merging into a protected branch and non-draft pull requests are never allowed in a run; push the run's own branch or open a draft PR when granted, and leave the rest to the owner.`,
  unknownProd: (why) => `QUILL_DENIED unknown-prod: ${why}; the guard cannot tell what this changes, so it is not allowed. Use a read-only form, or record the change in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.`,
  critical: (change, pins) => `QUILL_CRITICAL_CHANGE scope=${change.scope} target=${change.target ?? 'unknown'}: not granted for this run${pins.length ? ` (it may perform only its approved action, run exactly as one command: ${pins.join(' | ')})` : ''}. ${CRITICAL_TAIL}`,
};

/**
 * Decides one tool call for a run.
 * @param {{ tool_name: string, tool_input?: object, mcp_server_source?: string }} call  the
 *   PreToolUse input; `mcp_server_source` is the server's `source` from the run's system/init
 *   event, when known.
 * @param {object|null} grant  readGrant()'s result, or null when readGrant threw (missing,
 *   tampered or invalid grant). Without a usable grant only `local` calls that touch no files are
 *   allowed, whatever the guard mode.
 * @param {{ cwd?: string, vars?: object, currentBranch?: string, defaultBranch?: string,
 *   installRoot?: string }} env  cwd: the agent's working directory (the hook input's `cwd`);
 *   vars: the hook's environment (process.env: QUILL_HANDOFF_GUARD, QUILL_HANDOFF_ID, QUILL_HOME,
 *   USERPROFILE/HOME, TEMP/TMP/TMPDIR, CLAUDE_PLUGIN_ROOT); currentBranch / defaultBranch: the
 *   checkout's branch (a bare `git push` needs it) and the repository's default branch;
 *   installRoot: the install whose guard code is protected (default INSTALL_ROOT).
 * @returns {{ decision: 'allow'|'deny', reason: string, classification: object,
 *   criticalChange?: { scope: string, target: string|null } }}  Observe mode (grant access `full`
 *   and QUILL_HANDOFF_GUARD=observe) allows everything and fills criticalChange for writes.
 */
export function decide(call, grant, env) {
  const c = isPlainObject(call) ? call : {};
  const e = isPlainObject(env) ? env : {};
  const vars = isPlainObject(e.vars) ? e.vars : {};
  const g = isPlainObject(grant) ? grant : null;
  const home = homeOf(vars);
  const ctx = {
    cwd: typeof e.cwd === 'string' && e.cwd ? e.cwd : undefined,
    home,
    env: vars,
    currentBranch: nonEmpty(e.currentBranch),
    defaultBranch: nonEmpty(e.defaultBranch),
    isProtectedBranch: (name) => protectedBranch(name, e),
    mcpPolicy: g && isPlainObject(g.mcpPolicy) ? g.mcpPolicy : { read: [], write: {} },
    trackerHosts: strings(g?.trackerHosts),
  };
  const classification = classifyCall({ tool_name: c.tool_name, tool_input: c.tool_input }, ctx);
  const result = (r) => ({ decision: r.decision, reason: r.reason, classification, ...(r.criticalChange ? { criticalChange: r.criticalChange } : {}) });
  if (!g) {
    return result(touchesNothing(c.tool_name, classification)
      ? { decision: 'allow', reason: 'no usable grant: a local call that touches no files' }
      : { decision: 'deny', reason: REASONS.tampered() });
  }
  const parts = partsOf(classification);
  if (g.access === 'full' && varOf(vars, 'QUILL_HANDOFF_GUARD') === 'observe') {
    const effect = parts.find((p) => EFFECT_CLASSES.has(p.class));
    return result({ decision: 'allow', reason: `full access (observe only): ${classification.reason}`, criticalChange: effect ? changeOf(effect) : undefined });
  }
  return result(enforce(c, classification, parts, g, e, vars, home, ctx));
}

function enforce(c, cls, parts, g, e, vars, home, ctx) {
  const deny = (reason, criticalChange) => ({ decision: 'deny', reason, criticalChange });
  const tool = typeof c.tool_name === 'string' ? c.tool_name : '';
  const source = typeof c.mcp_server_source === 'string' ? c.mcp_server_source : '';
  if (tool.startsWith('mcp__') && source && !TRUSTED_MCP_SOURCES.has(source)) {
    const server = /^mcp__(.+?)__/.exec(tool)?.[1] ?? tool;
    // tool names spell the server with anything but letters, digits, _ and - replaced by _
    const trusted = strings(g.trustedMcpServers).some((s) => s === server || s.replace(/[^A-Za-z0-9_-]/g, '_') === server);
    if (!trusted) return deny(REASONS.untrustedMcp(server, source));
  }
  const bad = cls.class === 'unparseable' ? cls : parts.find((p) => p.class === 'unparseable');
  if (bad) return deny(REASONS.unparseable(bad.reason));
  const priv = parts.find((p) => p.class === 'privileged');
  if (priv) return deny(REASONS.privileged(priv.reason));

  const perms = isPlainObject(g.permissions) ? g.permissions : {};
  const reads = readPathsOf(tool, c.tool_input, cls, ctx, home);
  const writes = writePathsOf(tool, cls);
  if (reads.length || writes.length) {
    const roots = rootsOf(g, e, vars, home, perms, writes.length > 0);
    for (const p of reads) if (!readable(p, roots)) return deny(REASONS.outsideReadable(p));
    for (const p of writes) {
      const why = writeProblem(p, roots);
      if (why) return deny(REASONS[why](p));
    }
  }

  for (const p of parts) {
    if (p.class !== 'write' || !String(p.scope ?? '').startsWith('git.')) continue;
    const why = gitProblem(p, perms, e);
    if (why) return deny(why);
  }
  const unknown = parts.find((p) => p.class === 'unknown-prod');
  if (unknown) return deny(REASONS.unknownProd(unknown.reason));

  let info = null;
  let via = null;
  for (const p of parts) {
    if (!(p.class === 'external.write' || (p.class === 'write' && !String(p.scope ?? '').startsWith('git.')))) continue;
    info = info ?? callInfo(c);
    const cover = coverOf(p, g, info);
    if (!cover.ok) return deny(REASONS.critical(changeOf(p), cover.pins), changeOf(p));
    via = via ?? cover.via;
  }
  return { decision: 'allow', reason: via ? `allowed by ${via}` : `allowed: ${cls.reason}` };
}

// ------------------------------------------------------------------ paths and roots

function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function danglingTarget(p) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    const t = fs.readlinkSync(p);
    return WIN ? t.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '') : t;
  } catch {
    return null;
  }
}

// The path the OS would reach (ruling R10): links resolved through the nearest existing ancestor,
// with the segments that do not exist yet re-appended, so a file about to be created works. A
// dangling link on the way is followed to where it points, because writing through it creates
// its target. Null when links loop.
export function canonicalPath(p, hops = 0) {
  const resolved = path.resolve(p);
  const real = realOrNull(resolved);
  if (real) return real;
  const tail = [];
  let cursor = resolved;
  for (;;) {
    const target = danglingTarget(cursor);
    if (target !== null) {
      if (hops >= MAX_LINK_HOPS) return null;
      const dir = path.dirname(cursor);
      return canonicalPath(path.join(path.resolve(realOrNull(dir) ?? dir, target), ...tail), hops + 1);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    tail.unshift(path.basename(cursor));
    const realParent = realOrNull(parent);
    if (realParent) return path.join(realParent, ...tail);
    cursor = parent;
  }
}

// True when `child` is `root` or below it. Case-insensitive on Windows; `C:\repo-other` is not
// inside `C:\repo`. Both paths are expected in canonical form.
export function isWithin(child, root) {
  const c = WIN ? child.toLowerCase() : child;
  const r = WIN ? root.toLowerCase() : root;
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Length of the deepest root containing `p`, or -1: the most specific root decides.
function deepest(roots, p) {
  let best = -1;
  for (const r of roots) if (r.length > best && isWithin(p, r)) best = r.length;
  return best;
}

// Every root in canonical form. Paths the worker or the owner chose (grant roots, home, Quill
// home, run dir, install root, temp) are resolved; fixed names below them (credential dirs, guard
// files, run-dir files) are joined onto the resolved base, which keeps one decision to a handful
// of filesystem lookups. Results are memoised for this decision only; the write-side roots are
// built only when the call writes.
function rootsOf(g, e, vars, home, perms, forWrites) {
  const memo = new Map();
  const canonOne = (p) => {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return null;
    if (!memo.has(p)) memo.set(p, canonicalPath(p));
    return memo.get(p);
  };
  const canon = (list) => list.map(canonOne).filter(Boolean);
  const under = (base, names) => (base ? names.map((n) => path.join(base, n)) : []);

  const qhEnv = { QUILL_HOME: varOf(vars, 'QUILL_HOME') ?? path.join(home, '.claude', 'quill') };
  const grantWritable = canon(strings(g.writableRoots));
  const unreadable = [...under(canonOne(home), HOME_SECRETS), ...canon([quillHome(qhEnv)])];
  const roots = { canonical: canonOne, readable: [...canon(strings(g.readableRoots)), ...grantWritable], unreadable };
  if (!forWrites) return roots;

  let runDir = null;
  try { runDir = varOf(vars, 'QUILL_HANDOFF_ID') ? canonOne(handoffRunDir(qhEnv, varOf(vars, 'QUILL_HANDOFF_ID'))) : null; } catch { runDir = null; }
  const temps = ['TEMP', 'TMP', 'TMPDIR'].map((k) => varOf(vars, k)).filter(Boolean);
  const canEdit = perms.edit_source === true || perms.edit_files === true || perms.delete_files === true;
  // Per-run permissions are the guard's to enforce (§4.2): without an edit permission only the
  // scratch areas stay writable, whatever roots the grant lists.
  const scratch = canon([runDir, ...(temps.length ? temps : [os.tmpdir()])]);
  return {
    ...roots,
    canEdit,
    writable: canEdit ? grantWritable : grantWritable.filter((w) => scratch.some((s) => isWithin(w, s))),
    protected: [
      ...canon(strings(g.protectedPaths)),
      ...unreadable,
      ...under(canonOne(nonEmpty(e.installRoot) ?? INSTALL_ROOT), GUARD_CODE),
      ...under(runDir, RUN_DIR_FILES),
      ...canon([varOf(vars, 'CLAUDE_PLUGIN_ROOT')]),
      ...grantWritable.map((w) => path.join(w, '.git')),
    ],
  };
}

function readable(p, roots) {
  const c = roots.canonical(p);
  if (!c) return false;
  const r = deepest(roots.readable, c);
  return r >= 0 && deepest(roots.unreadable, c) < r;
}

// Null when the write may go ahead, else the REASONS key. The most specific root decides, and a
// protected root wins a tie with a writable one.
function writeProblem(p, roots) {
  const c = roots.canonical(p);
  if (!c) return 'outsideWritable';
  if (protectedName(c)) return 'protectedPath';
  const w = deepest(roots.writable, c);
  const prot = deepest(roots.protected, c);
  if (w >= 0 && w > prot) {
    // deleting, moving or replacing a directory that holds a protected path changes it too
    return roots.protected.some((q) => q.length > c.length && isWithin(q, c)) ? 'protectedPath' : null;
  }
  // Somewhere the run may read but not change (its checkout without edit_source, even though the
  // worker keeps checkouts under the protected Quill home): the missing permission is the reason.
  if (!roots.canEdit && deepest(roots.readable, c) > prot) return 'noEdit';
  return prot >= 0 ? 'protectedPath' : 'outsideWritable';
}

// Git internals anywhere (hooks and config run later with the owner's credentials; a `.git` file
// redirects the git dir) and Claude settings in a checkout, including replacing the `.claude` dir.
function protectedName(c) {
  const segs = c.split(/[\\/]+/).map((s) => (WIN ? s.toLowerCase() : s));
  if (segs.includes('.git')) return true;
  const i = segs.lastIndexOf('.claude');
  if (i < 0) return false;
  return i === segs.length - 1 || (i === segs.length - 2 && /^settings.*\.json$/i.test(segs[i + 1]));
}

function readPathsOf(tool, input, cls, ctx, home) {
  const out = [];
  if (READ_TOOLS.has(tool)) out.push(cls.path ?? null);
  if (Array.isArray(cls.readPaths)) out.push(...cls.readPaths);
  if (tool === 'Glob') {
    const base = globBase(input, cls.path ?? ctx.cwd, home);
    if (base !== undefined) out.push(base);
  }
  return out;
}

function writePathsOf(tool, cls) {
  const out = [];
  if (WRITE_TOOLS.has(tool)) out.push(cls.path ?? null);
  if (Array.isArray(cls.paths)) out.push(...cls.paths);
  return out;
}

// An absolute, `~` or `..` Glob pattern searches somewhere other than its path: its literal
// prefix must be readable too. Undefined when the pattern stays below its search path.
function globBase(input, searchDir, home) {
  const pattern = isPlainObject(input) && typeof input.pattern === 'string' ? input.pattern : '';
  const segs = pattern.split(/[\\/]/);
  const absolute = path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern);
  const tilde = segs[0] === '~';
  if (!absolute && !tilde && !segs.includes('..')) return undefined;
  const fixed = [];
  for (const s of segs) {
    if (/[*?[\]{}]/.test(s)) break;
    fixed.push(s);
  }
  if (tilde) fixed[0] = home;
  const prefix = fixed.join('/') || (absolute ? '/' : '.');
  if (!absolute && !tilde && !searchDir) return null;
  return path.resolve(searchDir ?? home, prefix);
}

// ------------------------------------------------------------------ git, scopes and pins

function partsOf(cls) {
  if (Array.isArray(cls.calls)) return cls.calls;
  return cls.class === 'local' ? [] : [cls];
}

function touchesNothing(tool, cls) {
  return cls.class === 'local' && !cls.path && !(cls.paths && cls.paths.length) && !(cls.readPaths && cls.readPaths.length) && !READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool);
}

function protectedBranch(name, e) {
  return typeof name !== 'string' || !name || isProtectedBranch(name, { default_branch: nonEmpty(e.defaultBranch) });
}

// Ruling R2: the classifier's git pseudo-scopes are per-run permissions, never grantable scopes.
function gitProblem(p, perms, e) {
  switch (p.scope) {
    case 'git.commit': return perms.commit === true ? null : REASONS.noCommit();
    case 'git.push':
      if (perms.push_branch !== true) return REASONS.noPush();
      return protectedBranch(p.target, e) ? REASONS.protectedBranch(p.reason) : null;
    case 'git.pr': return perms.open_draft_pr === true ? null : REASONS.noPr();
    default: return REASONS.protectedBranch(p.reason);
  }
}

const targetOf = (p) => p.target ?? p.host ?? null;
const changeOf = (p) => ({ scope: p.scope ?? p.class, target: targetOf(p) });
const scopeName = (s) => (s.includes(':') ? s.slice(0, s.indexOf(':')) : s);
const scopeTarget = (s) => (s.includes(':') ? s.slice(s.indexOf(':') + 1) : undefined);

function sameTarget(want, p) {
  const got = targetOf(p);
  if (typeof got !== 'string') return false;
  return p.class === 'external.write' ? got.toLowerCase() === String(want).toLowerCase() : got === String(want);
}

function callInfo(c) {
  const dialect = SHELLS[c.tool_name];
  if (dialect) {
    const command = isPlainObject(c.tool_input) && typeof c.tool_input.command === 'string' ? c.tool_input.command : '';
    const toks = tokenize(command, dialect);
    return { kind: 'shell', dialect, toks, segments: toks ? toks.map((t) => t.join(' ')) : [] };
  }
  if (typeof c.tool_name === 'string' && c.tool_name.startsWith('mcp__')) return { kind: 'mcp', tool: c.tool_name };
  return { kind: 'other' };
}

// A scope with action pins allows only its pinned actions (§7.5); otherwise a granted scope
// covers the write when its name and target match and one of its matchers fits the call.
function coverOf(p, g, info) {
  const pins = (Array.isArray(g.actionPins) ? g.actionPins : [])
    .filter((a) => isPlainObject(a) && typeof a.scope === 'string' && typeof a.pin === 'string' && scopeName(a.scope) === p.scope);
  if (pins.length) return pins.some((a) => pinMatches(a, p, info)) ? { ok: true, via: 'the approved action pin' } : { ok: false, pins: pins.map((a) => a.pin.trim()) };
  const scope = (Array.isArray(g.scopes) ? g.scopes : []).find((s) => scopeCovers(s, p, info));
  return scope ? { ok: true, via: `scope ${scope.name}${scope.target ? `:${scope.target}` : ''}` } : { ok: false, pins: [] };
}

// Normalised equality: a shell pin is compared token by token with the whole command (wrappers
// unwrapped, quoting and spacing ignored); an MCP pin is `<tool name> <identifying argument>`.
function pinMatches(a, p, info) {
  const target = scopeTarget(a.scope);
  if (target !== undefined && !sameTarget(target, p)) return false;
  const pin = a.pin.trim();
  if (info.kind === 'shell') {
    const want = tokenize(pin, info.dialect);
    return !!want && !!info.toks && JSON.stringify(want) === JSON.stringify(info.toks);
  }
  if (info.kind === 'mcp') {
    const [tool, ...ids] = pin.split(/\s+/);
    return tool === info.tool && ids.join(' ') === (targetOf(p) ?? '');
  }
  return false;
}

function scopeCovers(s, p, info) {
  if (!isPlainObject(s) || s.name !== p.scope) return false;
  if (s.target !== undefined && s.target !== null && s.target !== '' && !sameTarget(s.target, p)) return false;
  const m = isPlainObject(s.matchers) ? s.matchers : {};
  if (info.kind === 'mcp') return strings(m.mcp).some((pat) => globMatch(pat, info.tool));
  if (info.kind !== 'shell') return false;
  if (strings(m.bash).some((pat) => info.segments.some((seg) => globMatch(pat, seg)))) return true;
  return typeof p.host === 'string' && strings(m.hosts).some((h) => globMatch(h.toLowerCase(), p.host.toLowerCase()));
}

const globCache = new Map();
function globMatch(pattern, text) {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
    if (globCache.size < 500) globCache.set(pattern, re);
  }
  return re.test(text);
}

// ------------------------------------------------------------------ small helpers

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strings(list) {
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s) : [];
}

function nonEmpty(v) {
  return typeof v === 'string' && v ? v : undefined;
}

// Environment names are case-insensitive on Windows.
function varOf(vars, name) {
  if (typeof vars[name] === 'string') return vars[name] || undefined;
  if (WIN) for (const k of Object.keys(vars)) if (k.toUpperCase() === name && typeof vars[k] === 'string') return vars[k] || undefined;
  return undefined;
}

function homeOf(vars) {
  return (WIN ? varOf(vars, 'USERPROFILE') ?? varOf(vars, 'HOME') : varOf(vars, 'HOME')) ?? os.homedir();
}
