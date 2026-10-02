# Schedules and the Bitbucket Provider (Step 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship step 3 of "Session Quill: zero-command ticket tracking": named jobs on cron or interval schedules (`[[schedule]]` in config), reconciliation rehosted as the `reconcile` job, a Schedules panel with Run now, and a Bitbucket (Cloud and Server/Data Center) PR provider.

**Architecture:** A scheduler worker extension replaces the reconcile extension's private two-hour timer. It reads `[[schedule]]` tables (default: `reconcile` every `sync_interval_hours`), computes the next run in the store's IANA time zone with a dependency-free cron evaluator, runs at most one run per job at a time, collapses missed slots into one catch-up run, and journals every run as `schedule-run` events (started/finished) that the reducer folds into `state.schedules`. Manual runs are a `run-job` request (no undo delay); `refresh` stays as "run reconcile now". The worker exposes schedule info in the snapshot for a header dialog. A Bitbucket provider polls PR state over REST with a token read from a named environment variable and sent only to `api.bitbucket.org` or the configured server base URL.

**Tech Stack:** Node 22+ ESM, built-ins only (`fetch`, `Intl`), `node:test`.

**Spec:** Claude Doc "Session Quill: zero-command ticket tracking" (https://claude.ai/artifact/CQjjJMoyhY2tweXK2jJpQr, rev 11: "Schedules" — config example, job table, rules; "UI features" → Schedules panel; "Implementation order" step 3), with `docs/TRD.md` §Reconciliation and lifecycle (two-hour cadence in the store time zone, catch up once on wake, refresh within one tick), `docs/DATA-CONTRACT.md` §Mutation request, ADR 0005/0006.

## Global Constraints

- Hooks stay offline; only the worker touches the network (proposal "Rules").
- A missed run catches up once, never repeatedly; one run per job at a time; every run is a journal event visible in the UI and replay (proposal "Rules").
- Schedules evaluate in the store's IANA time zone (TRD §Reconciliation).
- Default behaviour is unchanged: with no `[[schedule]]`, `reconcile` runs every `sync_interval_hours` (2 h) and on first start; Refresh still runs within one tick and duplicates join one run (A30).
- Schedules live in user config only; a repository's `.quill.toml` cannot schedule worker jobs.
- Provider credentials come from environment variables named in config; they are never written to config, the journal, the snapshot or logs, and are sent only to the provider host the config names.
- Jobs not built yet (`digest`, `publish`, `agent`, `tracker-sync`, `stale-sweep`) are accepted in config with a warning and not run.

## Review Focus

1. **Token exfiltration through a crafted PR link** (a lookalike host, `http:`, or a different server). Tests: Task 6 `the token is sent only to the configured host`.
2. **DST gaps and repeats, and day-of-month OR day-of-week** in cron evaluation. Tests: Task 2.
3. **A run interrupted by a crash or stop** must be marked, never left "running" forever. Test: Task 5 `an unfinished run is marked interrupted`.
4. **Overlapping triggers** (schedule due while Refresh and Run now are pending) produce one run. Test: Task 5 `one run per job at a time`.
5. **CI failures on platforms we cannot sign into.** Test: Task 0 annotation script.

---

### Task 0: CI failures as annotations

GitHub shows job logs only to signed-in users, but check-run annotations are public. A Node 24 / Windows job failed after step 2 and its log is unreadable here.

**Files:**
- Create: `scripts/ci-annotate.mjs`
- Modify: `package.json` (script `test:ci`), `.github/workflows/ci.yml` (run `test:ci`; annotate on failure)
- Test: new `tests/scripts/ci-annotate.test.js`

**Interfaces:**
- Produces: `annotationsFromTap(text) -> string[]` (GitHub `::error title=…::…` lines for failed leaf tests).

- [ ] **Step 1: Write the failing test** `tests/scripts/ci-annotate.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationsFromTap } from '../../scripts/ci-annotate.mjs';

const TAP = [
  'TAP version 13',
  '# Subtest: tests/a.test.js',
  '    not ok 1 - adds numbers',
  '      ---',
  '      duration_ms: 1.2',
  "      location: 'C:\\\\repo\\\\tests\\\\a.test.js:5:1'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        Expected values to be strictly equal:',
  '        ',
  '        1 !== 2',
  "      code: 'ERR_ASSERTION'",
  '      ...',
  '    ok 2 - passes',
  'not ok 1 - tests/a.test.js',
  '  ---',
  "  failureType: 'subtestsFailed'",
  '  ...',
].join('\n');

test('failed leaf tests become GitHub error annotations with their message and location; file rollups are skipped', () => {
  const lines = annotationsFromTap(TAP);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=adds numbers::/);
  assert.match(lines[0], /Expected values to be strictly equal:%0A%0A1 !== 2/);
  assert.match(lines[0], /a\.test\.js:5:1/);
  assert.deepEqual(annotationsFromTap('TAP version 13\nok 1 - fine\n'), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/scripts/ci-annotate.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement** `scripts/ci-annotate.mjs`

```js
#!/usr/bin/env node
// Turns failed tests in a node:test TAP file into GitHub Actions error annotations, which are
// readable without signing in (job logs are not):  node scripts/ci-annotate.mjs test-results.tap
import fs from 'node:fs';

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotationsFromTap(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const yaml = [];
    if (lines[i + 1] && lines[i + 1].trim() === '---') {
      for (let j = i + 2; j < lines.length && lines[j].trim() !== '...'; j += 1) yaml.push(lines[j].slice(indent + 2));
    }
    const field = (name) => { const l = yaml.find((y) => y.startsWith(`${name}:`)); return l ? l.slice(name.length + 1).trim().replace(/^'|'$/g, '') : null; };
    if (field('failureType') === 'subtestsFailed') continue;
    let message = '';
    const at = yaml.findIndex((y) => /^error:/.test(y));
    if (at >= 0) {
      const head = yaml[at].slice('error:'.length).trim();
      if (head && head !== '|-' && head !== '|') message = head.replace(/^'|'$/g, '');
      else message = yaml.slice(at + 1).filter((y) => /^\s{2}/.test(y) || y === '').map((y) => y.replace(/^\s{2}/, '')).join('\n').trim();
    }
    const location = (field('location') ?? '').replace(/\\\\/g, '\\');
    out.push(`::error title=${escProp(m[2])}::${esc(`${message || 'test failed'}${location ? `\n    at ${location}` : ''}`)}`);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('ci-annotate.mjs')) {
  const file = process.argv[2] ?? 'test-results.tap';
  if (fs.existsSync(file)) for (const line of annotationsFromTap(fs.readFileSync(file, 'utf8')).slice(0, 25)) console.log(line);
  else console.log(`::warning::no TAP file at ${file}`);
}
```

`package.json` scripts: `"test:ci": "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=test-results.tap \"tests/**/*.test.js\""`.

`.github/workflows/ci.yml`, test job: replace `run: npm test` with `run: npm run test:ci` and add after it:

```yaml
      - name: Publish failing tests as annotations
        if: failure()
        run: node scripts/ci-annotate.mjs test-results.tap
```

Add `test-results.tap` to `.gitignore`.

- [ ] **Step 4: Run to verify**

Run: `node --test tests/scripts/ci-annotate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-annotate.mjs tests/scripts/ci-annotate.test.js package.json .github/workflows/ci.yml .gitignore
git commit -m "ci: publish failing tests as annotations readable without signing in"
```

---

### Task 1: TOML array tables

**Files:**
- Modify: `src/config/toml.js` (`parseToml` accepts top-level `[[name]]`; `stringifyToml` emits them)
- Test: `tests/config/toml.test.js`

**Interfaces:**
- Produces: `parseToml` returns `root[name] = [ {…}, … ]` for `[[name]]`; `stringifyToml` writes arrays of plain tables at the top level as `[[name]]` blocks.

- [ ] **Step 1: Write the failing test** (append)

```js
test('top-level array tables parse in order and round-trip through stringifyToml', () => {
  const text = 'store_path = "/q"\n\n[[schedule]]\nname = "reconcile"\nevery = "2h"\njob = "reconcile"\n\n[[schedule]]\nname = "evening"\ncron = "30 19 * * 1-5"\njob = "reconcile"\nenabled = false\n';
  const cfg = parseToml(text);
  assert.deepEqual(cfg.schedule, [{ name: 'reconcile', every: '2h', job: 'reconcile' }, { name: 'evening', cron: '30 19 * * 1-5', job: 'reconcile', enabled: false }]);
  assert.deepEqual(parseToml(stringifyToml(cfg)), cfg);
  assert.throws(() => parseToml('schedule = ["x"]\n[[schedule]]\nname = "a"\n'), /collides/);
  assert.throws(() => parseToml('[[a.b]]\n'), /top-level/);
  assert.throws(() => parseToml('[[schedule]\n'), /malformed/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/config/toml.test.js`
Expected: FAIL with `array tables are not supported`.

- [ ] **Step 3: Implement** in `src/config/toml.js`

In `parseToml`, replace the `[[` rejection with:

```js
    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) throw unsupported(rawLine, lineNo, 'malformed array table header');
      const name = line.slice(2, -2).trim();
      if (!KEY_RE.test(name)) throw unsupported(rawLine, lineNo, 'array tables must have a simple top-level name');
      if (root[name] === undefined) root[name] = [];
      if (!Array.isArray(root[name]) || root[name].some((x) => !isTable(x))) throw unsupported(rawLine, lineNo, 'array table name collides with a value');
      table = {};
      root[name].push(table);
      return;
    }
```

In `emitTable`:

```js
const isTableArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isTable);

function emitTable(obj, prefix, out) {
  const scalars = Object.entries(obj).filter(([, v]) => !isTable(v) && !isTableArray(v) && v !== undefined && v !== null);
  const tables = Object.entries(obj).filter(([, v]) => isTable(v));
  const arrays = Object.entries(obj).filter(([, v]) => isTableArray(v));
  if (prefix.length) out.push(`[${prefix.join('.')}]`);
  for (const [k, v] of scalars) out.push(`${k} = ${formatValue(v)}`);
  if (prefix.length || scalars.length) out.push('');
  for (const [k, v] of tables) emitTable(v, [...prefix, k], out);
  for (const [k, items] of arrays) {
    if (prefix.length) throw new TrackerError('toml-unsupported', 'array tables are only supported at the top level');
    for (const item of items) {
      out.push(`[[${k}]]`);
      for (const [ik, iv] of Object.entries(item)) {
        if (iv === undefined || iv === null) continue;
        if (isTable(iv) || isTableArray(iv)) throw new TrackerError('toml-unsupported', 'nested tables inside array tables are not supported');
        out.push(`${ik} = ${formatValue(iv)}`);
      }
      out.push('');
    }
  }
}
```

- [ ] **Step 4: Run to verify** — `node --test tests/config/toml.test.js tests/config/config.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(config): TOML array tables for [[schedule]]"` (files: `src/config/toml.js tests/config/toml.test.js`).

---

### Task 2: Cron and interval evaluation

**Files:**
- Create: `src/schedule/cron.js`
- Test: new `tests/schedule/cron.test.js`

**Interfaces:**
- Produces: `parseCron(expr) -> CronSpec` (throws `TrackerError('schedule-invalid')`); `nextAfter(spec, afterMs, timeZone) -> ms | null` (strictly after; null when it never fires within five years); `zonedToUtc(y, m, d, h, mi, tz) -> ms | null` (null in a DST gap); `parseInterval(text) -> ms`.

- [ ] **Step 1: Write the failing test** `tests/schedule/cron.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextAfter, parseInterval } from '../../src/schedule/cron.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString().replace('.000Z', 'Z'));

test('parseCron accepts lists, ranges, steps and names, and rejects malformed fields', () => {
  assert.doesNotThrow(() => parseCron('0 */2 * * *'));
  assert.doesNotThrow(() => parseCron('5,35 9-17/2 1-15 JAN-MAR mon-fri'));
  for (const bad of ['* * *', '60 * * * *', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '0 0 * 13 *', '0 0 * * 8']) {
    assert.throws(() => parseCron(bad), (e) => e.code === 'schedule-invalid', bad);
  }
});

test('nextAfter is strictly after the reference, in UTC and in an offset time zone', () => {
  const every2h = parseCron('0 */2 * * *');
  assert.equal(iso(nextAfter(every2h, at('2026-10-02T09:15:00Z'), 'UTC')), '2026-10-02T10:00:00Z');
  assert.equal(iso(nextAfter(every2h, at('2026-10-02T10:00:00Z'), 'UTC')), '2026-10-02T12:00:00Z');
  const weekdayEvening = parseCron('30 19 * * 1-5');
  // 2026-10-02 is a Friday; 19:30 in Kolkata (UTC+05:30) is 14:00 UTC.
  assert.equal(iso(nextAfter(weekdayEvening, at('2026-10-02T00:00:00Z'), 'Asia/Kolkata')), '2026-10-02T14:00:00Z');
  assert.equal(iso(nextAfter(weekdayEvening, at('2026-10-02T14:00:00Z'), 'Asia/Kolkata')), '2026-10-05T14:00:00Z', 'the weekend is skipped');
});

test('a wall time that does not exist on a DST change is skipped, and day-of-month OR day-of-week applies', () => {
  const twoThirty = parseCron('30 2 * * *');
  // New York springs forward on Sunday 2026-03-08: 02:30 does not exist that day.
  assert.equal(iso(nextAfter(twoThirty, at('2026-03-07T12:00:00Z'), 'America/New_York')), '2026-03-09T06:30:00Z');
  const thirteenthOrFriday = parseCron('0 0 13 * 5');
  assert.equal(iso(nextAfter(thirteenthOrFriday, at('2026-10-02T00:30:00Z'), 'UTC')), '2026-10-09T00:00:00Z');
  assert.equal(nextAfter(parseCron('0 0 30 2 *'), at('2026-10-02T00:00:00Z'), 'UTC'), null, 'February 30th never comes');
});

test('nextAfter for every minute is quick; parseInterval takes minutes, hours or days', () => {
  const started = process.hrtime.bigint();
  assert.equal(iso(nextAfter(parseCron('* * * * *'), at('2026-10-02T09:15:30Z'), 'Asia/Kolkata')), '2026-10-02T09:16:00Z');
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 100);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('30m'), 1_800_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  for (const bad of ['0m', '1s', 'often', '']) assert.throws(() => parseInterval(bad), (e) => e.code === 'schedule-invalid', bad);
});
```

- [ ] **Step 2: Run it to verify it fails** — `node --test tests/schedule/cron.test.js` → FAIL (`Cannot find module`).

- [ ] **Step 3: Implement** `src/schedule/cron.js`

```js
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
    if (range === '*') { lo = field.min; hi = field.max; } else if (range.includes('-')) {
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
```

- [ ] **Step 4: Run to verify** — `node --test tests/schedule/cron.test.js` → PASS, 4 tests.
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): dependency-free cron and interval evaluation in the store time zone"`.

---

### Task 3: Schedule config

**Files:**
- Create: `src/schedule/config.js`
- Test: new `tests/schedule/config.test.js`

**Interfaces:**
- Consumes: `parseCron`, `nextAfter`, `parseInterval` (Task 2).
- Produces: `JOBS = ['reconcile']`, `PLANNED_JOBS`, `defaultSchedules(config)`, `normalizeSchedules(config, { timeZone, now }) -> { schedules: Schedule[], warnings }`; `Schedule = { name, job, cron, every, spec, interval_ms, enabled }`.

- [ ] **Step 1: Write the failing test** `tests/schedule/config.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedules, defaultSchedules } from '../../src/schedule/config.js';

const NOW = Date.parse('2026-10-02T08:00:00Z');

test('with no [[schedule]] the reconcile job runs every sync_interval_hours, as before', () => {
  assert.deepEqual(normalizeSchedules({ sync_interval_hours: 3 }).schedules.map((s) => [s.name, s.job, s.every, s.interval_ms, s.enabled]), [['reconcile', 'reconcile', '3h', 3 * 3_600_000, true]]);
  assert.equal(defaultSchedules({}).at(0).every, '2h');
});

test('schedules are validated; planned jobs and broken entries are reported and skipped', () => {
  const { schedules, warnings } = normalizeSchedules({ schedule: [
    { name: 'reconcile', job: 'reconcile', every: '2h' },
    { name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5' },
    { name: 'paused', job: 'reconcile', every: '1d', enabled: false },
    { name: 'daily-digest', job: 'digest', cron: '30 19 * * 1-5' },
    { name: 'bad-cron', job: 'reconcile', cron: '61 * * * *' },
    { name: 'both', job: 'reconcile', cron: '* * * * *', every: '1h' },
    { name: 'evening', job: 'reconcile', every: '1h' },
    { name: 'Bad Name', job: 'reconcile', every: '1h' },
    { name: 'mystery', job: 'mine-bitcoin', every: '1h' },
    { name: 'never', job: 'reconcile', cron: '0 0 30 2 *' },
  ] }, { timeZone: 'UTC', now: NOW });
  assert.deepEqual(schedules.map((s) => [s.name, s.enabled]), [['reconcile', true], ['evening', true], ['paused', false]]);
  assert.equal(schedules[1].cron, '30 19 * * 1-5');
  const text = warnings.join('\n');
  for (const expected of [/daily-digest.*later release/, /bad-cron.*minute/, /both.*exactly one/, /evening.*duplicate/, /lowercase/, /mystery.*unknown job/, /never.*never fires/]) assert.match(text, expected);
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (`Cannot find module`).

- [ ] **Step 3: Implement** `src/schedule/config.js`

```js
// [[schedule]] tables from user config (ADR 0007). Repository config cannot schedule jobs.
import { parseCron, parseInterval, nextAfter } from './cron.js';

export const JOBS = ['reconcile'];
// Named by the zero-command proposal and accepted in config so later releases need no migration.
export const PLANNED_JOBS = ['stale-sweep', 'digest', 'publish', 'agent', 'tracker-sync'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function defaultSchedules(config = {}) {
  const hours = Number.isInteger(config.sync_interval_hours) && config.sync_interval_hours > 0 ? config.sync_interval_hours : 2;
  return [{ name: 'reconcile', job: 'reconcile', cron: null, every: `${hours}h`, spec: null, interval_ms: hours * 3_600_000, enabled: true }];
}

export function normalizeSchedules(config = {}, { timeZone = 'UTC', now = Date.now() } = {}) {
  if (config.schedule === undefined) return { schedules: defaultSchedules(config), warnings: [] };
  if (!Array.isArray(config.schedule)) return { schedules: defaultSchedules(config), warnings: ['[[schedule]] must be a list of tables; using the default reconcile schedule'] };
  const schedules = [];
  const warnings = [];
  const names = new Set();
  config.schedule.forEach((raw, i) => {
    const where = `schedule ${raw && typeof raw.name === 'string' ? `"${raw.name}"` : `#${i + 1}`}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warnings.push(`${where}: must be a table`); return; }
    if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) { warnings.push(`${where}: name must use lowercase letters, digits and dashes`); return; }
    if (names.has(raw.name)) { warnings.push(`${where}: duplicate name; ignored`); return; }
    if (PLANNED_JOBS.includes(raw.job)) { warnings.push(`${where}: job "${raw.job}" arrives in a later release; skipped`); return; }
    if (!JOBS.includes(raw.job)) { warnings.push(`${where}: unknown job "${raw.job}"; available jobs: ${JOBS.join(', ')}`); return; }
    if ((raw.cron === undefined) === (raw.every === undefined)) { warnings.push(`${where}: set exactly one of cron or every`); return; }
    try {
      const enabled = raw.enabled !== false;
      if (raw.cron !== undefined) {
        const spec = parseCron(raw.cron);
        if (nextAfter(spec, now, timeZone) === null) throw new Error('this cron expression never fires');
        schedules.push({ name: raw.name, job: raw.job, cron: spec.expr, every: null, spec, interval_ms: null, enabled });
      } else {
        schedules.push({ name: raw.name, job: raw.job, cron: null, every: String(raw.every).trim(), spec: null, interval_ms: parseInterval(raw.every), enabled });
      }
      names.add(raw.name);
    } catch (err) {
      warnings.push(`${where}: ${err.message}`);
    }
  });
  return { schedules, warnings };
}
```

- [ ] **Step 4: Run to verify** — `node --test tests/schedule/config.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): [[schedule]] config with defaults and validation"`.

---

### Task 4: `schedule-run` events

**Files:**
- Modify: `src/core/events.js` (`schedule-run` kind), `src/core/state.js` (`schedules: new Map()`), `src/core/reducer.js` (`applyScheduleRun`, `SCHEDULE_HISTORY = 20`)
- Test: new `tests/schedule/schedule-run.test.js`

**Interfaces:**
- Produces: event payload `{ schedule, job, run_id, phase: 'started' | 'finished', trigger?, outcome?, summary?, error? }`; `state.schedules.get(name) = { name, job, last_started_at, last_finished_at, last_outcome, last_error, last_summary, running_run_id, runs: [{ run_id, trigger, started_at, finished_at, outcome, summary, error }] }` (newest first, at most 20).

- [ ] **Step 1: Write the failing test** `tests/schedule/schedule-run.test.js`

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, ev, resetSeq } from '../core/helpers.js';

