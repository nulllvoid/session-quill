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
import { TrackerError } from '../lib/errors.js';
import { pinAction } from './action-pin.js';
import { BUDGET_DEFAULTS } from './runner.js';

export const MAX_INTERRUPTED_EFFECTS = 50;
const TERMINAL = new Set(['done', 'failed', 'timed-out', 'cancelled']);
const WRITE_CLASSES = new Set(['write', 'external.write']);
// A local commit changes only the run's checkout; every other write reaches something outside it.
const LOCAL_SCOPES = new Set(['git.commit']);
const SHELLS = new Set(['Bash', 'PowerShell', 'Monitor']);
// What `--resume` may be handed: a session id as Claude Code reports it, never anything option-like.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
