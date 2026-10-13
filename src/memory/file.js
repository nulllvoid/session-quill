// Filing a finished run's learnings into memory (spec §6.2). Pure apart from reading the run's own
// checkout: the worker passes the run, its tool ledger, its checkout and the memory it already has,
// and gets back journal events to emit (ADR 0001: the worker is the only writer; agents never write
// memory). Trust comes from provenance, never from what the agent says about itself:
//
//   page-proposed run (h.proposal)            -> quarantined  (every learning of the run)
//   instruction-like text, any source         -> quarantined  (INSTRUCTION_PATTERNS below)
//   tool-output / external-text               -> quarantined
//   own-command, every claimed "<command> -> exit N" matches a shell call in the ledger with
//     exit code N (ruling R1)                 -> verified     (else observed)
//   repo-file, every cited path:line exists in the run's checkout
//                                             -> sourced      (else observed); each matched
//     evidence item is pinned to the file's content as " @blob:<git blob sha1>"
//
// Then, within the same scope (and repository or ticket) and section, a learning whose normalised
// text equals an entry's, or whose word sets overlap by Jaccard >= 0.8, confirms that entry instead
// of filing a new one. A quarantined learning only ever matches quarantined entries, so it can never
// keep a trusted entry alive. A new entry whose key an older live entry already holds with other
// text supersedes that entry when the new one is verified (never an owner or pinned entry); in every
// other case both are kept and Task 12's conflicts() selector reports the pair.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deterministicId } from '../lib/ids.js';
import { redactCapped, summarizeInput } from '../handoff/stream.js';
import { canonicalSection } from './sections.js';

export const MAX_FILED_PER_RUN = 15;
// Entry text is redacted, then cut to this many UTF-8 bytes; evidence items to EVIDENCE_ITEM_BYTES.
export const ENTRY_TEXT_BYTES = 1000;
export const EVIDENCE_ITEM_BYTES = 300;
export const MAX_EVIDENCE_ITEMS = 10;
export const KEY_CHARS = 100;
export const JACCARD_MIN = 0.8;
// A cited file larger than this is not read, so its cite does not count as sourced.
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// One Run note keeps at most this many attempts and lessons, each field cut to RUN_NOTE_FIELD_BYTES.
export const RUN_NOTE_ATTEMPTS = 40;
export const RUN_NOTE_LESSONS = 15;
export const RUN_NOTE_FIELD_BYTES = 300;

const SCOPES = new Set(['repo', 'task', 'machine']);
const KINDS = new Set(['fact', 'procedure', 'pitfall', 'tool', 'pointer']);
const DERIVED = new Set(['repo-file', 'own-command', 'tool-output', 'external-text']);
const SHELL = new Set(['Bash', 'PowerShell']);
const OUTCOMES = new Set(['worked', 'failed', 'refused', 'unavailable', 'skipped']);

// Text that reads as an instruction to an agent rather than a fact about the repository or machine.
// A match quarantines the learning whatever its source; a false positive only costs the owner one
// approval. Each pattern is bounded (no unbounded repetition across a sentence), so matching stays
// linear in the (already capped) text.
export const INSTRUCTION_PATTERNS = [
  { name: 'addresses-agent', re: /\b(?:you|claude|the (?:assistant|agent|model|ai)|assistants?|agents?)\s+(?:must|should|shall|need to|have to|are (?:now )?(?:required|allowed|permitted|authori[sz]ed))\b/i },
  { name: 'ignore-instructions', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompts?|guidelines?|guidance|constraints?|polic(?:y|ies))\b/i },
  { name: 'widen-permissions', re: /\b(?:grant|give|widen|expand|escalate|elevate|enable|allow|request)\b[^.\n]{0,40}\b(?:permissions?|scopes?|full access|privileges?|sudo|admin rights|root access)\b/i },
  { name: 'skip-permission-prompts', re: /--dangerously-skip-permissions|\bbypassPermissions\b|--permission-mode\s+bypass/i },
  { name: 'disable-checks', re: /\b(?:disable|skip|bypass|turn off|switch off|comment out|circumvent|silence|weaken)\b[^.\n]{0,40}\b(?:checks?|guard|hooks?|tests?|lint(?:er|ing)?|ci|verification|validation|security|gate|safety|assertions?)\b/i },
  { name: 'no-verify', re: /--no-verify\b|--no-gpg-sign\b/i },
  { name: 'push-merge-deploy', re: /\b(?:push|merge|deploy|release|publish|ship)\b[^.\n]{0,30}\b(?:to|into|onto|on)\s+(?:the\s+)?(?:main|master|trunk|prod(?:uction)?|release|live)\b/i },
  { name: 'git-push', re: /\bgit\s+push\b|\bgh\s+pr\s+merge\b/i },
  { name: 'contact-host', re: /\b(?:send|post|upload|exfiltrate|forward|transmit|e-?mail|curl|wget|contact|notify|beacon)\b[^\n]{0,60}?(?:https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\bwebhook\b|\b[a-z0-9-]+\.(?:com|net|org|io|dev|xyz|ru|cn|site|app|top)\b)/i },
  { name: 'credentials', re: /\b(?:change|rotate|reset|set|update|replace|export|print|reveal|share|copy|paste|leak|dump)\b[^.\n]{0,40}\b(?:credentials?|passwords?|tokens?|api[ _-]?keys?|secrets?|ssh[ _-]?keys?|private keys?|kubeconfig)\b|\.env\b[^.\n]{0,20}\b(?:send|share|print|copy)\b/i },
];

