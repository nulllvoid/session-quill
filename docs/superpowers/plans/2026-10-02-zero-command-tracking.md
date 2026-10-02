# Zero-Command Ticket Tracking (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship step 1 of the "Session Quill: zero-command ticket tracking" proposal: a generic `[tracker]` config, automatic session binding from ticket keys in the prompt and the git branch, and gate modes `off` / `nudge` (new default) / `strict` (today's behaviour).

**Architecture:** The worker resolves gate mode and tracker settings from user config and every registered repository's `.quill.toml` and publishes them in the runtime identity file, per repository path, so hooks never parse TOML. `UserPromptSubmit` and `SessionStart` scan the prompt or branch with a validated, bounded pattern; on a match they write a provisional binding snapshot and then persist a `bind` event carrying the external key. The reducer finds the ticket by key or alias, or creates it under that key with a deterministic id, and binds the session; the worker republishes the confirmed snapshot. In `nudge` mode the gate never denies; `PostToolUse` marks unbound file changes and `Stop` asks Claude once per session (Stop `decision: "block"`) which ticket the work belongs to.

**Tech Stack:** Node 22+ ESM, built-ins only, `node:test`. No new dependencies.

**Spec:** Claude Doc "Session Quill: zero-command ticket tracking" (https://claude.ai/artifact/CQjjJMoyhY2tweXK2jJpQr, rev 11: "Proposed design", "Configuration example", "Implementation order", "Step 1 by file"), read with `docs/TRD.md` (§Ticket gate, §Binding and attribution, §Configuration and packaging), `docs/PRD.md`, `docs/DATA-CONTRACT.md` and ADRs 0001–0004. Where the proposal changes the v0.2 spec (default gate behaviour), ADR 0005 records it and Task 11 amends the spec files.

## Global Constraints

- Node built-ins only; no npm dependencies (TRD §Configuration and packaging).
- Hooks stay offline: no network, no model calls, no journal reads, no `git` subprocess; hook p95 <= 200 ms (PRD NFR, TRD §Durability 8).
- Never emit a PreToolUse `allow`; a bound or nudged call produces no decision (TRD §Ticket gate, ADR 0003).
- An identity file without `gate_mode` (written by an older worker) means `strict`, so behaviour changes only once the new worker runs.
- `LOCAL-<slug>-<id>` keys stay legal; existing stores replay unchanged.
- Repository config never weakens user config (TRD §Configuration): a repo `[gate].mode` may only tighten the user's mode; repo `gate.allow_tools` is never read.
- Bindings are forward-only: earlier captured work keeps its attribution (TRD §Binding; proposal open question 1).
- Prompt text is not retained beyond the existing 80-character title candidate (TRD §Capture and approval).
- External links must be `https://` URLs without whitespace or quote characters (DATA-CONTRACT §Common conventions).
- The public repository contains no company tracker domain or private prefixes; docs and tests use `https://example.atlassian.net`.
- Commands stay namespaced `/session-quill:<name>`.

## Review Focus

1. **Adversarial `key_pattern` in a repository `.quill.toml`.** Nested-quantifier or non-compiling patterns are rejected at config load (tracker becomes null, health warning) so no hook can hang on a prompt. Tests: Task 2 `normalizeTracker ... validates every field`; Task 6 `a repository cannot loosen the gate, and invalid tracker config ...`.
2. **Very long prompts.** Scans cap at 4,000 characters and 10 keys. Test: Task 2 `scanning is bounded for long or adversarial input`.
3. **The worker overwriting a provisional snapshot** between the hook's provisional write and ingestion of its `bind` event (strict mode would deny a call the user just unlocked). Test: Task 6 `a fresh provisional snapshot survives ...`.
4. **A bind event that cannot be persisted** must not leave a provisional binding behind. Test: Task 7 `if the bind event cannot be persisted ...`.
5. **Stop-hook loops.** The nudge fires once per session and never when `stop_hook_active` is true. Test: Task 8 `... is asked once at Stop`.
6. **Common uppercase tokens** (`UTF-8`, `SHA-256`, `GPT-4`) never create tickets without a prefix allowlist. Test: Task 2 `without prefixes ...`.

---

### Task 1: TOML literal strings

The proposal's `key_pattern = '\b([A-Z][A-Z0-9]+-\d+)\b'` is a TOML literal string. The restricted parser only accepts double-quoted strings, whose escape rules reject `\b` and `\d`.

**Files:**
- Modify: `src/config/toml.js` (`splitArray`, `parseValue`, `stripComment`; new `parseLiteral`)
- Test: `tests/config/toml.test.js`

**Interfaces:**
- Produces: `parseToml` accepts `'literal'` strings (no escapes) as values and array items.

- [ ] **Step 1: Write the failing test** (append to `tests/config/toml.test.js`)

```js
test('parseToml accepts single-quoted literal strings without escape processing', () => {
  const cfg = parseToml("[tracker]\nkey_pattern = '\\b([A-Z][A-Z0-9]+-\\d+)\\b'  # regex\nprefixes = ['PMLA', \"PC\"]\nnote = 'a # not a comment'\n");
  assert.equal(cfg.tracker.key_pattern, '\\b([A-Z][A-Z0-9]+-\\d+)\\b');
  assert.deepEqual(cfg.tracker.prefixes, ['PMLA', 'PC']);
  assert.equal(cfg.tracker.note, 'a # not a comment');
  assert.throws(() => parseToml("x = 'it's'"), /literal string/);
  assert.throws(() => parseToml("x = ['open]"), /unterminated/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/config/toml.test.js`
Expected: FAIL with `unsupported value`.

- [ ] **Step 3: Implement**

Add after `parseString`:

```js
// TOML literal strings ('...') carry no escapes, which keeps regular expressions readable.
function parseLiteral(raw, line, lineNo) {
  if (raw.length < 2 || !raw.endsWith("'")) throw unsupported(line, lineNo, 'expected a single-quoted literal string');
  const inner = raw.slice(1, -1);
  if (inner.includes("'")) throw unsupported(line, lineNo, 'unexpected quote inside literal string');
  return inner;
}
```

Replace `splitArray` with a quote-aware version:

```js
function splitArray(inner, line, lineNo) {
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') { cur += inner[i + 1] ?? ''; i += 1; } else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch; cur += ch;
    } else if (ch === ',') {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
    } else if (ch === '[' || ch === '{') {
      throw unsupported(line, lineNo, 'nested arrays and inline tables are not supported');
    } else {
      cur += ch;
    }
  }
  if (quote) throw unsupported(line, lineNo, 'unterminated string in array');
  if (cur.trim()) items.push(cur.trim());
  return items;
}
```

In `parseValue` add `if (raw.startsWith("'")) return parseLiteral(raw, line, lineNo);` after the double-quote branch, and map array items with:

```js
    return splitArray(raw.slice(1, -1), line, lineNo).map((item) => {
      if (item.startsWith('"')) return parseString(item, line, lineNo);
      if (item.startsWith("'")) return parseLiteral(item, line, lineNo);
      throw unsupported(line, lineNo, 'only arrays of strings are supported');
    });
```

Replace `stripComment` so `#` inside either quote style is kept:

```js
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/config/toml.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/toml.js tests/config/toml.test.js
git commit -m "feat(config): accept TOML literal strings for tracker key patterns"
```

---

### Task 2: External keys module

**Files:**
- Create: `src/core/external-keys.js`
- Test: `tests/core/external-keys.test.js`

**Interfaces:**
- Produces:
  - `normalizeTracker(raw) -> Tracker | null` (throws `TrackerError('config-invalid')`); `Tracker = { system, domain, url_template, key_pattern, prefixes: string[], sources: string[], on_new_key, repo }`.
  - `findKeys(text, tracker, { uppercase = false } = {}) -> string[]` (order of appearance, deduplicated, at most 10).
  - `renderUrl(key, tracker) -> string | null`; `isSafeExternalUrl(url) -> boolean`.
  - `externalTicketId(storeId, key) -> uuid`; `branchTitle(branch, key) -> string`; `keyExample(tracker) -> string`; `keyPrefix(key) -> string`.
  - Constants `TRACKER_SYSTEMS`, `KEY_SOURCES`, `ON_NEW_KEY`, `DEFAULT_KEY_PATTERN`, `MAX_SCAN_CHARS = 4000`, `MAX_KEYS = 10`, `NON_TICKET_PREFIXES`.

- [ ] **Step 1: Write the failing test** `tests/core/external-keys.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTracker, findKeys, renderUrl, externalTicketId, branchTitle, keyExample, isSafeExternalUrl } from '../../src/core/external-keys.js';

const jira = normalizeTracker({ system: 'jira', domain: 'https://example.atlassian.net/', prefixes: ['PMLA', 'pc'] });

test('normalizeTracker fills defaults per system and validates every field', () => {
  assert.equal(normalizeTracker(undefined), null);
  assert.deepEqual(jira, { system: 'jira', domain: 'https://example.atlassian.net', url_template: '{domain}/browse/{key}', key_pattern: '\\b([A-Z][A-Z0-9]+-\\d+)\\b', prefixes: ['PMLA', 'PC'], sources: ['prompt', 'branch'], on_new_key: 'switch', repo: '' });
  assert.equal(normalizeTracker({ system: 'linear', domain: 'https://linear.app/acme' }).url_template, '{domain}/issue/{key}');
  for (const bad of [{ system: 'trello' }, { key_pattern: '(' }, { key_pattern: '(a+)+$' }, { key_pattern: 'x'.repeat(201) }, { prefixes: ['pm la'] }, { sources: ['email'] }, { on_new_key: 'merge' }, { domain: 'http://insecure.example' }, { domain: 'javascript:alert(1)' }, { repo: 'a b' }]) {
    assert.throws(() => normalizeTracker(bad), (err) => err.code === 'config-invalid', JSON.stringify(bad));
  }
});

test('findKeys returns configured keys in order of appearance without duplicates', () => {
  assert.deepEqual(findKeys('Fix PMLA-1234 and PC-9; PMLA-1234 again; also ABC-1', jira), ['PMLA-1234', 'PC-9']);
  assert.deepEqual(findKeys('nothing here', jira), []);
  assert.deepEqual(findKeys('', jira), []);
  assert.deepEqual(findKeys('PMLA-1', null), []);
});

test('without prefixes common uppercase-dash-number tokens are not ticket keys', () => {
  const any = normalizeTracker({});
  assert.deepEqual(findKeys('UTF-8, SHA-256, ISO-8601, RFC-3339, GPT-4 and CVE-2024 but ENG-42', any), ['ENG-42']);
});

test('branch scanning upper-cases only when asked, and branchTitle keeps the words after the key', () => {
  assert.deepEqual(findKeys('feat/pmla-77-retry-flake', jira, { uppercase: true }), ['PMLA-77']);
  assert.deepEqual(findKeys('feat/pmla-77-retry-flake', jira), []);
  assert.equal(branchTitle('feat/pmla-77-retry-flake', 'PMLA-77'), 'retry flake');
  assert.equal(branchTitle('PMLA-77', 'PMLA-77'), '');
});

test('scanning is bounded for long or adversarial input', () => {
  const long = `${'PMLA-1 '.repeat(20)}${'x'.repeat(200_000)} PMLA-999999`;
  const started = process.hrtime.bigint();
  const keys = findKeys(long, jira);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 50);
  assert.deepEqual(keys, ['PMLA-1']);
  const many = Array.from({ length: 50 }, (_, i) => `PMLA-${i + 1}`).join(' ');
  assert.equal(findKeys(many, jira).length, 10);
});

test('renderUrl fills the template and refuses unsafe or incomplete links', () => {
  assert.equal(renderUrl('PMLA-12', jira), 'https://example.atlassian.net/browse/PMLA-12');
  const gh = normalizeTracker({ system: 'github', domain: 'https://github.com', repo: 'acme/app', key_pattern: '\\b(GH-\\d+)\\b' });
  assert.equal(renderUrl('GH-7', gh), 'https://github.com/acme/app/issues/7');
  assert.equal(renderUrl('PMLA-12', normalizeTracker({ system: 'jira' })), null, 'no domain, no link');
  assert.equal(renderUrl('PMLA-12', normalizeTracker({ system: 'custom' })), null, 'no template, no link');
  assert.equal(isSafeExternalUrl('https://x.example/a b'), false);
  assert.equal(isSafeExternalUrl('https://x.example/"onload'), false);
  assert.equal(isSafeExternalUrl('http://x.example/a'), false);
});

test('externalTicketId is deterministic per store and key; keyExample uses the first prefix', () => {
  assert.equal(externalTicketId('s1', 'PMLA-1'), externalTicketId('s1', 'PMLA-1'));
  assert.notEqual(externalTicketId('s1', 'PMLA-1'), externalTicketId('s2', 'PMLA-1'));
  assert.equal(keyExample(jira), 'PMLA-123');
  assert.equal(keyExample(null), 'PROJ-123');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core/external-keys.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement** `src/core/external-keys.js`

```js
// Ticket-key recognition and tracker links for zero-command tracking (ADR 0005). Pure functions:
// hooks run them on every prompt, so the pattern is validated once at config load and every scan
// is bounded.
import { deterministicId } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';

export const TRACKER_SYSTEMS = ['jira', 'linear', 'github', 'custom'];
// commit and pr are reserved for a later release; v1 acts on prompt and branch only.
export const KEY_SOURCES = ['prompt', 'branch', 'commit', 'pr'];
export const ON_NEW_KEY = ['switch', 'add', 'ignore'];
export const DEFAULT_KEY_PATTERN = '\\b([A-Z][A-Z0-9]+-\\d+)\\b';
export const MAX_SCAN_CHARS = 4000;
export const MAX_KEYS = 10;
// Without a prefix allowlist these uppercase-dash-number tokens are never treated as ticket keys.
export const NON_TICKET_PREFIXES = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'GPT', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'MD', 'PEP', 'ES', 'ECMA', 'IPV', 'WIN', 'COVID', 'CVE', 'CWE', 'ARM', 'UTC', 'GMT', 'CP', 'AV', 'PR', 'TS', 'IE']);
const DEFAULT_TEMPLATES = { jira: '{domain}/browse/{key}', linear: '{domain}/issue/{key}', github: '{domain}/{repo}/issues/{number}', custom: '' };
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;
const DOMAIN_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;
// A group containing a quantifier that is itself quantified, e.g. (a+)+: catastrophic backtracking.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

