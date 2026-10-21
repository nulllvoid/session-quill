// Anchored memory (FR-2.2, ADR 0032). A sourced learning cites path:line in the run's checkout;
// filing records each cite as an anchor { file_path, blob_sha, line, symbol_name }: the file's git
// blob at the run's base commit, the cited line, and the nearest declaration within SYMBOL_WINDOW
// lines (a plain-text heuristic, not a parser; tree-sitter anchors are deferred). Later the worker
// compares the anchored region with the file as it is now. When the share of changed lines reaches
// `[memory] anchor_stale_ratio` (default 0.3) the entry is staled: the worker journals a
// `memory-tx` `staled` op (the reducer stays pure; this module never reads a clock or git). Pinned
// and owner entries are never staled (ruling R27).
//
// Everything here is pure: callers pass file text and get numbers or events back.
import { createHash } from 'node:crypto';
import { validAnchors, fileAnchors, runEnvAnchor, isRunEnvAnchor, MAX_ANCHORS } from '../core/reduce/memory.js';

// A run-env anchor (ADR 0041, src/handoff/run-env.js) can sit beside the file anchors; every
// file check here reads fileAnchors() and never sees it.
export { validAnchors, fileAnchors, runEnvAnchor, isRunEnvAnchor, MAX_ANCHORS };

export const SYMBOL_WINDOW = 5;
// Lines on each side of the anchored line whose change is measured.
export const ANCHOR_WINDOW = 10;
export const SYMBOL_CHARS = 200;
export const DEFAULT_ANCHOR_STALE_RATIO = 0.3;

/** `[memory] anchor_stale_ratio` from the user config: a number above 0 and at most 1, else 0.3. */
export function anchorStaleRatio(config = {}) {
  const m = config && config.memory && typeof config.memory === 'object' ? config.memory : {};
  const v = m.anchor_stale_ratio;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_ANCHOR_STALE_RATIO;
}

/** A file's lines without line ends; a final newline adds no empty line. */
export function splitLines(text) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  if (!s) return [];
  const lines = s.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// Declaration shapes across common languages; the first capture is the declared name.
