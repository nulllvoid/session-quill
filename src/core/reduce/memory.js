import { deterministicId } from '../../lib/ids.js';

// Learned memory (FEAT-12, spec §6.1): `memory-tx` journal events reduce into state.memory. Pure and
// deterministic - every time comes from the event, nothing is computed from a clock. Staleness is a
// selector concern (src/core/memory.js), not stored here. A malformed or unknown op is ignored and
// recorded in state.memory.problems; the reducer never throws.

export const MEMORY_OPS = ['filed', 'confirmed', 'superseded', 'retired', 'approved', 'owner-note', 'pinned', 'unpinned', 'edited'];
export const MEMORY_SCOPES = ['machine', 'repo', 'task'];
export const MEMORY_TRUSTS = ['owner', 'verified', 'sourced', 'observed', 'quarantined'];
export const MEMORY_STATES = ['active', 'stale', 'retired'];
export const MEMORY_PROBLEM_CAP = 100;

export function createMemoryState() {
  return { entries: new Map(), problems: [] };
}

function problem(state, ev, op, code, entryId) {
  const list = state.memory.problems;
  list.push({ at: ev.occurred_at, event_id: ev.event_id, op: typeof op === 'string' ? op : null, code, entry_id: typeof entryId === 'string' ? entryId : null });
  if (list.length > MEMORY_PROBLEM_CAP) list.splice(0, list.length - MEMORY_PROBLEM_CAP);
  return { rejected: code };
}

