// Time helpers shared by the dashboard views (pure; no DOM).
export const UI_MINUTE = 60_000;
export const UI_HOUR = 3_600_000;
export const UI_DAY = 86_400_000;

export function parseMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// never-synced when last_sync is null; fresh < 2 h; ageing 2–6 h; stale > 6 h (DATA-CONTRACT).
export function freshness(meta, nowIso) {
  if (!meta || !meta.last_sync) return 'never-synced';
  const age = parseMs(nowIso) - parseMs(meta.last_sync);
  if (age < 2 * UI_HOUR) return 'fresh';
  if (age <= 6 * UI_HOUR) return 'ageing';
  return 'stale';
}

export function ageLabel(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const abs = Math.abs(ms);
  if (abs < UI_MINUTE) return 'just now';
  if (abs < UI_HOUR) { const m = Math.floor(abs / UI_MINUTE); return `${m} min`; }
  if (abs < UI_DAY) { const h = Math.floor(abs / UI_HOUR); return `${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.floor(abs / UI_DAY);
  return `${d} day${d === 1 ? '' : 's'}`;
}

export function relativeTime(iso, nowIso) {
  const ms = parseMs(iso);
  if (ms === null) return 'unknown';
  const diff = parseMs(nowIso) - ms;
  if (Math.abs(diff) < UI_MINUTE) return 'just now';
  const label = ageLabel(diff);
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

export function formatAbsolute(iso, timeZone = 'UTC') {
  const ms = parseMs(iso);
  if (ms === null) return 'unknown';
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
    return fmt.format(new Date(ms)).replace(',', '');
  } catch {
    return iso;
  }
}

export function daysBetween(dateA, nowIso, timeZone = 'UTC') {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(parseMs(nowIso)));
  return Math.round((Date.parse(dateA) - Date.parse(today)) / UI_DAY);
}
