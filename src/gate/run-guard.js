// Per-run guard decisions (spec §4.1–4.3, §7.5). Turns a classification from prod-classify.js and
// the run's frozen grant (src/handoff/grant.js) into allow or deny, with a reason that tells the
// agent what to do instead. Synchronous, and side-effect free apart from realpath, lstat, readlink
// and readdir lookups: every path is compared after links are resolved (ruling R10), and every
// entry beside a shell wildcard is checked too (ruling R15), which is what stops a junction or
// symlink inside the checkout from reaching past the run's roots.
//
// Order of checks in enforce mode (the first that fails decides the reason):
//   1. MCP server source  — an untrusted server is refused whatever the call is
//   2. unparseable        — nothing else about the command can be trusted
//   3. quill-privileged   — Quill's own mutating commands are never available in a run
//   4. file boundary      — Glob/Grep patterns that climb out, readable roots, then writable roots
//                           and protected paths (links resolved, wildcards expanded)
//   5. git per-run permissions and protected branches (ADR 0017, ruling R2)
//   6. unknown-prod       — cannot be proposed as a scoped change because it has no scope
//   7. scopes and action pins — an uncovered write is a QUILL_CRITICAL_CHANGE
// Hard denials come before critical changes: proposing an action the run could never take anyway
// (wrong path, protected branch, privileged) would only send the owner an unusable proposal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCall, CLIMB_REASON_RE } from './prod-classify.js';
import { parseShell, binName } from './shell-tokens.js';
import { quillHome, handoffRunDir } from '../lib/paths.js';
import { isProtectedBranch } from '../handoff/permissions.js';
import { canonicalJson } from '../handoff/grant.js';
import { commandProblem, commandCheck, BUILTIN_COMMANDS } from './scope-commands.js';

// The Quill install this guard runs from.
export const INSTALL_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// The guard's code and every local module it loads, relative to the install root. A run never
// changes them, even when its checkout is the install root (Review Focus 2). A test walks the
// guard's imports to keep this list complete.
export const GUARD_CODE = ['src/gate', 'bin/quill-guard.js', 'src/handoff/grant.js', 'src/handoff/permissions.js', 'src/handoff/stream.js', 'src/handoff/mcp-sources.js', 'src/export/sanitize.js', 'src/lib/paths.js', 'src/lib/errors.js', 'src/lib/atomic-fs.js', 'src/lib/git-head.js'];
// A shell wildcard that can match more directory entries than this is refused rather than checked.
export const MAX_GLOB_MATCHES = 512;
// The worker's own files in the run dir: the rest of the run dir is scratch. mcp-servers.json
// tells the guard which MCP servers it may trust by source (R20), so a run must not rewrite it.
const RUN_DIR_FILES = ['grant.json', 'run-settings.json', 'ledger.jsonl', 'env', 'mcp-servers.json'];
// Claude's settings and the credential locations under home (spec §4.2): never readable, never writable.
const HOME_SECRETS = ['.claude', '.claude.json', '.claude.json.backup', '.kube', '.aws', '.config/gcloud', '.azure', '.ssh', '.netrc', '_netrc', '.pgpass', '.docker/config.json', '.git-credentials'];
const TRUSTED_MCP_SOURCES = new Set(['claudeai', 'user', 'plugin']);
const SHELLS = { Bash: 'bash', Monitor: 'bash', PowerShell: 'powershell' };
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EFFECT_CLASSES = new Set(['write', 'external.write', 'privileged', 'unknown-prod']);
const WIN = process.platform === 'win32';
// File names are compared case-insensitively where the usual file system ignores case.
const NAMES_FOLD_CASE = WIN || process.platform === 'darwin';
const MAX_LINK_HOPS = 32;
const TOOL_NAME_SAFE = /^[A-Za-z0-9_-]+$/;
// The production CLIs whose credentials a run redirects, by credential system (Task 9 report
// names). A read through one of them needs that system's read-only profile (spec §3 onboarding).
const PROD_CLI_SYSTEMS = { kubectl: 'kubernetes', helm: 'kubernetes', k9s: 'kubernetes', aws: 'aws', eksctl: 'aws', gcloud: 'gcp', gsutil: 'gcp', bq: 'gcp', az: 'azure', psql: 'databases', mysql: 'databases', mongosh: 'databases', 'redis-cli': 'databases', argocd: 'argo' };