beforeEach(() => resetSeq());
const run = (state, phase, run_id, extra = {}, at = '2026-10-02T08:00:00Z') => ev(state, 'schedule-run', { schedule: 'reconcile', job: 'reconcile', run_id, phase, ...extra }, { producer: 'worker', occurred_at: at });

test('started and finished runs are folded into the schedule record, newest first', () => {
  const state = newState();
  run(state, 'started', 'r1', { trigger: 'schedule' });
  const rec = state.schedules.get('reconcile');
  assert.equal(rec.running_run_id, 'r1');
  assert.equal(rec.runs[0].outcome, 'running');
  run(state, 'finished', 'r1', { outcome: 'ok', summary: '3 PR checks' }, '2026-10-02T08:00:05Z');
  assert.deepEqual([rec.running_run_id, rec.last_outcome, rec.last_summary, rec.last_started_at, rec.last_finished_at], [null, 'ok', '3 PR checks', '2026-10-02T08:00:00Z', '2026-10-02T08:00:05Z']);
  run(state, 'started', 'r2', { trigger: 'manual' }, '2026-10-02T09:00:00Z');
  run(state, 'finished', 'r2', { outcome: 'failed', error: 'gh: offline' }, '2026-10-02T09:00:01Z');
  assert.deepEqual(rec.runs.map((r) => [r.run_id, r.trigger, r.outcome, r.error]), [['r2', 'manual', 'failed', 'gh: offline'], ['r1', 'schedule', 'ok', null]]);
});

