// Filing a finished run's learnings into memory (spec §6.2). Pure apart from reading the run's own
// checkout: the worker passes the run, its tool ledger, its checkout and the memory it already has,
// and gets back journal events to emit (ADR 0001: the worker is the only writer; agents never write
// memory). Trust comes from provenance, never from what the agent says about itself:
//
//   page-proposed run (h.proposal)            -> quarantined  (every learning of the run)
//   instruction-like text, any source         -> quarantined  (src/memory/instructions.js, R29)
//   tool-output / external-text               -> quarantined
//   own-command, every claimed "<command> -> exit N" matches a shell call in the ledger with
//     exit code N (ruling R1)                 -> verified     (else observed)
//   repo-file, every cited path:line exists in the file as it is at the run's base commit (or, with
//     no base commit, in the checkout's working tree for files the run did not change)
//                                             -> sourced; each matched evidence item is pinned as
//                                                " @blob:<git blob sha1>"
//   repo-file whose cite does not verify (no cite, missing file or line, outside the checkout, no
//     checkout)                               -> quarantined, reason "unverified-cite" (ruling R28)
//
// Worker-observed facts (src/memory/worker-facts.js) join as `verified` candidates outside the cap.
//
// Placing a candidate (key first, so a changed value is never swallowed as a duplicate):
//   - with a key: an entry of the same scope and key with the same normalised text is confirmed; one
//     with other text is superseded when the candidate is verified and may supersede (never an owner
//     or pinned entry), otherwise both are kept and Task 12's conflicts() reports the pair;
//   - without a key: an entry of the same scope and section with the same normalised text, or a
//     key-less one whose word set overlaps by Jaccard >= 0.8, is confirmed.
// A quarantined candidate only ever matches quarantined entries, so it can never keep a trusted
// entry alive, and never supersedes anything.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deterministicId } from '../lib/ids.js';
import { redactCapped, summarizeInput } from '../handoff/stream.js';
import { canonicalSection } from './sections.js';
import { instructionLike } from './instructions.js';

export { instructionLike, INSTRUCTION_PATTERNS, scanForms } from './instructions.js';
export { workerLearnings } from './worker-facts.js';

export const MAX_FILED_PER_RUN = 15;
// At most this many raw items are even looked at (the result parser caps at 15; an explicit result
// file does not).
export const MAX_LEARNINGS_READ = 200;
// Entry text is redacted, then cut to this many UTF-8 bytes; evidence items to EVIDENCE_ITEM_BYTES.
export const ENTRY_TEXT_BYTES = 1000;
export const EVIDENCE_ITEM_BYTES = 300;
export const MAX_EVIDENCE_ITEMS = 10;
export const KEY_CHARS = 100;
export const JACCARD_MIN = 0.8;
// Raw text the instruction filter and the claim parser read, per field.
const RAW_FIELD_BYTES = 4096;
// A cited file larger than this is not read, so its cite does not verify.
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CITED_FILES = 40;
// One Run note keeps at most this many attempts and lessons, each field cut to RUN_NOTE_FIELD_BYTES.
export const RUN_NOTE_ATTEMPTS = 40;
export const RUN_NOTE_LESSONS = 15;
export const RUN_NOTE_FIELD_BYTES = 300;

const SCOPES = new Set(['repo', 'task', 'machine']);
const KINDS = new Set(['fact', 'procedure', 'pitfall', 'tool', 'pointer']);
const DERIVED = new Set(['repo-file', 'own-command', 'tool-output', 'external-text']);
const SHELL = new Set(['Bash', 'PowerShell']);
const OUTCOMES = new Set(['worked', 'failed', 'refused', 'unavailable', 'skipped']);

/** Lower case, punctuation stripped, whitespace collapsed. */
export function normaliseText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (norm) => new Set(norm ? norm.split(' ') : []);
const textHash = (norm) => createHash('sha256').update(norm).digest('hex');