const CRITICAL_TAIL = 'Record it in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.';
const REASONS = {
  tampered: () => "QUILL_DENIED grant-tampered: this run's grant file is missing or no longer matches the hash recorded when the run was queued, so only local commands that touch no files are allowed. Stop changing things, report the problem in the result and finish.",
  untrustedMcp: (server, source) => `QUILL_DENIED untrusted-mcp-server: MCP server ${server} comes from the ${source} configuration and is not in [handoff] trusted_mcp_servers, so this run cannot use it. Use a connector or command that is available, and record the route you tried in attempts.`,
  unparseable: (why) => `QUILL_DENIED unparseable: the guard could not read this command (${why}); rewrite it as one plain command without variables, eval, wrappers or globs in write targets.`,
  climbs: (p) => `QUILL_DENIED unparseable: the path ${p} has '..' after a directory name, which shells resolve through links differently than the guard can check. Write the path without 'name/..': name the directory you mean directly, or start the path with '..' only.`,
  cdMissing: (dir) => `QUILL_DENIED unparseable: the command changes directory to ${dir}, which does not exist (or is not a directory), and later commands would still run in the old directory. Create the directory first, join the commands with && after the cd, or use paths from the current directory.`,
  climbFrom: (p, dir) => `QUILL_DENIED unparseable: ${p} climbs with '..' from ${dir}, which is not an existing directory, so the guard cannot tell where the shell really is (a cd into it fails, or it is created in the same command). Create the directory or change into it in an earlier command, or write the path without '..'.`,
  privileged: (why) => `QUILL_DENIED quill-privileged: ${why}. A run may use only Quill's read commands (status, ticket show|list|children, agent list|show|suggestions, handoff list, repo list, doctor); put what you wanted Quill to do in the result instead.`,
  outsideReadable: (p, via) => `QUILL_DENIED outside-readable: ${p ?? 'this location'}${via && via !== p ? ` reaches ${via}, which` : ''} is outside what this run may read (its checkout, run directory, context snapshot, temp directory and plugin directories). Work from those, and record in attempts what you could not reach.`,
  patternClimbs: (pattern) => `QUILL_DENIED outside-readable: the pattern ${pattern} climbs out of its search directory ('..' after a wildcard or brace), so the guard cannot tell what it reaches. Search from an explicit path inside the readable area instead.`,
  tooBroad: (p) => `QUILL_DENIED wildcard-too-broad: ${p} can reach more than ${MAX_GLOB_MATCHES} entries, too many for the guard to check where each one leads. List the explicit paths you need instead.`,
  unlisted: (p, dir) => `QUILL_DENIED wildcard-unchecked: ${p} has a wildcard below ${dir}, which cannot be listed, so the guard cannot check what it reaches. List the explicit paths you need instead.`,
  wildcardReach: (p, via, verb) => `QUILL_DENIED ${verb === 'read' ? 'outside-readable' : 'outside-writable'}: ${p} has a wildcard that can reach ${via ?? 'an entry whose links cannot be resolved'}, which this run may not ${verb}. The guard does not evaluate wildcards, it checks every entry beside them, so list the explicit paths you need instead.`,
  protectedPath: (p, via) => `QUILL_DENIED protected-path: ${p}${via && via !== p ? ` reaches ${via}, which` : ''} is protected (Quill's guard and store, this run's grant, settings, ledger and credential stubs, Claude settings or credentials) and cannot change in a run. Leave it as it is and continue with the rest of the task.`,
  protectedGit: (p) => `QUILL_DENIED protected-path: ${p} is inside git's own files (.git: hooks, config, the git dir pointer), which later run with the owner's credentials, so a run cannot change them. Use git commands for repository changes and describe anything else in the result.`,
  protectedConfig: (p) => `QUILL_DENIED protected-path: ${p} is Claude Code or MCP configuration in the checkout (.claude/ or .mcp.json); changing it needs a full-access run or a manual edit by the owner. Describe the change in the result and continue with the rest of the task.`,
  protectedAncestor: (p, inner) => `QUILL_DENIED protected-path: ${p} contains ${inner}, which is protected, so a command that changes ${p} as a whole is not allowed. Name the files you mean explicitly instead of the directory.`,
  noEdit: (p) => `QUILL_DENIED no-edit-permission: this run may read ${p} but not change it; edit_source is not granted for this run. Write scratch files under the run directory or the temp directory, and describe the change you would make in the result.`,
  outsideWritable: (p, via) => `QUILL_DENIED outside-writable: ${p ?? 'this location'}${via && via !== p ? ` reaches ${via}, which` : ''} is outside what this run may change (the checkout when editing is granted, the run directory and the temp directory). Write there instead, or describe the change in the result.`,
  noCommit: () => 'QUILL_DENIED no-commit-permission: git commits need the commit permission, which this run does not have. Leave the changes uncommitted and describe them in the result.',
  noPush: () => 'QUILL_DENIED no-push-permission: git push needs the push_branch permission, which this run does not have. Leave the commits local and say in the result that they need pushing.',
  noPr: () => 'QUILL_DENIED no-pr-permission: creating or changing a pull request needs the open_draft_pr permission, which this run does not have. Put the title and description you would use in the result.',
  protectedBranch: (why) => `QUILL_DENIED protected-branch: ${why}. Pushing to the default or a protected branch, force and tag pushes, deleting branches, merging into a protected branch and non-draft pull requests are never allowed in a run; push the run's own branch or open a draft PR when granted, and leave the rest to the owner.`,
  noReadonly: (system) => `QUILL_DENIED no-readonly-credentials: no read-only credentials configured for ${system} — set them in quill doctor ([prod.readonly] in config.toml). This run has only empty ${system} credentials, so the command could not succeed. Use a connected tool for ${system} if one is available, and record this route in attempts as unavailable.`,
  unknownProd: (why) => `QUILL_DENIED unknown-prod: ${why}; the guard cannot tell what this changes, so it is not allowed. Use a read-only form, or record the change in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.`,
  critical: (change, pins, ambiguous) => `QUILL_CRITICAL_CHANGE scope=${change.scope} target=${change.target ?? 'unknown'}: not granted for this run${pins.length ? ` (it may perform only its approved action, run exactly as written, alone and without environment changes: ${pins.join(' | ')})` : ''}${ambiguous ? `; the granted scope does not cover this command (${ambiguous}): a covered write is one plain command run by its bare name, with a listed write verb and only listed options, naming its one target once` : ''}. ${CRITICAL_TAIL}`,
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
 *   criticalChange?: { scope: string, target: string|null, ambiguous?: true } }}  Observe mode (grant access `full`
 *   and QUILL_HANDOFF_GUARD=observe) allows everything and fills criticalChange for writes.
 *
 * Grant shapes read here: scopes `[{ name, target?, matchers: { mcp?, bash?, hosts? } }]`;
 * actionPins `[{ scope: 'name' | 'name:target', pin }]`, where a shell pin is the exact command
 * and an MCP pin is `<tool name> <JSON of the whole tool input>`.
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
    return result({ decision: 'allow', reason: `full access (observe only): ${classification.reason}`, criticalChange: effect ? observedChange(effect, c) : undefined });
  }
  return result(enforce(c, classification, parts, g, e, vars, home, ctx));
}