/** The name of the first instruction-like pattern the text matches, else null. */
export function instructionLike(text) {
  const s = String(text ?? '');
  for (const p of INSTRUCTION_PATTERNS) if (p.re.test(s)) return p.name;
  return null;
}

/** Lower case, punctuation stripped, whitespace collapsed. */
export function normaliseText(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (norm) => new Set(norm ? norm.split(' ') : []);
const textHash = (norm) => createHash('sha256').update(norm).digest('hex');

/** Jaccard similarity of the word sets of two texts (normalised first). */
export function jaccard(a, b) {
  return jaccardSets(tokens(normaliseText(a)), tokens(normaliseText(b)));
}

function jaccardSets(x, y) {
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const redact = (s, max) => redactCapped(String(s ?? '').trim(), max);
const toIso = (v) => (typeof v === 'number' ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : String(v));

// The shape check of spec §6.2 step 1, plus redaction and caps. Returns null for a malformed learning.
function validate(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  if (!SCOPES.has(l.scope) || !KINDS.has(l.kind) || !DERIVED.has(l.derived_from) || !nonEmpty(l.text)) return null;
  const text = redact(l.text, ENTRY_TEXT_BYTES);
  if (!text) return null;
  const evidence = (Array.isArray(l.evidence) ? l.evidence : []).filter(nonEmpty).slice(0, MAX_EVIDENCE_ITEMS).map((e) => redact(e, EVIDENCE_ITEM_BYTES)).filter(Boolean);
  const key = nonEmpty(l.key) ? redact(l.key, KEY_CHARS * 4).slice(0, KEY_CHARS).trim() : null;
  return {
    scope: l.scope,
    section: canonicalSection(l.scope, l.section, l.kind),
    kind: l.kind,
    key: key || null,
    text,
    evidence,
    derived_from: l.derived_from,
    // What the instruction heuristic reads: the agent's own words, before any redaction.
    raw: [l.text, typeof l.section === 'string' ? l.section : '', typeof l.key === 'string' ? l.key : '', ...(Array.isArray(l.evidence) ? l.evidence.filter((e) => typeof e === 'string').slice(0, MAX_EVIDENCE_ITEMS) : [])].map((s) => String(s).slice(0, 4096)).join('\n'),
  };
}

// --- own-command: "<command> → exit N" claims against the ledger (R1) ---------------------------

const CLAIMS = [
  /^(.+?)\s*(?:→|->|=>)\s*(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|code|returned)\s*[:=]?\s*(-?\d{1,3})\s*\.?$/i,
  /^(.+?)\s*\(\s*(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|code)\s*[:=]?\s*(-?\d{1,3})\s*\)\s*\.?$/i,
  /^(.+?)\s+exited\s+(?:with\s+)?(?:code\s+|status\s+)?(-?\d{1,3})\s*\.?$/i,
  /^(.+?)\s*[:,;—–]\s*exit(?:\s+code)?\s*[:=]?\s*(-?\d{1,3})\s*\.?$/i,
];

function parseClaim(item) {
  const s = String(item ?? '').trim();
  for (const re of CLAIMS) {
    const m = re.exec(s);
    if (!m) continue;
    const command = m[1].trim().replace(/^\$\s+/, '').replace(/^[`'"]+|[`'"]+$/g, '').trim();
    if (command) return { command, exit: Number(m[2]) };
  }
  return null;
}

const squashWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const SUMMARY_CHARS = 300;

// Shell calls the ledger shows actually ran and returned: their summary and exit code. Guard lines
// and permission denials are refusals, not runs.
function shellCalls(ledger) {
  const out = [];
  for (const l of Array.isArray(ledger) ? ledger : []) {
    if (!l || typeof l !== 'object' || l.kind === 'guard' || l.kind === 'denial' || l.decision === 'deny') continue;
    const tool = typeof l.tool_name === 'string' && l.tool_name ? l.tool_name : l.tool;
    if (!SHELL.has(tool) || !Number.isInteger(l.exit_code)) continue;
    out.push({ tool, summary: squashWs(l.input_summary), exit: l.exit_code });
  }
  return out;
}

function claimMatches(claim, calls) {
  return calls.some((c) => {
    if (c.exit !== claim.exit) return false;
    // The ledger keeps a redacted one-line summary cut to 300 characters; the claim is summarised the same way.
    const want = squashWs(summarizeInput(c.tool, { command: claim.command }));
    return want === c.summary || (c.summary.length >= SUMMARY_CHARS - 1 && want.startsWith(c.summary));
  });
}

function commandVerified(evidence, calls) {
  const claims = evidence.map(parseClaim).filter(Boolean);
  return claims.length > 0 && claims.every((c) => claimMatches(c, calls));
}

// --- repo-file: path:line cites against the run's checkout ----------------------------------------

const CITE = /^(.+?)(?::(\d{1,7})(?:[-:]\d{1,7})?|#L(\d{1,7})(?:-L?\d{1,7})?)$/;

function citesIn(item) {
  const out = [];
  for (const raw of String(item).split(/\s+/)) {
    const token = raw.replace(/^[`'"([<]+|[`'")\]>,;.]+$/g, '');
    if (!token || token.includes('://')) continue;
    const m = CITE.exec(token);
    if (m) out.push({ file: m[1], line: Number(m[2] ?? m[3]) });
  }
  return out;
}

const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function inside(root, file) {
  const rel = path.relative(caseFold(root), caseFold(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The git blob sha1 of a file's content and its line count, or null when it is not a readable
// regular file inside the checkout (symlinks resolved, so a link cannot point outside).
function sourceOf(checkoutReal, file, cache) {
  if (cache.has(file)) return cache.get(file);
  let out = null;
  try {
    const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(checkoutReal, file);
    const real = fs.realpathSync.native(abs);
    const st = fs.statSync(real);
    if (inside(checkoutReal, real) && st.isFile() && st.size <= MAX_SOURCE_BYTES) {
      const buf = fs.readFileSync(real);
      const text = buf.toString('utf8');
      const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      const sha = createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
      out = { lines, sha };
    }
  } catch { out = null; }
  cache.set(file, out);
  return out;
}

// Sourced evidence with each matched item pinned, or null when there is no cite or any cite fails.
function sourcedEvidence(evidence, checkout) {
  if (!checkout) return null;
  let checkoutReal;
  try { checkoutReal = fs.realpathSync.native(checkout); } catch { return null; }
  const cache = new Map();
  let cited = 0;
  const pinned = [];
  for (const item of evidence) {
    const cites = citesIn(item);
    const shas = [];
    for (const c of cites) {
      cited += 1;
      const src = sourceOf(checkoutReal, c.file, cache);
      if (!src || c.line < 1 || c.line > src.lines) return null;
      if (!shas.includes(src.sha)) shas.push(src.sha);
    }
    pinned.push(shas.length ? `${item} ${shas.map((s) => `@blob:${s}`).join(' ')}` : item);
  }
  return cited ? pinned : null;
}

// --- trust ------------------------------------------------------------------------------------------

/** A run queued from a shared page's proposal (ADR 0025): everything it learns waits for the owner. */
export function isPageProposed(run) {
  return !!(run && run.proposal);
}

function decideTrust(l, { page, calls, checkout }) {
  if (page) return { trust: 'quarantined', reason: 'from a page-proposed run' };
  const hit = instructionLike(l.raw);
  if (hit) return { trust: 'quarantined', reason: `instruction-like text (${hit})` };
  if (l.derived_from === 'tool-output' || l.derived_from === 'external-text') return { trust: 'quarantined', reason: `derived from ${l.derived_from}` };
  if (l.derived_from === 'own-command') return { trust: commandVerified(l.evidence, calls) ? 'verified' : 'observed' };
  const pinned = sourcedEvidence(l.evidence, checkout);
  return pinned ? { trust: 'sourced', evidence: pinned } : { trust: 'observed' };
}

// --- filing -----------------------------------------------------------------------------------------

const scopeIdOf = (e) => (e.scope === 'repo' ? e.repo_id : e.scope === 'task' ? e.ticket_id : '');
const sameScope = (a, b) => a.scope === b.scope && (scopeIdOf(a) ?? '') === (scopeIdOf(b) ?? '');
const isLive = (e) => e && e.state !== 'retired' && !e.superseded_by;

function valuesOf(existing) {
  if (!existing) return [];
  if (existing instanceof Map) return [...existing.values()];
  return Array.isArray(existing) ? existing : [...existing];
}

/**
 * Turns a done run's learnings into journal events (spec §6.2).
 * @param {{ learnings: object[], run: object, ledger?: object[], checkout?: string|null,
 *   existing?: Map|Iterable, now: string|number }} opts  run: the handoff record (id, repo_id,
 *   ticket_id, proposal); ledger: readLedger() lines; checkout: the run's checkout, read before it is
 *   removed; existing: state.memory.entries.
 * @returns {{ kind: string, payload: object, source_identity: string }[]}  memory-tx events in apply
 *   order, then one handoff-tx recording the filing summary (`memory_filing`) on the run.
 */
export function fileLearnings({ learnings, run, ledger = [], checkout = null, existing = [], now }) {
  const list = Array.isArray(learnings) ? learnings : [];
  if (!list.length || !run || !nonEmpty(run.id)) return [];
  const at = toIso(now);
  const counts = { received: list.length, filed: 0, confirmed: 0, superseded: 0, conflicts: 0, duplicates: 0, quarantined: 0, dropped: 0, by_trust: { verified: 0, sourced: 0, observed: 0, quarantined: 0 } };
  const problems = new Map();
  const problem = (code, n = 1) => problems.set(code, (problems.get(code) ?? 0) + n);
  if (list.length > MAX_FILED_PER_RUN) {
    counts.dropped = list.length - MAX_FILED_PER_RUN;
    problem('learnings-capped', counts.dropped);
  }
  const pool = valuesOf(existing).filter((e) => e && isLive(e) && nonEmpty(e.id) && typeof e.text === 'string').map((e) => {
    const norm = normaliseText(e.text);
    return { id: e.id, scope: e.scope, repo_id: e.repo_id, ticket_id: e.ticket_id, section: canonicalSection(e.scope, e.section, e.kind), key: e.key ?? null, trust: e.trust, pinned: e.pinned === true, norm, hash: textHash(norm), words: tokens(norm), fromRun: false };
  });
  const calls = shellCalls(ledger);
  const page = isPageProposed(run);
  const confirmedIds = new Set();
  const events = [];
  list.slice(0, MAX_FILED_PER_RUN).forEach((raw, i) => {
    const l = validate(raw);
    if (!l) { problem('learning-invalid'); return; }
    if (l.scope === 'repo' && !nonEmpty(run.repo_id)) { problem('learning-no-repo'); return; }
    if (l.scope === 'task' && !nonEmpty(run.ticket_id)) { problem('learning-no-ticket'); return; }
    const decided = decideTrust(l, { page, calls, checkout });
    const quarantined = decided.trust === 'quarantined';
    const id = deterministicId(`${run.id}:learning:${i}`);
    const entry = {
      id, scope: l.scope, section: l.section, kind: l.kind, text: l.text, evidence: decided.evidence ?? l.evidence, derived_from: l.derived_from,
      trust: decided.trust, run_id: run.id, created_at: at, last_confirmed_at: at, confirmations: 0, state: 'active',
      ...(l.key ? { key: l.key } : {}),
      ...(l.scope === 'repo' ? { repo_id: run.repo_id } : {}),
      ...(l.scope === 'task' ? { ticket_id: run.ticket_id } : {}),
      ...(quarantined ? { quarantine_reason: decided.reason } : {}),
    };
    const norm = normaliseText(entry.text);
    const hash = textHash(norm);
    const words = tokens(norm);
    // Step 3: a match in the same scope and section confirms; quarantined only matches quarantined.
    const match = pool.find((p) => !p.dead && sameScope(p, entry) && p.section === entry.section && (p.trust === 'quarantined') === quarantined && (p.hash === hash || jaccardSets(p.words, words) >= JACCARD_MIN));
    if (match) {
      if (match.fromRun || confirmedIds.has(match.id)) { counts.duplicates += 1; return; }
      confirmedIds.add(match.id);
      counts.confirmed += 1;
      events.push({ kind: 'memory-tx', payload: { op: 'confirmed', entry: { id: match.id } }, source_identity: `memory-tx:${run.id}:learning:${i}:confirmed` });
      return;
    }
    events.push({ kind: 'memory-tx', payload: { op: 'filed', entry }, source_identity: `memory-tx:${run.id}:learning:${i}:filed` });
    counts.filed += 1;
    counts.by_trust[entry.trust] += 1;
    if (quarantined) counts.quarantined += 1;
    // Step 4: the same key with other text. A verified entry supersedes; otherwise both stay, a conflict.
    if (entry.key && !quarantined) {
      let conflict = false;
      for (const p of pool) {
        if (p.dead || !sameScope(p, entry) || p.key !== entry.key || p.trust === 'quarantined' || p.hash === hash) continue;
        if (entry.trust === 'verified' && p.trust !== 'owner' && !p.pinned) {
          p.dead = true;
          counts.superseded += 1;
          events.push({ kind: 'memory-tx', payload: { op: 'superseded', entry: { id: p.id }, superseded_by: id }, source_identity: `memory-tx:${run.id}:learning:${i}:supersedes:${p.id}` });
        } else conflict = true;
      }
      if (conflict) counts.conflicts += 1;
    }
    pool.push({ id, scope: entry.scope, repo_id: entry.repo_id, ticket_id: entry.ticket_id, section: entry.section, key: entry.key ?? null, trust: entry.trust, pinned: false, norm, hash, words, fromRun: true });
  });
  const memory_filing = { ...counts, problems: [...problems].map(([code, count]) => ({ code, count })) };
  events.push({ kind: 'handoff-tx', payload: { handoff_id: run.id, update: { memory_filing } }, source_identity: `handoff-tx:${run.id}:memory-filing` });
  return events;
}

/**
 * The task-scope lessons of a filing, for the ticket's Run notes: entries filed or confirmed for the
 * ticket, never quarantined ones (Run notes reach later runs).
 * @returns {{ entry_id: string, text: string, trust: string }[]}
 */
export function taskLessons(events, existing = []) {
  const byId = new Map(valuesOf(existing).filter((e) => e && nonEmpty(e.id)).map((e) => [e.id, e]));
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.kind !== 'memory-tx') continue;
    const { op } = ev.payload;
    const e = op === 'filed' ? ev.payload.entry : op === 'confirmed' ? byId.get(ev.payload.entry.id) : null;
    if (!e || e.scope !== 'task' || e.trust === 'quarantined') continue;
    out.push({ entry_id: e.id, text: e.text, trust: e.trust });
  }
  return out.slice(0, RUN_NOTE_LESSONS);
}

const field = (v) => (typeof v === 'string' && v.trim() ? redactCapped(v.trim(), RUN_NOTE_FIELD_BYTES) : '');

/**
 * One Run note for the ticket (spec §6.1 task memory): what the run attempted (its reconciled
 * attempts) and the task lessons it filed. Local only: exports and vault notes drop `run_notes`.
 * Returns the handoff-tx event that appends it through the journal (the reducer keeps the last
 * RUN_NOTES_MAX notes per ticket), or null when the run has nothing to say.
 * @param {string} ticketId
 * @param {object[]} reconciledAttempts  reconcileAttempts() output (agent attempts plus refusals the ledger added)
 * @param {{ entry_id: string, text: string, trust: string }[]} taskLearnings  taskLessons() output
 * @param {{ run: { id: string, ticket_id: string }, at: string|number }} opts
 */
export function appendRunNotes(ticketId, reconciledAttempts, taskLearnings, { run, at } = {}) {
  if (!run || !nonEmpty(run.id) || !nonEmpty(ticketId)) return null;
  const attempts = (Array.isArray(reconciledAttempts) ? reconciledAttempts : []).filter((a) => a && typeof a === 'object').slice(0, RUN_NOTE_ATTEMPTS).map((a) => ({
    route: field(a.route), tool: field(a.tool), target: field(a.target), outcome: OUTCOMES.has(a.outcome) ? a.outcome : 'unknown', reason: field(a.reason), evidence: field(a.evidence),
    verified: typeof a.verified === 'string' ? a.verified.slice(0, 40) : null, ...(a.added === true ? { added: true } : {}),
  }));
  const lessons = (Array.isArray(taskLearnings) ? taskLearnings : []).filter((l) => l && nonEmpty(l.text)).slice(0, RUN_NOTE_LESSONS).map((l) => ({ entry_id: typeof l.entry_id === 'string' ? l.entry_id : null, text: redactCapped(l.text, ENTRY_TEXT_BYTES), trust: typeof l.trust === 'string' ? l.trust : null }));
  if (!attempts.length && !lessons.length) return null;
  return { kind: 'handoff-tx', payload: { handoff_id: run.id, run_notes: { ticket_id: ticketId, run_id: run.id, at: toIso(at), attempts, lessons } }, source_identity: `handoff-tx:${run.id}:run-notes` };
}