test('history is capped at 20 runs; malformed payloads are rejected', () => {
  const state = newState();
  for (let i = 0; i < 25; i += 1) { run(state, 'started', `r${i}`); run(state, 'finished', `r${i}`, { outcome: 'ok' }); }
  assert.equal(state.schedules.get('reconcile').runs.length, 20);
  assert.equal(state.schedules.get('reconcile').runs[0].run_id, 'r24');
  assert.equal(ev(state, 'schedule-run', { phase: 'started' }, { producer: 'worker' }).rejected, 'schedule-invalid');
  assert.equal(run(state, 'paused', 'x').rejected, 'schedule-invalid');
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (`unknown event kind` or missing map).

- [ ] **Step 3: Implement**
- `src/core/events.js`: add `'schedule-run'` to `EVENT_KINDS`.
- `src/core/state.js` `createState`: add `schedules: new Map(),`.
- `src/core/reducer.js`:

```js
export const SCHEDULE_HISTORY = 20;

// Every scheduled or manual job run is journaled, so the Schedules panel and replay agree (ADR 0007).
function applyScheduleRun(state, ev) {
  const p = ev.payload;
  if (!p || typeof p.schedule !== 'string' || typeof p.run_id !== 'string' || !['started', 'finished'].includes(p.phase)) return { rejected: 'schedule-invalid' };
  let rec = state.schedules.get(p.schedule);
  if (!rec) {
    rec = { name: p.schedule, job: p.job ?? null, last_started_at: null, last_finished_at: null, last_outcome: null, last_error: null, last_summary: null, running_run_id: null, runs: [] };
    state.schedules.set(p.schedule, rec);
  }
  if (p.phase === 'started') {
    rec.job = p.job ?? rec.job;
    rec.last_started_at = ev.occurred_at;
    rec.running_run_id = p.run_id;
    rec.runs.unshift({ run_id: p.run_id, trigger: p.trigger ?? 'schedule', started_at: ev.occurred_at, finished_at: null, outcome: 'running', summary: null, error: null });
    if (rec.runs.length > SCHEDULE_HISTORY) rec.runs.length = SCHEDULE_HISTORY;
    return {};
  }
  const runRec = rec.runs.find((r) => r.run_id === p.run_id);
  if (runRec) Object.assign(runRec, { finished_at: ev.occurred_at, outcome: p.outcome ?? 'ok', summary: p.summary ?? null, error: p.error ?? null });
  rec.last_finished_at = ev.occurred_at;
  rec.last_outcome = p.outcome ?? 'ok';
  rec.last_error = p.error ?? null;
  rec.last_summary = p.summary ?? null;
  if (rec.running_run_id === p.run_id) rec.running_run_id = null;
  return {};
}
```

  and in `applyEventInner`: `case 'schedule-run': Object.assign(result, applyScheduleRun(state, ev)); break;`

- [ ] **Step 4: Run to verify** — `node --test tests/schedule/schedule-run.test.js tests/core/reducer.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(core): journal schedule runs and fold them into schedule records"`.

---

### Task 5: Scheduler extension, reconcile job, `run-job` requests

**Files:**
- Create: `src/schedule/jobs.js` (`createJobs`), `src/schedule/extension.js` (`createSchedulerExtension`)
- Modify: `src/reconcile/extension.js` (re-export), `src/server/requests.js` (`run-job` kind), `src/worker/worker.js` (`snapshotOptions` passes `schedules` and `next_sync_due`; `refreshIdentity` also reloads `schedule`), `src/worker/projections.js` (snapshot `schedules`; `buildMeta` accepts `next_sync_due`)
- Test: new `tests/schedule/extension.test.js`

**Interfaces:**
- Consumes: Tasks 2–4; `runReconciliation` (`src/reconcile/run.js`); `defaultProviders` (`src/reconcile/providers/index.js`, Task 6 adds `env`).
- Produces:
  - `createSchedulerExtension(ctx, { providers, jobs, stopWaitMs = 5000 })` with `name: 'reconcile'`, `idle()`, `onStart`, `tick`, `onStop`; sets `worker.scheduleInfo = () => ScheduleInfo[]`.
  - `ScheduleInfo = { name, job, cron, every, enabled, running, next_due, last_started_at, last_finished_at, last_outcome, last_error, last_summary, runs }` (runs: newest 10).
  - Request `{ kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule } }`, no delay; unknown names are refused with `schedule-unknown`.
  - Snapshot: top-level `schedules: ScheduleInfo[]`; `meta.next_sync_due` comes from the enabled reconcile schedule when a scheduler is attached.

- [ ] **Step 1: Write the failing test** `tests/schedule/extension.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from '../../src/worker/worker.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { createSchedulerExtension } from '../../src/schedule/extension.js';
import { submitRequest } from '../../src/server/requests.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath } from '../../src/lib/paths.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';

function fixture({ schedule, timezone = 'UTC', start = '2026-10-02T08:00:00Z' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sched-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const config = { ...defaultUserConfig(), store_path: storePath, timezone, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: {} };
  if (schedule) config.schedule = schedule;
  const env = { QUILL_HOME: home };
  saveUserConfig(config, env);
  let nowMs = Date.parse(start);
  return { home, meta, config, env, clock: () => nowMs, set: (iso) => { nowMs = Date.parse(iso); }, advance: (ms) => { nowMs += ms; } };
}

function fakeJobs() {
  const calls = [];
  let gate = null;
  return {
    calls,
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    jobs: { async reconcile(worker, { run_id, reason }) { calls.push({ run_id, reason }); if (gate) await gate; return { summary: `run ${calls.length}` }; } },
  };
}

async function boot(f, fake, extra = {}) {
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, ...extra });
  const ext = createSchedulerExtension({ env: f.env, config: f.config }, { jobs: fake.jobs, stopWaitMs: 0 });
  w.use(ext);
  await w.start();
  return { w, ext, tick: async () => { w.tick(); await ext.idle(); w.tick(); } };
}

test('a cron schedule runs at its slot in the store time zone, journals start and finish, and reports next and last runs', async () => {
  const f = fixture({ timezone: 'Asia/Kolkata', start: '2026-10-02T13:00:00Z', schedule: [{ name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5' }] });
  const fake = fakeJobs();
  const { w, tick } = await boot(f, fake);
  try {
    await tick();
    assert.equal(fake.calls.length, 0, '18:30 in Kolkata is before the slot');
    f.set('2026-10-02T14:00:00Z');
    await tick();
    assert.equal(fake.calls.length, 1);
    const rec = w.state.schedules.get('evening');
    assert.deepEqual([rec.last_outcome, rec.last_summary, rec.runs[0].trigger], ['ok', 'run 1', 'schedule']);
    const info = w.scheduleInfo().find((s) => s.name === 'evening');
    assert.equal(info.next_due, '2026-10-05T14:00:00Z', 'next weekday evening');
    assert.equal(w.snapshotOptions().next_sync_due, '2026-10-05T14:00:00Z');
    const j = new Journal(journalPath(f.env));
    j.open();
    assert.deepEqual([...j.read()].filter((e) => e.kind === 'schedule-run').map((e) => e.payload.phase), ['started', 'finished']);
    j.close();
  } finally { await w.stop(); }
});

test('missed slots while the worker was down catch up once on start, never repeatedly', async () => {
  const f = fixture({ start: '2026-10-02T07:59:00Z', schedule: [{ name: 'hourly', job: 'reconcile', cron: '0 * * * *' }] });
  const fake = fakeJobs();
  const first = await boot(f, fake);
  f.set('2026-10-02T08:00:00Z');
  await first.tick();
  assert.equal(fake.calls.length, 1);
  await first.w.stop();
  f.set('2026-10-02T13:30:00Z');
  const second = await boot(f, fake);
  try {
    await second.tick();
    await second.tick();
    assert.equal(fake.calls.length, 2, 'five missed slots, one catch-up run');
    assert.equal(second.w.state.schedules.get('hourly').runs[0].trigger, 'catch-up');
    assert.equal(second.w.scheduleInfo()[0].next_due, '2026-10-02T14:00:00Z');
  } finally { await second.w.stop(); }
});

test('one run per job at a time: Run now and Refresh queued during a run join the next run of that job', async () => {
  const f = fixture({ schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }] });
  const fake = fakeJobs();
  const release = fake.hold();
  const { w, ext, tick } = await boot(f, fake);
  try {
    w.tick();
    assert.equal(fake.calls.length, 1, 'never run: due at start');
    const manual = submitRequest(w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'reconcile' } }).request;
    assert.equal(manual.not_before, manual.created_at, 'Run now has no undo delay');
    const refresh = submitRequest(w, { id: randomUUID(), kind: 'refresh', target_id: null, expected_revision: null, payload: {} }).request;
    w.tick();
    assert.equal(fake.calls.length, 1, 'the job is still running');
    release();
    await ext.idle();
    await tick();
    assert.equal(fake.calls.length, 2);
    assert.deepEqual([w.state.requests.get(manual.id).state, w.state.requests.get(refresh.id).state], ['applied', 'applied']);
    assert.equal(w.state.requests.get(manual.id).result.run_id, w.state.requests.get(refresh.id).result.run_id);
    assert.throws(() => submitRequest(w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'nope' } }), (e) => e.code === 'schedule-unknown');
  } finally { await w.stop(); }
});

test('an unfinished run is marked interrupted on the next start; a failing job records its error and fails its request', async () => {
  const f = fixture({ schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }] });
  const stuck = fakeJobs();
  stuck.hold();
  const first = await boot(f, stuck);
  first.w.tick();
  await first.w.stop();
  const failing = { calls: [], jobs: { async reconcile() { throw new Error('gh: offline'); } } };
  const second = await boot(f, failing);
  try {
    const rec = second.w.state.schedules.get('reconcile');
    assert.equal(rec.runs.find((r) => r.outcome === 'interrupted').error, 'the worker stopped before this run finished');
    const req = submitRequest(second.w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'reconcile' } }).request;
    await second.tick();
    assert.deepEqual([rec.last_outcome, rec.last_error], ['failed', 'gh: offline']);
    const failed = second.w.state.requests.get(req.id);
    assert.deepEqual([failed.state, failed.error.retryable], ['failed', true]);
  } finally { await second.w.stop(); }
});

test('invalid schedules are reported as health warnings; editing [[schedule]] applies without a restart', async () => {
  const f = fixture({ schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }, { name: 'digest', job: 'digest', cron: '30 19 * * *' }] });
  const fake = fakeJobs();
  const { w } = await boot(f, fake, { identityCheckMs: 0 });
  try {
    assert.match(fs.readFileSync(path.join(f.home, 'state', 'health-errors.jsonl'), 'utf8'), /digest.*later release/);
    assert.deepEqual(w.scheduleInfo().map((s) => s.name), ['reconcile']);
    saveUserConfig({ ...f.config, schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }, { name: 'evening', job: 'reconcile', cron: '0 19 * * *' }] }, f.env);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(f.home, 'config.toml'), later, later);
    w.tick();
    assert.deepEqual(w.scheduleInfo().map((s) => s.name), ['reconcile', 'evening']);
  } finally { await w.stop(); }
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (`Cannot find module`).

- [ ] **Step 3: Implement**

`src/schedule/jobs.js`:

```js
// Job implementations for the scheduler; each returns a short summary for the Schedules panel.
import { runReconciliation } from '../reconcile/run.js';

export function createJobs({ providers }) {
  return {
    async reconcile(worker, { run_id, reason }) {
      const r = await runReconciliation(worker, { reason, providers, run_id });
      const errors = r.provider_health.filter((h) => h.error).length;
      const checks = r.pr_updates.length;
      return { summary: `${checks} PR check${checks === 1 ? '' : 's'}${errors ? `, ${errors} provider error${errors === 1 ? '' : 's'}` : ''}`, last_sync: r.last_sync };
    },
  };
}
```

`src/schedule/extension.js`:

```js
// Runs named jobs on cron or interval schedules in the store time zone. Missed slots catch up once,
// each job runs one at a time, and every run is journaled as schedule-run events (ADR 0007).
import { uuid } from '../lib/ids.js';
import { toIso } from '../lib/time.js';
import { normalizeSchedules } from './config.js';
import { nextAfter } from './cron.js';
import { createJobs } from './jobs.js';
import { defaultProviders } from '../reconcile/providers/index.js';

const CATCH_UP_SLACK_MS = 60_000;

export function createSchedulerExtension(ctx, { providers, jobs, stopWaitMs = 5000 } = {}) {
  const impl = jobs ?? createJobs({ providers: providers ?? defaultProviders(ctx.config, ctx.env) });
  let schedules = [];
  let loadedFrom;
  let baselineMs = null;
  const running = new Map();
  const nextCache = new Map();

  const tz = (worker) => worker.state.meta.timezone || 'UTC';

  function load(worker) {
    loadedFrom = worker.config.schedule;
    const { schedules: list, warnings } = normalizeSchedules(worker.config, { timeZone: tz(worker), now: worker.clock() });
    schedules = list;
    nextCache.clear();
    for (const w of warnings) { worker.log(`schedules: ${w}`); worker.recordHealthError({ kind: 'config-invalid', error: `schedules: ${w}` }); }
  }

  function lastRef(worker, s) {
    const rec = worker.state.schedules.get(s.name);
    if (rec && rec.last_started_at) return Date.parse(rec.last_started_at);
    if (s.job === 'reconcile' && worker.state.lastSync) return Date.parse(worker.state.lastSync);
    return null;
  }

  // 0 means due now (an interval schedule that has never run).
  function nextDueMs(worker, s) {
    if (!s.enabled) return null;
    const ref = lastRef(worker, s);
    if (s.interval_ms) return ref === null ? 0 : ref + s.interval_ms;
    const base = ref ?? baselineMs;
    const key = `${base}:${tz(worker)}`;
    const cached = nextCache.get(s.name);
    if (cached && cached.key === key) return cached.next;
    const next = nextAfter(s.spec, base, tz(worker));
    nextCache.set(s.name, { key, next });
    return next;
  }

  function scheduleForRequest(r) {
    if (r.kind === 'refresh') return schedules.find((s) => s.job === 'reconcile') ?? { name: 'reconcile', job: 'reconcile', enabled: false };
    return schedules.find((s) => s.name === (r.payload && r.payload.schedule)) ?? null;
  }

  function start(worker, s, trigger, requests) {
    const run_id = uuid();
    for (const r of requests) worker.emit('request-tx', { request_id: r.id, outcome: 'applying' }, { source_identity: `request-tx:${r.id}:applying` });
    worker.emit('schedule-run', { schedule: s.name, job: s.job, run_id, phase: 'started', trigger }, { source_identity: `schedule-run:${run_id}:started` });
    const reason = trigger === 'refresh' ? 'refresh' : trigger === 'manual' ? 'manual' : 'scheduled';
    const promise = (async () => {
      let outcome = 'ok';
      let summary = null;
      let error = null;
      let result = {};
      try {
        result = (await impl[s.job](worker, { run_id, reason, schedule: s.name })) ?? {};
        summary = result.summary ?? null;
      } catch (err) {
        outcome = 'failed';
        error = err.message;
        worker.log(`job ${s.job} (${s.name}) failed: ${err.stack ?? err.message}`);
      }
      worker.emit('schedule-run', { schedule: s.name, job: s.job, run_id, phase: 'finished', outcome, summary, error }, { source_identity: `schedule-run:${run_id}:finished` });
      for (const r of requests) {
        if (outcome === 'ok') worker.emit('request-tx', { request_id: r.id, outcome: 'applied', result: { run_id, last_sync: result.last_sync ?? null }, mutation: { type: 'refresh' } }, { source_identity: `request-tx:${r.id}:applied` });
        else worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: s.job === 'reconcile' ? 'reconcile-failed' : 'job-failed', message: error, retryable: true, current_revision: null } }, { source_identity: `request-tx:${r.id}:failed` });
      }
      worker.markGenerationDirty();
    })().finally(() => { running.delete(s.job); });
    running.set(s.job, { promise, run_id, schedule: s.name });
  }

  function info(worker) {
    return schedules.map((s) => {
      const rec = worker.state.schedules.get(s.name);
      const next = nextDueMs(worker, s);
      const job = running.get(s.job);
      return {
        name: s.name, job: s.job, cron: s.cron, every: s.every, enabled: s.enabled, running: !!(job && job.schedule === s.name),
        next_due: next === null ? null : toIso(next === 0 ? worker.clock() : next),
        last_started_at: rec ? rec.last_started_at : null, last_finished_at: rec ? rec.last_finished_at : null, last_outcome: rec ? rec.last_outcome : null,
        last_error: rec ? rec.last_error : null, last_summary: rec ? rec.last_summary : null, runs: rec ? rec.runs.slice(0, 10) : [],
      };
    });
  }

  return {
    name: 'reconcile',
    get activeRunId() { const r = running.get('reconcile'); return r ? r.run_id : null; },
    idle: () => Promise.all([...running.values()].map((r) => r.promise)).then(() => {}),
    async onStart(worker) {
      baselineMs = worker.clock();
      load(worker);
      worker.scheduleInfo = () => info(worker);
      for (const rec of worker.state.schedules.values()) {
        if (rec.running_run_id) worker.emit('schedule-run', { schedule: rec.name, job: rec.job, run_id: rec.running_run_id, phase: 'finished', outcome: 'interrupted', error: 'the worker stopped before this run finished' }, { source_identity: `schedule-run:${rec.running_run_id}:interrupted` });
      }
    },
    tick(worker) {
      if (baselineMs === null) return;
      if (worker.config.schedule !== loadedFrom) load(worker);
      const nowMs = worker.clock();
      const nowIso = toIso(nowMs);
      const batches = new Map();
      for (const r of worker.state.requests.values()) {
        if ((r.kind !== 'refresh' && r.kind !== 'run-job') || r.state !== 'pending' || (r.not_before ?? nowIso) > nowIso) continue;
        const s = scheduleForRequest(r);
        if (!s) {
          worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: 'schedule-unknown', message: `no schedule named ${r.payload && r.payload.schedule}`, retryable: false, current_revision: null } }, { source_identity: `request-tx:${r.id}:failed` });
          continue;
        }
        if (running.has(s.job)) continue;
        if (!batches.has(s.job)) batches.set(s.job, { s, trigger: r.kind === 'refresh' ? 'refresh' : 'manual', requests: [] });
        batches.get(s.job).requests.push(r);
      }
      for (const b of batches.values()) start(worker, b.s, b.trigger, b.requests);
      for (const s of schedules) {
        if (!s.enabled || running.has(s.job)) continue;
        const next = nextDueMs(worker, s);
        if (next === null || nowMs < next) continue;
        start(worker, s, next !== 0 && nowMs - next > CATCH_UP_SLACK_MS ? 'catch-up' : 'schedule', []);
      }
    },
    async onStop() {
      if (!running.size || stopWaitMs <= 0) return;
      await Promise.race([Promise.all([...running.values()].map((r) => r.promise)), new Promise((r) => setTimeout(r, stopWaitMs).unref())]);
    },
  };
}
```

`src/reconcile/extension.js` (whole file):

```js
// Reconciliation runs as the "reconcile" job of the schedule framework (ADR 0007); this module keeps
// the extension entry point the worker and tests load.
export { createSchedulerExtension as createExtension } from '../schedule/extension.js';
```

`src/server/requests.js`: add `'run-job'` to `KINDS`; give `validateRequestBody` a fourth parameter `{ scheduleNames = null } = {}` and a case:

```js
    case 'run-job': {
      if (typeof payload.schedule !== 'string' || !payload.schedule) throw new TrackerError('request-invalid', 'run-job needs payload.schedule');
      if (scheduleNames && !scheduleNames.includes(payload.schedule)) throw new TrackerError('schedule-unknown', `no schedule named ${payload.schedule}`);
      normalized = { schedule: payload.schedule };
      break;
    }