function enforce(c, cls, parts, g, e, vars, home, ctx) {
  const deny = (reason, criticalChange) => ({ decision: 'deny', reason, criticalChange });
  const tool = typeof c.tool_name === 'string' ? c.tool_name : '';
  const source = typeof c.mcp_server_source === 'string' ? c.mcp_server_source : '';
  if (tool.startsWith('mcp__') && source && !TRUSTED_MCP_SOURCES.has(source)) {
    const server = untrustedServer(tool, trustedServerNames(strings(g.trustedMcpServers)));
    if (server !== null) return deny(REASONS.untrustedMcp(server, source));
  }
  const bad = cls.class === 'unparseable' ? cls : parts.find((p) => p.class === 'unparseable');
  if (bad) {
    const climb = CLIMB_REASON_RE.exec(String(bad.reason));
    return deny(climb ? REASONS.climbs(climb[1]) : REASONS.unparseable(bad.reason));
  }
  const priv = parts.find((p) => p.class === 'privileged');
  if (priv) return deny(REASONS.privileged(priv.reason));

  const climbing = climbingPattern(tool, c.tool_input);
  if (climbing) return deny(REASONS.patternClimbs(climbing));
  // R18: a cd that would fail while later commands still run leaves them in the old directory
  for (const d of Array.isArray(cls.cdChecks) ? cls.cdChecks : []) {
    const real = typeof d === 'string' && path.isAbsolute(d) ? realOrNull(d) : null;
    let isDir = false;
    try { isDir = !!real && fs.statSync(real).isDirectory(); } catch { isDir = false; }
    if (!isDir) return deny(REASONS.cdMissing(d));
  }
  const perms = isPlainObject(g.permissions) ? g.permissions : {};
  const reads = readPathsOf(tool, c.tool_input, cls, ctx, home);
  const writes = writePathsOf(tool, cls);
  if (reads.length || writes.length) {
    const roots = rootsOf(g, e, vars, home, perms, writes.length > 0);
    for (const r of reads) {
      const why = readProblem(r, roots);
      if (why) return deny(why);
    }
    for (const w of writes) {
      const why = writeProblem(w, roots);
      if (why) return deny(why);
    }
  }

  for (const p of parts) {
    if (p.class !== 'write' || !String(p.scope ?? '').startsWith('git.')) continue;
    const why = gitProblem(p, perms, e);
    if (why) return deny(why);
  }
  const unknown = parts.find((p) => p.class === 'unknown-prod');
  if (unknown) return deny(REASONS.unknownProd(unknown.reason));
  // Spec §3 onboarding: a prod CLI read on a system the run holds no credentials for (its stub is
  // empty) is refused with the setup hint. `credentialSystems` lists the systems whose credentials
  // are not a stub; a grant without it (older grants) skips this check.
  if (Array.isArray(g.credentialSystems)) {
    const held = new Set(strings(g.credentialSystems));
    for (const p of parts) {
      if (p.class !== 'read' || !Array.isArray(p.argv) || typeof p.argv[0] !== 'string') continue;
      const system = PROD_CLI_SYSTEMS[binName(p.argv[0])];
      if (system && !held.has(system)) return deny(REASONS.noReadonly(system));
    }
  }

  let via = null;
  for (const p of parts) {
    if (!(p.class === 'external.write' || (p.class === 'write' && !String(p.scope ?? '').startsWith('git.')))) continue;
    const cover = coverOf(p, g, c, e);
    if (!cover.ok) return deny(REASONS.critical(changeOf(p), cover.pins, cover.why ?? null), changeOf(p));
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
  const fast = deepPath(resolved, hops);
  if (fast !== undefined) return fast;
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

// canonicalPath for a long path that does not exist: the deepest existing ancestor is found by
// bisection (a path below one that does not resolve does not resolve either), so a path with
// thousands of segments costs a dozen lookups rather than one per segment. The first missing
// segment is then checked as the walk from the leaf would: a dangling link is followed; anything
// else that unexpectedly exists sends the caller back to that walk (undefined).
function deepPath(resolved, hops) {
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  if (parts.length < 16) return undefined;
  const prefix = (k) => path.join(root, ...parts.slice(0, k));
  let lo = 0; // prefix(lo) resolves (the root)
  let hi = parts.length; // prefix(hi) does not
  let real = realOrNull(root);
  if (!real) return undefined;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const r = realOrNull(prefix(mid));
    if (r) { lo = mid; real = r; } else hi = mid;
  }
  const missing = prefix(lo + 1);
  const rest = parts.slice(lo + 1);
  const target = danglingTarget(missing);
  if (target !== null) {
    if (hops >= MAX_LINK_HOPS) return null;
    return canonicalPath(path.join(path.resolve(real, target), ...rest), hops + 1);
  }
  let st;
  try { st = fs.lstatSync(missing, { throwIfNoEntry: false }); } catch { st = null; }
  if (st !== undefined) return undefined;
  return path.join(real, ...parts.slice(lo));
}

// True when `child` is `root` or below it. Case-insensitive on Windows; `C:\repo-other` is not
// inside `C:\repo`. Both paths are expected in canonical form.
export function isWithin(child, root) {
  const c = WIN ? child.toLowerCase() : child;
  const r = WIN ? root.toLowerCase() : root;
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// The deepest root containing `p` (the most specific root decides), or null; deepest() gives its
// length, or -1.
function deepestRoot(roots, p) {
  let best = null;
  for (const r of roots) if ((best === null || r.length > best.length) && isWithin(p, r)) best = r;
  return best;
}
const deepest = (roots, p) => deepestRoot(roots, p)?.length ?? -1;

// Canonical forms of roots that exist, kept for the life of the process. The hook decides one
// call per process, so nothing can go stale there; an in-process caller re-resolves roots that did
// not exist yet. A run cannot swap an existing root for a link through guarded tools: every
// writable root holds a protected path (.git, the grant), so the ancestor rule refuses replacing
// it, and the other roots are not writable. Paths named by a call are never cached.
const rootCache = new Map();
function canonicalRoot(p) {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return null;
  const hit = rootCache.get(p);
  if (hit) return hit;
  const real = realOrNull(path.resolve(p));
  if (!real) return canonicalPath(p);
  if (rootCache.size < 256) rootCache.set(p, real);
  return real;
}

// What a run never reads, in canonical form: Claude's settings and the credential locations under
// home, and the Quill home (whose run dir and worktrees are readable as deeper roots).
function unreadableRoots(vars, home) {
  const base = canonicalRoot(home);
  const qh = canonicalRoot(quillHome({ QUILL_HOME: varOf(vars, 'QUILL_HOME') ?? path.join(home, '.claude', 'quill') }));
  return [...(base ? HOME_SECRETS.map((n) => path.join(base, n)) : []), ...(qh ? [qh] : [])];
}

/**
 * Whether decide's read rule lets `p` be read when `readableRoots` are the readable roots: the
 * deepest readable root containing it must be deeper than the deepest unreadable one (see
 * unreadableRoots). Links are resolved. Used by the guard's exception fallback (bin/quill-guard.js).
 * @param {string} p  an absolute path
 * @param {string[]} readableRoots  absolute roots
 * @param {object} vars  the hook's environment (HOME/USERPROFILE, QUILL_HOME)
 */
export function readableUnder(p, readableRoots, vars) {
  const v = isPlainObject(vars) ? vars : {};
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  const c = canonicalPath(p);
  if (!c) return false;
  const r = deepest(strings(readableRoots).map(canonicalRoot).filter(Boolean), c);
  return r >= 0 && deepest(unreadableRoots(v, homeOf(v)), c) < r;
}

// Every root in canonical form. Paths the worker or the owner chose (grant roots, home, Quill
// home, run dir, install root, temp) are resolved; fixed names below them (credential dirs, guard
// files, run-dir files) are joined onto the resolved base, which keeps one decision to a handful
// of filesystem lookups. The write-side roots are built only when the call writes. `canonical`
// resolves the call's own paths, memoised for this decision only.
function rootsOf(g, e, vars, home, perms, forWrites) {
  const canon = (list) => list.map(canonicalRoot).filter(Boolean);
  const memo = new Map();
  const canonical = (p) => {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return null;
    if (!memo.has(p)) memo.set(p, canonicalPath(p));
    return memo.get(p);
  };
  const under = (base, names) => (base ? names.map((n) => path.join(base, n)) : []);

  const qhEnv = { QUILL_HOME: varOf(vars, 'QUILL_HOME') ?? path.join(home, '.claude', 'quill') };
  const grantWritable = canon(strings(g.writableRoots));
  const unreadable = unreadableRoots(vars, home);
  const roots = { canonical, scan: scanState(), readable: [...canon(strings(g.readableRoots)), ...grantWritable], unreadable };
  if (!forWrites) return roots;

  let runDir = null;
  try { runDir = varOf(vars, 'QUILL_HANDOFF_ID') ? canonicalRoot(handoffRunDir(qhEnv, varOf(vars, 'QUILL_HANDOFF_ID'))) : null; } catch { runDir = null; }
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
      ...under(canonicalRoot(nonEmpty(e.installRoot) ?? INSTALL_ROOT), GUARD_CODE),
      ...under(runDir, RUN_DIR_FILES),
      ...canon([varOf(vars, 'CLAUDE_PLUGIN_ROOT')]),
      ...grantWritable.map((w) => path.join(w, '.git')),
      ...grantWritable.flatMap(linkedConfig),
    ],
  };
}

