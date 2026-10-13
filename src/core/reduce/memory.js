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
    // An owner note on an existing id replaces its text, takes ownership and revives it.
    if (Number.isInteger(p.expected_revision) && p.expected_revision !== existing.revision) return problem(state, ev, op, 'revision-conflict', id);
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
  if (Number.isInteger(p.expected_revision) && p.expected_revision !== entry.revision) return problem(state, ev, op, 'revision-conflict', id);

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
      if (!nonEmpty(newId) || newId === id) return problem(state, ev, op, 'memory-supersede-invalid', id);
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
      entry.revision += 1;
      return {};
    case 'pinned':
    case 'unpinned':
      entry.pinned = op === 'pinned';
      entry.revision += 1;
      return {};
    case 'edited':
      // The owner's wording replaces the old text; the entry keeps its id, evidence and history of counts.
      if (!nonEmpty(raw.text)) return problem(state, ev, op, 'memory-entry-invalid', id);
      if (entry.superseded_by) return problem(state, ev, op, 'memory-entry-retired', id);
      entry.text = raw.text;
      entry.trust = 'owner';
      if (entry.state === 'stale') entry.state = 'active';
      entry.revision += 1;
      return {};
    default:
      return problem(state, ev, op, 'memory-op-unknown', id);
  }
}