function jaccardSets(x, y) {
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

/** Jaccard similarity of the word sets of two texts (normalised first). */
export function jaccard(a, b) {
  return jaccardSets(tokens(normaliseText(a)), tokens(normaliseText(b)));
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const redact = (s, max) => redactCapped(String(s ?? '').trim(), max);
const rawOf = (s) => String(s ?? '').slice(0, RAW_FIELD_BYTES);
const toIso = (v) => (typeof v === 'number' ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : String(v));

// The shape check of spec §6.2 step 1, plus redaction and caps. Returns null for a malformed learning.
function validate(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  if (!SCOPES.has(l.scope) || !KINDS.has(l.kind) || !DERIVED.has(l.derived_from) || !nonEmpty(l.text)) return null;
  const text = redact(l.text, ENTRY_TEXT_BYTES);
  if (!text) return null;
  const rawEvidence = (Array.isArray(l.evidence) ? l.evidence : []).filter(nonEmpty).slice(0, MAX_EVIDENCE_ITEMS).map((e) => rawOf(e).trim());
  const evidence = rawEvidence.map((e) => redact(e, EVIDENCE_ITEM_BYTES)).filter(Boolean);
  const key = nonEmpty(l.key) ? redact(l.key, KEY_CHARS * 4).slice(0, KEY_CHARS).trim() : null;
  return {
    scope: l.scope,
    section: canonicalSection(l.scope, l.section, l.kind),
    kind: l.kind,
    key: key || null,
    text,
    evidence,
    derived_from: l.derived_from,
    // The agent's own words before redaction or the evidence cut: the instruction filter reads all
    // of them, and claims are parsed from whole evidence items (a long command keeps its "→ exit N").
    rawEvidence,
    raw: [rawOf(l.text), typeof l.section === 'string' ? rawOf(l.section) : '', typeof l.key === 'string' ? rawOf(l.key) : '', ...rawEvidence].join('\n'),
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

// The claims when every one of them matches the ledger, else null.
function verifiedClaims(rawEvidence, calls) {
  const claims = rawEvidence.map(parseClaim).filter(Boolean);
  return claims.length > 0 && claims.every((c) => claimMatches(c, calls)) ? claims : null;
}

// A verified entry may replace an older value only when it is about the command it verified: the
// command (or its first two words) appears in its text or key (review Minor 1).
function aboutCommand(claims, text, key) {
  const hay = normaliseText(`${text} ${key ?? ''}`);
  return claims.some((c) => {
    const words = normaliseText(c.command).split(' ').filter(Boolean);
    return words.length > 0 && (hay.includes(words.join(' ')) || hay.includes(words.slice(0, 2).join(' ')));
  });
}

// --- repo-file: path:line cites against the run's checkout ----------------------------------------

const CITE = /^(.+?)(?::(\d{1,7})(?:[-:]\d{1,7})?|#L(\d{1,7})(?:-L?\d{1,7})?)$/;

// A token is a file cite only when its path part looks like a path: it has a separator, or a file
// extension with a letter in it. host:port, times, versions and user@host never count (Minor 2).
function looksLikePath(p) {
  if (!p || p.includes('@') || p.includes('://')) return false;
  if (/[\\/]/.test(p)) return true;
  return /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]{0,9}$/.test(p);
}

function citesIn(item) {
  const out = [];
  for (const raw of String(item).split(/\s+/)) {
    const token = raw.replace(/^[`'"([<]+|[`'")\]>,;.]+$/g, '');
    if (!token) continue;
    const m = CITE.exec(token);
    if (m && looksLikePath(m[1])) out.push({ file: m[1], line: Number(m[2] ?? m[3]) });
  }
  return out;
}

const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function inside(root, file) {
  const rel = path.relative(caseFold(root), caseFold(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const lineCount = (buf) => {
  const text = buf.toString('utf8');
  return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
};
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// The checkout-relative path of a cite (forward slashes), or null when it leaves the checkout.
function relCite(checkoutReal, file) {
  if (/[\r\n\0]/.test(file)) return null;
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(checkoutReal, file);
  if (!inside(checkoutReal, abs)) return null;
  return path.relative(checkoutReal, abs).split(path.sep).join('/');
}

// Files as they are at the run's base commit, read in one `git cat-file --batch`: { lines, sha }
// per relative path, or null. Anything the run created or changed is judged by its base version,
// so a run cannot make its own cite true (Minor 4).
function readAtCommit(checkoutReal, commit, rels) {
  const out = new Map(rels.map((r) => [r, null]));
  if (!rels.length) return out;
  let buf;
  try {
    buf = execFileSync('git', ['cat-file', '--batch'], { cwd: checkoutReal, input: rels.map((r) => `${commit}:${r}\n`).join(''), maxBuffer: 64 * 1024 * 1024, timeout: 15_000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return out; }
  let pos = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header.length !== 3 || header[1] !== 'blob') continue; // "<name> missing", a tree, ...
    const size = Number(header[2]);
    const content = buf.subarray(pos, pos + size);
    pos += size + 1;
    if (size <= MAX_SOURCE_BYTES) out.set(rel, { lines: lineCount(content), sha: header[0] });
  }
  return out;
}

// Files in the working tree (no base commit known): regular files inside the checkout, symlinks
// resolved, never one the run changed.
function readWorkingTree(checkoutReal, rels, changed) {
  const out = new Map();
  for (const rel of rels) {
    let src = null;
    try {
      if (!changed.has(caseFold(rel))) {
        const real = fs.realpathSync.native(path.resolve(checkoutReal, rel));
        const st = fs.statSync(real);
        if (inside(checkoutReal, real) && st.isFile() && st.size <= MAX_SOURCE_BYTES) {
          const buf = fs.readFileSync(real);
          src = { lines: lineCount(buf), sha: blobSha(buf) };
        }
      }
    } catch { src = null; }
    out.set(rel, src);
  }
  return out;
}

const COMMIT = /^[0-9a-f]{7,64}$/i;

// Sourced evidence with each matched item pinned, or null when there is no cite or any cite fails.
function sourcedEvidence(evidence, checkout, run) {
  if (!checkout) return null;
  let checkoutReal;
  try { checkoutReal = fs.realpathSync.native(checkout); } catch { return null; }
  const items = evidence.map((item) => ({ item, cites: citesIn(item).map((c) => ({ ...c, rel: relCite(checkoutReal, c.file) })) }));
  const all = items.flatMap((x) => x.cites);
  if (!all.length || all.some((c) => !c.rel)) return null;
  const rels = [...new Set(all.map((c) => c.rel))];
  if (rels.length > MAX_CITED_FILES) return null;
  const changed = new Set((Array.isArray(run.changed_files) ? run.changed_files : []).filter((f) => typeof f === 'string').map((f) => caseFold(f.split('\\').join('/'))));
  const sources = typeof run.base_commit === 'string' && COMMIT.test(run.base_commit) ? readAtCommit(checkoutReal, run.base_commit, rels) : readWorkingTree(checkoutReal, rels, changed);
  const pinned = [];
  for (const { item, cites } of items) {
    const shas = [];
    for (const c of cites) {
      const src = sources.get(c.rel);
      if (!src || c.line < 1 || c.line > src.lines) return null;
      if (!shas.includes(src.sha)) shas.push(src.sha);
    }
    pinned.push(shas.length ? `${item} ${shas.map((s) => `@blob:${s}`).join(' ')}` : item);
  }
  return pinned;
}

// --- trust ------------------------------------------------------------------------------------------

/** A run queued from a shared page's proposal (ADR 0025): everything it learns waits for the owner. */
export function isPageProposed(run) {
  return !!(run && run.proposal);
}

function decideTrust(l, { page, calls, checkout, run }) {
  if (page) return { trust: 'quarantined', reason: 'from a page-proposed run' };
  const hit = instructionLike(l.raw);
  if (hit) return { trust: 'quarantined', reason: `instruction-like text (${hit})` };
  if (l.derived_from === 'tool-output' || l.derived_from === 'external-text') return { trust: 'quarantined', reason: `derived from ${l.derived_from}` };
  if (l.derived_from === 'own-command') {
    const claims = verifiedClaims(l.rawEvidence, calls);
    return claims ? { trust: 'verified', mayReplace: aboutCommand(claims, l.text, l.key) } : { trust: 'observed' };
  }
  const pinned = sourcedEvidence(l.evidence, checkout, run);
  return pinned ? { trust: 'sourced', evidence: pinned } : { trust: 'quarantined', reason: 'unverified-cite' };
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

const poolEntry = (e, fromRun) => {
  const norm = normaliseText(e.text);
  return { id: e.id, scope: e.scope, repo_id: e.repo_id, ticket_id: e.ticket_id, section: canonicalSection(e.scope, e.section, e.kind), key: e.key ?? null, trust: e.trust, pinned: e.pinned === true, hash: textHash(norm), words: tokens(norm), fromRun };
};

/**
 * Turns a finished run's learnings and worker-observed facts into journal events (spec §6.2).
 * @param {{ learnings?: object[], run: object, ledger?: object[], checkout?: string|null,
 *   existing?: Map|Iterable, now: string|number, workerFacts?: object[] }} opts
 *   run: the handoff record (id, repo_id, ticket_id, proposal, base_commit, changed_files);
 *   learnings: the agent's (pass [] for a run that did not finish done); ledger: readLedger()
 *   lines; checkout: the run's checkout, read before it is removed; existing: state.memory.entries;
 *   workerFacts: workerLearnings() output.
 * @returns {{ kind: string, payload: object, source_identity: string }[]}  memory-tx events in apply
 *   order, then one handoff-tx recording the filing summary (`memory_filing`) on the run.
 */
export function fileLearnings({ learnings, run, ledger = [], checkout = null, existing = [], now, workerFacts = [] }) {
  const list = (Array.isArray(learnings) ? learnings : []).slice(0, MAX_LEARNINGS_READ);
  const facts = Array.isArray(workerFacts) ? workerFacts : [];
  if ((!list.length && !facts.length) || !run || !nonEmpty(run.id)) return [];
  const at = toIso(now);
  const counts = { received: Array.isArray(learnings) ? learnings.length : 0, filed: 0, confirmed: 0, superseded: 0, conflicts: 0, duplicates: 0, quarantined: 0, dropped: 0, by_trust: { verified: 0, sourced: 0, observed: 0, quarantined: 0 }, worker: { filed: 0, confirmed: 0, superseded: 0, conflicts: 0 } };
  const problems = new Map();
  const problem = (code, n = 1) => problems.set(code, (problems.get(code) ?? 0) + n);
  const pool = valuesOf(existing).filter((e) => e && isLive(e) && nonEmpty(e.id) && typeof e.text === 'string').map((e) => poolEntry(e, false));
  const confirmedIds = new Set();
  const events = [];

  // Places one candidate entry: confirm, or file (and supersede or flag a conflict).
  function place(entry, { tag, mayReplace, tally }) {
    const quarantined = entry.trust === 'quarantined';
    const norm = normaliseText(entry.text);
    const hash = textHash(norm);
    const words = tokens(norm);
    const sameClass = (p) => (p.trust === 'quarantined') === quarantined;
    const live = pool.filter((p) => !p.dead && sameScope(p, entry));
    const keyed = entry.key ? live.filter((p) => p.key === entry.key) : [];
    const match = entry.key
      ? keyed.find((p) => sameClass(p) && p.hash === hash) ?? live.find((p) => !p.key && sameClass(p) && p.section === entry.section && p.hash === hash)
      : live.find((p) => sameClass(p) && p.section === entry.section && (p.hash === hash || (!p.key && jaccardSets(p.words, words) >= JACCARD_MIN)));
    if (match) {
      if (match.fromRun || confirmedIds.has(match.id)) { counts.duplicates += 1; return; }
      confirmedIds.add(match.id);
      tally.confirmed += 1;
      events.push({ kind: 'memory-tx', payload: { op: 'confirmed', entry: { id: match.id } }, source_identity: `memory-tx:${run.id}:${tag}:confirmed` });
      return;
    }
    events.push({ kind: 'memory-tx', payload: { op: 'filed', entry }, source_identity: `memory-tx:${run.id}:${tag}:filed` });
    tally.filed += 1;
    if (tally === counts) {
      counts.by_trust[entry.trust] += 1;
      if (quarantined) counts.quarantined += 1;
    }
    if (entry.key && !quarantined) {
      let conflict = false;
      for (const p of keyed) {
        if (p.dead || p.trust === 'quarantined' || p.hash === hash) continue;
        if (entry.trust === 'verified' && mayReplace && p.trust !== 'owner' && !p.pinned) {
          p.dead = true;
          tally.superseded += 1;
          events.push({ kind: 'memory-tx', payload: { op: 'superseded', entry: { id: p.id }, superseded_by: entry.id }, source_identity: `memory-tx:${run.id}:${tag}:supersedes:${p.id}` });
        } else conflict = true;
      }
      if (conflict) tally.conflicts += 1;
    }
    pool.push({ ...poolEntry(entry, true) });
  }

  // The agent's learnings: validated first, then at most 15 valid ones are filed (Minor 5).
  const page = isPageProposed(run);
  const calls = shellCalls(ledger);
  let accepted = 0;
  list.forEach((raw, i) => {
    const l = validate(raw);
    if (!l) { problem('learning-invalid'); return; }
    if (l.scope === 'repo' && !nonEmpty(run.repo_id)) { problem('learning-no-repo'); return; }
    if (l.scope === 'task' && !nonEmpty(run.ticket_id)) { problem('learning-no-ticket'); return; }
    if (accepted >= MAX_FILED_PER_RUN) { counts.dropped += 1; return; }
    accepted += 1;
    const decided = decideTrust(l, { page, calls, checkout, run });
    const quarantined = decided.trust === 'quarantined';
    const entry = {
      id: deterministicId(`${run.id}:learning:${i}`), scope: l.scope, section: l.section, kind: l.kind, text: l.text, evidence: decided.evidence ?? l.evidence, derived_from: l.derived_from,
      trust: decided.trust, run_id: run.id, created_at: at, last_confirmed_at: at, confirmations: 0, state: 'active',
      ...(l.key ? { key: l.key } : {}),
      ...(l.scope === 'repo' ? { repo_id: run.repo_id } : {}),
      ...(l.scope === 'task' ? { ticket_id: run.ticket_id } : {}),
      ...(quarantined ? { quarantine_reason: decided.reason } : {}),
    };
    place(entry, { tag: `learning:${i}`, mayReplace: decided.mayReplace === true, tally: counts });
  });
  if (counts.dropped) problem('learnings-capped', counts.dropped);

  // Worker-observed facts: verified, keyed, outside the cap.
  for (const f of facts) {
    if (!f || !SCOPES.has(f.scope) || !nonEmpty(f.key) || !nonEmpty(f.text)) continue;
    if (f.scope === 'repo' && !nonEmpty(run.repo_id)) continue;
    const entry = {
      id: deterministicId(`${run.id}:worker:${f.key}`), scope: f.scope, section: f.section, kind: f.kind ?? 'fact', key: f.key, text: f.text, evidence: Array.isArray(f.evidence) ? f.evidence : [], derived_from: 'worker',
      trust: 'verified', run_id: run.id, created_at: at, last_confirmed_at: at, confirmations: 0, state: 'active',
      ...(f.scope === 'repo' ? { repo_id: run.repo_id } : {}),
    };
    place(entry, { tag: `worker:${f.key}`, mayReplace: true, tally: counts.worker });
  }

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

/** What replaces instruction-like free text in a Run note. */
export const withheldText = (runId) => `[withheld: instruction-like text — see run ${runId}]`;

/**
 * One Run note for the ticket (spec §6.1 task memory): what the run attempted (its reconciled
 * attempts) and the task lessons it filed. Local only: exports and vault notes drop `run_notes`.
 * Every free-text field is redacted, capped and passed through the instruction filter; flagged text
 * is replaced by withheldText(run.id). A note from a page-proposed run is marked `origin: 'page'`:
 * Task 14 must not deliver such a note to other runs.
 * Returns the handoff-tx event that appends it through the journal (the reducer keeps the last
 * RUN_NOTES_MAX notes per ticket), or null when the run has nothing to say.
 * @param {string} ticketId
 * @param {object[]} reconciledAttempts  reconcileAttempts() output (agent attempts plus refusals the ledger added)
 * @param {{ entry_id: string, text: string, trust: string }[]} taskLearnings  taskLessons() output
 * @param {{ run: { id: string, ticket_id: string, proposal?: object }, at: string|number }} opts
 */
export function appendRunNotes(ticketId, reconciledAttempts, taskLearnings, { run, at } = {}) {
  if (!run || !nonEmpty(run.id) || !nonEmpty(ticketId)) return null;
  let withheld = 0;
  const free = (v, max = RUN_NOTE_FIELD_BYTES) => {
    if (typeof v !== 'string' || !v.trim()) return '';
    if (instructionLike(rawOf(v))) { withheld += 1; return withheldText(run.id); }
    return redactCapped(v.trim(), max);
  };
  const attempts = (Array.isArray(reconciledAttempts) ? reconciledAttempts : []).filter((a) => a && typeof a === 'object').slice(0, RUN_NOTE_ATTEMPTS).map((a) => ({
    route: free(a.route), tool: free(a.tool), target: free(a.target), outcome: OUTCOMES.has(a.outcome) ? a.outcome : 'unknown', reason: free(a.reason), evidence: free(a.evidence),
    verified: typeof a.verified === 'string' ? a.verified.slice(0, 40) : null, ...(a.added === true ? { added: true } : {}),
  }));
  const lessons = (Array.isArray(taskLearnings) ? taskLearnings : []).filter((l) => l && nonEmpty(l.text)).slice(0, RUN_NOTE_LESSONS).map((l) => ({ entry_id: typeof l.entry_id === 'string' ? l.entry_id : null, text: free(l.text, ENTRY_TEXT_BYTES), trust: typeof l.trust === 'string' ? l.trust : null }));
  if (!attempts.length && !lessons.length) return null;
  const note = { ticket_id: ticketId, run_id: run.id, at: toIso(at), attempts, lessons, ...(withheld ? { withheld } : {}), ...(isPageProposed(run) ? { origin: 'page' } : {}) };
  return { kind: 'handoff-tx', payload: { handoff_id: run.id, run_notes: note }, source_identity: `handoff-tx:${run.id}:run-notes` };
}