// Where a writable root's `.claude` and `.mcp.json` lead when they are links (R13b), so the
// configuration cannot be changed under the link target's name either. Kept for the life of the
// process like the root cache: a run cannot create, remove or relink these names, because the
// name rule protects them.
const linkedConfigCache = new Map();
function linkedConfig(w) {
  const hit = linkedConfigCache.get(w);
  if (hit) return hit;
  const out = [];
  for (const name of ['.claude', '.mcp.json']) {
    const p = path.join(w, name);
    let st;
    try { st = fs.lstatSync(p, { throwIfNoEntry: false }); } catch { st = undefined; }
    if (!st || !st.isSymbolicLink()) continue;
    const c = canonicalPath(p);
    if (c) out.push(c);
  }
  if (linkedConfigCache.size < 64) linkedConfigCache.set(w, out);
  return out;
}

// Wildcard characters per dialect (ruling R15; N3: cmd also treats `<`, `>` and `"` as DOS
// wildcards). Paths of unknown dialect use them all.
const WILDCARD = { bash: /[*?[\]{}]/, powershell: /[*?[\]{}`]/, cmd: /[*?[\]{}<>"]/ };
const ANY_WILDCARD = /[*?[\]{}`<>"]/;

// Checks everything an entry can reach, as canonical paths, with `check(c, wildcard)` (a deny
// reason or null); returns the first reason, or null. A file tool's path is literal. A shell path
// comes with its spec from the classifier: `root`, a literal absolute directory (the hook's cwd for
// a relative word), and `segs`, the text the call supplied, `..` uncollapsed. The walk follows the
// segments one by one:
//  - `..` takes the parent of each directory reached, after its links were resolved, as the shell
//    does (P1); the classifier's lexically resolved path is checked as well, as PowerShell, cmd and
//    the file tools resolve it;
//  - a wildcard segment (ruling R15) is over-approximated, not evaluated, so no glob dialect needs
//    emulating: it matches EVERY entry of each directory reached so far (one containing `**`,
//    every entry at any depth, links included); every entry is resolved and checked like the path
//    itself, and directories go on to the next segment;
//  - a directory that cannot be listed refuses the call: an empty listing is not a pass;
//  - one budget of MAX_GLOB_MATCHES visited entries serves the whole call (N2), and listings,
//    realpaths and directory checks are memoised for the call.
// Entries are checked as they are reached, so a refused wildcard stops at its first bad entry.
function reach(entry, roots, check) {
  if (typeof entry.p !== 'string' || !path.isAbsolute(entry.p)) return check(null, false);
  if (entry.literal || !entry.spec) return check(roots.canonical(entry.p), false);
  const { root, segs, dialect, ifDir } = entry.spec;
  const wildRe = WILDCARD[dialect] ?? ANY_WILDCARD;
  const wild = (s) => wildRe.test(s);
  const hasWild = segs.some(wild);
  const lexical = check(roots.canonical(entry.p), hasWild);
  if (lexical || (!hasWild && !segs.includes('..'))) return lexical;
  // Each frontier entry is a directory (`base`, real when `real`) plus literal segments not looked
  // up yet: a run of literal segments costs nothing until a `..`, a wildcard or the end needs the
  // real directory, so the walk is linear in the segments (R17.1).
  const at = (f) => (f.tail.length ? path.join(f.base, ...f.tail) : f.base);
  let frontier = [{ base: root, tail: [], real: false }];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg === '..') {
      // the classifier refuses `..` after a name within one path word (R17.1), so a `..` here
      // starts a word: the shell takes the parent of the directory it is really in
      const next = [];
      for (const f of frontier) {
        if (f.real && !f.tail.length) { next.push({ base: path.dirname(f.base), tail: [], real: true }); continue; }
        const up = roots.scan.parentOf(at(f), i === ifDir, roots.canonical);
        if (up === MOOT) continue;
        if (up === null) return REASONS.climbFrom(entry.p, at(f));
        next.push({ base: up, tail: [], real: true });
      }
      frontier = next;
      continue;
    }
    if (!wild(seg)) {
      for (const f of frontier) f.tail.push(seg);
      continue;
    }
    const dirs = frontier.map((f) => (f.real && !f.tail.length ? f.base : roots.canonical(at(f))));
    if (dirs.includes(null)) return check(null, hasWild);
    const deep = seg.includes('**');
    const next = deep ? [...dirs] : [];
    const stack = [...dirs];
    const seen = new Set(dirs);
    while (stack.length) {
      const dir = stack.pop();
      const entries = roots.scan.list(dir);
      if (entries === null) return REASONS.unlisted(entry.p, dir);
      for (const ent of entries) {
        if ((roots.scan.visited += 1) > MAX_GLOB_MATCHES) return REASONS.tooBroad(entry.p);
        const full = path.join(dir, ent.name);
        const link = ent.isSymbolicLink();
        const real = link ? roots.canonical(full) : full;
        const why = check(real, true);
        if (why) return why;
        if (!(link ? roots.scan.isDirectory(real) : ent.isDirectory())) continue;
        next.push(real);
        if (deep && !seen.has(real)) { seen.add(real); stack.push(real); }
      }
    }
    frontier = next.map((d) => ({ base: d, tail: [], real: true }));
  }
  for (const f of frontier) {
    const why = check(f.real && !f.tail.length ? f.base : roots.canonical(at(f)), hasWild);
    if (why) return why;
  }
  return null;
}

