// Interrupted runs and batch spend (spec §5.2, §5.4; Task 19).
//
// A run cut off by a worker restart (or stop) keeps its recorded session id and its partial tool
// ledger. It can be resumed as a NEW run: `retry_of` names the interrupted one, `--resume` continues
// its Claude Code session, and the new run is granted exactly what the original was (same access,
// permissions, scopes and, for an approved critical change, the same action pins and scope
// fingerprints, checked again at dispatch). Never more.
//
// Writes the original run's ledger shows the guard allowed become uncertain effects ("kubectl
// apply on stg may have run"): the worker never saw the run finish, so it claims neither that they
// ran nor that they did not.
//
// A bulk batch (ADR 0023) stops starting new members once its recorded spend reaches
// `[handoff] max_batch_budget_usd` (default 30): members already running carry on, the rest stay
// queued until the owner cancels them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrackerError } from '../lib/errors.js';
import { isUnder } from './worktree.js';
import { pinAction } from './action-pin.js';
import { BUDGET_DEFAULTS } from './runner.js';

export const MAX_INTERRUPTED_EFFECTS = 50;
const TERMINAL = new Set(['done', 'failed', 'timed-out', 'cancelled']);
const WRITE_CLASSES = new Set(['write', 'external.write']);
// A local commit changes only the run's checkout; every other write reaches something outside it.
const LOCAL_SCOPES = new Set(['git.commit']);
const SHELLS = new Set(['Bash', 'PowerShell', 'Monitor']);
// What `--resume` may be handed, and what names the session's transcript file: a UUID, as Claude
// Code reports session ids, and nothing else (no option, no path, no NTFS stream name).
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code names a project folder after the working directory, every character outside
// [A-Za-z0-9] as "-"; a name longer than this is cut and given a hash suffix Quill cannot compute.
export const PROJECT_NAME_MAX = 200;
export const SESSION_MISSING = 'session not found - retry as a new run';
const PLAIN_WORD_RE = /^[a-z][a-z0-9-]{0,40}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** `[handoff] max_batch_budget_usd`: a positive number, else the default (30). */
export function batchBudgetUsd(config = {}) {
  const v = config && isPlainObject(config.handoff) ? config.handoff.max_batch_budget_usd : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : BUDGET_DEFAULTS.max_batch_budget_usd;
}

/**
 * The recorded spend of a batch, in USD: the cost each finished member recorded (an estimate under
 * a subscription counts as recorded). Running and queued members have recorded nothing yet.
 */
export function batchSpend(handoffs, batchId) {
  if (typeof batchId !== 'string' || !batchId) return 0;
  let sum = 0;
  for (const h of handoffs ?? []) {
    if (!h || h.batch_id !== batchId || !TERMINAL.has(h.state)) continue;
    if (typeof h.cost_usd === 'number' && Number.isFinite(h.cost_usd) && h.cost_usd > 0) sum += h.cost_usd;
  }
  return Math.round(sum * 10000) / 10000;
}

/** Whether a batch's recorded spend has reached its budget. */
export function batchBudgetReached(handoffs, batchId, budgetUsd) {
  return typeof batchId === 'string' && !!batchId && batchSpend(handoffs, batchId) >= budgetUsd;
}

// "kubectl apply", "git push", "mcp__atlassian__editJiraIssue": the call as one short label, from
// the ledger's redacted summary. A call that is not one plain command is named by its scope.
function callLabel(line) {
  const tool = typeof line.tool_name === 'string' ? line.tool_name : typeof line.tool === 'string' ? line.tool : '';
  if (tool.startsWith('mcp__')) return text(tool, 200);
  if (SHELLS.has(tool)) {
    let pin = null;
    try { pin = pinAction({ tool, action: typeof line.input_summary === 'string' ? line.input_summary : '' }); } catch { pin = null; }
    if (pin && pin.kind === 'bash' && pin.binary) {
      if (pin.verb) return text(`${pin.binary} ${pin.verb}`, 120);
      const first = pin.exact && Array.isArray(pin.values) ? pin.values[0] : null;
      return text(typeof first === 'string' && PLAIN_WORD_RE.test(first) ? `${pin.binary} ${first}` : pin.binary, 120);
    }
  }
  const scope = text(line.scope, 80);
  return scope ? `a ${scope} call` : tool ? text(tool, 80) : 'a write';
}

