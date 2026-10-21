// Local usage health for `quill doctor`: computed on this machine from the journal tail, the
// health log and the latest snapshot. Nothing here is sent anywhere (PRD: no telemetry).
import fs from 'node:fs';
import { ageMs, DAY } from '../lib/time.js';

export const USAGE_WINDOW_DAYS = 7;
const TAIL_BYTES = 4 * 1024 * 1024;

// The last `maxBytes` of the journal as parsed events. Bounded, so a large journal costs the same.
export function readJournalTail(file, { maxBytes = TAIL_BYTES } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line may be cut mid-record
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn or foreign line */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
}

export function usageStats({ events = [], healthErrors = [], sessions = [], nowIso, days = USAGE_WINDOW_DAYS }) {
  const within = (iso) => !!iso && ageMs(iso, nowIso) <= days * DAY;
  const hookMs = events
    .filter((e) => (e.kind === 'pre-tool' || e.kind === 'post-tool') && within(e.occurred_at) && Number.isFinite(e.payload && e.payload.hook_ms))
    .map((e) => e.payload.hook_ms)
    .sort((a, b) => a - b);
  const toolCalls = events.filter((e) => e.kind === 'pre-tool' && within(e.occurred_at)).length;
  const gaps = healthErrors.filter((e) => e.kind === 'capture-gap' && within(e.at)).length;
  const slow = healthErrors.filter((e) => e.kind === 'slow-capture' && within(e.at)).length;
  const recent = sessions.filter((s) => within(s.last_event_at) && !s.agent_id);
  const unlinked = recent.filter((s) => s.unbound_work && ((s.unbound_work.files ?? []).length || (s.unbound_work.commits ?? []).length)).length;
  const bound = recent.filter((s) => (s.ticket_ids ?? []).length).length;
  return {
    days,
    tool_calls: toolCalls,
    hook_samples: hookMs.length,
    hook_p50_ms: percentile(hookMs, 0.5),
    hook_p95_ms: percentile(hookMs, 0.95),
    capture_gaps: gaps,
    slow_captures: slow,
    sessions: recent.length,
    sessions_bound: bound,
    sessions_with_unlinked_work: unlinked,
  };
}

// One line per measure, with a level the doctor report understands.
export function usageItems(stats, { hookBudgetMs = 200 } = {}) {
  const items = [];
  const d = `last ${stats.days} days`;
  if (stats.hook_samples) {
    const level = stats.hook_p95_ms > hookBudgetMs ? 'warn' : 'ok';
    items.push({ level, label: 'hook latency', detail: `p50 ${stats.hook_p50_ms} ms, p95 ${stats.hook_p95_ms} ms over ${stats.hook_samples} tool hooks (${d}; budget ${hookBudgetMs} ms)` });
  } else {
    items.push({ level: 'ok', label: 'hook latency', detail: `no measured tool hooks yet (${d}; recorded from 0.6.1)` });
  }
  items.push({ level: stats.capture_gaps ? 'warn' : 'ok', label: 'capture health', detail: `${stats.capture_gaps} capture gap(s), ${stats.slow_captures} slow capture(s) over ${stats.tool_calls} tool calls (${d})` });
  if (stats.sessions) {
    const pct = Math.round((stats.sessions_with_unlinked_work / stats.sessions) * 100);
    items.push({ level: pct > 25 ? 'warn' : 'ok', label: 'ticket coverage', detail: `${stats.sessions_bound}/${stats.sessions} sessions linked to a ticket; ${stats.sessions_with_unlinked_work} (${pct}%) left unlinked work (${d})` });
  }
  return items;
}

// Recipe stats for `quill doctor` (ADR 0033, FR-5.2): plain counts per recipe over the last `days`,
// from the journaled run records and owner requests on this machine. Counts, never a score.
export const RECIPE_STATS_DAYS = 30;
export const REVERT_WINDOW_MS = 48 * 60 * 60 * 1000;
// Owner requests that step into a run: stopping it or undoing a file it changed. A retry or a
// resume is counted from the new run's `retry_of`, once.
export const INTERVENTION_KINDS = new Set(['handoff-cancel', 'undo-file-effect']);

const values = (x) => (x instanceof Map ? [...x.values()] : Array.isArray(x) ? x : []);

/**
 * @returns {Array<{ recipe: string, runs: number, done: number, failed: number, tests_first_pass: number,
 *   tests_after_repair: number, interventions: number, merged: number, reverted_48h: number,
 *   pending_48h: number, median_done_to_merge_ms: number|null }>}
 */