// A `..` from a symbolic link's own path (spec `ifDir`) when that path is not an existing
// directory: the link is not made there, so that reading of its target does not apply.
const MOOT = Symbol('moot');

// Per-call state for walking wildcards: the shared visit budget and memoised listings (read with
// opendir, so a huge directory stops at the budget), directory checks, and the real parents `..`
// leads to.
function scanState() {
  const listings = new Map();
  const dirs = new Map();
  const parents = new Map();
  return {
    visited: 0,
    // Where `..` from `d` leads: the parent of the real directory `d` names, or null when `d` is
    // not an existing directory (a `cd` into it failed, so the shell is somewhere the guard cannot
    // tell). With `linkSlot` (`d` is where `ln -s` may put its link): a missing `d` is a directory
    // the command creates first, an existing non-directory is MOOT.
    parentOf(d, linkSlot, canonical) {
      const key = `${linkSlot ? 1 : 0}${d}`;
      if (parents.has(key)) return parents.get(key);
      let up = null;
      const real = realOrNull(d);
      if (real && this.isDirectory(real)) up = path.dirname(real);
      else if (linkSlot) {
        let st;
        try { st = fs.lstatSync(d, { throwIfNoEntry: false }); } catch { st = null; }
        if (st === undefined) { const c = canonical(d); up = c ? path.dirname(c) : null; } else if (st) up = MOOT;
      }
      parents.set(key, up);
      return up;
    },
    list(dir) {
      if (listings.has(dir)) return listings.get(dir);
      let entries = null;
      try {
        const d = fs.opendirSync(dir);
        try {
          entries = [];
          for (let ent = d.readSync(); ent !== null && entries.length <= MAX_GLOB_MATCHES; ent = d.readSync()) entries.push(ent);
        } finally {
          d.closeSync();
        }
      } catch {
        entries = null;
      }
      listings.set(dir, entries);
      return entries;
    },
    isDirectory(p) {
      if (!dirs.has(p)) {
        let yes = false;
        try { yes = fs.statSync(p).isDirectory(); } catch { yes = false; }
        dirs.set(p, yes);
      }
      return dirs.get(p);
    },
  };
}

