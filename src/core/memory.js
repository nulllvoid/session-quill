// Memory selectors over state.memory (spec §6.2-6.3). Pure: every time comes from the caller.

const DAY_MS = 86_400_000;
export const STALE_AFTER_DAYS = 90;
export const RETIRE_AFTER_DAYS = 180;

const SCOPE_ORDER = { machine: 0, repo: 1, task: 2 };
const TRUST_TIER = { owner: 0, verified: 1, sourced: 2, observed: 3, quarantined: 4 };

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const isLive = (e) => e.state === 'active' && !e.superseded_by;
const scopeId = (e) => (e.scope === 'repo' ? e.repo_id : e.scope === 'task' ? e.ticket_id : '');

// Pinned and owner entries first, then verified > sourced > observed, then recency, then confirmations.
export function rankMemory(a, b) {
  const tier = (e) => (e.pinned === true ? 0 : TRUST_TIER[e.trust]);
  return tier(a) - tier(b) || cmp(b.last_confirmed_at, a.last_confirmed_at) || b.confirmations - a.confirmations || cmp(a.id, b.id);
}

// Delivery order (spec §6.3): this ticket's notes, then owner notes and pinned entries, then repo
// entries, then machine entries; within each bucket by section, then rank.
function bucket(e) {
  if (e.scope === 'task') return 0;
  if (e.pinned === true || e.trust === 'owner') return 1;
  return e.scope === 'repo' ? 2 : 3;
}

function order(a, b) {
  return bucket(a) - bucket(b) || cmp(a.section, b.section) || rankMemory(a, b);
}

// Listing order for review pages: scope, section, rank.
function listOrder(a, b) {
  return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || cmp(a.section, b.section) || rankMemory(a, b);
}

const toMs = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);

// Groups of live, non-quarantined entries sharing scope, scope id and key with differing text.
function conflictGroups(entries) {
  const byKey = new Map();
  for (const e of entries) {
    if (!e.key || !isLive(e) || e.trust === 'quarantined') continue;
    const k = JSON.stringify([e.scope, scopeId(e), e.key]);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const groups = [];
  for (const list of byKey.values()) {
    if (new Set(list.map((e) => norm(e.text))).size < 2) continue;
    groups.push({ scope: list[0].scope, repo_id: list[0].repo_id ?? null, ticket_id: list[0].ticket_id ?? null, key: list[0].key, entries: list.sort(rankMemory) });
  }
  return groups.sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || cmp(a.repo_id ?? '', b.repo_id ?? '') || cmp(a.ticket_id ?? '', b.ticket_id ?? '') || cmp(a.key, b.key));
}

// Entries for a run: machine scope, this repo and this ticket; active, not quarantined, not superseded.
// Of a conflicting pair only the higher-ranked entry is returned (spec §6.2.4). With `now` (ms or ISO
// string) entries that memoryStaleness reports stale or retired are left out too. Returned in delivery order.
export function memoryFor(state, { repo_id = null, ticket_id = null, now } = {}) {
  const nowMs = now === undefined ? null : toMs(now);
  const pool = [...state.memory.entries.values()].filter((e) => isLive(e) && e.trust !== 'quarantined'
    && (nowMs === null || memoryStaleness(e, nowMs) === 'active')
    && (e.scope === 'machine' || (e.scope === 'repo' && repo_id !== null && e.repo_id === repo_id) || (e.scope === 'task' && ticket_id !== null && e.ticket_id === ticket_id)));
  const losers = new Set();
  for (const g of conflictGroups(pool)) for (const e of g.entries.slice(1)) losers.add(e.id);
  return pool.filter((e) => !losers.has(e.id)).sort(order);
}

// Learnings waiting for the owner's approval.
export function quarantined(state) {
  return [...state.memory.entries.values()].filter((e) => e.trust === 'quarantined' && e.state !== 'retired' && !e.superseded_by).sort(listOrder);
}

// Same scope + key, different text, both active (and not quarantined): the owner decides.
export function conflicts(state) {
  return conflictGroups([...state.memory.entries.values()]);
}

// 90 days without confirmation -> stale (not inlined); 180 -> retired. The reducer cannot read a clock,
// so callers pass `nowMs`. Pinned and owner entries stay active. The age runs from the later of creation and last confirmation.
export function memoryStaleness(entry, nowMs) {
  if (entry.state === 'retired' || entry.superseded_by) return 'retired';
  // Owner notes and pinned entries never age out (ruling R27).
  if (entry.pinned === true || entry.trust === 'owner') return 'active';
  const times = [Date.parse(entry.last_confirmed_at), Date.parse(entry.created_at)].filter(Number.isFinite);
  if (!times.length || !Number.isFinite(nowMs)) return entry.state === 'stale' ? 'stale' : 'active';
  const since = Math.max(...times);
  const days = (nowMs - since) / DAY_MS;
  if (days >= RETIRE_AFTER_DAYS) return 'retired';
  if (days >= STALE_AFTER_DAYS || entry.state === 'stale') return 'stale';
  return 'active';
}