```

  `submitRequest` passes `{ scheduleNames: worker.scheduleInfo ? worker.scheduleInfo().map((s) => s.name) : null }`; `applyDueRequests` and `recoverApplying` skip `run-job` as they skip `refresh`.

`src/worker/projections.js`: `buildSnapshot` accepts `schedules = []` and `next_sync_due` and returns `schedules` beside `requests`; `buildMeta` accepts `next_sync_due` and uses it when it is not `undefined`.

`src/worker/worker.js` `snapshotOptions()` adds:

```js
    const schedules = this.scheduleInfo ? this.scheduleInfo() : null;
    const reconcile = schedules ? schedules.find((s) => s.job === 'reconcile' && s.enabled) : null;
    // ...existing fields, plus:
    schedules: schedules ?? [],
    next_sync_due: schedules ? (reconcile ? reconcile.next_due : null) : undefined,
```

  and `refreshIdentity` copies `schedule: fresh.schedule` into `this.config`.

- [ ] **Step 4: Run to verify**

Run: `node --test tests/schedule/extension.test.js tests/reconcile/run.test.js tests/server/http.test.js tests/server/requests.test.js tests/acceptance/phase3.test.js`
Expected: PASS (the existing scheduler test keeps the two-hour cadence, catch-up on first start and refresh joining).

- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): scheduler extension runs reconcile as a job; Run now requests"`.