function readProblem(entry, roots) {
  return reach(entry, roots, (c, wildcard) => {
    const r = c ? deepest(roots.readable, c) : -1;
    if (r >= 0 && deepest(roots.unreadable, c) < r) return null;
    return wildcard ? REASONS.wildcardReach(entry.p, c, 'read') : REASONS.outsideReadable(entry.p, c);
  });
}

// Null when the write may go ahead, else the deny reason. The most specific root decides, and a
// protected root wins a tie with a writable one.
function writeProblem(entry, roots) {
  // R13b: names are checked on the path as written too, before links are resolved
  if (typeof entry.p === 'string' && path.isAbsolute(entry.p)) {
    const why = namedProblem(entry.p, path.resolve(entry.p), roots);
    if (why) return why;
  }
  return reach(entry, roots, (c, wildcard) => {
    const why = writeProblemAt(entry.p, c, roots);
    return why && wildcard ? REASONS.wildcardReach(entry.p, c, 'change') : why;
  });
}

function namedProblem(p, c, roots) {
  const base = deepestRoot(roots.readable, c);
  const named = base ? protectedName(c, base) : null;
  if (named === 'git') return REASONS.protectedGit(p);
  if (named === 'config') return REASONS.protectedConfig(p);
  return null;
}

function writeProblemAt(p, c, roots) {
  if (!c) return REASONS.outsideWritable(p);
  const named = namedProblem(p, c, roots);
  if (named) return named;
  const w = deepest(roots.writable, c);
  const prot = deepest(roots.protected, c);
  if (w >= 0 && w > prot) {
    // deleting, moving or replacing a directory that holds a protected path changes it too
    const inner = roots.protected.find((q) => q.length > c.length && isWithin(q, c));
    return inner ? REASONS.protectedAncestor(p, inner) : null;
  }
  // Somewhere the run may read but not change (its checkout without edit_source, even though the
  // worker keeps checkouts under the protected Quill home): the missing permission is the reason.
  if (!roots.canEdit && deepest(roots.readable, c) > prot) return REASONS.noEdit(p);
  return prot >= 0 ? REASONS.protectedPath(p, c) : REASONS.outsideWritable(p, c);
}

// Names that are protected below a run's checkout (and any other root): git's own files, whose
// hooks and config later run with the owner's credentials and whose `.git` file can redirect the
// git dir, and Claude Code / MCP configuration (ruling R13: `.claude/**`, `.mcp.json`). Compared
// below the containing root, so a Quill home under ~/.claude does not make every run path match.
function protectedName(c, base) {
  const rel = path.relative(base, c);
  if (!rel) return null;
  const segs = rel.split(/[\\/]+/).map((s) => (NAMES_FOLD_CASE ? s.toLowerCase() : s));
  if (segs.includes('.git')) return 'git';
  if (segs.includes('.claude') || segs.includes('.mcp.json')) return 'config';
  return null;
}

// Each entry is { p, literal: true } for a file tool's path, never scanned for wildcards, or
// { p, spec } for a shell path (see reach).
function readPathsOf(tool, input, cls, ctx, home) {
  const out = [];
  if (READ_TOOLS.has(tool)) out.push({ p: cls.path ?? null, literal: true });
  out.push(...shellEntries(cls.readPaths, cls.readSpecs));
  for (const pattern of patternsOf(tool, input)) {
    const base = patternBase(pattern, cls.path ?? ctx.cwd, home);
    if (base !== undefined) out.push({ p: base, literal: true });
  }
  return out;
}

function writePathsOf(tool, cls) {
  const out = [];
  if (WRITE_TOOLS.has(tool)) out.push({ p: cls.path ?? null, literal: true });
  out.push(...shellEntries(cls.paths, cls.writeSpecs));
  return out;
}

