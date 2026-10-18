// Critical changes, worker side (spec §7.1–7.2, ADR 0028; rulings R44–R47). Every judgement is
// made here, once, when a run finishes done: which critical_changes entries become proposals, their
// action pins, scopes with fingerprints, and the child ticket's title, description and
// critical_spec. The `critical-proposal` event carries all of it; the reducer only checks the
// event's structure, id, source and the run's state, so replay never depends on this code.
import { getBlob } from '../core/blobs.js';
import { deterministicId } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';
import { childKeys } from '../agents/suggestions.js';
import { PROPOSAL_TTL_MS } from '../publish/run-proposals.js';
import { loadScopeCatalog, resolveScopes } from './scopes.js';
import { pinOfChange, HIDDEN_CHAR_RE } from './action-pin.js';
import { CRITICAL_CAPS } from './runner.js';

// Why an entry of a done run did not become a proposal, kept on the run as critical_notes (local
// only: never exported or written to a vault note).
export const CRITICAL_NO_SCOPE = 'no matching scope configured';
export const CRITICAL_NO_PIN = 'the action is not one plain command, or a tool call written as <tool name> <JSON input>, so it cannot be pinned';
export const CRITICAL_TRUNCATED = 'the entry was longer than the result allows and was cut, so it is not proposed';
export const CRITICAL_HIDDEN = 'the scope, target or action holds a control, format or bidi character, so what is shown may not be what would run';
export const criticalTargetMismatch = (want, got) => `the action acts on ${got ? `"${cleanLine(got, 80)}"` : 'no target the guard can read'}, not the scope's target "${cleanLine(want, 80)}"`;

const RISKS = ['low', 'medium', 'high'];
const CLEAN_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Agent text for display: one line, hidden characters removed, dash runs broken, capped. Never used on an action. */
export function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CLEAN_RE, ' ').replace(/-{3,}/g, '–').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The scope an entry names: `name:target`, or `name` with its `target` field. */
export function changeScope(change) {
  const raw = isPlainObject(change) && typeof change.scope === 'string' ? change.scope.trim() : '';
  const colon = raw.indexOf(':');
  const name = colon < 0 ? raw : raw.slice(0, colon);
  const own = colon < 0 ? '' : raw.slice(colon + 1).trim();
  const field = isPlainObject(change) && typeof change.target === 'string' ? change.target.trim() : '';
  return { name, target: own || field || null };
}

/**
 * The child ticket of one critical change. The description names the proposal, never its action,
 * evidence, why, verify or rollback text (R46): those stay in critical_spec, which no note,
 * export or publisher carries.
 */
export function criticalChild(change, { run, parent, index, pin, scopes }) {
  const c = isPlainObject(change) ? change : {};
  const title = cleanLine(c.title, 200) || 'Critical change';
  const scope = scopes[0];
  const scopeText = `${scope.name}${scope.target ? `:${scope.target}` : ''}`;
  const id8 = String(run.id).slice(0, 8);
  const description = [
    `**Goal:** Make the critical change "${title}" in scope ${scopeText} once you approve it, exactly as proposed.`,
    '',
    `**Context:** Run ${id8} of ${parent.key} needed this write but its scopes did not allow it, so it proposed it instead. The pinned action, why, evidence, verify, rollback and risk are in the proposal under Runs → Needs you.`,
    '',
    '**Done when:**',
    '- An approved run of this ticket made the change exactly as pinned',
    '- The change is checked as the proposal\'s verify step describes',
  ].join('\n');
  const critical_spec = {
    from_handoff_id: run.id, index, title, action: typeof c.action === 'string' ? c.action.trim() : '', action_pin: pin, scope: scope.name, target: scope.target,
    scopes: scopes.map((s) => ({ name: s.name, target: s.target, fingerprint: s.fingerprint })),
    why: cleanLine(c.why, 500), evidence: cleanLine(c.evidence, 500), verify: cleanLine(c.verify, 500), rollback: cleanLine(c.rollback, 500), risk: RISKS.includes(c.risk) ? c.risk : 'high',
  };
  return { title, description, critical_spec };
}

/** The `critical-proposal` payload for critical_changes[index] of a done run. */
export function buildCriticalProposal({ run, parent, index, change, pin, scopes, key }) {
  return {
    id: deterministicId(`${run.id}:critical:${index}`), from_handoff_id: run.id, index, pin, scopes,
    child: { key, ...criticalChild(change, { run, parent, index, pin, scopes }) },
  };
}

// M1: the pin's own target (context, Argo app, host; an MCP call's identifying argument) must be
// the scope's target, or the approved run could not make the change.
function targetProblem(pin, scope) {
  if (scope.target === null || scope.target === undefined) return null;
  const want = String(scope.target);
  if (pin.kind === 'mcp') return Object.values(pin.ids ?? {}).includes(want) ? null : criticalTargetMismatch(want, null);
  if (typeof pin.target === 'string') {
    const same = pin.target.toLowerCase().replace(/\.$/, '') === want.toLowerCase().replace(/\.$/, '') && (scope.name === 'http.write' || pin.target === want);
    return same ? null : criticalTargetMismatch(want, pin.target);
  }
  // An exact pin (a tool or option the built-in tables do not know): the target must be one of its words.
  if (pin.exact === true) return (pin.values ?? []).includes(want) ? null : criticalTargetMismatch(want, null);
  return criticalTargetMismatch(want, null);
}

