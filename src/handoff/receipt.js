// Evidence receipts (ADR 0033, FR-5.1): a deterministic Markdown summary of what the worker itself
// recorded about a run (its test gate, whether the tested tree is the committed tree, guard
// counts, owner approvals and change counts), with a sha256 digest over those journaled facts.
//
// Pure: the receipt is built from the reduced state only, so the same state always gives the same
// text and digest, and `quill receipt` can rebuild it from the journal. It is a digest, never
// proof. Privacy (ADR 0028, autonomous-runs spec §9): no scope names, targets, local paths, test
// output or agent text ever appear in it; the guard and change rows are counts.
import { createHash } from 'node:crypto';

export const RECEIPT_HEADING = '### Session Quill evidence receipt';
export const RECEIPT_VERSION = 1;

// Guard classes from src/gate/prod-classify.js; anything else is counted as `other`.
const GUARD_CLASSES = new Set(['local', 'read', 'external.write', 'write', 'unknown-prod', 'unparseable', 'privileged']);

/**
 * Counts of the guard's own decisions in a run's ledger (`readLedger` output). Only `guard` lines
 * count: those are the guard hook's decisions; stream lines are not.
 * @returns {{ allow: number, deny: number, critical: number, by_class: Record<string, number> }}
 */
export function guardSummary(lines = []) {
  const out = { allow: 0, deny: 0, critical: 0, by_class: {} };
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || typeof l !== 'object' || l.kind !== 'guard') continue;
    if (l.decision === 'allow') out.allow += 1;
    else if (l.decision === 'deny') out.deny += 1;
    else continue;
    if (l.critical === true) out.critical += 1;
    const cls = typeof l.class === 'string' && GUARD_CLASSES.has(l.class) ? l.class : 'other';
    out.by_class[cls] = (out.by_class[cls] ?? 0) + 1;
  }
  out.by_class = Object.fromEntries(Object.entries(out.by_class).sort(([a], [b]) => a.localeCompare(b)));
  return out;
}

// Config files when a repository sets no `config_globs`.
export const DEFAULT_CONFIG_GLOBS = Object.freeze([
  '**/*.json', '**/*.toml', '**/*.yaml', '**/*.yml', '**/*.ini', '**/*.cfg', '**/*.conf', '**/.env*', '**/*.config.*', '**/Dockerfile', '**/Makefile', '.github/**', '**/*.properties',
]);

export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // `**/` matches zero or more whole directories; a trailing `**` matches the rest.
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const TEST_RE = /(^|\/)(tests?|__tests__|specs?)\//i;
const TEST_NAME_RE = /(\.|_|-)(test|spec)\.[a-z0-9]+$|^test_[^/]*\.py$/i;
const DOC_RE = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const isTest = (p) => TEST_RE.test(p) || TEST_NAME_RE.test(p.split('/').pop());

/**
 * Change counts of a run's changed files. `critical_paths` null means the repository configures
 * none (the receipt says so rather than claiming zero). Paths never leave this function.
 * @returns {{ files: number, config: number, tests: number, code: number, docs: number, critical_paths: number|null }}
 */
export function changeSummary(files = [], { critical_paths = null, config_globs = null } = {}) {
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f).map((f) => f.replace(/\\/g, '/'));
  const configRes = (Array.isArray(config_globs) && config_globs.length ? config_globs : DEFAULT_CONFIG_GLOBS).map(globToRegExp);
  const criticalRes = Array.isArray(critical_paths) && critical_paths.length ? critical_paths.map(globToRegExp) : null;
  const out = { files: list.length, config: 0, tests: 0, code: 0, docs: 0, critical_paths: criticalRes ? 0 : null };
  for (const p of list) {
    if (criticalRes && criticalRes.some((r) => r.test(p))) out.critical_paths += 1;
    if (isTest(p)) out.tests += 1;
    else if (configRes.some((r) => r.test(p))) out.config += 1;
    else if (DOC_RE.test(p)) out.docs += 1;
    else out.code += 1;
  }
  return out;
}

