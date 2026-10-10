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