---

### Task 6: Bitbucket provider

**Files:**
- Create: `src/reconcile/providers/bitbucket.js`
- Modify: `src/reconcile/providers/index.js` (`defaultProviders(config, env)`; `bitbucket` kind)
- Test: new `tests/reconcile/bitbucket.test.js`

**Interfaces:**
- Produces: `createBitbucketProvider({ baseUrl, tokenEnv = 'BITBUCKET_TOKEN', usernameEnv = null, env, fetchImpl, timeoutMs })`, `mapCloudPr(json)`, `mapServerPr(json)`; repository config fields `provider = "bitbucket"`, `provider_url` (Server/Data Center base; omit for Cloud), `token_env`, `username_env`.

- [ ] **Step 1: Write the failing test** `tests/reconcile/bitbucket.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBitbucketProvider, mapCloudPr, mapServerPr } from '../../src/reconcile/providers/bitbucket.js';
import { defaultProviders } from '../../src/reconcile/providers/index.js';

function recordingFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }; };
  return { calls, fetchImpl };
}

test('Cloud and Server PR JSON map to contract states and times', () => {
  assert.deepEqual(mapCloudPr({ state: 'OPEN', draft: true, created_on: '2026-09-30T08:00:00.716224+00:00', source: { branch: { name: 'feat/x' } }, destination: { branch: { name: 'main' } } }), { state: 'draft', opened_at: '2026-09-30T08:00:00Z', merged_at: null, base_branch: 'main', head_branch: 'feat/x' });
  assert.equal(mapCloudPr({ state: 'MERGED', updated_on: '2026-10-01T09:00:00+00:00' }).merged_at, '2026-10-01T09:00:00Z');
  assert.equal(mapCloudPr({ state: 'DECLINED' }).state, 'closed');
  assert.equal(mapCloudPr({ state: 'SUPERSEDED' }).state, 'closed');
  assert.deepEqual(mapServerPr({ state: 'MERGED', createdDate: Date.parse('2026-09-30T08:00:00Z'), closedDate: Date.parse('2026-10-01T10:30:00Z'), fromRef: { displayId: 'feat/y' }, toRef: { displayId: 'release' } }), { state: 'merged', opened_at: '2026-09-30T08:00:00Z', merged_at: '2026-10-01T10:30:00Z', base_branch: 'release', head_branch: 'feat/y' });
  assert.equal(mapServerPr({ state: 'OPEN' }).state, 'open');
});

test('Cloud polling calls the API with a bearer token, or basic auth with a username', async () => {
  const r = recordingFetch({ state: 'OPEN' });
  const p = createBitbucketProvider({ env: { BITBUCKET_TOKEN: 't0k' }, fetchImpl: r.fetchImpl });
  assert.equal((await p.fetchPr('https://bitbucket.org/acme/app/pull-requests/7')).state, 'open');
  assert.equal(r.calls[0].url, 'https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7');
  assert.equal(r.calls[0].init.headers.authorization, 'Bearer t0k');
  assert.equal(r.calls[0].init.redirect, 'error');
  const b = recordingFetch({ state: 'OPEN' });
  await createBitbucketProvider({ env: { BITBUCKET_TOKEN: 'pw', BB_USER: 'me' }, usernameEnv: 'BB_USER', fetchImpl: b.fetchImpl }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7/overview');
  assert.equal(b.calls[0].init.headers.authorization, `Basic ${Buffer.from('me:pw').toString('base64')}`);
});

test('the token is sent only to the configured host: lookalikes, http and foreign servers are refused without a request', async () => {
  const r = recordingFetch({ state: 'OPEN' });
  const cloud = createBitbucketProvider({ env: { BITBUCKET_TOKEN: 'secret' }, fetchImpl: r.fetchImpl });
  for (const url of ['https://bitbucket.org.evil.example/acme/app/pull-requests/7', 'http://bitbucket.org/acme/app/pull-requests/7', 'https://evil.example/projects/PM/repos/app/pull-requests/1']) {
    await assert.rejects(cloud.fetchPr(url), (e) => e.code === 'provider-error' && !e.message.includes('secret'), url);
  }
  const server = createBitbucketProvider({ baseUrl: 'https://bitbucket.example.com', env: { BITBUCKET_TOKEN: 'secret' }, fetchImpl: r.fetchImpl });
  await assert.rejects(server.fetchPr('https://other.example.com/projects/PM/repos/app/pull-requests/1'), /configured for https:\/\/bitbucket\.example\.com/);
  await assert.rejects(server.fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), /configured for https:\/\/bitbucket\.example\.com/);
  assert.equal(r.calls.length, 0);
  await assert.rejects(createBitbucketProvider({ baseUrl: 'http://bitbucket.example.com', env: {}, fetchImpl: r.fetchImpl }).fetchPr('http://bitbucket.example.com/projects/PM/repos/app/pull-requests/1'), /https/);
});

test('a missing token, an HTTP error or a timeout is a provider error that names the variable and never the token', async () => {
  const r = recordingFetch({});
  await assert.rejects(createBitbucketProvider({ env: {}, fetchImpl: r.fetchImpl }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), /set BITBUCKET_TOKEN/);
  assert.equal(r.calls.length, 0);
  const denied = recordingFetch({}, { status: 401 });
  await assert.rejects(createBitbucketProvider({ env: { BB: 'hunter2' }, tokenEnv: 'BB', fetchImpl: denied.fetchImpl }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), (e) => /HTTP 401 \(check BB\)/.test(e.message) && !e.message.includes('hunter2'));
  const slow = async (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
  await assert.rejects(createBitbucketProvider({ env: { BITBUCKET_TOKEN: 't' }, fetchImpl: slow, timeoutMs: 20 }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), /timed out/);
});

test('Server/Data Center polling works against a loopback server, and defaultProviders picks Bitbucket for a repository', async () => {
  let seen = null;
  const srv = http.createServer((req, res) => { seen = { url: req.url, auth: req.headers.authorization }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ state: 'MERGED', createdDate: 1, closedDate: Date.parse('2026-10-01T10:30:00Z'), fromRef: { displayId: 'f' }, toRef: { displayId: 'main' } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const providers = defaultProviders({}, { BB_SERVER: 'srv-token' });
    const p = providers.for({ id: 'app', provider: 'bitbucket', provider_url: base, token_env: 'BB_SERVER' });
    assert.equal(p.name, 'bitbucket');
    const pr = await p.fetchPr(`${base}/projects/PM/repos/app/pull-requests/12`);
    assert.deepEqual([pr.state, pr.merged_at], ['merged', '2026-10-01T10:30:00Z']);
    assert.deepEqual(seen, { url: '/rest/api/1.0/projects/PM/repos/app/pull-requests/12', auth: 'Bearer srv-token' });
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (`Cannot find module`).

- [ ] **Step 3: Implement** `src/reconcile/providers/bitbucket.js`

```js
// Bitbucket Cloud and Bitbucket Server/Data Center pull requests over REST (ADR 0007). The token
// comes from an environment variable named in config and is sent only to api.bitbucket.org or to
// the configured server base URL, never to a host taken from a PR link.
import { TrackerError } from '../../lib/errors.js';
import { toIso } from '../../lib/time.js';