// Canonical JSON: object keys sorted at every level, so equal facts always hash equally.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

const HEX40 = /^[0-9a-f]{40}$/;
const ref = (v) => (typeof v === 'string' && HEX40.test(v) ? v : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

function gateFacts(g) {
  if (!g || typeof g !== 'object') return null;
  const runs = Array.isArray(g.runs) && g.runs.length
    ? g.runs.map((r) => ({ status: typeof r.status === 'string' ? r.status : null, exit_code: Number.isInteger(r.exit_code) ? r.exit_code : null, ms: int(r.ms) }))
    // A gate recorded before every attempt was kept has only its final run.
    : g.status === 'passed' || g.status === 'failed' || g.status === 'timeout' ? [{ status: g.status, exit_code: Number.isInteger(g.exit_code) ? g.exit_code : null, ms: int(g.ms) }] : [];
  return { status: typeof g.status === 'string' ? g.status : null, command: typeof g.command === 'string' ? g.command : null, runs, repaired: g.repaired === true };
}

function guardFacts(s) {
  if (!s || typeof s !== 'object') return null;
  const by = s.by_class && typeof s.by_class === 'object' ? Object.fromEntries(Object.entries(s.by_class).filter(([k, n]) => (GUARD_CLASSES.has(k) || k === 'other') && Number.isInteger(n) && n > 0).sort(([a], [b]) => a.localeCompare(b))) : {};
  return { allow: count(s.allow), deny: count(s.deny), critical: count(s.critical), by_class: by };
}

function changeFacts(c) {
  if (!c || typeof c !== 'object') return null;
  return { files: count(c.files), config: count(c.config), tests: count(c.tests), code: count(c.code), docs: count(c.docs), critical_paths: Number.isInteger(c.critical_paths) ? c.critical_paths : null };
}

// Owner approvals behind this run: proposals (a page proposal or a critical change) the owner
// approved and that became this run. Counted from the journal, never from agent text.
function approvals(state, h) {
  const map = state && state.runProposals instanceof Map ? state.runProposals : new Map();
  let n = 0;
  for (const p of map.values()) if (p && p.handoff_id === h.id && p.state === 'approved') n += 1;
  return n;
}

const scopeCount = (h) => (Array.isArray(h.scopes) ? h.scopes.length : Number.isInteger(h.scope_count) ? h.scope_count : 0);

/** The journaled facts a receipt states, in the canonical shape its digest covers. */
export function receiptFacts(state, handoffId) {
  const h = state && state.handoffs instanceof Map ? state.handoffs.get(handoffId) : null;
  if (!h) return null;
  return {
    v: RECEIPT_VERSION,
    run: h.id,
    ticket: h.ticket_id ?? null,
    recipe: h.recipe && typeof h.recipe.name === 'string' ? h.recipe.name : h.mode ?? null,
    access: h.access ?? 'standard',
    scopes: scopeCount(h),
    test_gate: gateFacts(h.test_gate),
    tested_tree: ref(h.tested_tree),
    commit_sha: ref(h.commit_sha),
    commit_tree: ref(h.commit_tree),
    guard: guardFacts(h.guard_summary),
    approvals: approvals(state, h),
    changes: changeFacts(h.change_summary),
  };
}

// Words a terminal or PR may show. Control and format characters never pass.
const clean = (s, max = 200) => {
  const t = String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// A test command is repository config, but it may name a file on this machine: absolute paths
// (POSIX, Windows drive or UNC, home-relative) are replaced, so no local path leaves the machine.
const ABS_START = String.raw`(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|/(?=[^\s/]))`;
const QUOTED_PATH = new RegExp(String.raw`(["'])${ABS_START}[^"']*\1`, 'g');
const BARE_PATH = new RegExp(String.raw`(?<=^|[\s=:])${ABS_START}[^\s"']*`, 'g');
export function publicCommand(command) {
  return clean(command, 400).replace(QUOTED_PATH, '<local path>').replace(BARE_PATH, '<local path>').replace(/`/g, "'").slice(0, 160);
}
const recipeWord = (r) => clean(r, 60).replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';

function accessWords(f) {
  if (f.access === 'autonomous') return f.scopes ? `Autonomous + scopes (${f.scopes})` : 'Autonomous';
  if (f.access === 'full') return 'Full access';
  if (f.access === 'settings') return 'My Claude Code settings';
  return 'Standard access';
}

const secs = (ms) => (ms === null ? 'time not recorded' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
function runWords(r) {
  if (r.status === 'timeout') return `timed out after ${secs(r.ms)}`;
  return `exit code ${r.exit_code ?? 'unknown'} in ${secs(r.ms)}`;
}

function gateLine(f) {
  const g = f.test_gate;
  if (!g) return 'Test gate: not run by the worker; not test-verified.';
  if (g.status === 'skipped') return 'Test gate: skipped (no changes to test, or no test command configured); not test-verified.';
  const runs = g.runs.map((r, i) => `attempt ${i + 1} ${runWords(r)}`).join(' · ');
  const verdict = g.status === 'passed' ? `Tests passed (worker)${g.repaired ? ' after one repair turn' : ''}` : g.status === 'timeout' ? 'Tests timed out' : 'Tests failed';
  return `Test gate: \`${publicCommand(g.command)}\` · ${runs || 'no attempt recorded'} · ${verdict}.`;
}

function treeLine(f) {
  const sha7 = f.commit_sha ? f.commit_sha.slice(0, 7) : null;
  if (!f.tested_tree) return f.test_gate && f.test_gate.status === 'passed' ? 'Tested tree: not recorded.' : 'Tested tree: none (no passing test run).';
  if (!sha7 || !f.commit_tree) return 'Tested tree: recorded; no commit to compare it with.';
  return f.tested_tree === f.commit_tree ? `Tested tree matches commit ${sha7}.` : `Tested tree differs from commit ${sha7}.`;
}

function guardLine(f) {
  if (f.access !== 'autonomous' && f.access !== 'full') return 'Guard: not used (this access tier has no Quill guard).';
  const g = f.guard;
  if (!g) return 'Guard: no ledger summary recorded.';
  const mode = f.access === 'full' ? ' (observe only: full access allows and records every call)' : '';
  const classes = Object.entries(g.by_class).map(([k, n]) => `${k} ${n}`).join(', ');
  return `Guard${mode}: ${g.allow} allowed, ${g.deny} refused, ${g.critical} critical${classes ? ` · by class: ${classes}` : ''}.`;
}

function changesLine(f) {
  const c = f.changes;
  if (!c) return 'Changes: not recorded.';
  const crit = c.critical_paths === null ? 'no critical paths configured' : `${c.critical_paths} critical-path file${c.critical_paths === 1 ? '' : 's'}`;
  return `Changes: ${c.files} file${c.files === 1 ? '' : 's'} · ${c.config} config · tests:code ${c.tests}:${c.code} · ${crit}.`;
}

/**
 * The receipt for one run. Pure: same state, same markdown and digest.
 * @returns {{ markdown: string, sha256: string, through_sequence: number, facts: object } | null}
 */
export function buildReceipt(state, handoffId) {
  const facts = receiptFacts(state, handoffId);
  if (!facts) return null;
  const through = Number.isInteger(state.lastSequence) ? state.lastSequence : 0;
  const sha256 = createHash('sha256').update(canonicalJson(facts)).digest('hex');
  const lines = [
    RECEIPT_HEADING,
    '',
    `- Run \`${facts.run.slice(0, 8)}\` · recipe \`${recipeWord(facts.recipe)}\` · ${accessWords(facts)}`,
    `- ${gateLine(facts)}`,
    `- ${treeLine(facts)}`,
    `- ${guardLine(facts)}`,
    `- Owner approvals: ${facts.approvals}.`,
    `- ${changesLine(facts)}`,
    '',
    `Digest sha256 ${sha256} over the run's journaled facts through sequence ${through}.`,
    '',
    'Not a deployment.',
  ];
  return { markdown: `${lines.join('\n')}\n`, sha256, through_sequence: through, facts };
}