/**
 * The uncertain effects of an interrupted run: each write its ledger shows the guard allowed (a
 * scoped write, an MCP write, a push; never a refused call or a local commit), as "<call> on
 * <target> may have run". Duplicates once, capped at MAX_INTERRUPTED_EFFECTS.
 * @param {object[]} lines  readLedger() output
 * @returns {string[]}
 */
export function interruptedEffects(lines = []) {
  const out = [];
  const seen = new Set();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!isPlainObject(l) || l.kind !== 'guard' || l.decision !== 'allow' || !WRITE_CLASSES.has(l.class)) continue;
    if (typeof l.scope === 'string' && LOCAL_SCOPES.has(l.scope)) continue;
    const target = l.ambiguous === true ? '' : text(l.target, 120);
    const effect = `${callLabel(l)}${target ? ` on ${target}` : ''} may have run`;
    if (seen.has(effect)) continue;
    seen.add(effect);
    out.push(effect);
    if (out.length >= MAX_INTERRUPTED_EFFECTS) break;
  }
  return out;
}

/** Why a run cannot be resumed ({ code, message }), or null when it can. */
export function resumeProblem(h) {
  if (!h || h.state !== 'failed' || !h.error || h.error.code !== 'interrupted') return { code: 'run-not-resumable', message: 'only a run interrupted by a worker restart or stop can be resumed; retry it as a new run instead' };
  if (typeof h.session_id !== 'string' || !SESSION_ID_RE.test(h.session_id)) return { code: 'no-session', message: 'this run was interrupted before Claude Code reported a session, so there is nothing to resume; retry it as a new run instead' };
  return null;
}

const refuse = (message) => { throw new TrackerError('resume-refused', message); };
const specOf = (s) => (typeof s === 'string' ? s : '');

/**
 * What a resumed run copies from the run it resumes: the same mode, note, permissions, access,
 * branch, recipe, scopes and limits; for an approved critical change (ADR 0028) also the action pin
 * of every scope, the fingerprints dispatch checks again, and the proposal it came from. Never a
 * batch id. Throws `resume-refused` when a critical run's pins or fingerprints do not cover every
 * one of its scopes: a scope grant is never resumed without its pin.
 */
export function resumeFields(h) {
  const scopes = Array.isArray(h.scopes) ? h.scopes.map(specOf).filter(Boolean) : [];
  const fromRun = !!(isPlainObject(h.proposal) && h.proposal.origin === 'run');
  const critical = fromRun || (typeof h.origin_proposal_id === 'string' && h.origin_proposal_id !== '') || (Array.isArray(h.action_pins) && h.action_pins.length > 0);
  const out = {
    mode: h.mode, note: h.note ?? '', permissions: { ...(h.permissions ?? {}) }, access: h.access ?? 'standard', branch: h.branch ?? null,
    recipe: h.recipe ? { ...h.recipe } : null, legacy: h.legacy, outputs: Array.isArray(h.outputs) ? [...h.outputs] : h.outputs,
    ...(scopes.length ? { scopes } : {}),
    ...(h.max_turns !== undefined ? { max_turns: h.max_turns } : {}),
    ...(h.max_budget_usd !== undefined ? { max_budget_usd: h.max_budget_usd } : {}),
    ...(Array.isArray(h.planned_paths) && h.planned_paths.length ? { planned_paths: [...h.planned_paths] } : {}),
    ...(h.proposal_id ? { proposal_id: h.proposal_id } : {}),
    ...(isPlainObject(h.proposal) ? { proposal: { ...h.proposal } } : {}),
  };
  if (!critical) {
    if (!scopes.length) return out;
    // A scoped run is resumed only with the scopes exactly as its grant was frozen (dispatch checks
    // the fingerprints again); one that recorded none cannot show that, so it is not resumed.
    const prints = isPlainObject(h.scope_fingerprints) ? h.scope_fingerprints : null;
    if (!prints || scopes.some((s) => typeof prints[s] !== 'string' || !prints[s])) refuse('this run\'s write scopes were not recorded as granted, so it cannot be resumed with exactly those scopes; queue a new run instead');
    return { ...out, scope_fingerprints: Object.fromEntries(scopes.map((s) => [s, prints[s]])) };
  }
  if (!fromRun || typeof h.origin_proposal_id !== 'string' || !h.origin_proposal_id) refuse('this run carries action pins but is not an approved critical change; it cannot be resumed');
  const pins = Array.isArray(h.action_pins) ? h.action_pins.filter((a) => isPlainObject(a) && typeof a.scope === 'string' && typeof a.pin === 'string' && a.pin.trim()) : [];
  const prints = isPlainObject(h.scope_fingerprints) ? h.scope_fingerprints : null;
  if (!scopes.length || !prints) refuse('this critical change run has no recorded scope or fingerprint, so it cannot be resumed with the scope exactly as approved');
  for (const s of scopes) {
    if (!pins.some((a) => a.scope === s)) refuse(`scope ${s} of this critical change run has no pinned action; a scope is never granted again without its pin`);
    if (typeof prints[s] !== 'string' || !prints[s]) refuse(`scope ${s} of this critical change run has no recorded fingerprint; it cannot be resumed`);
  }
  if (pins.some((a) => !scopes.includes(a.scope)) || Object.keys(prints).some((s) => !scopes.includes(s))) refuse('the pins or fingerprints of this critical change run name a scope it was not granted; it cannot be resumed');
  return { ...out, action_pins: pins.map((a) => ({ scope: a.scope, pin: a.pin })), scope_fingerprints: { ...prints }, origin_proposal_id: h.origin_proposal_id };
}

