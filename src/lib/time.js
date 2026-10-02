const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function nowIso(clock = Date.now) {
  return toIso(clock());
}

export function toIso(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid time: ${value}`);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function parseIso(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid time: ${iso}`);
  return ms;
}

export function addMs(iso, ms) {
  return toIso(parseIso(iso) + ms);
}

export function ageMs(iso, now) {
  return parseIso(now) - parseIso(iso);
}

export function isoDateInZone(iso, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(parseIso(iso))).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function splitDate(date) {
  const m = DATE_RE.exec(date);
  if (!m) throw new TypeError(`invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

export function dateDiffDays(dateA, dateB) {
  const a = Date.UTC(...splitDate(dateA));
  const b = Date.UTC(...splitDate(dateB));
  return Math.round((a - b) / DAY);
}

export function isIsoZ(value) {
  return typeof value === 'string' && ISO_Z_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function isDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