const CLOUD_PATH_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull-requests\/(\d+)(?:\/[a-z-]*)?\/?$/;
const SERVER_PATH_RE = /^\/projects\/([A-Za-z0-9_~-]+)\/repos\/([A-Za-z0-9_.-]+)\/pull-requests\/(\d+)(?:\/[a-z-]*)?\/?$/;
const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function fail(message) {
  return new TrackerError('provider-error', message);
}

const iso = (value) => {
  if (value === undefined || value === null || value === '') return null;
  try { return toIso(value); } catch { return null; }
};

function mapState(raw, draft, closedStates) {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'OPEN') return draft === true ? 'draft' : 'open';
  if (closedStates.includes(s)) return 'closed';
  return 'unknown';
}

// Bitbucket Cloud has no merge timestamp; the last update of a merged PR is the closest record.
export function mapCloudPr(json) {
  const state = mapState(json.state, json.draft, ['DECLINED', 'SUPERSEDED']);
  return { state, opened_at: iso(json.created_on), merged_at: state === 'merged' ? iso(json.updated_on) : null, base_branch: json.destination?.branch?.name ?? null, head_branch: json.source?.branch?.name ?? null };
}

export function mapServerPr(json) {
  const state = mapState(json.state, json.draft, ['DECLINED']);
  return { state, opened_at: iso(json.createdDate), merged_at: state === 'merged' ? iso(json.closedDate ?? json.updatedDate) : null, base_branch: json.toRef?.displayId ?? null, head_branch: json.fromRef?.displayId ?? null };
}