// The classifier's specs, plus any resolved path that came without one, scanned from its root
// in every dialect's wildcard set.
function shellEntries(paths, specs) {
  const out = [];
  const covered = new Set();
  for (const s of Array.isArray(specs) ? specs : []) {
    if (!isPlainObject(s) || typeof s.path !== 'string' || typeof s.root !== 'string' || !Array.isArray(s.segs)) continue;
    out.push({ p: s.path, spec: s });
    covered.add(s.path);
  }
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || covered.has(p) || !path.isAbsolute(p)) continue;
    const { root } = path.parse(path.resolve(p));
    out.push({ p, spec: { root, segs: path.resolve(p).slice(root.length).split(/[\\/]+/).filter(Boolean), dialect: null } });
  }
  return out;
}

// Glob's `pattern` and Grep's `glob` name paths relative to the search directory.
function patternsOf(tool, input) {
  if (!isPlainObject(input)) return [];
  const p = tool === 'Glob' ? input.pattern : tool === 'Grep' ? input.glob : undefined;
  return typeof p === 'string' && p ? [p] : [];
}

// A `..` after the first wildcard or brace makes the searched directories unknowable (M1).
function climbingPattern(tool, input) {
  for (const pattern of patternsOf(tool, input)) {
    const i = pattern.search(/[*?[{]/);
    if (i >= 0 && /(^|[\\/{,])\.\.([\\/},]|$)/.test(pattern.slice(i))) return pattern;
  }
  return null;
}

// An absolute, `~` or `..` pattern searches somewhere other than its path: its literal prefix
// must be readable too. Undefined when the pattern stays below its search path.
function patternBase(pattern, searchDir, home) {
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

// ------------------------------------------------------------------ MCP servers

// Server names as they appear in tool names. A configured name with other characters is folded
// (each becomes `_`, as Claude Code spells tool names) only when no other configured name has
// the same tool-name spelling.
function trustedServerNames(entries) {
  const forms = entries.map((e) => (TOOL_NAME_SAFE.test(e) ? { name: e, exact: true } : { name: e.replace(/[^A-Za-z0-9_-]/g, '_'), exact: false }));
  const count = new Map();
  for (const f of forms) count.set(f.name, (count.get(f.name) ?? 0) + 1);
  return new Set(forms.filter((f) => f.exact || count.get(f.name) === 1).map((f) => f.name));
}

// `mcp__<server>__<tool>` can be split wherever `__` occurs; every reading must name a trusted
// server. Returns the first untrusted server name, or null when all are trusted.
function untrustedServer(tool, trusted) {
  const body = tool.slice('mcp__'.length);
  const servers = [];
  for (let i = body.indexOf('__'); i >= 0; i = body.indexOf('__', i + 1)) if (i > 0 && i + 2 < body.length) servers.push(body.slice(0, i));
  if (!servers.length) return body;
  return servers.find((s) => !trusted.has(s)) ?? null;
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
// Observe mode (review N2): a shell write that the built-in allow-list could not cover with the
// target it names is recorded with no target and `ambiguous: true`, never with the first-named one.
function observedChange(p, c) {
  const change = changeOf(p);
  const dialect = SHELLS[c.tool_name];
  if (!dialect || String(change.scope).startsWith('git.')) return change;
  const command = isPlainObject(c.tool_input) && typeof c.tool_input.command === 'string' ? c.tool_input.command : '';
  const commands = BUILTIN_COMMANDS[change.scope];
  if (!commands) return change;
  const plain = !commandProblem(command, dialect === 'bash' ? 'bash' : 'powershell', { commands, target: change.target, scope: change.scope });
  return plain ? change : { scope: change.scope, target: null, ambiguous: true };
}
const scopeName = (s) => (s.includes(':') ? s.slice(0, s.indexOf(':')) : s);
const scopeTarget = (s) => (s.includes(':') ? s.slice(s.indexOf(':') + 1) : undefined);
const isMcp = (c) => typeof c.tool_name === 'string' && c.tool_name.startsWith('mcp__');

function sameTarget(want, p) {
  const got = targetOf(p);
  if (typeof got !== 'string') return false;
  // Hosts compare without case or a trailing root dot (R25).
  const host = (h) => String(h).toLowerCase().replace(/\.$/, '');
  return p.class === 'external.write' ? host(got) === host(want) : got === String(want);
}

// A scope with action pins allows only its pinned actions (§7.5); otherwise a granted scope
// covers the write when its name and target match and one of its matchers fits the call.
function coverOf(p, g, c, e = {}) {
  const pins = (Array.isArray(g.actionPins) ? g.actionPins : [])
    .filter((a) => isPlainObject(a) && typeof a.scope === 'string' && typeof a.pin === 'string' && scopeName(a.scope) === p.scope);
  if (pins.length) return pins.some((a) => pinMatches(a, p, c)) ? { ok: true, via: 'the approved action pin' } : { ok: false, pins: pins.map((a) => a.pin.trim()) };
  let why = null;
  const scope = (Array.isArray(g.scopes) ? g.scopes : []).find((s) => {
    const r = scopeCovers(s, p, c, g, e);
    if (r !== true && typeof r === 'string') why = why ?? r;
    return r === true;
  });
  return scope ? { ok: true, via: `scope ${scope.name}${scope.target ? `:${scope.target}` : ''}` } : { ok: false, pins: [], why };
}

// A pin authorises exactly its action. A shell pin matches only a call that is that one command:
// same words and redirects (quoting and spacing aside), no chain, pipe or environment assignment,
// and no wrapper (`env`, `sudo`, `bash -c` …) around it, which the call's first word shows. An MCP
// pin matches only the same tool with the same whole input (canonical JSON).
function pinMatches(a, p, c) {
  const target = scopeTarget(a.scope);
  if (target !== undefined && !sameTarget(target, p)) return false;
  const pin = a.pin.trim();
  const dialect = SHELLS[c.tool_name];
  if (dialect) {
    const command = isPlainObject(c.tool_input) && typeof c.tool_input.command === 'string' ? c.tool_input.command : null;
    if (command === null || firstWord(command) !== firstWord(pin)) return false;
    const want = soleCommand(pin, dialect);
    const got = soleCommand(command, dialect);
    return !!want && !!got && JSON.stringify(want) === JSON.stringify(got);
  }
  if (isMcp(c)) {
    const space = pin.search(/\s/);
    if (space < 0 || pin.slice(0, space) !== c.tool_name) return false;
    let want;
    try { want = JSON.parse(pin.slice(space + 1)); } catch { return false; }
    return isPlainObject(want) && canonicalJson(want) === canonicalJson(isPlainObject(c.tool_input) ? c.tool_input : {});
  }
  return false;
}

const firstWord = (text) => text.trim().split(/\s+/, 1)[0];

// The one plain command a text holds, or null: exactly one segment, literal words, no environment.
function soleCommand(text, dialect) {
  const parsed = parseShell(text.trim(), dialect);
  if (parsed.error || parsed.segments.length !== 1) return null;
  const s = parsed.segments[0];
  if (s.unparseable || !s.argv.length || s.piped || s.nested || s.stdinDyn) return null;
  if (Object.keys(s.env ?? {}).length || (s.kinds ?? []).some((k) => k !== 'lit')) return null;
  return { argv: s.argv, redirects: (s.redirects ?? []).map((r) => [r.op, r.target]), stdin: s.stdin ?? null };
}

// Command patterns match the part's own words (I3); a `hosts` pattern covers an external write
// to that host when the scope's name is the classifier's scope for it (M4). Ruling R25: a shell
// call is covered only when the whole call passes the scope's command allow-list
// (scope-commands.js; a grant without `matchers.commands` uses the built-in lists) and the agent's
// working directory is inside the run's checkout. Returns true, false, or why a granted scope of
// this name does not cover the call.
function scopeCovers(s, p, c, g = {}, e = {}) {
  if (!isPlainObject(s) || s.name !== p.scope) return false;
  if (s.target !== undefined && s.target !== null && s.target !== '' && !sameTarget(s.target, p)) return false;
  const m = isPlainObject(s.matchers) ? s.matchers : {};
  if (isMcp(c)) return strings(m.mcp).some((pat) => globMatch(pat, c.tool_name));
  const dialect = SHELLS[c.tool_name];
  if (!dialect) return false;
  const command = isPlainObject(c.tool_input) && typeof c.tool_input.command === 'string' ? c.tool_input.command : '';
  const commands = isPlainObject(m.commands) ? m.commands : BUILTIN_COMMANDS[s.name] ?? {};
  const check = commandCheck(command, dialect === 'bash' ? 'bash' : 'powershell', { commands, target: typeof s.target === 'string' && s.target ? s.target : null, scope: s.name });
  if (check.why) return check.why;
  const root = typeof g.checkoutRoot === 'string' && g.checkoutRoot ? g.checkoutRoot : strings(g.readableRoots)[0];
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : null;
  if (!root || !cwd || !isWithin(path.resolve(cwd), path.resolve(root))) return 'the command does not run inside the run\'s checkout';
  // R26.2: every file the request reads through an option value is inside the checkout or this
  // run's directory (links resolved); a readable root elsewhere is not enough.
  const vars = isPlainObject(e.vars) ? e.vars : {};
  const home = homeOf(vars);
  let runDir = null;
  try { const id = varOf(vars, 'QUILL_HANDOFF_ID'); runDir = id ? handoffRunDir({ QUILL_HOME: varOf(vars, 'QUILL_HOME') ?? path.join(home, '.claude', 'quill') }, id) : null; } catch { runDir = null; }
  const inside = [root, runDir].filter(Boolean).map((r) => canonicalRoot(path.resolve(r))).filter(Boolean);
  for (const f of check.files) {
    const expanded = f === '~' || /^~[\\/]/.test(f) ? path.join(home, f.slice(1)) : f;
    const real = realOrNull(path.resolve(cwd, expanded));
    if (!real) return `the file ${f.slice(0, 80)} does not exist, so the guard cannot tell where it is`;
    if (!inside.some((r) => isWithin(real, r))) return `${f.slice(0, 80)} is outside the run's checkout and run directory`;
  }
  // R26.4: an image push names its registry; it must be one of the scope's hosts.
  for (const h of check.hosts) if (!strings(m.hosts).some((pat) => globMatch(pat.toLowerCase(), h))) return `the registry ${h.slice(0, 80)} is not one of this scope's hosts`;
  if (Array.isArray(p.argv) && p.argv.length && strings(m.bash).some((pat) => globMatch(pat, p.argv.join(' ')))) return true;
  return p.class === 'external.write' && typeof p.host === 'string' && strings(m.hosts).some((h) => globMatch(h.toLowerCase(), p.host.toLowerCase().replace(/\.$/, '')));
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