// expected_revision, when present at all, must be an integer equal to the entry's revision; a malformed
// value never turns a guarded op into an unguarded one.
function revisionProblem(p, entry) {
  if (p.expected_revision === undefined) return null;
  if (!Number.isInteger(p.expected_revision) || p.expected_revision < 0) return 'memory-revision-invalid';
  return p.expected_revision === entry.revision ? null : 'revision-conflict';
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// A fresh entry object built field by field from the payload (never aliasing it), or { code } when malformed.
function buildEntry(raw, ev, { trust } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { code: 'memory-entry-invalid' };
  if (!nonEmpty(raw.id) || !nonEmpty(raw.text)) return { code: 'memory-entry-invalid' };
  if (!MEMORY_SCOPES.includes(raw.scope)) return { code: 'memory-entry-invalid' };
  const finalTrust = trust ?? raw.trust;
  if (!MEMORY_TRUSTS.includes(finalTrust)) return { code: 'memory-entry-invalid' };
  const entryState = raw.state ?? 'active';
  if (!MEMORY_STATES.includes(entryState)) return { code: 'memory-entry-invalid' };
  if (raw.scope === 'repo' && !nonEmpty(raw.repo_id)) return { code: 'memory-entry-invalid' };
  if (raw.scope === 'task' && !nonEmpty(raw.ticket_id)) return { code: 'memory-entry-invalid' };
  const createdAt = nonEmpty(raw.created_at) ? raw.created_at : ev.occurred_at;
  const entry = {
    id: raw.id,
    scope: raw.scope,
    section: typeof raw.section === 'string' ? raw.section : '',
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    text: raw.text,
    evidence: strings(raw.evidence),
    derived_from: typeof raw.derived_from === 'string' ? raw.derived_from : null,
    trust: finalTrust,
    created_at: createdAt,
    last_confirmed_at: nonEmpty(raw.last_confirmed_at) ? raw.last_confirmed_at : createdAt,
    confirmations: Number.isInteger(raw.confirmations) && raw.confirmations >= 0 ? raw.confirmations : 0,
    state: entryState,
    pinned: raw.pinned === true,
    revision: 1,
  };
  if (raw.scope === 'repo') entry.repo_id = raw.repo_id;
  if (raw.scope === 'task') entry.ticket_id = raw.ticket_id;
  if (nonEmpty(raw.key)) entry.key = raw.key;
  if (nonEmpty(raw.run_id)) entry.run_id = raw.run_id;
  if (nonEmpty(raw.last_used_run)) entry.last_used_run = raw.last_used_run;
  if (nonEmpty(raw.superseded_by)) entry.superseded_by = raw.superseded_by;
  // Why filing held a learning for the owner (src/memory/file.js); shown on the Memory page.
  if (finalTrust === 'quarantined' && nonEmpty(raw.quarantine_reason)) entry.quarantine_reason = raw.quarantine_reason.slice(0, 200);
  return { entry };
}

// Applies one memory-tx event. Returns {} when applied or { rejected } when ignored (and recorded).
export function applyMemoryTx(state, ev) {
  const p = ev.payload;
  const op = p && p.op;
  const raw = p ? p.entry : undefined;
  const id = raw && typeof raw === 'object' ? raw.id : undefined;
  if (!MEMORY_OPS.includes(op)) return problem(state, ev, op, 'memory-op-unknown', id);
  const entries = state.memory.entries;

  if (op === 'filed' || op === 'owner-note') {
    const built = buildEntry(raw, ev, op === 'owner-note' ? { trust: 'owner' } : {});
    if (built.code) return problem(state, ev, op, built.code, id);
    const existing = entries.get(built.entry.id);
    if (!existing) { entries.set(built.entry.id, built.entry); return {}; }
    if (op === 'filed') return problem(state, ev, op, 'memory-entry-exists', id);
    const bad = revisionProblem(p, existing);
    if (bad) return problem(state, ev, op, bad, id);
    // A superseded entry stays superseded; the owner's note becomes a new live entry in its place.
    if (existing.superseded_by) {
      const fresh = buildEntry({ ...raw, id: deterministicId(`${ev.event_id}:memory:${raw.id}`), created_at: ev.occurred_at, last_confirmed_at: ev.occurred_at, state: 'active', confirmations: 0 }, ev, { trust: 'owner' });
      if (fresh.code) return problem(state, ev, op, fresh.code, id);
      entries.set(fresh.entry.id, fresh.entry);
      return {};
    }
    // Otherwise an owner note on an existing id replaces its text, takes ownership and revives it.
    existing.text = built.entry.text;
    existing.trust = 'owner';
    existing.state = 'active';
    if (built.entry.section) existing.section = built.entry.section;
    if (built.entry.key) existing.key = built.entry.key;
    if (built.entry.kind) existing.kind = built.entry.kind;
    existing.revision += 1;
    return {};
  }

  // Every other op acts on an existing entry.
  if (!nonEmpty(id)) return problem(state, ev, op, 'memory-entry-invalid', id);
  const entry = entries.get(id);
  if (!entry) return problem(state, ev, op, 'memory-entry-unknown', id);
  const badRevision = revisionProblem(p, entry);
  if (badRevision) return problem(state, ev, op, badRevision, id);

  switch (op) {
    case 'confirmed':
      if (entry.state === 'retired' || entry.superseded_by) return problem(state, ev, op, 'memory-entry-retired', id);
      entry.confirmations += 1;
      entry.last_confirmed_at = ev.occurred_at;
      if (entry.state === 'stale') entry.state = 'active';
      entry.revision += 1;
      return {};
    case 'superseded': {
      // `entry` is the old entry; its replacement is named by superseded_by (payload or entry). The
      // replacement may be filed before this op, carried in it (payload.replacement) or filed after it.
      const newId = nonEmpty(p.superseded_by) ? p.superseded_by : raw.superseded_by;
      if (!nonEmpty(newId) || newId === id || entry.superseded_by) return problem(state, ev, op, 'memory-supersede-invalid', id);
      // No cycles: the replacement's own chain must not lead back to this entry.
      for (let cur = entries.get(newId), hops = 0; cur && cur.superseded_by && hops < entries.size; cur = entries.get(cur.superseded_by), hops += 1) {
        if (cur.superseded_by === id) return problem(state, ev, op, 'memory-supersede-invalid', id);
      }
      let replacement = null;
      if (p.replacement !== undefined) {
        const built = buildEntry(p.replacement, ev);
        if (built.code || built.entry.id !== newId) return problem(state, ev, op, 'memory-supersede-invalid', id);
        replacement = built.entry;
      }
      if (replacement && !entries.has(newId)) entries.set(newId, replacement);
      entry.superseded_by = newId;
      entry.state = 'retired';
      entry.revision += 1;
      return {};
    }
    case 'retired':
      if (entry.state !== 'retired') { entry.state = 'retired'; entry.revision += 1; }
      return {};
    case 'approved':
      if (entry.trust !== 'quarantined') return problem(state, ev, op, 'memory-not-quarantined', id);
      entry.trust = 'owner';
      delete entry.quarantine_reason;
      entry.revision += 1;
      return {};
    case 'pinned':
    case 'unpinned':
      entry.pinned = op === 'pinned';
      entry.revision += 1;
      return {};
    case 'edited':
      // The owner's wording replaces the old text and revives a retired or stale entry; the entry keeps its
      // id and evidence. A superseded entry is dead: edit its replacement instead.
      if (!nonEmpty(raw.text)) return problem(state, ev, op, 'memory-entry-invalid', id);
      if (entry.superseded_by) return problem(state, ev, op, 'memory-entry-retired', id);
      entry.text = raw.text;
      entry.trust = 'owner';
      entry.state = 'active';
      entry.revision += 1;
      return {};
    default:
      return problem(state, ev, op, 'memory-op-unknown', id);
  }
}