function serverBase(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { throw fail(`provider_url "${baseUrl}" is not a URL`); }
  const loopback = u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  if (u.protocol !== 'https:' && !loopback) throw fail(`provider_url must use https (got ${u.protocol}//${u.host})`);
  if (u.search || u.hash || u.username || u.password) throw fail('provider_url must not contain credentials, a query or a fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function apiUrlFor(prUrl, base) {
  let u;
  try { u = new URL(prUrl); } catch { throw fail(`unsupported Bitbucket PR link ${prUrl}`); }
  if (base) {
    const root = new URL(base);
    const prefix = root.pathname.replace(/\/+$/, '');
    const m = u.origin === root.origin && u.pathname.startsWith(`${prefix}/`) ? SERVER_PATH_RE.exec(u.pathname.slice(prefix.length)) : null;
    if (!m) throw fail(`this repository is configured for ${base}; ${u.origin} links are not polled`);
    return `${base}/rest/api/1.0/projects/${m[1]}/repos/${m[2]}/pull-requests/${m[3]}`;
  }
  const m = u.protocol === 'https:' && u.hostname === 'bitbucket.org' && !u.port ? CLOUD_PATH_RE.exec(u.pathname) : null;
  if (!m) throw fail(`not a Bitbucket Cloud PR link (set provider_url for Bitbucket Server): ${u.origin}`);
  return `https://api.bitbucket.org/2.0/repositories/${m[1]}/${m[2]}/pullrequests/${m[3]}`;
}

export function createBitbucketProvider({ baseUrl = null, tokenEnv = 'BITBUCKET_TOKEN', usernameEnv = null, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let base = null;
  let configError = null;
  try { base = baseUrl ? serverBase(baseUrl) : null; } catch (err) { configError = err; }
  return {
    name: 'bitbucket',
    async fetchPr(url) {
      if (configError) throw configError;
      const target = apiUrlFor(url, base);
      const token = env[tokenEnv];
      if (!token) throw fail(`set ${tokenEnv} to a Bitbucket ${base ? 'HTTP access token' : 'access token or app password'} to poll pull requests`);
      const user = usernameEnv ? env[usernameEnv] : null;
      const authorization = user ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` : `Bearer ${token}`;
      let res;
      try {
        res = await fetchImpl(target, { headers: { accept: 'application/json', authorization }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw fail(`Bitbucket request failed: ${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
      }
      if (!res.ok) throw fail(`Bitbucket returned HTTP ${res.status}${res.status === 401 || res.status === 403 ? ` (check ${tokenEnv})` : ''}`);
      const text = await res.text();
      if (text.length > MAX_BODY) throw fail('Bitbucket response is too large');
      let json;
      try { json = JSON.parse(text); } catch { throw fail('Bitbucket returned malformed JSON'); }
      return base ? mapServerPr(json) : mapCloudPr(json);
    },
  };
}
```

`src/reconcile/providers/index.js`:

```js
import { createGithubProvider } from './github.js';
import { createBitbucketProvider } from './bitbucket.js';
import { createNullProvider } from './null.js';

export function defaultProviders(config = {}, env = process.env) {
  const cache = new Map();
  return {
    for(repo) {
      const id = repo ? repo.id : null;
      const kind = repo && repo.provider ? repo.provider : null;
      const key = `${kind}:${id}:${repo ? repo.provider_url ?? '' : ''}`;
      if (!cache.has(key)) {
        let provider;
        if (kind === 'github') provider = createGithubProvider();
        else if (kind === 'bitbucket') provider = createBitbucketProvider({ baseUrl: repo.provider_url ?? null, tokenEnv: repo.token_env ?? 'BITBUCKET_TOKEN', usernameEnv: repo.username_env ?? null, env });
        else provider = createNullProvider(id ?? 'unknown');
        cache.set(key, provider);
      }
      return cache.get(key);
    },
  };
}
```

- [ ] **Step 4: Run to verify** — `node --test tests/reconcile/bitbucket.test.js tests/reconcile/run.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(reconcile): Bitbucket Cloud and Server PR provider with host-pinned tokens"`.

---

### Task 7: Schedules panel

**Files:**
- Modify: `ui/components.js` (`normalizeSnapshot` default `schedules: []`; `requestFeedback` label for `run-job`)
- Modify: `ui/views/dialogs.js` (`renderSchedulesDialog`), `ui/views/header.js` (Schedules button), `ui/app.js` (actions `schedules`, `run-job`; dialog refresh per generation), `ui/styles.css`
- Test: `tests/ui/render.test.js`

**Interfaces:**
- Consumes: snapshot `schedules` (Task 5); `run-job` request (Task 5).
- Produces: `renderSchedulesDialog(snapshot, { now, pending })`; header button `data-action="schedules"` when the snapshot has schedules and is not an export; row button `data-action="run-job" data-schedule=<name>` when the snapshot can refresh.

- [ ] **Step 1: Write the failing tests** (append; import `renderSchedulesDialog` from dialogs and `renderHeader` already imported)

```js
function scheduleSnapshot() {
  const snap = snapshot();
  snap.schedules = [
    { name: 'reconcile', job: 'reconcile', cron: null, every: '2h', enabled: true, running: false, next_due: '2026-10-02T13:30:00Z', last_started_at: '2026-10-02T11:30:00Z', last_finished_at: '2026-10-02T11:30:04Z', last_outcome: 'ok', last_error: null, last_summary: '3 PR checks', runs: [{ run_id: 'r1', trigger: 'schedule', started_at: '2026-10-02T11:30:00Z', finished_at: '2026-10-02T11:30:04Z', outcome: 'ok', summary: '3 PR checks', error: null }] },
    { name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5', every: null, enabled: true, running: true, next_due: '2026-10-05T14:00:00Z', last_started_at: '2026-10-02T11:59:00Z', last_finished_at: null, last_outcome: 'failed', last_error: 'gh: <offline>', last_summary: null, runs: [] },
    { name: 'paused', job: 'reconcile', cron: null, every: '1d', enabled: false, running: false, next_due: null, last_started_at: null, last_finished_at: null, last_outcome: null, last_error: null, last_summary: null, runs: [] },
  ];
  return snap;
}

test('the Schedules dialog shows when, next run, last result, history and Run now; it escapes errors', () => {
  const html = renderSchedulesDialog(scheduleSnapshot(), { now: NOW, pending: [] });
  assert.match(html, /<code>every 2h<\/code>/);
  assert.match(html, /<code>cron 30 19 \* \* 1-5<\/code>/);
  assert.match(html, /3 PR checks/);
  assert.match(html, /gh: &lt;offline&gt;/);
  assert.match(html, /Recent runs \(1\)/);
  assert.match(html, /data-action="run-job" data-schedule="reconcile"/);
  assert.match(html, /data-action="run-job" data-schedule="evening" disabled/, 'a running schedule cannot be started again');
  assert.match(html, /paused<div class="small muted">reconcile · disabled/);
  assert.match(html, /never run/);
  const queued = renderSchedulesDialog(scheduleSnapshot(), { now: NOW, pending: [{ id: 'q', kind: 'run-job', state: 'pending', payload: { schedule: 'reconcile' } }] });
  assert.doesNotMatch(queued, /data-action="run-job" data-schedule="reconcile"/);
  const ro = { ...scheduleSnapshot(), capabilities: { read: true } };
  assert.doesNotMatch(renderSchedulesDialog(ro, { now: NOW, pending: [] }), /data-action="run-job"/);
});

test('the header offers Schedules only when the worker reports schedules and the page is not an export', () => {
  const opts = { now: NOW, online: true, refresh: null, theme: 'dark', filters: noFilters, view: 'picknext', endpoint: '127.0.0.1:1', receipt: null };
  assert.match(renderHeader(scheduleSnapshot(), opts), /data-action="schedules"/);
  assert.doesNotMatch(renderHeader(snapshot(), opts), /data-action="schedules"/);
  const exported = scheduleSnapshot();
  exported.meta = { ...exported.meta, exported_at: NOW };
  assert.doesNotMatch(renderHeader(exported, opts), /data-action="schedules"/);
});
```

- [ ] **Step 2: Run them to verify they fail** — FAIL (`renderSchedulesDialog` is not exported).

- [ ] **Step 3: Implement**

`ui/components.js`: in `normalizeSnapshot` add `schedules: snapshot.schedules ?? [],`; add `'run-job': 'run'` to the `requestFeedback` label map.

`ui/views/dialogs.js` (import `timeEl` from components):

```js
const ACTIVE_REQUEST = new Set(['sending', 'pending', 'applying']);

// Schedules panel (ADR 0007): what runs on its own, when it runs next, and how the last runs went.
export function renderSchedulesDialog(rawSnapshot, { now, pending = [] } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  const canRun = !!(snapshot.capabilities && snapshot.capabilities.refresh);
  const rows = snapshot.schedules.map((s) => {
    const when = s.cron ? `cron ${s.cron}` : `every ${s.every}`;
    const queued = pending.some((r) => r.kind === 'run-job' && r.payload && r.payload.schedule === s.name && ACTIVE_REQUEST.has(r.state));
    const outcome = s.running ? 'running' : (s.last_outcome ?? 'never run');
    const action = !canRun ? '' : queued ? '<span class="muted small">Queued…</span>' : `<button type="button" class="btn small" data-action="run-job" data-schedule="${attr(s.name)}"${s.running ? ' disabled' : ''}>${icon('play')}Run now</button>`;
    const runs = (s.runs ?? []).length ? `<tr class="runs"><td colspan="5"><details><summary class="small">Recent runs (${esc(s.runs.length)})</summary><ul class="small">${s.runs.map((r) => `<li>${timeEl(r.started_at, now, tz)} · ${esc(r.trigger)} · <strong>${esc(r.outcome)}</strong>${r.summary ? ` — ${esc(r.summary)}` : ''}${r.error ? ` — <span class="critical">${esc(r.error)}</span>` : ''}</li>`).join('')}</ul></details></td></tr>` : '';
    return `<tr data-schedule="${attr(s.name)}"><th scope="row">${esc(s.name)}<div class="small muted">${esc(s.job)}${s.enabled ? '' : ' · disabled'}</div></th><td><code>${esc(when)}</code></td><td>${s.enabled && s.next_due ? timeEl(s.next_due, now, tz) : '<span class="muted">—</span>'}</td><td><span class="chip" data-outcome="${attr(outcome)}">${esc(outcome)}</span> ${s.last_started_at ? timeEl(s.last_started_at, now, tz) : ''}${s.last_summary ? `<div class="small">${esc(s.last_summary)}</div>` : ''}${s.last_error ? `<div class="small critical">${esc(s.last_error)}</div>` : ''}</td><td>${action}</td></tr>${runs}`;
  }).join('');
  return `<div class="dialog-form schedules-dialog"><h2 id="dialog-title">${icon('clock')}Schedules</h2>
<p class="small muted">Jobs the worker runs on its own, in the store time zone (${esc(tz)}). A run missed while the computer was off runs once when the worker starts. Change them under <code>[[schedule]]</code> in your config.</p>
${snapshot.schedules.length ? `<div class="table-wrap"><table class="schedules-table"><thead><tr><th scope="col">Schedule</th><th scope="col">When</th><th scope="col">Next run</th><th scope="col">Last run</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No schedules are configured.</p>'}
<div class="dialog-actions"><button type="button" class="btn primary" data-action="close-dialog">Close</button></div></div>`;
}
```

`ui/views/header.js`: beside the Export button add `${(snapshot.schedules ?? []).length && !snapshot.meta.exported_at ? `<button type="button" class="btn small" data-action="schedules">${icon('clock')}Schedules</button>` : ''}` (use the normalized snapshot already in scope).

`ui/app.js`:
- import `renderSchedulesDialog`; in `renderDialog` add `else if (d.type === 'schedules') html = renderSchedulesDialog(s, { now: nowIso(), pending: [...appState.requests.values()] });`, and for this type use `${JSON.stringify(d)}:${s.generation_id}:${[...appState.requests.values()].filter((r) => r.kind === 'run-job').map((r) => r.state).join(',')}` as the dialog key so it updates while open.
- actions: `case 'schedules': appState.dialog = { type: 'schedules' }; render(); break;` and `case 'run-job': submit({ kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: el.dataset.schedule } }, { announceText: `Running ${el.dataset.schedule} now` }); break;`

`ui/styles.css`:

```css
.schedules-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.schedules-table th, .schedules-table td { text-align: left; vertical-align: top; padding: 6px 8px; border-top: 1px solid var(--border); }
.schedules-table tr.runs td { border-top: none; padding-top: 0; }
.chip[data-outcome="failed"], .chip[data-outcome="interrupted"] { color: var(--critical); }
.chip[data-outcome="ok"] { color: var(--good); }
```

- [ ] **Step 4: Run to verify** — `node --test tests/ui/render.test.js tests/ui/tokens.test.js tests/export/static.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): Schedules panel with next and last runs and Run now"`.