/**
 * The prompt of a resumed run's first turn. The session already holds the original task; this says
 * what changed and that nothing earlier may be assumed done or repeated blindly.
 */
export function resumePrompt({ contextDir = null, checkout = false } = {}) {
  return [
    'The Quill worker stopped while you were working on this task, so your previous turn was interrupted. This is a new run resuming your session.',
    'Tool calls you made before the interruption may or may not have completed. Check the current state before repeating any change, and never repeat a write to a production system or an external service without first checking whether it already happened.',
    checkout ? 'Your working directory is a fresh checkout of the same base: file changes you made in the interrupted run are not in it.' : null,
    contextDir ? `Your run directory changed. The memory snapshot to read is now ${contextDir}.` : null,
    'The same access, permissions and limits apply as before. Finish the task, then end with the final fenced JSON block exactly as the original instructions ask.',
  ].filter(Boolean).join('\n\n');
}

/** Claude Code's config root as a child with environment `env` sees it (CLAUDE_CONFIG_DIR, else the home's .claude). */
export function claudeConfigRoot(env = {}, platform = process.platform) {
  const get = (name) => {
    const k = Object.keys(env).find((x) => (platform === 'win32' ? x.toUpperCase() === name : x === name));
    const v = k === undefined ? undefined : env[k];
    return typeof v === 'string' && v ? v : null;
  };
  const dir = get('CLAUDE_CONFIG_DIR');
  if (dir) return path.resolve(dir);
  const home = platform === 'win32' ? get('USERPROFILE') ?? get('HOME') : get('HOME') ?? get('USERPROFILE');
  return path.join(home ?? os.homedir(), '.claude');
}