const DECLS = [
  /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:class|interface|struct|enum|trait|protocol|record|module|namespace|object)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:def|fn|func|fun|sub|proc)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  /\btype\s+([A-Za-z_$][\w$]*)\s*(?:=|<|struct\b|interface\b|\{)/,
  // Variables only at the top level (no indentation), so a loop counter is never the symbol.
  /^(?:export\s+)?(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/,
  /^\s*(?:(?:public|private|protected|static|async|override|export|default|final|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/,
];
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'yield']);

/** The name a line declares, or null. */
export function declaredName(line) {
  const s = String(line ?? '');
  for (const re of DECLS) {
    const m = re.exec(s);
    if (m && !NOT_NAMES.has(m[1])) return m[1].slice(0, SYMBOL_CHARS);
  }
  return null;
}

// The 1-based line nearest `line` (the line itself, then one above, one below, ...) within `span`
// for which `test(text)` holds, or null.
function nearest(lines, line, span, test) {
  for (let d = 0; d <= span; d += 1) {
    for (const n of d === 0 ? [line] : [line - d, line + d]) {
      if (n >= 1 && n <= lines.length && test(lines[n - 1])) return n;
    }
  }
  return null;
}

/** The symbol declared at or within ±SYMBOL_WINDOW lines of `line` (1-based), nearest first, above before below. */
export function symbolAt(lines, line) {
  const n = nearest(lines, line, SYMBOL_WINDOW, (t) => declaredName(t) !== null);
  return n === null ? null : declaredName(lines[n - 1]);
}

/** One anchor for a cite of `line` in a file at blob `sha` (its text when known, for the symbol). */
export function makeAnchor({ file_path, blob_sha, line, text = null }) {
  return { file_path, blob_sha, line, symbol_name: text === null || text === undefined ? null : symbolAt(splitLines(text), line) };
}

// Longest common subsequence length of `a` (a short window) within `b` (a whole file), in
// O(|a| x |b|) time and O(|a|) memory.
function lcsLength(a, b) {
  const row = new Array(a.length + 1).fill(0);
  for (const line of b) {
    let diag = 0;
    for (let i = 1; i <= a.length; i += 1) {
      const up = row[i];
      row[i] = a[i - 1] === line ? diag + 1 : Math.max(row[i], row[i - 1]);
      diag = up;
    }
  }
  return row[a.length];
}

// A line that says something: blank lines and bare punctuation ("}", "});") match anywhere and are
// not counted.
const meaningful = (t) => /[\p{L}\p{N}]/u.test(t);

/**
 * The share (0..1, three decimals) of the anchored region that is no longer in the file: the
 * meaningful lines within ANCHOR_WINDOW of the anchored line in the old file (whitespace-trimmed)
 * that the new file no longer has in the same order (longest common subsequence against the whole
 * new file, so code added or moved elsewhere does not count). An anchor with a symbol whose
 * declaration is gone from the new file gives 1, and so do an anchored line past the old file's end
 * and an empty new file.
 */
export function changedRatio(oldText, newText, anchor, { window = ANCHOR_WINDOW } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const L = anchor && anchor.line;
  if (!Number.isInteger(L) || L < 1 || L > a.length || !b.length) return 1;
  const sym = anchor.symbol_name;
  if (typeof sym === 'string' && sym && !b.some((t) => declaredName(t) === sym)) return 1;
  const lo = Math.max(1, L - window);
  const hi = Math.min(a.length, L + window);
  let region = a.slice(lo - 1, hi).map((t) => t.trim()).filter(meaningful);
  if (!region.length) region = [a[L - 1].trim()];
  const kept = lcsLength(region, b.map((t) => t.trim()));
  return Math.round((1 - kept / region.length) * 1000) / 1000;
}

/**
 * The entries of repository `repoId` the worker's anchor check looks at: live sourced entries with
 * anchors at repo scope, or task scope on a ticket of that repository. Pinned and owner entries
 * are left out (R27), and so are quarantined ones (never delivered).
 */
export function anchorCandidates(state, repoId) {
  const out = [];
  for (const e of state.memory ? state.memory.entries.values() : []) {
    if (e.state !== 'active' || e.superseded_by || e.trust !== 'sourced' || e.pinned === true || !fileAnchors(e.anchors).length) continue;
    const ticket = e.scope === 'task' && state.tickets ? state.tickets.get(e.ticket_id) : null;
    if ((e.scope === 'repo' && e.repo_id === repoId) || (ticket && ticket.repo_id === repoId)) out.push(e);
  }
  return out;
}

/**
 * What the worker's anchor check of one repository saw: HEAD plus a hash of the candidates' ids and
 * their anchors' files and blobs, sorted. Equal keys mean an equal check, so it may be skipped; a
 * candidate swapped for another, or re-anchored by a confirmation, at the same HEAD is a new key.
 */
export function anchorCheckKey(head, entries) {
  const lines = entries.map((e) => [e.id, ...fileAnchors(e.anchors).map((a) => `${a.file_path}@${a.blob_sha}`).sort()].join('\t')).sort();
  return `${head}:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

/**
 * The `staled` memory-tx for an entry whose anchored source changed, with its deterministic source
 * identity: a check repeated against the same file version never journals a second one, and an
 * entry a run confirmed again is not staled again for that same version.
 * @param {string} entryId
 * @param {{ file_path: string, blob_sha: string, current_blob_sha: string|null, changed_ratio: number }} anchor
 */
export function staledEvent(entryId, anchor) {
  const current = anchor.current_blob_sha ?? null;
  return {
    kind: 'memory-tx',
    payload: { op: 'staled', entry: { id: entryId }, reason: 'anchor-changed', anchor: { file_path: anchor.file_path, blob_sha: anchor.blob_sha, current_blob_sha: current, changed_ratio: anchor.changed_ratio } },
    source_identity: `memory-tx:anchor:${entryId}:${current ?? 'missing'}`,
  };
}