function invalid(message) {
  return new TrackerError('config-invalid', message);
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw invalid(`tracker.${field} must be an array of strings`);
  return value;
}

export function normalizeTracker(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('[tracker] must be a table');
  const system = raw.system ?? 'custom';
  if (!TRACKER_SYSTEMS.includes(system)) throw invalid(`tracker.system must be one of ${TRACKER_SYSTEMS.join(', ')}`);
  const key_pattern = raw.key_pattern ?? DEFAULT_KEY_PATTERN;
  if (typeof key_pattern !== 'string' || !key_pattern || key_pattern.length > 200) throw invalid('tracker.key_pattern must be a non-empty regular expression of at most 200 characters');
  if (NESTED_QUANTIFIER.test(key_pattern)) throw invalid('tracker.key_pattern must not repeat a group that itself repeats (catastrophic backtracking risk)');
  try {
    new RegExp(key_pattern, 'g');
  } catch (err) {
    throw invalid(`tracker.key_pattern does not compile: ${err.message}`);
  }
  const prefixes = stringList(raw.prefixes, 'prefixes').map((p) => p.trim().toUpperCase());
  if (prefixes.some((p) => !PREFIX_RE.test(p))) throw invalid('tracker.prefixes must contain key prefixes such as PROJ');
  const sources = raw.sources === undefined ? ['prompt', 'branch'] : stringList(raw.sources, 'sources');
  if (sources.some((s) => !KEY_SOURCES.includes(s))) throw invalid(`tracker.sources may contain ${KEY_SOURCES.join(', ')}`);
  const on_new_key = raw.on_new_key ?? 'switch';
  if (!ON_NEW_KEY.includes(on_new_key)) throw invalid(`tracker.on_new_key must be one of ${ON_NEW_KEY.join(', ')}`);
  if (raw.domain !== undefined && typeof raw.domain !== 'string') throw invalid('tracker.domain must be a string');
  const domain = typeof raw.domain === 'string' ? raw.domain.trim().replace(/\/+$/, '') : '';
  if (domain && !DOMAIN_RE.test(domain)) throw invalid('tracker.domain must be an https:// origin such as https://example.atlassian.net');
  const url_template = raw.url_template ?? DEFAULT_TEMPLATES[system];
  if (typeof url_template !== 'string' || url_template.length > 300) throw invalid('tracker.url_template must be a string of at most 300 characters');
  const repo = raw.repo ?? '';
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._/-]*$/.test(repo)) throw invalid('tracker.repo must look like owner/name');
  return { system, domain, url_template, key_pattern, prefixes, sources, on_new_key, repo };
}

export function keyPrefix(key) {
  const i = key.lastIndexOf('-');
  return (i > 0 ? key.slice(0, i) : key).toUpperCase();
}

function acceptKey(key, tracker) {
  if (!KEY_RE.test(key) || key.includes('..')) return false;
  const prefix = keyPrefix(key);
  return tracker.prefixes.length ? tracker.prefixes.includes(prefix) : !NON_TICKET_PREFIXES.has(prefix);
}

export function findKeys(text, tracker, { uppercase = false } = {}) {
  if (!tracker || typeof text !== 'string' || !text) return [];
  const head = text.slice(0, MAX_SCAN_CHARS);
  const scan = uppercase ? head.toUpperCase() : head;
  const re = new RegExp(tracker.key_pattern, 'g');
  const keys = [];
  for (let m = re.exec(scan); m !== null; m = re.exec(scan)) {
    if (m[0] === '') { re.lastIndex += 1; continue; }
    let key = String(m[1] ?? m[0]).trim();
    if (tracker.prefixes.length) key = key.toUpperCase();
    if (acceptKey(key, tracker) && !keys.includes(key)) keys.push(key);
    if (keys.length >= MAX_KEYS) break;
  }
  return keys;
}

