// Five-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone
// with Intl only, plus simple intervals ("30m", "2h", "1d") (ADR 0007).
import { TrackerError } from '../lib/errors.js';

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], base: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], base: 0 },
];
const DAY_MS = 86_400_000;

function invalid(message) {
  return new TrackerError('schedule-invalid', message);
}

function parseValue(token, field) {
  if (field.names) {
    const i = field.names.indexOf(token.toUpperCase());
    if (i >= 0) return i + field.base;
  }
  if (!/^\d+$/.test(token)) throw invalid(`${field.name}: "${token}" is not a number`);
  const n = Number(token);
  if (n < field.min || n > field.max) throw invalid(`${field.name}: ${n} is outside ${field.min}-${field.max}`);
  return n;
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(',')) {
    const pieces = part.split('/');
    if (!part || pieces.length > 2) throw invalid(`${field.name}: "${part}" is not a valid item`);
    const [range, stepText] = pieces;
    if (stepText !== undefined && !/^[1-9]\d*$/.test(stepText)) throw invalid(`${field.name}: step "${stepText}" must be a positive number`);
    const step = stepText === undefined ? 1 : Number(stepText);
    let lo;
    let hi;
    if (range === '*') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = parseValue(a, field);
      hi = parseValue(b, field);
      if (lo > hi) throw invalid(`${field.name}: range ${range} runs backwards`);
    } else {
      lo = parseValue(range, field);
      hi = stepText === undefined ? lo : field.max;
    }
    for (let v = lo; v <= hi; v += step) values.add(field.name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return values;
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw invalid('cron must be a string');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw invalid(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  const sorted = (s) => [...s].sort((a, b) => a - b);
  return { expr: parts.join(' '), minute: sorted(minute), hour: sorted(hour), dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

const formatters = new Map();
function partsAt(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

function offsetAt(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Local wall time to a UTC instant; null when that wall time does not exist (a DST gap).
export function zonedToUtc(y, m, d, h, mi, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  const p = partsAt(t, timeZone);
  return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi ? t : null;
}

function dayMatches(spec, y, m, d) {
  if (!spec.month.has(m)) return false;
  const domOk = spec.dom.has(d);
  const dowOk = spec.dow.has(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dowOk;
  if (spec.dowAny) return domOk;
  return domOk || dowOk; // standard cron: either restricted day field may match
}

export function nextAfter(spec, afterMs, timeZone = 'UTC') {
  const start = partsAt(afterMs, timeZone);
  let day = Date.UTC(start.y, start.m - 1, start.d);
  for (let i = 0; i < 366 * 5; i += 1, day += DAY_MS) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (!dayMatches(spec, y, m, d)) continue;
    for (const h of spec.hour) {
      if (i === 0 && h < start.h - 1) continue;
      for (const mi of spec.minute) {
        const t = zonedToUtc(y, m, d, h, mi, timeZone);
        if (t !== null && t > afterMs) return t;
      }
    }
  }
  return null;
}

export function parseInterval(text) {
  const m = /^(\d+)\s*(m|h|d)$/.exec(String(text ?? '').trim());
  if (!m) throw invalid(`every must look like 30m, 2h or 1d, got "${text}"`);
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: DAY_MS }[m[2]];
  if (ms < 60_000) throw invalid('every must be at least 1 minute');
  return ms;
}