/** The project folder name Claude Code keeps a working directory's sessions under. */
export function projectDirName(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Links are never followed (R54): a project folder or transcript whose lstat reports a symbolic link
// (Windows junctions included) is refused, and what is used must really be inside the real
// projects folder: a folder is a direct child of it, a file a direct child of such a folder.
const lstatOf = (f) => { try { return fs.lstatSync(f); } catch { return null; } };
const realOf = (f) => { try { return fs.realpathSync.native(f); } catch { return null; } };
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The real path of project folder `dir` when it is a plain folder directly inside `realRoot`, else null.
function plainProjectDir(realRoot, dir) {
  const st = lstatOf(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  const real = realOf(dir);
  return real && samePath(path.dirname(real), realRoot) ? real : null;
}

// The real path of transcript `name` in the plain project folder `realDir` when it is a plain file, else null.
function plainTranscript(realDir, name) {
  const f = path.join(realDir, name);
  const st = lstatOf(f);
  if (!st || st.isSymbolicLink() || !st.isFile()) return null;
  const real = realOf(f);
  return real && samePath(path.dirname(real), realDir) ? real : null;
}

// The project folder names a child started in `cwd` may use: the cwd as the worker passed it (what
// a Windows child reports, 8.3 short names such as RUNNER~1 kept) and its real path (what getcwd
// reports on macOS and Linux: /private/var for /var).
function cwdNames(cwd) {
  const real = realOf(cwd);
  return [...new Set([projectDirName(cwd), ...(real ? [projectDirName(real)] : [])])];
}

// The interrupted session's transcript: under the original working directory's project folder
// (the one Claude Code last wrote, when both spellings hold one: the other is an earlier copy),
// else (a long name Claude Code shortened) the one plain project folder that holds it.
function sessionSource(realRoot, fromCwd, file) {
  if (fromCwd) {
    const direct = cwdNames(fromCwd)
      .map((name) => (name.length <= PROJECT_NAME_MAX ? plainProjectDir(realRoot, path.join(realRoot, name)) : null))
      .map((dir) => (dir ? plainTranscript(dir, file) : null))
      .filter(Boolean)
      .map((f) => ({ f, st: lstatOf(f) }))
      .sort((a, b) => (b.st?.mtimeMs ?? 0) - (a.st?.mtimeMs ?? 0) || (b.st?.size ?? 0) - (a.st?.size ?? 0));
    if (direct.length) return direct[0].f;
  }
  let entries = [];
  try { entries = fs.readdirSync(realRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()); } catch { entries = []; }
  const found = entries.map((d) => plainProjectDir(realRoot, path.join(realRoot, d.name))).filter(Boolean).map((dir) => plainTranscript(dir, file)).filter(Boolean);
  return found.length === 1 ? found[0] : null;
}

/**
 * Makes an interrupted run's Claude Code session reachable from the resumed run's working directory
 * (ruling R54): the transcript `<projects>/<old cwd>/<id>.jsonl` is COPIED, never moved, to the
 * project folder of the new cwd (and of its real path, when that differs). Never follows a link,
 * never writes outside `<configRoot>/projects`, never replaces a different transcript.
 * Throws `no-session` (not a UUID), `resume-session-missing` (SESSION_MISSING),
 * `resume-session-unreachable` (a folder name Claude Code would shorten) or
 * `resume-session-conflict`.
 * @returns {string[]} the transcript paths the resumed run will find
 */
export function carrySession({ configRoot, sessionId, fromCwd = null, toCwd }) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new TrackerError('no-session', 'the recorded session id is not a Claude Code session id, so it cannot be resumed; retry as a new run');
  const file = `${sessionId}.jsonl`;
  // Containment is judged on real paths: the projects folder as it really is on disk.
  const realRoot = realOf(path.join(path.resolve(configRoot), 'projects'));
  const source = realRoot ? sessionSource(realRoot, fromCwd, file) : null;
  if (!source) throw new TrackerError('resume-session-missing', SESSION_MISSING);
  // The child is started in `toCwd`: its folder name is one of these spellings, so both get the copy.
  const names = cwdNames(toCwd);
  const bytes = fs.readFileSync(source);
  const out = [];
  for (const name of names) {
    if (name.length > PROJECT_NAME_MAX) throw new TrackerError('resume-session-unreachable', "the resumed run's working directory has a path too long for Claude Code to find the session under; retry as a new run");
    const unreachable = () => new TrackerError('resume-session-unreachable', 'the session cannot be placed in a plain folder under the Claude Code projects folder (a link is never followed); retry as a new run');
    const wanted = path.join(realRoot, name);
    if (!isUnder(realRoot, wanted)) throw unreachable();
    // Created only directly under the real projects folder, then checked again as it really is.
    if (!lstatOf(wanted)) { try { fs.mkdirSync(wanted); } catch (err) { if (err.code !== 'EEXIST') throw err; } }
    const dir = plainProjectDir(realRoot, wanted);
    if (!dir) throw unreachable();
    const dest = path.join(dir, file);
    if (samePath(dest, source)) { out.push(dest); continue; }
    const st = lstatOf(dest);
    if (st) {
      if (st.isSymbolicLink() || !st.isFile() || !fs.readFileSync(dest).equals(bytes)) throw new TrackerError('resume-session-conflict', "a different session transcript with this id already exists for the resumed run's working directory; it was left as it is. Retry as a new run");
      out.push(dest);
      continue;
    }
    // 'wx' fails on anything already there, a dangling link included.
    fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    out.push(dest);
  }
  return out;
}