export function branchTitle(branch, key) {
  if (typeof branch !== 'string' || typeof key !== 'string') return '';
  const i = branch.toUpperCase().indexOf(key.toUpperCase());
  const tail = i >= 0 ? branch.slice(i + key.length) : '';
  return tail.replace(/[-_/.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function isSafeExternalUrl(url) {
  return typeof url === 'string' && url.length <= 500 && /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(url) && !/[<>"'`\\]/.test(url);
}

export function renderUrl(key, tracker) {
  if (!tracker || !tracker.url_template || typeof key !== 'string') return null;
  const number = (/(\d+)$/.exec(key) ?? [])[1] ?? '';
  const values = { domain: tracker.domain, key, repo: tracker.repo, number };
  let missing = false;
  const url = tracker.url_template.replace(/\{(domain|key|repo|number)\}/g, (_, name) => {
    if (!values[name]) missing = true;
    return values[name];
  });
  return !missing && isSafeExternalUrl(url) ? url : null;
}

export function externalTicketId(storeId, key) {
  return deterministicId(`external-ticket:${storeId}:${key}`);
}

export function keyExample(tracker) {
  return `${tracker && tracker.prefixes.length ? tracker.prefixes[0] : 'PROJ'}-123`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/core/external-keys.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/external-keys.js tests/core/external-keys.test.js
git commit -m "feat(core): tracker config validation, bounded key detection and URL templates"
```

---

### Task 3: Gate mode and tracker resolution, runtime identity builder

**Files:**
- Modify: `src/config/config.js` (`defaultUserConfig`; new `GATE_MODES`, `resolveGateMode`, `resolveTracker`)
- Create: `src/config/runtime.js` (`buildRuntimeIdentity`, `identityStamp`)
- Modify: `src/hooks/binding-snapshot.js` (`readRuntimeIdentity` fallback carries `gate_mode`, `tracker`, `repos`, `default_project_id`)
- Test: `tests/config/config.test.js`

**Interfaces:**
- Consumes: `normalizeTracker` (Task 2).
- Produces:
  - `resolveGateMode(user, repo = null) -> { mode: 'off'|'nudge'|'strict', warnings: string[] }`.
  - `resolveTracker(user, repo = null) -> Tracker | null` (throws `config-invalid`).
  - `buildRuntimeIdentity({ storeMeta, config }) -> { identity, warnings }`; `identity = { store_id, machine_id, store_path, gate_enabled, gate_mode, approval_phrases_enabled, allow_tools, tracker, default_project_id, repos: [{ repo_id, path, project_id, gate_mode, tracker }] }`.
  - `identityStamp(config, env) -> string` (mtimes of `config.toml` and each registered repo's `.quill.toml`).

- [ ] **Step 1: Write the failing tests** (append to `tests/config/config.test.js`; add `resolveGateMode, resolveTracker` to the config import and `import { buildRuntimeIdentity } from '../../src/config/runtime.js';`)

```js
test('gate mode defaults to nudge; legacy gate_enabled = false means off; invalid values fail closed to strict', () => {
  assert.equal(defaultUserConfig().gate.mode, 'nudge');
  assert.deepEqual(resolveGateMode(defaultUserConfig()), { mode: 'nudge', warnings: [] });
  assert.equal(resolveGateMode({ gate_enabled: false, gate: { mode: 'strict' } }).mode, 'off');
  const bad = resolveGateMode({ gate: { mode: 'loose' } });
  assert.equal(bad.mode, 'strict');
  assert.match(bad.warnings[0], /loose/);
});

test('a repository can tighten the gate mode but never loosen it', () => {
  assert.equal(resolveGateMode({ gate: { mode: 'nudge' } }, { gate: { mode: 'strict' } }).mode, 'strict');
  assert.equal(resolveGateMode({ gate: { mode: 'strict' } }, { gate: { mode: 'off' } }).mode, 'strict');
  assert.equal(resolveGateMode({ gate: { mode: 'nudge' } }, { gate: { mode: 'off' } }).mode, 'nudge');
});

test('tracker config merges repository over user values and is validated', () => {
  assert.equal(resolveTracker(defaultUserConfig(), null), null);
  const t = resolveTracker({ tracker: { system: 'jira', domain: 'https://example.atlassian.net' } }, { tracker: { prefixes: ['PMLA'] } });
  assert.deepEqual([t.system, t.domain, t.prefixes], ['jira', 'https://example.atlassian.net', ['PMLA']]);
  assert.throws(() => resolveTracker({}, { tracker: { key_pattern: '(a+)+' } }), /backtracking/);
});

test('a .quill.toml [tracker] table with a literal-string pattern loads end to end', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  fs.writeFileSync(path.join(repo, '.quill.toml'), "project_id = \"demo\"\n\n[tracker]\nsystem = \"jira\"\nkey_pattern = '\\b([A-Z][A-Z0-9]+-\\d+)\\b'\nprefixes = [\"PMLA\"]\n\n[gate]\nmode = \"strict\"\n");
  const cfg = loadRepoConfig(repo);
  assert.equal(resolveTracker({}, cfg).key_pattern, '\\b([A-Z][A-Z0-9]+-\\d+)\\b');
  assert.equal(resolveGateMode({}, cfg).mode, 'strict');
});

test('buildRuntimeIdentity resolves per-repository scopes and reports invalid config without failing', () => {
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  fs.writeFileSync(path.join(good, '.quill.toml'), 'project_id = "web"\n[tracker]\nprefixes = ["WEB"]\n[gate]\nmode = "strict"\n');
  fs.writeFileSync(path.join(bad, '.quill.toml'), "[tracker]\nkey_pattern = '(a+)+'\n");
  const config = { ...defaultUserConfig(), store_path: '/q', default_project: 'demo', projects: { demo: {} }, tracker: { system: 'jira', domain: 'https://example.atlassian.net' }, repos: { web: { project_id: 'web-old', canonical_path: good }, api: { project_id: 'api', canonical_path: bad }, ghost: { project_id: 'x' } } };
  const { identity, warnings } = buildRuntimeIdentity({ storeMeta: { store_id: 'S', owner_machine_id: 'M' }, config });
  assert.equal(identity.gate_mode, 'nudge');
  assert.equal(identity.tracker.system, 'jira');
  assert.equal(identity.default_project_id, 'demo');
  assert.equal(identity.repos.length, 2, 'repositories without a canonical path are skipped');
  const web = identity.repos.find((r) => r.repo_id === 'web');
  assert.deepEqual([web.path, web.project_id, web.gate_mode, web.tracker.prefixes, web.tracker.system], [path.resolve(good), 'web', 'strict', ['WEB'], 'jira']);
  const api = identity.repos.find((r) => r.repo_id === 'api');
  assert.equal(api.tracker, null);
  assert.match(warnings.join('\n'), /api: .*backtracking/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/config/config.test.js`
Expected: FAIL (`resolveGateMode` is not exported; `runtime.js` missing).

- [ ] **Step 3: Implement**

`src/config/config.js`: import `normalizeTracker` from `'../core/external-keys.js'`; change the default `gate` to `{ allow_tools: [], mode: 'nudge' }`; add:

```js
export const GATE_MODES = ['off', 'nudge', 'strict'];
const GATE_RANK = { off: 0, nudge: 1, strict: 2 };

// Effective gate mode (ADR 0005). The user picks off, nudge or strict (legacy gate_enabled = false
// means off). A repository may only tighten it; an unrecognized value fails closed to strict.
export function resolveGateMode(user = {}, repo = null) {
  const warnings = [];
  const read = (cfg, where) => {
    const mode = cfg && cfg.gate && cfg.gate.mode;
    if (mode === undefined || mode === null) return null;
    if (!GATE_MODES.includes(mode)) {
      warnings.push(`${where} gate.mode "${mode}" is not one of ${GATE_MODES.join(', ')}; using strict`);
      return 'strict';
    }
    return mode;
  };
  let mode = user && user.gate_enabled === false ? 'off' : (read(user, 'user config') ?? 'nudge');
  const repoMode = read(repo, '.quill.toml');
  if (repoMode && GATE_RANK[repoMode] > GATE_RANK[mode]) mode = repoMode;
  return { mode, warnings };
}

// Repository [tracker] values override user values field by field; the result is validated.
export function resolveTracker(user = {}, repo = null) {
  const u = user && user.tracker;
  const r = repo && repo.tracker;
  if (!u && !r) return null;
  return normalizeTracker({ ...(u ?? {}), ...(r ?? {}) });
}
```

`src/config/runtime.js`:

```js
// The runtime identity the worker publishes for hooks: gate mode, tracker and per-repository
// scopes resolved from user config and each registered repository's .quill.toml, so hooks never
// parse TOML (ADR 0005).
import fs from 'node:fs';
import path from 'node:path';
import { loadRepoConfig, resolveGateMode, resolveTracker } from './config.js';
import { configPath } from '../lib/paths.js';

export function buildRuntimeIdentity({ storeMeta, config }) {
  const warnings = [];
  const user = resolveGateMode(config, null);
  warnings.push(...user.warnings);
  let tracker = null;
  try {
    tracker = resolveTracker(config, null);
  } catch (err) {
    warnings.push(`user config: ${err.message}`);
  }
  const repos = [];
  for (const [repo_id, r] of Object.entries(config.repos ?? {})) {
    if (!r || !r.canonical_path) continue;
    let repoCfg = null;
    try {
      repoCfg = loadRepoConfig(r.canonical_path);
    } catch (err) {
      warnings.push(`${repo_id} .quill.toml: ${err.message}`);
    }
    const gate = resolveGateMode(config, repoCfg);
    warnings.push(...gate.warnings.map((w) => `${repo_id}: ${w}`));
    let repoTracker = null;
    try {
      repoTracker = resolveTracker(config, repoCfg);
    } catch (err) {
      warnings.push(`${repo_id}: ${err.message}`);
    }
    repos.push({ repo_id, path: path.resolve(r.canonical_path), project_id: (repoCfg && repoCfg.project_id) || r.project_id || null, gate_mode: gate.mode, tracker: repoTracker });
  }
  const identity = {
    store_id: storeMeta.store_id,
    machine_id: storeMeta.owner_machine_id,
    store_path: config.store_path,
    gate_enabled: config.gate_enabled !== false,
    gate_mode: user.mode,
    approval_phrases_enabled: config.approval_phrases_enabled === true,
    allow_tools: (config.gate && Array.isArray(config.gate.allow_tools)) ? config.gate.allow_tools : [],
    tracker,
    default_project_id: config.default_project || Object.keys(config.projects ?? {})[0] || null,
    repos,
  };
  return { identity, warnings };
}

// Changes to these files republish the identity without restarting the worker.
export function identityStamp(config, env) {
  const files = [configPath(env), ...Object.values(config.repos ?? {}).filter((r) => r && r.canonical_path).map((r) => path.join(r.canonical_path, '.quill.toml'))];
  return files.map((f) => {
    try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:-`; }
  }).join('|');
}
```

`src/hooks/binding-snapshot.js` fallback in `readRuntimeIdentity`: import `resolveGateMode, resolveTracker` from `'../config/config.js'` and add to the returned object:

```js
    gate_mode: resolveGateMode(cfg).mode,
    tracker: (() => { try { return resolveTracker(cfg); } catch { return null; } })(),
    default_project_id: cfg.default_project || null,
    repos: [],
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/config/config.test.js tests/config/toml.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.js src/config/runtime.js src/hooks/binding-snapshot.js tests/config/config.test.js
git commit -m "feat(config): gate modes, tracker resolution and per-repository runtime identity"
```

---

### Task 4: Gate modes in the gate and the hook

**Files:**
- Modify: `src/gate/decide.js` (`decideGate` gains `mode`)
- Create: `src/hooks/scope.js` (`scopeFor`)
- Modify: `src/hooks/adapter.js` (covered/mode computation, denial hint, `gate_mode` in the pre-tool payload)
- Modify: `src/cli/commands/hook.js` (malformed input and exceptions deny only when a non-nudge scope exists)
- Test: `tests/gate/decide.test.js`, new `tests/hooks/gate-modes.test.js`

**Interfaces:**
- Consumes: `keyExample` (Task 2); identity fields (Task 3).
- Produces:
  - `decideGate({ ..., mode = 'strict' })`: `off` → `none/gate-off`; `nudge` → `none` (`bound` or `nudge-unbound`) after the read/allow-list checks; anything else → the strict matrix.
  - `scopeFor(identity, cwd) -> { gate_mode, tracker, project_id, repo_id }`: longest registered repository path containing cwd (case-insensitive on Windows), identity defaults otherwise; missing `gate_mode` means `strict`.
  - Rules used by Tasks 7–8: `mode = gateEnabled ? scope.gate_mode : 'off'`; capture failures fail closed for covered tools unless `scope.gate_mode === 'nudge'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/gate/decide.test.js`:

```js
test('gate modes: off and nudge never deny; strict keeps the full matrix; unknown modes are strict', () => {
  for (const tool_name of ['Edit', 'Write', 'Bash', 'mcp__jira__create_issue', 'SomeNewTool']) {
    const tool_input = tool_name === 'Bash' ? { command: 'npm test' } : { file_path: 'C:/repo/a.js' };
    assert.equal(decideGate({ ...base, mode: 'nudge', tool_name, tool_input, binding: unbound }).decision, 'none', tool_name);
    assert.equal(decideGate({ ...base, mode: 'nudge', workerHealthy: false, tool_name, tool_input, binding: unbound }).decision, 'none', `${tool_name} unhealthy`);
    assert.equal(decideGate({ ...base, mode: 'off', tool_name, tool_input, binding: unbound }).decision, 'none');
    assert.equal(decideGate({ ...base, mode: 'strict', tool_name, tool_input, binding: unbound }).decision, 'deny');
  }
  assert.equal(decideGate({ ...base, mode: 'nudge', tool_name: 'Edit', tool_input: {}, binding: unbound }).reason, 'nudge-unbound');
  assert.equal(decideGate({ ...base, mode: 'nudge', tool_name: 'Edit', tool_input: {}, binding: bound }).reason, 'bound');
  assert.equal(decideGate({ ...base, mode: 'bogus', tool_name: 'Edit', tool_input: {}, binding: unbound }).decision, 'deny');
});
```

Create `tests/hooks/gate-modes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { normalizeTracker } from '../../src/core/external-keys.js';
import { main } from '../../src/cli/main.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-02T08:00:00Z';
const CWD = path.resolve(os.tmpdir(), 'gate-modes-repo');

function setup(mode, { tracker = null, repos = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-modes-'));
  const env = { QUILL_HOME: home };
  const identity = { store_id: STORE, machine_id: MACHINE, store_path: path.join(home, 'Quill'), gate_enabled: true, approval_phrases_enabled: false, allow_tools: [], tracker, default_project_id: 'demo', repos };
  if (mode !== undefined) identity.gate_mode = mode;
  writeRuntimeIdentity(identity, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  return env;
}

const pre = (env, tool_name, tool_input, extra = {}) => runHook('PreToolUse', { session_id: 's1', hook_event_name: 'PreToolUse', cwd: CWD, tool_name, tool_use_id: `u-${tool_name}`, tool_input, ...extra }, { env, now: NOW });

test('nudge mode: unbound writes, unknown shell and MCP tools get no decision and are recorded as not denied', () => {
  const env = setup('nudge');
  for (const [tool, input] of [['Edit', { file_path: path.join(CWD, 'a.js') }], ['Bash', { command: 'npm test' }], ['mcp__jira__create_issue', {}]]) {
    assert.equal(pre(env, tool, input).stdout, '', tool);
  }
  const evs = listIngress(env).map((x) => x.event).filter((e) => e.kind === 'pre-tool');
  assert.equal(evs.length, 3);
  assert.ok(evs.every((e) => e.payload.denied === false && e.payload.gate_mode === 'nudge'));
});

test('nudge mode: a capture failure or a missing session id never blocks', () => {
  const env = setup('nudge');
  fs.rmSync(path.join(env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(env.QUILL_HOME, 'ingress'), 'blocker');
  assert.equal(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout, '');
  assert.equal(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }, { session_id: undefined }).stdout, '');
});

test('strict mode with a tracker: the denial says that mentioning a key links the session', () => {
  const env = setup('strict', { tracker: normalizeTracker({ prefixes: ['PMLA'] }) });
  const reason = JSON.parse(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /PMLA-123/);
  assert.match(reason, /\/session-quill:ticket bind/);
});

test('an identity without gate_mode (older worker) keeps strict behaviour', () => {
  const env = setup(undefined);
  assert.equal(JSON.parse(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('a registered repository scope overrides the identity default by longest path', () => {
  const env = setup('nudge', { repos: [{ repo_id: 'demo', path: CWD, project_id: 'demo', gate_mode: 'strict', tracker: null }] });
  assert.equal(JSON.parse(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(pre(env, 'Edit', { file_path: 'x' }, { cwd: os.tmpdir() }).stdout, '', 'outside the repository the nudge default applies');
});

async function hookCli(env, stdin) {
  let out = '';
  const code = await main(['hook', 'PreToolUse'], { env, stdout: (s) => { out += s; }, stderr: () => {}, stdin: async () => stdin });
  return { code, out };
}

test('malformed hook input denies only when a non-nudge scope is configured', async () => {
  assert.equal((await hookCli(setup('nudge'), '{not json')).out, '');
  assert.match((await hookCli(setup('strict'), '{not json')).out, /"permissionDecision":"deny"/);
  assert.match((await hookCli(setup('nudge', { repos: [{ repo_id: 'r', path: CWD, gate_mode: 'strict' }] }), '{not json')).out, /"permissionDecision":"deny"/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/gate/decide.test.js tests/hooks/gate-modes.test.js`
Expected: FAIL (nudge cases deny; `gate_mode` missing from the payload; malformed nudge input denies).

- [ ] **Step 3: Implement**

`src/gate/decide.js`, `decideGate`: add `mode = 'strict'` to the destructured parameters; make the first line `if (gateEnabled === false || mode === 'off') return { decision: 'none', reason: 'gate-off' };`; after the `allowTools` check insert:

```js
  // Nudge never blocks a tool call; unlinked work is raised once at Stop instead (ADR 0005).
  if (mode === 'nudge') return { decision: 'none', reason: binding && binding.ticket_id ? 'bound' : 'nudge-unbound' };
```

`src/hooks/scope.js`:

```js
// Resolves the gate mode, tracker and project that apply to a hook call from the runtime identity:
// the registered repository with the longest path containing cwd wins (ADR 0005).
import path from 'node:path';

function norm(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function scopeFor(identity, cwd) {
  const base = { gate_mode: identity.gate_mode ?? 'strict', tracker: identity.tracker ?? null, project_id: identity.default_project_id ?? null, repo_id: null };
  if (typeof cwd !== 'string' || !cwd || !Array.isArray(identity.repos)) return base;
  const c = norm(cwd);
  let best = null;
  let bestLen = -1;
  for (const r of identity.repos) {
    if (!r || typeof r.path !== 'string') continue;
    const rp = norm(r.path);
    const within = c === rp || c.startsWith(rp.endsWith(path.sep) ? rp : rp + path.sep);
    if (within && rp.length > bestLen) { best = r; bestLen = rp.length; }
  }
  if (!best) return base;
  return { gate_mode: best.gate_mode ?? base.gate_mode, tracker: best.tracker ?? null, project_id: best.project_id ?? base.project_id, repo_id: best.repo_id ?? null };
}
```

`src/hooks/adapter.js`:
- import `scopeFor` from `'./scope.js'` and `keyExample` from `'../core/external-keys.js'`.
- Replace the `covered` line and the two early returns with:

```js
  const identity = readRuntimeIdentity(env);
  const { session_id, agent_id } = identityOf(input);
  // Every tool outside the dedicated read set is "covered".
  const toolCovered = eventName === 'PreToolUse' && !!input.tool_name && !READ_TOOLS.has(input.tool_name) && !(identity && Array.isArray(identity.allow_tools) && identity.allow_tools.includes(input.tool_name));

  if (!identity) {
    result.stderr += 'Session Quill: not initialized; run `quill init` to enable capture and the ticket gate.\n';
    return result;
  }
  const scope = scopeFor(identity, input.cwd);
  if (!session_id) {
    result.stderr += 'Session Quill: hook input has no session_id; identity unresolved (no cwd fallback).\n';
    if (toolCovered && scope.gate_mode !== 'nudge') result.stdout = denyOutput(`${DENIAL_REASON} (host provided no session identity)`);
    return result;
  }
```

- After `gateEnabled` is computed add:

```js
  const mode = gateEnabled ? scope.gate_mode : 'off';
  // Capture failures fail closed for covered tools except in nudge mode, which never blocks.
  const covered = toolCovered && scope.gate_mode !== 'nudge';
```

- In `PreToolUse`: pass `mode` to `decideGate`, add `gate_mode: mode` to the pre-tool payload, and build the denial with a key hint:

```js
      const reason = denied && scope.tracker ? `${gate.reason} Mentioning a ticket key such as ${keyExample(scope.tracker)} in a prompt also links the session.` : gate.reason;
      if (denied) result.stdout = denyOutput(reason);
```

`src/cli/commands/hook.js`: import `readRuntimeIdentity` from `'../../hooks/binding-snapshot.js'` and add

```js
// Without a readable tool call the hook cannot resolve the repository scope, so it fails closed
// when no identity is readable or any configured scope is not nudge (ADR 0005).
function failsClosed(env) {
  let identity = null;
  try { identity = readRuntimeIdentity(env); } catch { identity = null; }
  if (!identity) return true;
  const modes = [identity.gate_mode ?? 'strict', ...(Array.isArray(identity.repos) ? identity.repos.map((r) => (r && r.gate_mode) ?? 'strict') : [])];
  return modes.some((m) => m !== 'nudge');
}
```

and guard both DENY writes with `&& failsClosed(env)`.

- [ ] **Step 4: Run to verify**

Run: `node --test tests/gate/decide.test.js tests/hooks/gate-modes.test.js tests/hooks/adapter.test.js tests/review/fixes.test.js tests/acceptance/phase0.test.js`
Expected: PASS (existing tests write identities without `gate_mode`, so they keep strict behaviour).

- [ ] **Step 5: Commit**

```bash
git add src/gate/decide.js src/hooks/scope.js src/hooks/adapter.js src/cli/commands/hook.js tests/gate/decide.test.js tests/hooks/gate-modes.test.js
git commit -m "feat(gate): off, nudge and strict gate modes resolved per repository"
```

---

### Task 5: Reducer — bind by external key

**Files:**
- Modify: `src/core/state.js` (`newTicket` gains `external = null`)
- Modify: `src/core/reducer.js` (`createTicket` passes `external` and `created_via`; `bind` → `bindExternal`; `pre-tool` unknown-ticket fallback; `prompt` republishes snapshots of new sessions; `relink` stores `external`)
- Test: new `tests/core/external-bind.test.js`

**Interfaces:**
- Consumes: `externalTicketId` (Task 2).
- Produces: `bind` payload `{ external: { system, key, url }, source: 'prompt'|'branch', title_hint, project_id, repo_id, ensure_only }`; ticket field `external: { system, key, url, validation, validated_at, error } | null`; `relink` payload may carry `external`.

- [ ] **Step 1: Write the failing test** `tests/core/external-bind.test.js`

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev, resetSeq, STORE } from './helpers.js';
import { externalTicketId } from '../../src/core/external-keys.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ext = (key, extra = {}) => ({ external: { system: 'jira', key, url: `https://example.atlassian.net/browse/${key}` }, source: 'prompt', title_hint: null, project_id: 'demo', repo_id: 'demo', ensure_only: false, ...extra });
const start = (state, session_id = 'h1') => ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id });

beforeEach(() => resetSeq());

test('bind by external key creates the ticket under that key and binds the session', () => {
  const state = newState();
  start(state);
  const r = ev(state, 'bind', ext('PMLA-1234', { title_hint: 'PMLA-1234 fix the retry flake' }), { session_id: 'h1' });
  assert.equal(r.rejected, undefined);
  const id = externalTicketId(STORE, 'PMLA-1234');
  const t = state.tickets.get(id);
  assert.equal(t.key, 'PMLA-1234');
  assert.equal(t.title, 'PMLA-1234 fix the retry flake');
  assert.equal(t.project_id, 'demo');
  assert.deepEqual(t.external, { system: 'jira', key: 'PMLA-1234', url: 'https://example.atlassian.net/browse/PMLA-1234', validation: 'pending', validated_at: null, error: null });
  assert.equal(t.jira.key, 'PMLA-1234');
  assert.match(t.timeline[0].text, /Created \(auto from prompt\)/);
  const s = state.sessions.get('h1');
  assert.equal(s.current_ticket_id, id);
  assert.equal(s.current_binding_revision, 1);
  assert.ok(r.bindingChanged.has('h1'));
});

test('a key that already names a ticket, or an alias, binds to it; repeating the bind is a no-op', () => {
  const state = newState();
  createTicket(state);
  ev(state, 'relink', { ticket_id: T1, new_key: 'PMLA-7' });
  start(state);
  ev(state, 'bind', ext('PMLA-7'), { session_id: 'h1' });
  const s = state.sessions.get('h1');
  assert.equal(s.current_ticket_id, T1);
  ev(state, 'bind', ext('LOCAL-demo-ticket-00000001'), { session_id: 'h1' });
  ev(state, 'bind', ext('PMLA-7'), { session_id: 'h1' });
  assert.equal(s.current_binding_revision, 1);
  assert.equal(state.tickets.size, 1);
});

test('switching keys closes the previous interval; ensure_only records a mention without rebinding', () => {
  const state = newState();
  start(state);
  ev(state, 'bind', ext('PMLA-1'), { session_id: 'h1' });
  ev(state, 'bind', ext('PMLA-2'), { session_id: 'h1', occurred_at: '2026-10-02T08:10:00Z' });
  const s = state.sessions.get('h1');
  assert.equal(s.current_binding_revision, 2);
  assert.equal(s.bindings[0].unbound_at, '2026-10-02T08:10:00Z');
  ev(state, 'bind', ext('PMLA-3', { ensure_only: true }), { session_id: 'h1' });
  assert.equal(s.current_binding_revision, 2);
  assert.equal(s.current_ticket_id, externalTicketId(STORE, 'PMLA-2'));
  const t3 = state.tickets.get(externalTicketId(STORE, 'PMLA-3'));
  assert.match(t3.timeline.at(-1).text, /Mentioned in session h1/);
});

test('invalid keys are rejected and the session snapshot is still republished', () => {
  const state = newState();
  start(state);
  const r = ev(state, 'bind', ext('../etc'), { session_id: 'h1' });
  assert.equal(r.rejected, 'key-invalid');
  assert.ok(r.bindingChanged.has('h1'));
  assert.equal(state.tickets.size, 0);
});

test('a missing title hint names the ticket after its key; a missing project falls back to the first configured project', () => {
  const state = newState();
  start(state);
  ev(state, 'bind', ext('PMLA-5', { title_hint: '', project_id: null }), { session_id: 'h1' });
  const t = state.tickets.get(externalTicketId(STORE, 'PMLA-5'));
  assert.equal(t.title, 'PMLA-5');
  assert.equal(t.project_id, 'demo');
});

test('a pre-tool record naming an unknown ticket id is attributed to the session\'s current binding', () => {
  const state = newState();
  start(state);
  ev(state, 'bind', ext('PMLA-9'), { session_id: 'h1' });
  ev(state, 'pre-tool', { tool_name: 'Edit', write_target: 'src/a.js' }, { session_id: 'h1', tool_call_id: 't1', ticket_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', binding_revision: 1, occurred_at: '2026-10-02T08:05:00Z' });
  ev(state, 'post-tool', { tool_name: 'Edit', write_paths: ['src/a.js'], repo_id: 'demo', success: true }, { session_id: 'h1', tool_call_id: 't1', source_identity: 'post-tool:h1:t1', occurred_at: '2026-10-02T08:05:00Z' });
  const t = state.tickets.get(externalTicketId(STORE, 'PMLA-9'));
  assert.ok(t.files_touched.some((f) => f.relative_path === 'src/a.js'));
});

test('the first prompt from an unseen session republishes its binding snapshot', () => {
  const state = newState();
  const first = ev(state, 'prompt', { title_candidate: 'x', approval_candidate: false, length: 1 }, { session_id: 'late' });
  assert.ok(first.bindingChanged.has('late'));
  const second = ev(state, 'prompt', { title_candidate: null, approval_candidate: false, length: 1 }, { session_id: 'late' });
  assert.equal(second.bindingChanged.has('late'), false);
});

test('relink with an external record stores it beside the legacy jira field', () => {
  const state = newState();
  const t = createTicket(state);
  ev(state, 'relink', { ticket_id: T1, new_key: 'ENG-9', external: { system: 'linear', key: 'ENG-9', url: 'https://linear.app/acme/issue/ENG-9', validation: 'pending', validated_at: null, error: 'pending' } });
  assert.equal(t.key, 'ENG-9');
  assert.equal(t.external.system, 'linear');
  assert.equal(t.jira, null);
  assert.match(t.timeline.at(-1).text, /linear ENG-9/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core/external-bind.test.js`
Expected: FAIL (`ticket-unknown` rejection for external binds).

- [ ] **Step 3: Implement**

`src/core/state.js` `newTicket`: add `external = null` to the parameters and `external,` after `jira,` in the returned object.

`src/core/reducer.js`:
- import `externalTicketId` from `'./external-keys.js'`.
- In `createTicket`, pass `external: t.external ?? null` to `newTicket` and make the creation timeline entry ``timelineEntry(ev, 'status', `Created (${t.created_via ?? source})`)``.
- Add after `createTicket`:

```js
// Zero-command binding (ADR 0005): a ticket key seen in a prompt or branch binds the session,
// creating the ticket under that key (with a deterministic id) when the store has none.
function bindExternal(state, session, ev, result) {
  const p = ev.payload;
  const ext = p.external;
  if (!ext || typeof ext.key !== 'string') return { rejected: 'external-invalid' };
  try { validateKey(ext.key); } catch { return { rejected: 'key-invalid' }; }
  let ticketId = state.keyIndex.get(ext.key) ?? null;
  if (!ticketId) {
    const project_id = p.project_id ?? Object.keys(state.meta.projects)[0] ?? null;
    if (!project_id) return { rejected: 'project-required' };
    const external = { system: ext.system ?? 'custom', key: ext.key, url: ext.url ?? null, validation: 'pending', validated_at: null, error: ext.error ?? null };
    const id = externalTicketId(state.meta.store_id, ext.key);
    const title = (typeof p.title_hint === 'string' && p.title_hint.trim()) ? p.title_hint.trim().slice(0, 200) : ext.key;
    const created = createTicket(state, ev, {
      id, key: ext.key, title, project_id, category: 'research', priority: 'P2', repo_id: p.repo_id ?? null, external,
      jira: external.system === 'jira' ? { key: ext.key, url: external.url, validation: 'pending', validated_at: null, error: external.error } : null,
      created_via: `auto from ${p.source ?? 'prompt'}`,
    }, 'evidence', result);
    if (created.rejected) return created;
    ticketId = id;
  }
  const ticket = state.tickets.get(ticketId);
  if (p.ensure_only === true) {
    ticket.timeline.push(timelineEntry(ev, 'status', `Mentioned in session ${session.host_session_id} (${p.source ?? 'prompt'})`));
    touch(state, ticket, ev, result);
    return {};
  }
  if (session.current_ticket_id === ticketId) return {};
  bindSession(state, session, ev, { ticket_id: ticketId, project_id: ticket.project_id }, result);
  return {};
}
```

- `bind` case becomes:

```js
    case 'bind': {
      const s = getOrCreateSession(state, ev);
      // Always republish: a rejected bind must replace any provisional snapshot the hook wrote.
      result.bindingChanged.add(sessionKey(ev));
      if (ev.payload.external) { Object.assign(result, bindExternal(state, s, ev, result)); break; }
      const ticket = ev.payload.ticket_id ? state.tickets.get(ev.payload.ticket_id) : null;
      if (ev.payload.ticket_id && !ticket) { result.rejected = 'ticket-unknown'; break; }
      bindSession(state, s, ev, { ticket_id: ev.payload.ticket_id ?? null, project_id: ev.payload.project_id ?? (ticket ? ticket.project_id : null) }, result);
      break;
    }
```

- `prompt` case: before `getOrCreateSession` add `const seen = state.sessions.has(sessionKey(ev));` and after it `if (!seen) result.bindingChanged.add(sessionKey(ev));`.
- `pre-tool` case: replace the two attribution lines with

```js
        // A provisional hook binding can name a ticket id the worker resolved differently (the key
        // belonged to an existing ticket); the session's own confirmed binding is authoritative then.
        const unknownTicket = !!ev.ticket_id && !state.tickets.has(ev.ticket_id);
        const ticket_id = unknownTicket ? s.current_ticket_id : (ev.ticket_id ?? s.current_ticket_id);
        const binding_revision = unknownTicket ? s.current_binding_revision : (ev.binding_revision ?? s.current_binding_revision);
```

- `relink` case: after the `jira` assignment add `if (ev.payload.external !== undefined) ticket.external = ev.payload.external;` and change the timeline line to

```js
      const link = ticket.external ? ` (${ticket.external.system} ${ticket.external.key}, validation ${ticket.external.validation})` : ticket.jira ? ` (Jira ${ticket.jira.key}, validation ${ticket.jira.validation})` : '';
      ticket.timeline.push(timelineEntry(ev, 'status', `Relinked to ${ticket.key}${link}`));
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/core/external-bind.test.js tests/core/reducer.test.js tests/core/keys.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.js src/core/reducer.js tests/core/external-bind.test.js
git commit -m "feat(core): bind sessions by external ticket key, creating the ticket on first sight"
```

---

### Task 6: Worker — identity publication, refresh and provisional-snapshot guard

**Files:**
- Modify: `src/worker/worker.js` (constructor option `identityCheckMs`; `publishIdentity`, `refreshIdentity`; `tick`; `publishBinding` guard and `ticket_aliases`)
- Modify: `tests/acceptance/scenario.js` (option `gateMode`, default `'strict'`, for the strict-gate scenarios A01–A41)
- Test: new `tests/worker/identity.test.js`

**Interfaces:**
- Consumes: `buildRuntimeIdentity`, `identityStamp` (Task 3).
- Produces: exports `IDENTITY_CHECK_MS = 10_000`, `PROVISIONAL_MAX_MS = 30_000`; binding snapshots gain `ticket_aliases`; provisional contract for Task 7: a snapshot `{ provisional: true, provisional_event_id, provisional_at }` is kept while its event is unapplied and younger than 30 s.

- [ ] **Step 1: Write the failing test** `tests/worker/identity.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { readRuntimeIdentity, readBindingSnapshot, writeBindingSnapshot } from '../../src/hooks/binding-snapshot.js';
import { externalTicketId } from '../../src/core/external-keys.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';

function fixture({ repoToml = null, gate = null, tracker = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ident-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-identrepo-'));
  if (repoToml !== null) fs.writeFileSync(path.join(repo, '.quill.toml'), repoToml);
  const config = { ...defaultUserConfig(), store_path: storePath, default_project: 'demo', projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', canonical_path: repo, default_branch: 'main', deployment_environments: ['production'] } } };
  if (gate) config.gate = { ...config.gate, ...gate };
  if (tracker) config.tracker = tracker;
  const env = { QUILL_HOME: home };
  saveUserConfig(config, env);
  const clock = () => Date.parse('2026-10-02T08:00:00Z');
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: '2026-10-02T08:00:00Z', ...extra });
  return { home, repo, meta, config, env, clock, mk };
}

test('the worker publishes gate mode, tracker and per-repository scopes in the runtime identity', async () => {
  const f = fixture({ repoToml: 'project_id = "demo"\n[tracker]\nsystem = "jira"\ndomain = "https://example.atlassian.net"\nprefixes = ["PMLA"]\n[gate]\nmode = "strict"\n' });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  try {
    const id = readRuntimeIdentity(f.env);
    assert.equal(id.gate_mode, 'nudge');
    assert.equal(id.tracker, null);
    const r = id.repos.find((x) => x.repo_id === 'demo');
    assert.equal(r.gate_mode, 'strict');
    assert.deepEqual(r.tracker.prefixes, ['PMLA']);
    assert.equal(r.tracker.url_template, '{domain}/browse/{key}');
  } finally { await w.stop(); }
});

test('a repository cannot loosen the gate, and invalid tracker config is reported rather than applied', async () => {
  const f = fixture({ gate: { mode: 'strict' }, repoToml: "[gate]\nmode = \"off\"\n[tracker]\nkey_pattern = '(a+)+'\n" });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  try {
    const r = readRuntimeIdentity(f.env).repos[0];
    assert.equal(r.gate_mode, 'strict');
    assert.equal(r.tracker, null);
    const health = fs.readFileSync(path.join(f.home, 'state', 'health-errors.jsonl'), 'utf8');
    assert.match(health, /config-invalid/);
    assert.match(health, /backtracking/);
  } finally { await w.stop(); }
});

test('editing a registered .quill.toml republishes the identity without a restart', async () => {
  const f = fixture({ repoToml: '[tracker]\nprefixes = ["PMLA"]\n' });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, identityCheckMs: 0 });
  await w.start();
  try {
    const file = path.join(f.repo, '.quill.toml');
    fs.writeFileSync(file, '[tracker]\nprefixes = ["PC"]\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    w.tick();
    assert.deepEqual(readRuntimeIdentity(f.env).repos[0].tracker.prefixes, ['PC']);
  } finally { await w.stop(); }
});

test('a fresh provisional snapshot survives an unrelated publish until its bind event is applied', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  try {
    const bindEv = f.mk('bind', { external: { system: 'jira', key: 'PMLA-1', url: null }, source: 'prompt', title_hint: null, project_id: 'demo', repo_id: 'demo', ensure_only: false }, { session_id: 'p1' });
    const provisionalId = externalTicketId(f.meta.store_id, 'PMLA-1');
    writeBindingSnapshot('p1', { session_id: null, ticket_id: provisionalId, ticket_key: 'PMLA-1', ticket_title: 'PMLA-1', ticket_aliases: [], project_id: 'demo', binding_revision: 1, gate_enabled: true, has_title: false, provisional: true, provisional_event_id: bindEv.event_id, provisional_at: '2026-10-02T08:00:00Z' }, f.env);
    writeIngress(f.mk('session-start', { source: 'startup', cwd: f.repo }, { session_id: 'p1' }), f.env);
    w.tick();
    assert.equal(readBindingSnapshot('p1', f.env).provisional, true, 'an unrelated publish keeps the provisional binding');
    writeIngress(bindEv, f.env);
    w.tick();
    const confirmed = readBindingSnapshot('p1', f.env);
    assert.equal(confirmed.provisional, undefined);
    assert.equal(confirmed.ticket_id, provisionalId);
    assert.equal(confirmed.binding_revision, 1);
    assert.deepEqual(confirmed.ticket_aliases, []);
    writeBindingSnapshot('p2', { ticket_id: provisionalId, ticket_key: 'PMLA-1', binding_revision: 1, gate_enabled: true, provisional: true, provisional_event_id: 'never-applied', provisional_at: '2026-10-02T07:58:00Z' }, f.env);
    writeIngress(f.mk('session-start', { source: 'startup', cwd: f.repo }, { session_id: 'p2' }), f.env);
    w.tick();
    assert.equal(readBindingSnapshot('p2', f.env).ticket_id, null, 'a stale provisional snapshot is replaced');
  } finally { await w.stop(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/worker/identity.test.js`
Expected: FAIL (`gate_mode` undefined; provisional snapshot overwritten).

- [ ] **Step 3: Implement** in `src/worker/worker.js`

- imports: `buildRuntimeIdentity, identityStamp` from `'../config/runtime.js'`; `loadUserConfig` from `'../config/config.js'`; add `readBindingSnapshot` to the binding-snapshot import and `configPath` to the paths import.
- exports: `export const IDENTITY_CHECK_MS = 10 * SECOND;` and `export const PROVISIONAL_MAX_MS = 30 * SECOND;`.
- constructor: accept `identityCheckMs = IDENTITY_CHECK_MS`; set `this.identityCheckMs = identityCheckMs; this.identityStampValue = null; this.lastIdentityCheckMs = 0; this.identityWarnings = new Set();`.
- `start()`: replace the `writeRuntimeIdentity({...}, this.env);` block with `this.publishIdentity();`.
- `tick()`: call `this.refreshIdentity();` right after `this.heartbeat();`.
- new methods:

```js
  publishIdentity() {
    const { identity, warnings } = buildRuntimeIdentity({ storeMeta: this.storeMeta, config: this.config });
    writeRuntimeIdentity(identity, this.env);
    for (const w of warnings) {
      if (this.identityWarnings.has(w)) continue;
      this.identityWarnings.add(w);
      this.log(`config: ${w}`);
      this.recordHealthError({ kind: 'config-invalid', error: w });
    }
    this.identityStampValue = identityStamp(this.config, this.env);
  }

  // Gate mode and tracker edits in config.toml or a registered .quill.toml apply without a restart.
  refreshIdentity() {
    const ms = this.clock();
    if (ms - this.lastIdentityCheckMs < this.identityCheckMs) return;
    this.lastIdentityCheckMs = ms;
    if (identityStamp(this.config, this.env) === this.identityStampValue) return;
    try {
      if (fs.existsSync(configPath(this.env))) {
        const fresh = loadUserConfig(this.env);
        this.config = { ...this.config, gate_enabled: fresh.gate_enabled, gate: fresh.gate, tracker: fresh.tracker };
      }
    } catch (err) {
      this.recordHealthError({ kind: 'config-invalid', error: `config.toml: ${err.message}` });
    }
    this.publishIdentity();
  }
```

- `publishBinding(key)`: after the `session` guard add

```js
    // A hook's provisional binding (ADR 0005) stands until its bind event is applied, so an
    // unrelated republish cannot undo a binding the user just made; stale ones are replaced.
    const existing = readBindingSnapshot(key, this.env);
    if (existing && existing.provisional === true && existing.provisional_event_id && !this.state.appliedEvents.has(existing.provisional_event_id)) {
      const age = Math.abs(this.clock() - Date.parse(existing.provisional_at ?? ''));
      if (age < PROVISIONAL_MAX_MS) return;
    }
```

  and add `ticket_aliases: ticket ? [...ticket.aliases] : [],` to the published snapshot.

`tests/acceptance/scenario.js`: add `gateMode = 'strict'` to the `scenario()` options and set `config.gate = { ...config.gate, mode: gateMode };` before `saveUserConfig(config, env)`.

- [ ] **Step 4: Run to verify**

Run: `node --test tests/worker/identity.test.js tests/worker/worker.test.js tests/acceptance/phase1.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/worker.js tests/worker/identity.test.js tests/acceptance/scenario.js
git commit -m "feat(worker): publish per-repository gate and tracker scopes; keep fresh provisional bindings"
```

---

### Task 7: Hooks — auto-binding from prompt and branch

**Files:**
- Create: `src/lib/git-head.js` (`gitDirFor`, `currentBranch`)
- Create: `src/hooks/autobind.js` (`planAutoBind`)
- Modify: `src/hooks/adapter.js` (`autoBind` helper, `UserPromptSubmit`, `SessionStart`, `bindingContext`)
- Test: new `tests/lib/git-head.test.js`, new `tests/hooks/autobind.test.js`

**Interfaces:**
- Consumes: `findKeys`, `renderUrl`, `externalTicketId`, `branchTitle`, `keyExample` (Task 2); `scopeFor` and `mode` (Task 4); bind payload (Task 5); provisional contract (Task 6).
- Produces:
  - `currentBranch(cwd) -> string | null` (reads `.git/HEAD`; follows a worktree `.git` file).
  - `planAutoBind({ source, text, snapshot, tracker }) -> { key, ensure_only } | null`.
  - `UserPromptSubmit` `additionalContext` naming the linked key, plus the session id when the worker has never published a snapshot for the session.

- [ ] **Step 1: Write the failing tests**

`tests/lib/git-head.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { currentBranch } from '../../src/lib/git-head.js';

test('currentBranch reads HEAD from the nearest .git directory or worktree file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-head-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/PMLA-12-retry\n');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(currentBranch(path.join(repo, 'src', 'deep')), 'feat/PMLA-12-retry');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wt-'));
  const gitdir = path.join(repo, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/fix/PC-3\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  assert.equal(currentBranch(wt), 'fix/PC-3');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n');
  assert.equal(currentBranch(repo), null, 'detached HEAD has no branch');
  assert.equal(currentBranch(undefined), null);
});
```

`tests/hooks/autobind.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { planAutoBind } from '../../src/hooks/autobind.js';
import { writeBindingSnapshot, readBindingSnapshot, bindingSnapshotPath, writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { normalizeTracker, externalTicketId } from '../../src/core/external-keys.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-02T08:00:00Z';
const TRACKER = normalizeTracker({ system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA', 'PC'] });

function setup({ mode = 'nudge', tracker = TRACKER, branch = null, bound = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-auto-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-autorepo-'));
  if (branch) {
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  }
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: STORE, machine_id: MACHINE, store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: mode, approval_phrases_enabled: false, allow_tools: [], tracker: null, default_project_id: 'demo', repos: [{ repo_id: 'demo', path: repo, project_id: 'demo', gate_mode: mode, tracker }] }, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  if (bound) writeBindingSnapshot('s1', { session_id: 'x', ticket_id: T1, ticket_key: bound, ticket_title: 'Old', ticket_aliases: [], binding_revision: 1, gate_enabled: true, project_id: 'demo', has_title: true }, env);
  return { env, repo };
}

const hook = (fx, name, extra = {}) => runHook(name, { session_id: 's1', cwd: fx.repo, hook_event_name: name, permission_mode: 'default', ...extra }, { env: fx.env, now: NOW });
const binds = (fx) => listIngress(fx.env).map((x) => x.event).filter((e) => e.kind === 'bind');
const context = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test('a prompt mentioning a configured key links an unbound session before its next tool call', () => {
  const fx = setup({ mode: 'strict' });
  const r = hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-1234: fix the flaky retry test' });
  assert.match(context(r), /Linked to PMLA-1234/);
  const [bind] = binds(fx);
  assert.deepEqual(bind.payload.external, { system: 'jira', key: 'PMLA-1234', url: 'https://example.atlassian.net/browse/PMLA-1234' });
  assert.deepEqual([bind.payload.source, bind.payload.title_hint, bind.payload.project_id, bind.payload.repo_id, bind.payload.ensure_only], ['prompt', 'PMLA-1234: fix the flaky retry test', 'demo', 'demo', false]);
  const snap = readBindingSnapshot('s1', fx.env);
  assert.deepEqual([snap.provisional, snap.provisional_event_id, snap.ticket_key, snap.ticket_id, snap.binding_revision], [true, bind.event_id, 'PMLA-1234', externalTicketId(STORE, 'PMLA-1234'), 1]);
  const pre = hook(fx, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'u1', tool_input: { file_path: path.join(fx.repo, 'a.js') } });
  assert.equal(pre.stdout, '', 'the strict gate already sees the binding');
  const preEv = listIngress(fx.env).map((x) => x.event).find((e) => e.kind === 'pre-tool');
  assert.equal(preEv.ticket_id, externalTicketId(STORE, 'PMLA-1234'));
});

test('other prefixes, non-ticket tokens, missing tracker config and unregistered directories never bind', () => {
  const fx = setup();
  hook(fx, 'UserPromptSubmit', { prompt: 'Upgrade to UTF-8 and look at ABC-12' });
  assert.equal(binds(fx).length, 0);
  const none = setup({ tracker: null });
  hook(none, 'UserPromptSubmit', { prompt: 'PMLA-1 please' });
  assert.equal(binds(none).length, 0);
  hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-1 please', cwd: os.tmpdir() });
  assert.equal(binds(fx).length, 0);
});

test('a bound session switches on a new key by default, keeps its key when it is mentioned, and honours add and ignore', () => {
  const fx = setup({ bound: 'PMLA-1' });
  hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-1 depends on PMLA-2' });
  assert.equal(binds(fx).length, 0, 'the current key is mentioned, so nothing changes');
  hook(fx, 'UserPromptSubmit', { prompt: 'now look at PMLA-2' });
  assert.equal(binds(fx).length, 1);
  assert.equal(readBindingSnapshot('s1', fx.env).binding_revision, 2);
  const add = setup({ bound: 'PMLA-1', tracker: normalizeTracker({ prefixes: ['PMLA'], on_new_key: 'add' }) });
  hook(add, 'UserPromptSubmit', { prompt: 'see PMLA-3' });
  assert.equal(binds(add)[0].payload.ensure_only, true);
  assert.equal(readBindingSnapshot('s1', add.env).ticket_key, 'PMLA-1', 'add never rebinds');
  const ignore = setup({ bound: 'PMLA-1', tracker: normalizeTracker({ prefixes: ['PMLA'], on_new_key: 'ignore' }) });
  hook(ignore, 'UserPromptSubmit', { prompt: 'see PMLA-3' });
  assert.equal(binds(ignore).length, 0);
});

test('SessionStart links from the branch name when unbound and never switches an existing binding', () => {
  const fx = setup({ branch: 'feat/pmla-77-retry-flake' });
  const r = hook(fx, 'SessionStart', { source: 'startup' });
  assert.match(context(r), /Bound to PMLA-77 \(retry flake\)/);
  assert.deepEqual([binds(fx)[0].payload.source, binds(fx)[0].payload.title_hint], ['branch', 'retry flake']);
  const kept = setup({ branch: 'feat/PMLA-77-x', bound: 'PMLA-1' });
  hook(kept, 'SessionStart', { source: 'resume' });
  assert.equal(binds(kept).length, 0);
});

test('a session the worker has never seen gets its session id on the first prompt', () => {
  const fx = setup();
  assert.match(context(hook(fx, 'UserPromptSubmit', { prompt: 'hello' })), /Session Quill session: s1\..*Mention a ticket key \(for example PMLA-123\)/);
  const bound = setup({ bound: 'PMLA-1' });
  assert.equal(hook(bound, 'UserPromptSubmit', { prompt: 'hello' }).stdout, '');
});

test('if the bind event cannot be persisted the provisional snapshot is rolled back', () => {
  const fx = setup();
  fs.rmSync(path.join(fx.env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(fx.env.QUILL_HOME, 'ingress'), 'blocker');
  hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-5 go' });
  assert.equal(fs.existsSync(bindingSnapshotPath('s1', fx.env)), false);
  const bound = setup({ bound: 'PMLA-1' });
  fs.rmSync(path.join(bound.env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(bound.env.QUILL_HOME, 'ingress'), 'blocker');
  hook(bound, 'UserPromptSubmit', { prompt: 'PMLA-5 go' });
  assert.equal(readBindingSnapshot('s1', bound.env).ticket_key, 'PMLA-1');
});

test('planAutoBind: branches never switch, sources are honoured, the first new key wins, aliases count as bound', () => {
  assert.deepEqual(planAutoBind({ source: 'prompt', text: 'PC-1 and PMLA-2', snapshot: null, tracker: TRACKER }), { key: 'PC-1', ensure_only: false });
  assert.equal(planAutoBind({ source: 'branch', text: 'PMLA-2', snapshot: { ticket_id: T1, ticket_key: 'PMLA-1' }, tracker: TRACKER }), null);
  assert.equal(planAutoBind({ source: 'prompt', text: 'PMLA-2', snapshot: null, tracker: normalizeTracker({ prefixes: ['PMLA'], sources: ['branch'] }) }), null);
  assert.equal(planAutoBind({ source: 'prompt', text: 'see OLD-1', snapshot: { ticket_id: T1, ticket_key: 'PMLA-1', ticket_aliases: ['OLD-1'] }, tracker: normalizeTracker({ prefixes: ['PMLA', 'OLD'] }) }), null);
});

test('prompt scanning with auto-binding stays within the hook budget', () => {
  const fx = setup();
  const durations = [];
  const prompt = `PMLA-42 ${'context '.repeat(500)}`;
  for (let i = 0; i < 100; i += 1) {
    const started = process.hrtime.bigint();
    runHook('UserPromptSubmit', { session_id: `perf-${i}`, cwd: fx.repo, hook_event_name: 'UserPromptSubmit', prompt }, { env: fx.env, now: NOW });
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  durations.sort((a, b) => a - b);
  assert.ok(durations[94] < 200, `p95 ${durations[94].toFixed(1)} ms`);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/lib/git-head.test.js tests/hooks/autobind.test.js`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement**

`src/lib/git-head.js`:

```js
// Reads the current branch from .git/HEAD without spawning git, so hooks stay fast and offline.
import fs from 'node:fs';
import path from 'node:path';

export function gitDirFor(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { st = null; }
    if (st && st.isDirectory()) return dotGit;
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      return m ? path.resolve(dir, m[1]) : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function currentBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const gitDir = gitDirFor(cwd);
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1].slice(0, 255) : null;
  } catch {
    return null;
  }
}
```

`src/hooks/autobind.js`:

```js
// Decides whether a prompt or branch should change this session's binding (ADR 0005).
import { findKeys } from '../core/external-keys.js';

export function planAutoBind({ source, text, snapshot, tracker }) {
  if (!tracker || !tracker.sources.includes(source)) return null;
  const keys = findKeys(text, tracker, { uppercase: source === 'branch' && tracker.prefixes.length > 0 });
  if (!keys.length) return null;
  const bound = snapshot && snapshot.ticket_id ? [snapshot.ticket_key, ...(snapshot.ticket_aliases ?? [])] : [];
  if (bound.some((k) => keys.includes(k))) return null;
  if (!bound.length) return { key: keys[0], ensure_only: false };
  if (source === 'branch') return null;
  if (tracker.on_new_key === 'switch') return { key: keys[0], ensure_only: false };
  if (tracker.on_new_key === 'add') return { key: keys[0], ensure_only: true };
  return null;
}
```

`src/hooks/adapter.js`:
- imports: `planAutoBind` from `'./autobind.js'`; `currentBranch` from `'../lib/git-head.js'`; extend the external-keys import with `renderUrl, externalTicketId, branchTitle`; `writeBindingSnapshot, bindingSnapshotPath` from `'./binding-snapshot.js'`; `removeIfExists` from `'../lib/atomic-fs.js'`.
- replace `bindingContext`:

```js
function bindingContext(snapshot, session_id, mode, tracker) {
  if (snapshot && snapshot.ticket_id) {
    const title = snapshot.ticket_title && snapshot.ticket_title !== snapshot.ticket_key ? ` (${snapshot.ticket_title})` : '';
    return `Session Quill session: ${session_id}. Bound to ${snapshot.ticket_key}${title}, binding revision ${snapshot.binding_revision}. Supported writes are permitted. Use /session-quill:ticket show for details.`;
  }
  const gateNote = mode === 'off'
    ? 'Ticket gate is OFF for this session (audited).'
    : mode === 'nudge'
      ? 'Writes are not blocked (gate mode nudge); unlinked work is raised once at the end of a turn.'
      : 'Ticket gate is ON: supported write tools are denied until bound.';
  const how = tracker ? `Mention a ticket key (for example ${keyExample(tracker)}) in a prompt to link this session, or run` : 'Run';
  return `Session Quill session: ${session_id}. This session is unbound. ${gateNote} ${how} /session-quill:ticket create "<title>" or /session-quill:ticket bind <KEY>; pass --session ${session_id} to the quill CLI.`;
}
```

- add the IO helper:

```js
// Writes the provisional snapshot before the bind event so the worker's confirmation always lands
// after it; if the event cannot be persisted, the previous snapshot is restored (ADR 0005).
function autoBind({ plan, source, titleHint, base, key, snapshot, scope, identity, env, result, occurred_at }) {
  const tracker = scope.tracker;
  const ticket_id = externalTicketId(identity.store_id, plan.key);
  const ev = makeEvent({
    ...base, kind: 'bind', ticket_id: plan.ensure_only ? null : ticket_id,
    payload: { external: { system: tracker.system, key: plan.key, url: renderUrl(plan.key, tracker) }, source, title_hint: titleHint || null, project_id: scope.project_id, repo_id: scope.repo_id, ensure_only: plan.ensure_only },
    source_identity: `bind:${key}:${source}:${plan.key}:${occurred_at}`,
  });
  if (!plan.ensure_only) {
    try {
      writeBindingSnapshot(key, {
        session_id: snapshot ? snapshot.session_id ?? null : null, ticket_id, ticket_key: plan.key, ticket_title: titleHint || plan.key, ticket_aliases: [],
        project_id: scope.project_id, binding_revision: (snapshot ? snapshot.binding_revision ?? 0 : 0) + 1, gate_enabled: !(snapshot && snapshot.gate_enabled === false),
        has_title: !!(snapshot && snapshot.has_title), provisional: true, provisional_event_id: ev.event_id, provisional_at: occurred_at,
      }, env);
    } catch (err) {
      result.stderr += `Session Quill: provisional binding not written (${err.message})\n`;
    }
  }
  if (persist(ev, env, result)) return true;
  if (!plan.ensure_only) {
    try {
      if (snapshot) writeBindingSnapshot(key, snapshot, env);
      else removeIfExists(bindingSnapshotPath(key, env));
    } catch { /* nothing more to restore */ }
  }
  return false;
}
```

- `SessionStart` (non-handoff path) becomes:

```js
      let current = snapshot;
      if (!(current && current.ticket_id) && scope.tracker) {
        const branch = currentBranch(input.cwd);
        const plan = branch ? planAutoBind({ source: 'branch', text: branch, snapshot: current, tracker: scope.tracker }) : null;
        if (plan && autoBind({ plan, source: 'branch', titleHint: branchTitle(branch, plan.key), base, key, snapshot: current, scope, identity, env, result, occurred_at })) current = readBindingSnapshot(key, env);
      }
      result.stdout = contextOutput('SessionStart', bindingContext(current, session_id, mode, scope.tracker));
      return result;
```

- `UserPromptSubmit`, after `persist(ev, env, result);`:

```js
      const context = [];
      // A session started before `quill init` (or whose SessionStart was missed) learns its id here.
      if (!snapshot) context.push(bindingContext(null, session_id, mode, scope.tracker));
      if (!handoff) {
        const plan = planAutoBind({ source: 'prompt', text: prompt, snapshot, tracker: scope.tracker });
        if (plan && autoBind({ plan, source: 'prompt', titleHint: sanitizeTitle(prompt), base, key, snapshot, scope, identity, env, result, occurred_at }) && !plan.ensure_only) {
          const was = snapshot && snapshot.ticket_id ? ` (previously ${snapshot.ticket_key})` : '';
          context.length = 0;
          context.push(`Session Quill session: ${session_id}. Linked to ${plan.key}${was} because the prompt mentions it; captured work is attributed to it from now on.`);
        }
      }
      if (context.length) result.stdout = contextOutput('UserPromptSubmit', context.join(' '));
      return result;
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/lib/git-head.test.js tests/hooks/autobind.test.js tests/hooks/adapter.test.js tests/hooks/gate-modes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/git-head.js src/hooks/autobind.js src/hooks/adapter.js tests/lib/git-head.test.js tests/hooks/autobind.test.js
git commit -m "feat(hooks): link sessions from ticket keys in the prompt or branch, no commands needed"
```

---

### Task 8: Nudge at Stop

**Files:**
- Create: `src/hooks/nudge.js`
- Modify: `src/hooks/adapter.js` (`PostToolUse` marks unbound work; `Stop` asks once)
- Test: new `tests/hooks/nudge.test.js`

**Interfaces:**
- Consumes: `mode`, `scope` (Task 4); `keyExample` (Task 2).
- Produces: `markUnboundWork(key, env, at)`, `shouldNudge(key, env)`, `markNudged(key, env, at)`, `nudgeReason(tracker)`; marker file `state/nudge/<session>.json`; Stop output `{"decision":"block","reason":...}`; stop payload `nudged: boolean`.

- [ ] **Step 1: Write the failing test** `tests/hooks/nudge.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { writeBindingSnapshot, writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { normalizeTracker } from '../../src/core/external-keys.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-02T08:00:00Z';
const TRACKER = normalizeTracker({ system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA'] });

function setup({ mode = 'nudge', tracker = TRACKER, bound = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-nudge-'));
  const repo = path.resolve(os.tmpdir(), 'nudge-repo');
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: STORE, machine_id: 'M', store_path: home, gate_enabled: true, gate_mode: mode, approval_phrases_enabled: false, allow_tools: [], tracker, default_project_id: 'demo', repos: [] }, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  if (bound) writeBindingSnapshot('s1', { ticket_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_key: 'PMLA-1', binding_revision: 1, gate_enabled: true }, env);
  return { env, repo };
}

const hook = (fx, name, extra = {}) => runHook(name, { session_id: 's1', cwd: fx.repo, hook_event_name: name, ...extra }, { env: fx.env, now: NOW });
const edit = (fx, id = 'u1') => hook(fx, 'PostToolUse', { tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: path.join(fx.repo, 'src', 'a.js') }, tool_response: { filePath: path.join(fx.repo, 'src', 'a.js') } });
const stop = (fx, active = false) => hook(fx, 'Stop', { stop_hook_active: active, last_assistant_message: 'Done.' });

test('in nudge mode an unbound session that changed files is asked once at Stop', () => {
  const fx = setup();
  edit(fx);
  const out = JSON.parse(stop(fx).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /PMLA-123/);
  assert.match(out.reason, /Do not ask again/);
  assert.equal(listIngress(fx.env).map((x) => x.event).filter((e) => e.kind === 'stop')[0].payload.nudged, true);
  assert.equal(stop(fx, true).stdout, '', 'the continuation Claude runs because of the nudge is never blocked');
  edit(fx, 'u2');
  assert.equal(stop(fx).stdout, '', 'once per session');
});

test('no nudge when bound, when nothing changed, in strict or off mode, or for subagents', () => {
  const bound = setup({ bound: true });
  edit(bound);
  assert.equal(stop(bound).stdout, '');
  const idle = setup();
  assert.equal(stop(idle).stdout, '');
  for (const mode of ['strict', 'off']) {
    const fx = setup({ mode });
    edit(fx);
    assert.equal(stop(fx).stdout, '', mode);
  }
  const sub = setup();
  edit(sub);
  assert.equal(hook(sub, 'SubagentStop', { agent_id: 'a1', last_assistant_message: 'x' }).stdout, '');
});

test('without a tracker the nudge points at the bind command', () => {
  const fx = setup({ tracker: null });
  edit(fx);
  assert.match(JSON.parse(stop(fx).stdout).reason, /\/session-quill:ticket bind <KEY>/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/hooks/nudge.test.js`
Expected: FAIL (Stop prints nothing).

- [ ] **Step 3: Implement**

`src/hooks/nudge.js`:

```js
// Nudge-mode bookkeeping (ADR 0005): PostToolUse marks a session that changed files while unbound,
// and Stop asks Claude once per session to find out which ticket the work belongs to.
import path from 'node:path';
import { stateDir } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';
import { snapshotFileName } from './binding-snapshot.js';
import { keyExample } from '../core/external-keys.js';

export function nudgePath(sessionKey, env = process.env) {
  return path.join(stateDir(env), 'nudge', snapshotFileName(sessionKey));
}

function readNudge(sessionKey, env) {
  try { return readJsonIfExists(nudgePath(sessionKey, env)); } catch { return null; }
}

export function markUnboundWork(sessionKey, env, at) {
  const prior = readNudge(sessionKey, env);
  if (prior && (prior.pending || prior.nudged_at)) return;
  writeJsonAtomic(nudgePath(sessionKey, env), { schema_version: 1, session_key: sessionKey, pending: true, first_at: at, nudged_at: null });
}

export function shouldNudge(sessionKey, env) {
  const marker = readNudge(sessionKey, env);
  return !!(marker && marker.pending === true && !marker.nudged_at);
}

export function markNudged(sessionKey, env, at) {
  const prior = readNudge(sessionKey, env) ?? {};
  writeJsonAtomic(nudgePath(sessionKey, env), { ...prior, schema_version: 1, session_key: sessionKey, pending: false, nudged_at: at });
}

export function nudgeReason(tracker) {
  const how = tracker
    ? `tell them that mentioning its key (for example ${keyExample(tracker)}) in their next message links this session`
    : 'tell them they can link it with /session-quill:ticket bind <KEY> or /session-quill:ticket create "<title>"';
  return `Session Quill: this turn changed files but the session is not linked to a ticket. Before finishing, ask the user which ticket this work belongs to and ${how}. If the work has no ticket, say so. Do not ask again.`;
}
```

`src/hooks/adapter.js`: import the four functions. In `PostToolUse`, after `payload` is built:

```js
      if (mode === 'nudge' && !(snapshot && snapshot.ticket_id) && (payload.write_paths.length || payload.commit)) {
        try { markUnboundWork(key, env, occurred_at); } catch { /* best effort; never blocks capture */ }
      }
```

In `Stop`/`SubagentStop`, before the event is built:

```js
      const nudge = eventName === 'Stop' && mode === 'nudge' && !(snapshot && snapshot.ticket_id) && input.stop_hook_active !== true && shouldNudge(key, env);
```

add `nudged: nudge` to the stop payload, and after `persist(ev, env, result);`:

```js
      if (nudge) {
        try { markNudged(key, env, occurred_at); } catch { /* stop_hook_active still prevents a loop */ }
        result.stdout = JSON.stringify({ decision: 'block', reason: nudgeReason(scope.tracker) });
      }
```

- [ ] **Step 4: Run to verify**

Run: `node --test tests/hooks/nudge.test.js tests/hooks/adapter.test.js tests/acceptance/phase0.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/nudge.js src/hooks/adapter.js tests/hooks/nudge.test.js
git commit -m "feat(hooks): nudge mode asks once at Stop which ticket unlinked work belongs to"
```

---

### Task 9: CLI `ticket relink --external`

**Files:**
- Modify: `src/cli/commands/ticket.js` (`relink`)
- Modify: `src/cli/main.js` (help line), `commands/ticket.md` (argument hint, notes)
- Test: `tests/cli/ticket.test.js`

**Interfaces:**
- Consumes: `resolveTracker`, `loadRepoConfig` (Task 3); `renderUrl`, `isSafeExternalUrl`, `TRACKER_SYSTEMS` (Task 2); relink `external` payload (Task 5).
- Produces: `quill ticket relink <KEY> --external <EXT-KEY> [--system s] [--url https://...]`; `--jira <KEY>` stays an alias with `system = jira`.

- [ ] **Step 1: Write the failing test** (append to `tests/cli/ticket.test.js`; add `import { saveUserConfig } from '../../src/config/config.js';`)

```js
test('relink --external renders the tracker link; --jira stays an alias; bad keys and links are refused', async () => {
  const fx = makeHome();
  fx.config.tracker = { system: 'linear', domain: 'https://linear.app/acme' };
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  try {
    const a = await cli(['ticket', 'create', 'Linear work', '--session', 'sess-E'], fx.env);
    const akey = /(LOCAL-linear-work-[0-9a-f]{8})/.exec(a.out)[1];
    const r = await cli(['ticket', 'relink', akey, '--external', 'ENG-12', '--session', 'sess-E'], fx.env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ENG-12/);
    assert.match(r.out, /linear/);
    const rows = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    const eng = rows.find((t) => t.key === 'ENG-12');
    assert.equal(eng.external.url, 'https://linear.app/acme/issue/ENG-12');
    assert.equal(eng.jira, null);
    const b = await cli(['ticket', 'create', 'Jira work', '--session', 'sess-E'], fx.env);
    const bkey = /(LOCAL-jira-work-[0-9a-f]{8})/.exec(b.out)[1];
    const bad = await cli(['ticket', 'relink', bkey, '--external', 'eng 12', '--session', 'sess-E'], fx.env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /external key/);
    const badUrl = await cli(['ticket', 'relink', bkey, '--external', 'PMLA-9', '--url', 'http://x.example/PMLA-9', '--session', 'sess-E'], fx.env);
    assert.notEqual(badUrl.code, 0);
    assert.match(badUrl.err, /https/);
    const j = await cli(['ticket', 'relink', bkey, '--jira', 'PMLA-9', '--session', 'sess-E'], fx.env);
    assert.equal(j.code, 0, j.err);
    const pm = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((t) => t.key === 'PMLA-9');
    assert.deepEqual([pm.external.system, pm.jira.key], ['jira', 'PMLA-9']);
  } finally {
    await w.stop();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cli/ticket.test.js`
Expected: FAIL (`a Jira key like PROJ-123 is required`).

- [ ] **Step 3: Implement** — replace `relink` in `src/cli/commands/ticket.js` (imports: `loadRepoConfig, resolveTracker` from the config module; `renderUrl, isSafeExternalUrl, TRACKER_SYSTEMS` from `'../../core/external-keys.js'`):

```js
async function relink(ctx, io, args, flags) {
  const usage = 'usage: ticket relink <KEY> --external <EXT-KEY> [--system jira|linear|github|custom] [--url <https url>] (--jira <KEY> is an alias)';
  const [key] = args;
  if (!key) throw new TrackerError('key-required', usage);
  validateKey(key);
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const extKey = flags.external ?? flags.jira;
  if (typeof extKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(extKey)) throw new TrackerError('external-invalid', `an external key like PROJ-123 is required (--external; --jira is an alias). ${usage}`);
  validateKey(extKey);
  let tracker = null;
  try { tracker = resolveTracker(ctx.config, loadRepoConfig(process.cwd())); } catch { tracker = null; }
  const system = typeof flags.system === 'string' ? flags.system : (flags.jira ? 'jira' : tracker ? tracker.system : 'custom');
  if (!TRACKER_SYSTEMS.includes(system)) throw new TrackerError('system-invalid', `--system must be one of ${TRACKER_SYSTEMS.join(', ')}`);
  if (flags.url !== undefined && !isSafeExternalUrl(flags.url)) throw new TrackerError('external-url-invalid', 'the external link must be an https:// URL without spaces or quotes');
  const url = flags.url ?? (tracker && tracker.system === system ? renderUrl(extKey, tracker) : null);
  // Remote validation requires a configured provider; without one the link stays locally bound and pending.
  const pending = { validation: 'pending', validated_at: null, error: 'no tracker provider configured; remote validation pending' };
  const payload = { ticket_id: ticket.id, new_key: extKey, external: { system, key: extKey, url, ...pending } };
  if (system === 'jira') payload.jira = { key: extKey, url, ...pending };
  const session = flags.session ? sessionFromFlags(flags, ctx.env) : null;
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'relink', payload, session, ticket_id: ticket.id }), { timeoutMs: timeout(flags) });
  if (ack.rejected === 'key-collision') throw new TrackerError('key-collision', `key collision: ${extKey} already identifies another ticket (alias or key)`);
  if (ack.rejected) throw new TrackerError(ack.rejected, `relink rejected: ${ack.rejected}`);
  io.println(`Relinked ${key} → ${extKey} (alias ${key} kept; ${system} link ${url ?? 'not configured'}; validation pending: ${pending.error}).`);
  return 0;
}
```

`src/cli/main.js` help line: `ticket relink <KEY> --external <EXT-KEY> [--system s] [--url <url>] --session <id>   (--jira is an alias)`.

`commands/ticket.md`: argument hint `relink <KEY> --external <EXT-KEY>`; add the note "Mentioning a configured ticket key in a prompt links the session automatically; these commands remain for manual control."

- [ ] **Step 4: Run to verify**

Run: `node --test tests/cli/ticket.test.js`
Expected: PASS, including the existing `--jira` relink test.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/ticket.js src/cli/main.js commands/ticket.md tests/cli/ticket.test.js
git commit -m "feat(cli): ticket relink --external with tracker URL templates (--jira kept as an alias)"
```

---

### Task 10: Acceptance scenarios A42–A45

**Files:**
- Create: `tests/acceptance/phase6.test.js`

**Interfaces:**
- Consumes: everything above through the scenario harness (`scenario({ gateMode })`, `s.hook`, `s.settle`).

- [ ] **Step 1: Write the scenarios** `tests/acceptance/phase6.test.js`

```js
// Phase 6 — zero-command tracking (ADR 0005). Each test is named after its ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scenario } from './scenario.js';
import { externalTicketId } from '../../src/core/external-keys.js';
import { readBindingSnapshot } from '../../src/hooks/binding-snapshot.js';

const TRACKER = { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA'] };

function repoDir(branch = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-p6-'));
  if (branch) {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  }
  return dir;
}

async function start({ gateMode = 'nudge', branch = null } = {}) {
  const s = scenario({ gateMode });
  s.repo = repoDir(branch);
  s.config.repos.demo.canonical_path = s.repo;
  s.config.tracker = TRACKER;
  await s.start();
  return s;
}

const editIn = (s, session_id, id, rel) => {
  const file = path.join(s.repo, ...rel.split('/'));
  return {
    pre: () => s.hook('PreToolUse', { session_id, cwd: s.repo, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file } }),
    post: () => s.hook('PostToolUse', { session_id, cwd: s.repo, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file }, tool_response: { filePath: file } }),
  };
};

test('A42 mentioning a ticket key links the session with no commands, and its work is attributed to that ticket', async () => {
  const s = await start();
  try {
    s.hook('SessionStart', { session_id: 'z1', cwd: s.repo, source: 'startup' });
    const r = s.hook('UserPromptSubmit', { session_id: 'z1', cwd: s.repo, prompt: 'PMLA-4242 make retries deterministic' });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Linked to PMLA-4242/);
    const e = editIn(s, 'z1', 'tz1', 'src/retry.js');
    assert.equal(e.pre().stdout, '');
    e.post();
    await s.settle();
    const t = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-4242'));
    assert.equal(t.key, 'PMLA-4242');
    assert.equal(t.title, 'PMLA-4242 make retries deterministic');
    assert.equal(t.external.url, 'https://example.atlassian.net/browse/PMLA-4242');
    assert.ok(t.files_touched.some((f) => f.relative_path === 'src/retry.js'));
    const snap = readBindingSnapshot('z1', s.env);
    assert.equal(snap.provisional, undefined, 'the worker confirmed the provisional binding');
    assert.equal(snap.ticket_key, 'PMLA-4242');
    s.w.flushNotes();
    assert.ok(fs.existsSync(s.notePath('PMLA-4242')));
  } finally { await s.stop(); }
});

test('A43 a session started on a ticket branch is linked at SessionStart; a later key mention switches it forward only', async () => {
  const s = await start({ branch: 'feat/PMLA-77-retry-flake' });
  try {
    const r = s.hook('SessionStart', { session_id: 'z2', cwd: s.repo, source: 'startup' });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Bound to PMLA-77 \(retry flake\)/);
    const first = editIn(s, 'z2', 'tz2a', 'src/a.js');
    first.pre(); first.post();
    await s.settle();
    s.hook('UserPromptSubmit', { session_id: 'z2', cwd: s.repo, prompt: 'switch to PMLA-78 now' });
    await s.settle();
    const second = editIn(s, 'z2', 'tz2b', 'src/b.js');
    second.pre(); second.post();
    await s.settle();
    const t77 = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-77'));
    const t78 = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-78'));
    assert.deepEqual(t77.files_touched.map((f) => f.relative_path), ['src/a.js']);
    assert.deepEqual(t78.files_touched.map((f) => f.relative_path), ['src/b.js']);
  } finally { await s.stop(); }
});

test('A44 nudge mode never blocks unlinked work, asks once at Stop, and the reply links the session for later work', async () => {
  const s = await start();
  try {
    s.hook('SessionStart', { session_id: 'z3', cwd: s.repo, source: 'startup' });
    const before = editIn(s, 'z3', 'tz3a', 'src/early.js');
    assert.equal(before.pre().stdout, '');
    before.post();
    await s.settle();
    const stop = s.hook('Stop', { session_id: 'z3', cwd: s.repo, stop_hook_active: false, last_assistant_message: 'Edited early.js.' });
    assert.equal(JSON.parse(stop.stdout).decision, 'block');
    assert.equal(s.hook('Stop', { session_id: 'z3', cwd: s.repo, stop_hook_active: true, last_assistant_message: 'Which ticket?' }).stdout, '');
    await s.settle();
    s.hook('UserPromptSubmit', { session_id: 'z3', cwd: s.repo, prompt: 'It is PMLA-9' });
    await s.settle();
    const after = editIn(s, 'z3', 'tz3b', 'src/late.js');
    after.pre(); after.post();
    await s.settle();
    const t = s.w.state.tickets.get(externalTicketId(s.meta.store_id, 'PMLA-9'));
    assert.deepEqual(t.files_touched.map((f) => f.relative_path), ['src/late.js'], 'binding is forward-only: earlier unlinked work is not reassigned');
  } finally { await s.stop(); }
});

test('A45 strict mode keeps the original gate, and mentioning a key unlocks writes without running a command', async () => {
  const s = await start({ gateMode: 'strict' });
  try {
    s.hook('SessionStart', { session_id: 'z4', cwd: s.repo, source: 'startup' });
    const e = editIn(s, 'z4', 'tz4', 'src/x.js');
    const denied = JSON.parse(e.pre().stdout).hookSpecificOutput;
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /PMLA-123/);
    s.hook('UserPromptSubmit', { session_id: 'z4', cwd: s.repo, prompt: 'PMLA-10 go' });
    const e2 = editIn(s, 'z4', 'tz4b', 'src/x.js');
    assert.equal(e2.pre().stdout, '', 'the provisional binding lets the very next call through');
    await s.settle();
    assert.equal(readBindingSnapshot('z4', s.env).ticket_key, 'PMLA-10');
  } finally { await s.stop(); }
});
```

- [ ] **Step 2: Run them**

Run: `node --test tests/acceptance/phase6.test.js`
Expected: PASS (all behaviour exists after Tasks 1–9; a failure here is a defect in those tasks, debugged with superpowers:systematic-debugging).

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance/phase6.test.js
git commit -m "test(acceptance): phase 6 zero-command tracking scenarios A42-A45"
```

---

### Task 11: Documentation and spec amendments

**Files:**
- Create: `docs/decisions/0005-gate-modes-and-auto-binding.md`
- Modify: `docs/TRD.md` (§Ticket gate gate-mode paragraph; §Binding auto-binding bullet; §Configuration resolved defaults)
- Modify: `docs/PRD.md` (guarantee line; FR-1 note; defaults line)
- Modify: `docs/DATA-CONTRACT.md` (ticket `external` field)
- Modify: `docs/ACCEPTANCE.md` (A01/A07/A13 apply in strict mode; new Phase 6 rows A42–A45)
- Modify: `docs/ACCEPTANCE-RESULTS.md` (Phase 6 results; test count), `docs/README.md` (decision list), `README.md` (feature bullet, first-run flow, `[tracker]` example, gate modes), `CHANGELOG.md` (Unreleased)

- [ ] **Step 1: Write ADR 0005**: Context (proposal friction points 1–6), Decision (three gate modes with nudge default and the stricter-of repository rule; `[tracker]` table; prompt/branch auto-binding with a provisional snapshot and deterministic ticket ids; external keys as first-class keys; Stop nudge once per session; forward-only binding), Consequences (the PRD guarantee and A01/A07/A13 now describe strict mode; nudge enforces nothing; repository patterns are validated and scans bounded; unlinked work stays unattributed until the step 2 inbox), Alternatives (keep the strict default; key-index files for hooks; spawning `git` in hooks).
- [ ] **Step 2: Amend TRD, PRD, DATA-CONTRACT and ACCEPTANCE** so the committed spec matches ADR 0005 (docs/README.md: "Conflicts must be resolved in these files").
- [ ] **Step 3: Update README** (features, "First tracked session" rewritten around mentioning a key, a configuration example using `https://example.atlassian.net`), CHANGELOG `[Unreleased]`, the docs/README decision list and ACCEPTANCE-RESULTS.
- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass (1 skip where symlink creation is not permitted).

- [ ] **Step 5: Commit**

```bash
git add docs README.md CHANGELOG.md
git commit -m "docs: ADR 0005 gate modes and zero-command binding; amend spec, README and changelog"
```