const hidden = (v) => typeof v === 'string' && HIDDEN_CHAR_RE.test(v);
const tooLong = (c) => Object.entries(CRITICAL_CAPS).some(([k, max]) => typeof c[k] === 'string' && c[k].trim().length > max);

/**
 * Splits a done run's critical_changes into proposals and notes. Only expected refusals become
 * notes; anything else (a bug) is logged and the entry is left out without a note (M3).
 * @returns {{ plans: { index, change, pin, scopes }[], notes: { index, reason }[] }}
 */
export function planCriticalChanges(worker, changes, { loadCatalog = loadScopeCatalog, resolve = resolveScopes } = {}) {
  const plans = [];
  const notes = [];
  let catalog = null;
  (Array.isArray(changes) ? changes : []).forEach((change, index) => {
    try {
      const c = isPlainObject(change) ? change : {};
      if ((Array.isArray(c.truncated) && c.truncated.length) || tooLong(c)) { notes.push({ index, reason: CRITICAL_TRUNCATED }); return; }
      if (hidden(c.action) || hidden(c.target) || hidden(c.scope)) { notes.push({ index, reason: CRITICAL_HIDDEN }); return; }
      catalog ??= loadCatalog(worker.config ?? {}, { env: worker.env });
      const { name, target } = changeScope(c);
      if (!name || name.startsWith('git.') || !Object.hasOwn(catalog, name)) { notes.push({ index, reason: CRITICAL_NO_SCOPE }); return; }
      const pin = pinOfChange(c);
      if (!pin) { notes.push({ index, reason: CRITICAL_NO_PIN }); return; }
      let scopes;
      try {
        const [r] = resolve([catalog[name].takesTarget && target ? `${name}:${target}` : name], catalog);
        scopes = [{ name: r.name, target: r.target ?? null, fingerprint: r.fingerprint }];
      } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        notes.push({ index, reason: cleanLine(err.message, 300) || err.code });
        return;
      }
      const mismatch = targetProblem(pin, scopes[0]);
      if (mismatch) { notes.push({ index, reason: mismatch }); return; }
      plans.push({ index, change: c, pin, scopes });
    } catch (err) {
      if (typeof worker.log === 'function') worker.log(`critical change ${index} not proposed after an unexpected error: ${err && err.stack ? err.stack : err}`);
    }
  });
  return { plans, notes };
}

const proposed = (worker, id) => worker.state.runProposals.has(id) || worker.state.appliedSources.has(`critical-proposal:${id}`);

/**
 * Emits one critical-proposal per plan when the run's recorded state is done. Already journaled
 * ids are skipped; a failure is logged and never escapes (the run is already recorded).
 * @returns {number} events emitted
 */
export function emitCriticalProposals(worker, handoffId, plans) {
  const run = worker.state.handoffs.get(handoffId);
  const ticket = run ? worker.state.tickets.get(run.ticket_id) : null;
  if (!run || run.state !== 'done' || !ticket) return 0;
  let emitted = 0;
  for (const plan of plans) {
    const id = deterministicId(`${run.id}:critical:${plan.index}`);
    if (proposed(worker, id)) continue;
    try {
      const [key] = childKeys(worker.state, ticket, 1);
      const payload = buildCriticalProposal({ run, parent: ticket, index: plan.index, change: plan.change, pin: plan.pin, scopes: plan.scopes, key });
      const { result } = worker.emit('critical-proposal', payload, { source_identity: `critical-proposal:${id}`, ticket_id: ticket.id });
      emitted += 1;
      if (result && result.rejected && typeof worker.log === 'function') worker.log(`critical-proposal ${id} for run ${run.id} refused: ${result.rejected}`);
    } catch (err) {
      if (typeof worker.log === 'function') worker.log(`critical-proposal for run ${run.id} entry ${plan.index} not emitted: ${err && err.message ? err.message : err}`);
    }
  }
  return emitted;
}

/**
 * M2: at worker start, done runs of the last PROPOSAL_TTL_MS whose critical changes were planned
 * but never journaled (a stop or crash between the handoff-tx and the emission) are proposed now.
 * Entries the run's critical_notes already explain are not retried.
 */
export function reemitMissingCriticalProposals(worker) {
  const now = Date.parse(worker.now());
  let emitted = 0;
  for (const h of worker.state.handoffs.values()) {
    if (h.state !== 'done' || !(h.critical_count > 0) || !h.result_ref || !h.finished_at || now - Date.parse(h.finished_at) > PROPOSAL_TTL_MS) continue;
    const noted = new Set((Array.isArray(h.critical_notes) ? h.critical_notes : []).map((n) => n && n.index));
    const missing = [];
    for (let i = 0; i < h.critical_count; i += 1) if (!noted.has(i) && !proposed(worker, deterministicId(`${h.id}:critical:${i}`))) missing.push(i);
    if (!missing.length) continue;
    let result = null;
    try { result = JSON.parse(getBlob(h.result_ref, worker.env)); } catch { result = null; }
    if (!result || !Array.isArray(result.critical_changes)) continue;
    const { plans } = planCriticalChanges(worker, result.critical_changes);
    emitted += emitCriticalProposals(worker, h.id, plans.filter((p) => missing.includes(p.index)));
  }
  return emitted;
}
