// Runs (spec §2): which tab a run belongs to, batch groups, and the facts a row may state. Pure
// functions over snapshot records; nothing here guesses a reason or an ETA the worker did not record.
import { ticketById, matchesFilters, formatDuration } from '../components.js';

export const RUN_TABS = ['needs', 'live', 'failed', 'all'];
export const RUN_TAB_LABELS = { needs: 'Needs you', live: 'Live', failed: 'Failed', all: 'All' };
const LIVE = new Set(['queued', 'running']);
const FAILED = new Set(['failed', 'timed-out', 'cancelled']);
const DAY_MS = 86_400_000;
const NEEDS_WINDOW_MS = 7 * DAY_MS;
const ALL_WINDOW_MS = 30 * DAY_MS;

const newestFirst = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Whole minutes only, so a running row's markup changes at most once a minute and a poll does not
// rebuild the list (and drop focus) every 2 s.
function runningFor(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Running for under a minute';
  const h = Math.floor(mins / 60), m = mins % 60;
  return `Running for ${h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`}`;
}

export function isStaticSnapshot(snapshot) {
  return !!(snapshot.meta && snapshot.meta.exported_at);
}

// An export cannot act and strips suggestions, so it has no Needs you tab.
export function visibleRunTabs(snapshot) {
  return isStaticSnapshot(snapshot) ? RUN_TABS.filter((t) => t !== 'needs') : RUN_TABS;
}

export function ticketRuns(snapshot, ticketId) {
  return (snapshot.handoffs ?? []).filter((h) => h.ticket_id === ticketId).sort((a, b) => (a.requested_at < b.requested_at ? 1 : a.requested_at > b.requested_at ? -1 : 0));
}

// The run that retried this one (Retry as new run), else the next run on the same ticket. A CI fix
// (ADR 0039) pushes to the same pull request as the run it fixes, so it never supersedes one.
export function supersededBy(snapshot, h) {
  const later = (snapshot.handoffs ?? []).filter((x) => x.id !== h.id && x.ticket_id === h.ticket_id && x.requested_at > h.requested_at && x.origin !== 'ci');
  const retry = later.find((x) => x.retry_of && (x.retry_of === h.id || x.retry_of === h.request_id));
  if (retry) return { run: retry, retried: true };
  const next = later.sort((a, b) => (a.requested_at < b.requested_at ? -1 : 1))[0];
  return next ? { run: next, retried: false } : null;
}

export function openSuggestions(h) {
  return (h.suggestions ?? []).filter((s) => s.state === 'proposed');
}

const within7Days = (h, now) => Date.parse(now) - Date.parse(h.finished_at ?? h.requested_at) <= NEEDS_WINDOW_MS;
const openTicket = (snapshot, h) => { const t = ticketById(snapshot, h.ticket_id); return !!t && t.status !== 'done'; };
const TERMINAL_PR = new Set(['merged', 'closed']);
// Failures that wait on a setting or an approval rather than on a retry (ADR 0039).
const DECISION_CODES = new Set(['scope-changed', 'scope-credentials-missing']);
const isDecisionFailure = (code) => typeof code === 'string' && (DECISION_CODES.has(code) || code.startsWith('recipe-needs-'));
const TEST_CODES = new Set(['tests-failed', 'tests-timeout']);
// The worker's test gate failed or timed out, and nothing else is recorded as the run's error.
const isTestFailure = (h) => {
  const code = h.error && h.error.code;
  if (code) return TEST_CODES.has(code);
  return !!h.test_gate && ['failed', 'timeout'].includes(h.test_gate.status);
};

// The run's CI fix proposals (ADR 0039), newest first.
export function ciProposalsOf(snapshot, handoffId) {
  return (snapshot.run_proposals ?? []).filter((p) => p.origin === 'ci' && p.from_handoff_id === handoffId).sort((a, b) => (a.proposed_at < b.proposed_at ? 1 : a.proposed_at > b.proposed_at ? -1 : 0));
}

// Whether the run's pull request is recorded merged or closed (on the ticket, or by the CI watch).
function prClosed(snapshot, h) {
  if (h.ci && TERMINAL_PR.has(h.ci.pr_state)) return true;
  const t = ticketById(snapshot, h.ticket_id);
  const pr = t && h.pr_url ? (t.prs ?? []).find((x) => x.url === h.pr_url) : null;
  return !!(pr && TERMINAL_PR.has(pr.state));
}

/**
 * A Quill-opened pull request whose latest CI observation is failing (ADR 0039): the CI failed item,
 * while the owner has not yet approved or dismissed a fix for that commit. Returns { proposal } (the
 * open proposal for the commit, or null when none was staged), else null.
 */
export function ciAttention(snapshot, h, now) {
  if (h.state !== 'done' || h.origin === 'ci' || !h.ci || h.ci.state !== 'failing' || prClosed(snapshot, h)) return null;
  const resolved = (snapshot.handoffs || []).some(next => next.ticket_id === h.ticket_id && next.id !== h.id && next.origin !== 'ci' && next.requested_at > h.requested_at && ['done', 'failed', 'timed-out'].includes(next.state));
  if (!openTicket(snapshot, h) || !h.intent && !within7Days(h, now) || resolved) return null;
  const forHead = ciProposalsOf(snapshot, h.id).find((p) => p.ci && p.ci.head_sha === h.ci.head_sha) ?? null;
  if (forHead && forHead.state !== 'proposed') return null;
  return { proposal: forHead };
}

/**
 * A finished fix waiting for the owner's review (ADR 0039): it edited source and changed files, in
 * the last 7 days, on an open ticket, no later run superseded it, its pull request is not recorded
 * merged or closed, and CI is not recorded failing on it. A CI fix run is reviewed through the run
 * whose pull request it pushed to.
 */
export function readyToReview(snapshot, h, now) {
  if (h.state !== 'done' || h.origin === 'ci' || !(h.permissions && h.permissions.edit_source) || !(h.changed_files ?? []).length) return false;
  if (!openTicket(snapshot, h) || !within7Days(h, now) || supersededBy(snapshot, h) || prClosed(snapshot, h)) return false;
  return !(h.ci && h.ci.state === 'failing');
}

/**
 * Which Needs you group a run belongs to, or null when it does not need the owner (ADR 0039):
 * 'decision', 'tests', 'failed' or 'ready' for its own row, 'ci' for the CI failed item. A finished
 * run needs the owner while it has suggestions to decide on, while CI fails on its pull request, or
 * while it is ready to review; a failure does for 7 days, on a ticket that is still open, until a
 * later run on that ticket supersedes it. Cancelled runs never do: the owner cancelled them.
 */
export function attentionOf(snapshot, h, now) {
  if (h.state === 'done') {
    if (openSuggestions(h).length) return 'decision';
    if (ciAttention(snapshot, h, now)) return 'ci';
    if (readyToReview(snapshot, h, now)) return Number.isInteger(h.scope_drift) && h.scope_drift > 0 ? 'decision' : 'ready';
    return null;
  }
  if (h.state !== 'failed' && h.state !== 'timed-out') return null;
  const resolved = (snapshot.handoffs || []).some(next => next.ticket_id === h.ticket_id && next.id !== h.id && next.origin !== 'ci' && next.requested_at > h.requested_at && ['done', 'failed', 'timed-out'].includes(next.state));
  if (!openTicket(snapshot, h) || !h.intent && !within7Days(h, now) || resolved) return null;
  if (isDecisionFailure(h.error && h.error.code)) return 'decision';
  if (isTestFailure(h)) return 'tests';
  return 'failed';
}

export function needsYou(snapshot, h, now) {
  return attentionOf(snapshot, h, now) !== null;
}

// Mirrors the ticket filters matchesFilters applies (machine is Sessions-only, so it is not one here).
function hasFilters(f = {}) {
  return !!(f.project || f.category || f.tag || f.repo || f.stale || f.q);
}

// What of memory needs the owner (spec §6.4): each quarantined learning, and each group of entries
// that disagree on a key. Memory reaches the page only from the owner endpoint, never an export.
function memoryNeeds(memory, filters) {
  if (!memory) return [];
  const f = filters ?? {};
  // A memory item has no ticket: only a repo filter can select it, and only its own repo.
  const keep = (repoId) => !hasFilters(f) || (!!f.repo && repoId === f.repo && !f.project && !f.category && !f.tag && !f.stale && !f.q);
  const learnings = (memory.entries ?? []).filter((e) => e.trust === 'quarantined' && keep(e.repo_id ?? null)).map((e) => ({ kind: 'learning', id: e.id, at: e.created_at ?? '', entry: e }));
  const groups = (memory.conflicts ?? []).filter((c) => keep(c.repo_id ?? null)).map((c) => ({ kind: 'memory-conflict', id: c.id, at: c.at ?? '', conflict: c }));
  return [...learnings, ...groups];
}

// One task-level attention identity, shared by Work and Runs; recorded run identities remain separate.
export function workAttentionItems(snapshot) {
  if (isStaticSnapshot(snapshot)) return [];
  const closureIds = new Set((snapshot.reconciliation?.items || []).map(item => item.ticket_id));
  return (snapshot.tickets || []).filter(t => t.work_rollup && !closureIds.has(t.id) && (t.status === 'blocked' || t.repo_state === 'needs-clone' || t.work_rollup.closure_state === 'needs-review' || t.work_rollup.unclassified > 0 || (t.validation_issues || []).some(x => x.startsWith('parent')))).map(t => ({kind:'work',id:`work:${t.id}`,ticket:t,at:t.updated_at || '',group:'decision',reason:t.work_rollup.reasons?.[0]?.text || t.blocker || (t.repo_state === 'needs-clone' ? 'Repository needs a local checkout' : 'Review the parent relationship')}));
}

export function runTabs(snapshot, filters, now, { memory = null } = {}) {
  const keep = (ticketId) => {
    const t = ticketById(snapshot, ticketId);
    return t ? matchesFilters(t, filters, snapshot) : !hasFilters(filters);
  };
  const runs = (snapshot.handoffs ?? []).filter((h) => keep(h.ticket_id)).map((h) => ({ kind: 'run', id: h.id, at: h.requested_at ?? '', run: h }));
  const proposals = (snapshot.run_proposals ?? []).filter((p) => (p.state === 'proposed' || p.state === 'expired') && keep(p.ticket_id)).map((p) => ({ kind: 'proposal', id: p.id, at: p.proposed_at ?? '', proposal: p }));
  const nowMs = Date.parse(now);
  // Each run needs the owner at most once as its own row, and at most once as the CI failed item
  // (ADR 0039). An open CI fix proposal is always carried by its run's CI item, whatever else the
  // run needs and however old or superseded the run is, so it is never hidden and never listed
  // again on its own; one whose run is not in the snapshot gets a CI item without the run.
  const runNeeds = [];
  if (!isStaticSnapshot(snapshot)) {
    const openCi = new Map();
    for (const x of proposals) {
      const p = x.proposal;
      if (p.origin !== 'ci' || p.state !== 'proposed') continue;
      const prev = openCi.get(p.from_handoff_id);
      if (!prev || String(p.proposed_at ?? '') > String(prev.proposed_at ?? '')) openCi.set(p.from_handoff_id, p);
    }
    const ciNeed = (h, id, proposal, at) => ({ kind: 'ci', id: `ci:${id}`, at, run: h, proposal, group: 'tests' });
    for (const x of runs) {
      const group = attentionOf(snapshot, x.run, now);
      const open = openCi.get(x.run.id) ?? null;
      openCi.delete(x.run.id);
      const at = (x.run.ci && x.run.ci.observed_at) || (open && open.proposed_at) || x.at;
      if (group === 'ci') runNeeds.push(ciNeed(x.run, x.run.id, ciAttention(snapshot, x.run, now).proposal ?? open, at));
      else {
        if (group) runNeeds.push({ ...x, group });
        if (open) runNeeds.push(ciNeed(x.run, x.run.id, open, at));
      }
    }
    for (const [id, p] of openCi) runNeeds.push(ciNeed((snapshot.handoffs ?? []).find((h) => h.id === id) ?? null, id, p, p.proposed_at ?? ''));
  }
  const closure = snapshot.capabilities?.edit_tickets && !isStaticSnapshot(snapshot)
    ? (snapshot.reconciliation?.items ?? []).filter((item) => keep(item.ticket_id)).map((item) => ({ kind: 'closure', id: `closure:${item.ticket_id}`, at: '', item, group: 'decision' })) : [];
  const tabs = {
    needs: isStaticSnapshot(snapshot) ? [] : [...proposals.filter((x) => x.proposal.state === 'proposed' && x.proposal.origin !== 'ci').map((x) => ({ ...x, group: 'decision' })), ...runNeeds, ...closure, ...workAttentionItems(snapshot).filter(x => keep(x.ticket.id)), ...memoryNeeds(memory, filters).map((x) => ({ ...x, group: 'decision' }))],
    live: runs.filter((x) => LIVE.has(x.run.state)),
    failed: runs.filter((x) => FAILED.has(x.run.state)),
    all: [...proposals, ...runs.filter((x) => !Number.isFinite(Date.parse(x.at)) || nowMs - Date.parse(x.at) <= ALL_WINDOW_MS)],
  };
  for (const k of RUN_TABS) tabs[k].sort(newestFirst);
  return tabs;
}

// Needs you groups (ADR 0039, design system §5), in order. Live is shown inside Needs you but is
// never counted: the tab count and the attention dot count the other groups only.
export const ATTENTION_GROUPS = [
  { key: 'decision', label: 'Needs your decision', counted: true },
  { key: 'tests', label: 'Tests or CI failed', counted: true },
  { key: 'failed', label: 'Other failures', counted: true },
  { key: 'ready', label: 'Ready to review', counted: true },
  { key: 'live', label: 'Live', counted: false },
];

/** The Needs you items split into their groups, then Live; empty groups are left out. */
export function attentionGroups(tabs) {
  const out = [];
  for (const g of ATTENTION_GROUPS) {
    const items = g.key === 'live' ? tabs.live : tabs.needs.filter((x) => x.group === g.key);
    if (items.length) out.push({ ...g, items });
  }
  return out;
}

export function defaultRunTab(tabs, names) {
  for (const k of ['needs', 'live']) if (names.includes(k) && tabs[k].length) return k;
  return 'all';
}

// Runs sharing a batch_id stay together, placed where their newest member falls.
export function groupRuns(items) {
  const out = [];
  const batches = new Map();
  for (const item of items) {
    const batchId = item.kind === 'run' ? item.run.batch_id : null;
    if (!batchId) { out.push(item); continue; }
    let group = batches.get(batchId);
    if (!group) { group = { kind: 'batch', id: batchId, at: item.at, items: [] }; batches.set(batchId, group); out.push(group); }
    group.items.push(item);
  }
  return out;
}

const FINISHED = new Set(['done', 'failed', 'timed-out', 'cancelled']);
const CI_FACTS = { failing: 'CI failing', pending: 'CI pending', passing: 'CI passing', none: 'no CI checks' };

// A batch's recorded spend against its budget (spec §5.2), as the worker counts it
// (src/handoff/resume.js): the cost each finished member recorded, estimates included. Null when
// the snapshot carries no budget (an export, an older worker) or the run is in no batch.
export function batchBudgetState(snapshot, batchId) {
  const limits = snapshot.meta && snapshot.meta.handoff_limits;
  const budget = limits ? limits.batch_budget_usd : null;
  if (typeof batchId !== 'string' || !batchId || typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return null;
  let spent = 0;
  for (const x of snapshot.handoffs ?? []) {
    if (x.batch_id === batchId && FINISHED.has(x.state) && typeof x.cost_usd === 'number' && Number.isFinite(x.cost_usd) && x.cost_usd > 0) spent += x.cost_usd;
  }
  spent = Math.round(spent * 10000) / 10000;
  return { spent, budget, reached: spent >= budget };
}

// What a row may say about a run: occupancy facts while queued, elapsed time while running, and
// outcomes once finished. Plain text; the caller escapes.
export function runFacts(snapshot, h, now) {
  const facts = [];
  if (h.state === 'queued') {
    facts.push('Queued');
    const fix = !!(h.permissions && h.permissions.edit_source);
    const running = (snapshot.handoffs ?? []).filter((x) => x.state === 'running' && !!(x.permissions && x.permissions.edit_source) === fix);
    const limits = snapshot.meta && snapshot.meta.handoff_limits;
    const cap = limits ? limits[fix ? 'fix' : 'readonly'] : null;
    if (Number.isInteger(cap) && running.length >= cap) facts.push(`${fix ? 'fix' : 'read-only'} slots ${running.length}/${cap} in use`);
    if (fix && h.repo_id && running.some((x) => x.repo_id === h.repo_id)) facts.push('repository busy');
    // The worker starts no further member of a batch whose recorded spend reached its budget.
    const spend = h.batch_id ? batchBudgetState(snapshot, h.batch_id) : null;
    if (spend && spend.reached) facts.push('Batch budget reached');
  } else if (h.state === 'running') {
    facts.push(Number.isFinite(Date.parse(h.started_at)) ? runningFor(Math.max(0, Date.parse(now) - Date.parse(h.started_at))) : 'Running');
    if (h.timings && Number.isFinite(h.timings.worktree_ms)) facts.push(`setup ${formatDuration(h.timings.worktree_ms)}`);
  } else if (h.state === 'done') {
    const open = openSuggestions(h).length;
    if (open) facts.push(`${plural(open, 'suggestion')} to review`);
    if ((h.changed_files ?? []).length) facts.push(`${plural(h.changed_files.length, 'file')} changed`);
    if (h.pr_url) facts.push('draft PR opened');
    // What the CI watch last recorded on the run's pull request (ADR 0039): CI's word, not the test gate's.
    if (h.ci && CI_FACTS[h.ci.state]) facts.push(CI_FACTS[h.ci.state]);
    if (!facts.length) facts.push('Finished');
  } else {
    const gate = h.test_gate && h.test_gate.status;
    facts.push(h.error && h.error.message ? h.error.message : h.state === 'cancelled' ? 'Cancelled' : h.state === 'timed-out' ? 'Timed out' : gate === 'failed' ? 'Tests failed' : gate === 'timeout' ? 'Tests timed out' : 'Failed');
    const next = supersededBy(snapshot, h);
    if (next) facts.push(next.retried ? 'Retried as a new run' : 'Superseded by a later run');
  }
  return facts;
}

export function liveRunCount(snapshot) {
  return (snapshot.handoffs ?? []).filter((h) => LIVE.has(h.state)).length;
}

// The global attention count: the unfiltered Needs you list, memory items included (design system §7).
export function needsYouCount(snapshot, now, memory = null) {
  return runTabs(snapshot, {}, now, { memory }).needs.length;
}
