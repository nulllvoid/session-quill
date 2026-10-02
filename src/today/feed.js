// The Today feed (ADR 0009): a day-by-day view of what happened, grouped by ticket, built from
// ticket timelines and sessions. The digest job writes the same data as markdown.
export const TODAY_DAYS = 7;
export const TODAY_KINDS = ['commit', 'pr', 'deployment', 'status', 'write', 'plan', 'conclusion', 'handoff', 'bind'];
const ITEMS_PER_TICKET = 12;
const DAY_MS = 86_400_000;

function dateFormatter(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
}

// The store-local calendar date of an instant.
export function localDate(iso, timeZone) {
  return dateFormatter(timeZone)(iso);
}

export function buildToday(state, { nowIso, days = TODAY_DAYS, timezone = null } = {}) {
  const tz = timezone ?? state.meta.timezone ?? 'UTC';
  const dateOf = dateFormatter(tz);
  // One extra day of margin so the oldest local day is complete in any time zone.
  const cutoff = new Date(Date.parse(nowIso) - (days + 1) * DAY_MS).toISOString();
  const lastDate = dateOf(nowIso);
  // Calendar-day arithmetic, so a daylight-saving change never makes the window a day short or long.
  const [y, m, d] = lastDate.split('-').map(Number);
  const firstDate = new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10);
  const byDay = new Map();
  const dayFor = (date) => {
    if (!byDay.has(date)) byDay.set(date, { date, tickets: new Map(), sessions: 0 });
    return byDay.get(date);
  };
  for (const t of state.tickets.values()) {
    for (const e of t.timeline ?? []) {
      if (!e.at || e.at < cutoff || e.at > nowIso || !TODAY_KINDS.includes(e.kind)) continue;
      const date = dateOf(e.at);
      if (date < firstDate || date > lastDate) continue;
      const day = dayFor(date);
      let entry = day.tickets.get(t.id);
      if (!entry) { entry = { ticket_id: t.id, key: t.key, title: t.title, status: t.status, counts: {}, items: [], last_at: e.at }; day.tickets.set(t.id, entry); }
      entry.counts[e.kind] = (entry.counts[e.kind] ?? 0) + 1;
      entry.items.push({ at: e.at, kind: e.kind, text: e.text });
      if (e.at > entry.last_at) entry.last_at = e.at;
    }
  }
  for (const s of state.sessions.values()) {
    if (!s.started_at || s.started_at < cutoff || s.started_at > nowIso) continue;
    const date = dateOf(s.started_at);
    if (date >= firstDate && date <= lastDate) dayFor(date).sessions += 1;
  }
  const out = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).map((d) => ({
    date: d.date,
    sessions: d.sessions,
    tickets: [...d.tickets.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : a.key < b.key ? -1 : 1)).map((t) => ({
      ...t, items: t.items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, ITEMS_PER_TICKET),
    })),
  }));
  return { timezone: tz, generated_for: lastDate, days: out };
}