export function recipeStats({ handoffs = [], tickets = [], requests = [], nowIso, days = RECIPE_STATS_DAYS }) {
  const now = Date.parse(nowIso);
  const runs = values(handoffs).filter((h) => h && h.requested_at && ageMs(h.requested_at, nowIso) <= days * DAY && ageMs(h.requested_at, nowIso) >= 0);
  // A PR the run opened, as the run observed it, else as its ticket's evidence shows it.
  const ticketPrs = new Map();
  for (const t of values(tickets)) for (const pr of t && Array.isArray(t.prs) ? t.prs : []) if (pr && pr.url) ticketPrs.set(pr.url, pr);
  const interventions = new Map();
  for (const r of values(requests)) {
    if (!r || r.state !== 'applied') continue;
    const id = r.payload && typeof r.payload.handoff_id === 'string' ? r.payload.handoff_id : null;
    if (id && INTERVENTION_KINDS.has(r.kind)) interventions.set(id, (interventions.get(id) ?? 0) + 1);
  }
  // A retry (or a resume) is the owner queuing the run again: it counts against the run it retries.
  for (const h of values(handoffs)) if (h && typeof h.retry_of === 'string') interventions.set(h.retry_of, (interventions.get(h.retry_of) ?? 0) + 1);
  const by = new Map();
  for (const h of runs) {
    const recipe = h.recipe && typeof h.recipe.name === 'string' ? h.recipe.name : h.mode ?? 'unknown';
    const s = by.get(recipe) ?? { recipe, runs: 0, done: 0, failed: 0, tests_first_pass: 0, tests_after_repair: 0, interventions: 0, merged: 0, reverted_48h: 0, pending_48h: 0, merge_ms: [] };
    s.runs += 1;
    if (h.state === 'done') s.done += 1;
    else if (h.state === 'failed' || h.state === 'timed-out') s.failed += 1;
    const g = h.test_gate;
    if (g && g.status === 'passed') {
      const attempts = Array.isArray(g.runs) && g.runs.length ? g.runs.length : g.attempts ?? 1;
      if (attempts === 1) s.tests_first_pass += 1;
      else if (g.repaired) s.tests_after_repair += 1;
    }
    s.interventions += interventions.get(h.id) ?? 0;
    const obs = h.pr_observed && h.pr_observed.state ? h.pr_observed : h.pr_url ? ticketPrs.get(h.pr_url) ?? null : null;
    if (obs && obs.state === 'merged' && obs.merged_at) {
      s.merged += 1;
      const merged = Date.parse(obs.merged_at);
      const revertedIn = obs.reverted_by && obs.reverted_at ? Date.parse(obs.reverted_at) - merged : null;
      if (revertedIn !== null && revertedIn >= 0 && revertedIn <= REVERT_WINDOW_MS) s.reverted_48h += 1;
      // Not yet known: the window is still open, or nothing checked it after the window closed.
      else if (now < merged + REVERT_WINDOW_MS || !(obs.revert_checked_at && Date.parse(obs.revert_checked_at) >= merged + REVERT_WINDOW_MS)) s.pending_48h += 1;
      if (h.finished_at && merged >= Date.parse(h.finished_at)) s.merge_ms.push(merged - Date.parse(h.finished_at));
    }
    by.set(recipe, s);
  }
  return [...by.values()].sort((a, b) => b.runs - a.runs || a.recipe.localeCompare(b.recipe)).map(({ merge_ms, ...s }) => {
    const sorted = merge_ms.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return { ...s, median_done_to_merge_ms: sorted.length ? (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)) : null };
  });
}

// One line per recipe for the doctor report.
export function recipeLines(stats, { days = RECIPE_STATS_DAYS } = {}) {
  if (!stats.length) return [`no agent runs in the last ${days} days`];
  const hours = (ms) => (ms === null ? null : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
  return stats.map((s) => {
    const merge = s.merged ? `${s.merged} PR(s) merged, ${s.reverted_48h} reverted within 48 h${s.pending_48h ? `, ${s.pending_48h} not yet known` : ''}${s.median_done_to_merge_ms !== null ? `, median ${hours(s.median_done_to_merge_ms)} from run end to merge` : ''}` : 'no PR merged';
    return `${String(s.recipe).replace(/[\p{Cc}\p{Cf}]+/gu, '').slice(0, 60)}: ${s.runs} run(s), ${s.done} done, ${s.failed} failed · tests passed (worker) first time ${s.tests_first_pass}, after a repair ${s.tests_after_repair} · ${s.interventions} owner intervention(s) · ${merge}`;
  });
}