---

### Task 8: Acceptance A49–A52, dev seed, browser check

**Files:**
- Modify: `tests/acceptance/scenario.js` (option `timezone`, default `'UTC'`)
- Create: `tests/acceptance/phase7.test.js`
- Modify: `scripts/dev-seed.mjs` (two schedules)

- [ ] **Step 1: Write the scenarios** `tests/acceptance/phase7.test.js` — using `scenario({ timezone, withServer, providers })`:
  - **A49** a `[[schedule]]` cron slot in a non-UTC store time zone runs reconcile once at the slot; `GET /v1/snapshot` shows `schedules[*].next_due`, `last_outcome` and the run history, and `meta.next_sync_due` follows the reconcile schedule.
  - **A50** with the worker stopped across several slots, the restarted worker runs exactly one `catch-up` run and the next slot is the next future one.
  - **A51** `POST /v1/requests` with `run-job` returns 202 with `not_before == created_at`, runs within one tick, records trigger `manual`; an unknown schedule returns 400; Refresh still applies (A30 unchanged).
  - **A52** a ticket with a Bitbucket Server PR link is polled through the real provider against a loopback fake Bitbucket (`provider_url`, `token_env`): the PR becomes merged, the ticket moves to deploy-pending with one obligation per environment, and the token appears nowhere in the snapshot, journal or health log.
- [ ] **Step 2: Run them** — `node --test tests/acceptance/phase7.test.js` → PASS.
- [ ] **Step 3: Dev seed** — add `schedule: [{ name: 'reconcile', job: 'reconcile', every: '2h' }, { name: 'evening-sync', job: 'reconcile', cron: '30 19 * * 1-5' }]` to the seeded config.
- [ ] **Step 4: Browser check** — restart the seed, open Schedules from the header at 1440 px, confirm both rows, next runs in the store time zone, last results and history, press Run now on `evening-sync` and see it run and record `manual`.
- [ ] **Step 5: Commit** — `git commit -m "test(acceptance): A49-A52 schedules, catch-up, Run now and Bitbucket polling"`.

---

### Task 9: Documentation

**Files:**
- Create: `docs/decisions/0007-schedules-and-bitbucket.md`
- Modify: `docs/TRD.md` (§Reconciliation: schedules, catch-up, Run now; §Configuration: `[[schedule]]`, provider fields), `docs/DATA-CONTRACT.md` (schedule record, `schedule-run` event, `run-job` request, snapshot `schedules`), `docs/UI-DESIGN.md` (header Schedules panel), `docs/ACCEPTANCE.md` (A49–A52), `docs/ACCEPTANCE-RESULTS.md`, `docs/README.md`, `README.md` (schedules and Bitbucket setup), `CHANGELOG.md`

- [ ] **Step 1: Write ADR 0007** (Context: fixed two-hour timer, GitHub-only polling; Decision: `[[schedule]]` in user config only, cron or every in the store time zone, default unchanged, one run per job, catch-up once, journaled runs, `run-job` without delay, planned jobs accepted but skipped, Bitbucket Cloud and Server with host-pinned tokens from named variables and `redirect: 'error'`; Consequences: Cloud merge time approximated by the last update, editing schedules applies without restart, scheduled cloud agents deferred; Alternatives: a cron library, repository-defined schedules, `gh`-style CLI for Bitbucket).
- [ ] **Step 2: Amend the spec files and user docs** listed above.
- [ ] **Step 3: Run the full suite** — `npm test` → all pass (1 skip).
- [ ] **Step 4: Commit** — `git commit -m "docs: ADR 0007 schedules and the Bitbucket provider; spec, README and changelog"`.
