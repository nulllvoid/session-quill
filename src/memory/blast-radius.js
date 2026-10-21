// The context card (FR-2.1, ADR 0038): what else a ticket's files usually touch. The worker builds
// it from a cached `git log` co-change index, the other tickets in state and the guard's own facts,
// and writes it as a projection (projections/context/<ticketId>.json). It is derived, never
// journaled, and never part of snapshot.json, an export or the mirror. Hooks only read the file
// (no git on the hook path, ADR 0021); runs get it inside the prompt's data fence.
//
// Text rule (Review Focus 4): only worker-structured fields reach the card (git paths and counts,
// captured file paths, ticket keys and status, the worker's own `denied:*` facts). Every string
// passes memoryLine (one line, no fence markers) and the instruction filter; a flagged title is
// withheld, a flagged path or fact is dropped.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { quillHome } from '../lib/paths.js';
import { writeFileAtomic } from '../lib/atomic-fs.js';
import { memoryPaths, repoStem } from './paths.js';
import { cleanGitEnv } from './file.js';
import { memoryLine } from './deliver.js';
import { instructionLike } from './instructions.js';
import { memoryFor } from '../core/memory.js';
import { PROTECTED_CHECKOUT_PATHS } from '../handoff/autonomous.js';
import { writeContextCard } from '../worker/projections.js';

export const COCHANGE_FORMAT = 1;
export const MAX_COMMITS = 2000;
export const MAX_FILES_PER_COMMIT = 50;
export const PARTNERS_PER_FILE = 10;
// One shared commit is noise; a partner needs at least this many.
export const MIN_CO_CHANGE = 2;
export const CARD_LIMIT = 5;
export const CARD_DEBOUNCE_MS = 2000;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const TOUCHED_SCAN = 20;
const PATH_BYTES = 200;
const TITLE_BYTES = 120;
const FACT_BYTES = 200;
const LIVE = new Set(['queued', 'running']);

function gitOut(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-replace-objects', '-c', 'core.quotepath=off', ...args], { cwd, env: cleanGitEnv(), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** <quillHome>/memory/cache/<repoStem>.cochange.json */
export function coChangeCachePath(home, repoId) {
  return path.join(memoryPaths(home).root, 'cache', `${repoStem(repoId)}.cochange.json`);
}

function validIndex(v) {
  return v && typeof v === 'object' && v.format === COCHANGE_FORMAT && typeof v.head === 'string' && v.partners && typeof v.partners === 'object' && !Array.isArray(v.partners);
}

/** The cached index of a repository as last built (whatever HEAD is now), or null. Never runs git. */
export function readCachedCoChange(home, repoId) {
  if (!repoId) return null;
  try {
    const v = JSON.parse(fs.readFileSync(coChangeCachePath(home, repoId), 'utf8'));
    return validIndex(v) ? { head: v.head, partners: v.partners } : null;
  } catch { return null; }
}

// `git log --name-only` with a \x01 line before each commit; quoted names (newlines, tabs) are skipped.
function partnersFrom(log, maxFilesPerCommit) {
  const counts = new Map();
  for (const chunk of log.split('\x01')) {
    const files = [...new Set(chunk.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('"') && l !== '__proto__'))];
    if (files.length < 2 || files.length > maxFilesPerCommit) continue;
    for (const a of files) {
      let m = counts.get(a);
      if (!m) counts.set(a, (m = new Map()));
      for (const b of files) if (b !== a) m.set(b, (m.get(b) ?? 0) + 1);
    }
  }
  const partners = {};
  for (const [file, m] of [...counts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const top = [...m].filter(([, n]) => n >= MIN_CO_CHANGE).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, PARTNERS_PER_FILE);
    if (top.length) partners[file] = top;
  }
  return partners;
}

/**
 * Files that changed together in the last `maxCommits` non-merge commits of HEAD, from one
 * `git log`, cached per repository and keyed by HEAD (and the window). Commits touching more than
 * `maxFilesPerCommit` files (sweeps, renames, vendoring) are skipped.
 * @returns {Promise<{ head: string|null, partners: { [file: string]: [string, number][] } }>}
 */
export async function coChangeIndex(repoPath, { maxCommits = MAX_COMMITS, maxFilesPerCommit = MAX_FILES_PER_COMMIT, home = quillHome(), repoId = null } = {}) {
  if (!repoPath || !fs.statSync(repoPath).isDirectory()) throw new Error(`not a directory: ${repoPath}`);
  const root = path.resolve(repoPath);
  let head;
  try { head = (await gitOut(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim(); } catch (err) {
    if (err && err.code === 1) return { head: null, partners: {} }; // no commits yet
    throw err;
  }
  if (!/^[0-9a-f]{40,64}$/.test(head)) return { head: null, partners: {} };
  const id = repoId ?? path.basename(root);
  const file = coChangeCachePath(home, id);
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (validIndex(v) && v.head === head && v.repo_path === root && v.max_commits === maxCommits && v.max_files_per_commit === maxFilesPerCommit) return { head, partners: v.partners };
  } catch { /* missing or unreadable: rebuild */ }
  const log = await gitOut(root, ['log', '--no-merges', '--no-renames', `-n${Math.max(1, Math.floor(maxCommits))}`, '--name-only', '--format=%x01', head, '--']);
  const partners = partnersFrom(log, maxFilesPerCommit);
  writeFileAtomic(file, JSON.stringify({ format: COCHANGE_FORMAT, head, repo_path: root, max_commits: maxCommits, max_files_per_commit: maxFilesPerCommit, partners }));
  return { head, partners };
}

// --- the card ---------------------------------------------------------------------------------------

/** One clean line, or null when it is empty or reads like an instruction. */
function safe(value, max) {
  const line = memoryLine(String(value ?? ''), max);
  return line && !instructionLike(line) ? line : null;
}

const isRelative = (p) => typeof p === 'string' && p && !/^([A-Za-z]:|\/|\\)/.test(p) && !p.split('/').includes('..');
const sameRepo = (a, b) => (a ?? null) === null || (b ?? null) === null || a === b;

// The ticket's repository-relative files, most recently touched first.
function touchedFiles(ticket) {
  return [...(ticket.files_touched ?? [])]
    .filter((f) => f && isRelative(f.relative_path) && sameRepo(f.repo_id, ticket.repo_id))
    .sort((a, b) => (String(a.last_seen ?? '') < String(b.last_seen ?? '') ? 1 : -1))
    .map((f) => f.relative_path);
}

// A captured path is relative to the session's cwd, git's to the repository root: an exact key, else
// the one index key ending in /<path>.
function indexKey(partners, rel, suffixes) {
  if (Object.hasOwn(partners, rel)) return rel;
  const hits = suffixes().filter((k) => k.endsWith(`/${rel}`));
  return hits.length === 1 ? hits[0] : null;
}

function coChange(index, touched) {
  const partners = index && index.partners && typeof index.partners === 'object' ? index.partners : null;
  if (!partners) return [];
  let keys = null;
  const suffixes = () => (keys ??= Object.keys(partners));
  const resolved = touched.slice(0, TOUCHED_SCAN).map((rel) => [rel, indexKey(partners, rel, suffixes)]);
  const mine = new Set(resolved.map(([rel, k]) => k ?? rel));
  const best = new Map();
  for (const [rel, k] of resolved) {
    if (!k || !Array.isArray(partners[k])) continue;
    for (const pair of partners[k]) {
      if (!Array.isArray(pair)) continue;
      const [p, n] = pair;
      if (typeof p !== 'string' || !Number.isInteger(n) || n < MIN_CO_CHANGE || mine.has(p)) continue;
      if (!best.has(p) || best.get(p).n < n) best.set(p, { file: rel, partner: p, n });
    }
  }
  const out = [];
  for (const c of [...best.values()].sort((a, b) => b.n - a.n || (a.partner < b.partner ? -1 : 1))) {
    const file = safe(c.file, PATH_BYTES);
    const partner = safe(c.partner, PATH_BYTES);
    if (file && partner) out.push({ file, partner, n: c.n });
    if (out.length >= CARD_LIMIT) break;
  }
  return out;
}

// Other tickets whose captured writes overlap this ticket's files; local-only tickets never, and a
// run counts as live only when it was not proposed from a shared page.
function related(state, ticket, touched) {
  const mine = new Set(touched);
  if (!mine.size) return [];
  const live = new Set();
  for (const h of state.handoffs?.values() ?? []) if (LIVE.has(h.state) && !h.proposal) live.add(h.ticket_id);
  const found = [];
  for (const t of state.tickets?.values() ?? []) {
    if (!t || t.id === ticket.id || t.local_only === true || !sameRepo(t.repo_id, ticket.repo_id)) continue;
    const files = [...new Set((t.files_touched ?? []).filter((f) => f && sameRepo(f.repo_id, ticket.repo_id) && mine.has(f.relative_path)).map((f) => f.relative_path))];
    if (files.length) found.push({ t, files });
  }
  found.sort((a, b) => b.files.length - a.files.length || String(b.t.last_activity ?? '').localeCompare(String(a.t.last_activity ?? '')) || String(a.t.key).localeCompare(String(b.t.key)));
  const out = [];
  for (const { t, files } of found) {
    const key = safe(t.key, 80);
    if (!key) continue;
    out.push({ key, title: safe(t.title, TITLE_BYTES), status: safe(t.status, 20), files: files.map((f) => safe(f, PATH_BYTES)).filter(Boolean).slice(0, 3), live_run: live.has(t.id) });
    if (out.length >= CARD_LIMIT) break;
  }
  return out;
}

const isProtected = (rel) => PROTECTED_CHECKOUT_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`));

function guard(state, ticket, touched, now) {
  const out = [];
  // Open critical changes proposed under this ticket (ADR 0028): proposals, never changes that ran.
  const open = new Set([...(state.runProposals?.values() ?? [])].filter((p) => p && p.origin === 'run' && p.state === 'proposed' && !p.lapsed_at).map((p) => p.ticket_id));
  for (const c of state.tickets?.values() ?? []) {
    if (c.parent_id !== ticket.id || !(c.tags ?? []).includes('critical') || !open.has(c.id) || c.status === 'done') continue;
    const key = safe(c.key, 80);
    if (key) out.push(`Critical change ${key} is proposed and waits for the owner's decision; it has not run`);
  }
  for (const rel of touched) {
    if (!isProtected(rel)) continue;
    const p = safe(rel, PATH_BYTES);
    if (p) out.push(`${p} is a protected path: autonomous runs cannot write it`);
  }
  // The worker's own guard-refusal facts (src/memory/worker-facts.js); memoryFor never returns a
  // quarantined, retired, superseded or (with now) stale entry.
  if (state.memory && state.memory.entries) {
    const facts = memoryFor(state, { repo_id: ticket.repo_id ?? null, ticket_id: ticket.id, now })
      .filter((e) => typeof e.key === 'string' && e.key.startsWith('denied:') && e.derived_from === 'worker' && e.trust === 'verified')
      .sort((a, b) => String(b.last_confirmed_at ?? '').localeCompare(String(a.last_confirmed_at ?? '')));
    for (const e of facts) { const line = safe(e.text, FACT_BYTES); if (line) out.push(line); }
  }
  return [...new Set(out)].slice(0, CARD_LIMIT);
}

/**
 * The context card of one ticket. Pure: state and the index are read, nothing else.
 * @param {object} state  worker state (tickets, handoffs, runProposals, memory)
 * @param {object} ticket
 * @param {{ partners: object }|null} index  coChangeIndex() or readCachedCoChange(), or null
 * @param {{ now?: string|number }} [opts]  now: leaves stale memory facts out
 * @returns {{ co_change: {file, partner, n}[], related: {key, title, status, files, live_run}[], guard: string[] }}
 */
export function contextCard(state, ticket, index, { now } = {}) {
  if (!ticket) return { co_change: [], related: [], guard: [] };
  const touched = touchedFiles(ticket);
  return { co_change: coChange(index, touched), related: related(state, ticket, touched), guard: guard(state, ticket, touched, now) };
}

export const cardIsEmpty = (card) => !card || !((card.co_change ?? []).length || (card.related ?? []).length || (card.guard ?? []).length);

/** The card as plain lines for a run's data fence (src/handoff/runner.js). */
export function cardLines(card) {
  if (cardIsEmpty(card)) return null;
  return [
    ...(card.co_change ?? []).map((c) => `- changed together: ${c.partner} with ${c.file} in ${c.n} commits`),
    ...(card.related ?? []).map((r) => `- other ticket on these files: ${r.key}${r.title ? ` "${r.title}"` : ''}${r.status ? ` (${r.status}${r.live_run ? ', a run is live' : ''})` : ''}: ${(r.files ?? []).join(', ')}`),
    ...(card.guard ?? []).map((g) => `- guard: ${g}`),
  ];
}

// --- worker scheduling --------------------------------------------------------------------------------

// Which bound tickets need a card, debounced so a burst of writes computes once. The worker calls
// note() after each applied record and tick() on its loop; compute runs in the background, one at a
// time, and never journals anything.
export class ContextCards {
  constructor({ debounceMs = CARD_DEBOUNCE_MS } = {}) {
    this.debounceMs = debounceMs;
    this.pending = new Set();
    this.firstAt = null;
    this.signatures = new Map(); // ticket id -> files signature last scheduled
    this.inflight = null;
    this.stopped = false;
  }

  static signature(ticket) {
    const files = ticket.files_touched ?? [];
    return JSON.stringify([ticket.repo_id ?? null, files.length, files.length ? files[files.length - 1].relative_path : null]);
  }

  mark(worker, ticketId) {
    const t = ticketId ? worker.state.tickets.get(ticketId) : null;
    if (!t) return;
    this.signatures.set(ticketId, ContextCards.signature(t));
    this.pending.add(ticketId);
    if (this.firstAt === null) this.firstAt = worker.clock();
  }

  // A binding changed (the session's ticket gets a card), or a bound ticket's files changed.
  note(worker, result) {
    for (const key of result.bindingChanged ?? []) this.mark(worker, worker.state.sessions.get(key)?.current_ticket_id);
    if (!result.changed || !result.changed.size) return;
    for (const session of worker.state.sessions.values()) {
      const id = session.current_ticket_id;
      if (!id || !result.changed.has(id) || this.pending.has(id)) continue;
      const t = worker.state.tickets.get(id);
      if (t && this.signatures.get(id) !== ContextCards.signature(t)) this.mark(worker, id);
    }
  }

  // Every currently bound ticket, at worker start.
  noteAllBound(worker) {
    for (const s of worker.state.sessions.values()) if (s.current_ticket_id) this.mark(worker, s.current_ticket_id);
  }

  tick(worker) {
    if (this.stopped || this.inflight || !this.pending.size || worker.clock() < this.firstAt + this.debounceMs) return;
    const ids = [...this.pending];
    this.pending.clear();
    this.firstAt = null;
    this.inflight = this.computeAll(worker, ids).finally(() => { this.inflight = null; });
  }

  async computeAll(worker, ids) {
    for (const id of ids) {
      if (this.stopped) return;
      try { await this.compute(worker, id); } catch (err) { worker.log(`context card not written for ${id}: ${err.message}`); }
    }
  }

  async compute(worker, id) {
    const before = worker.state.tickets.get(id);
    if (!before) return;
    const repo = before.repo_id ? (worker.config.repos ?? {})[before.repo_id] : null;
    let index = null;
    if (repo && repo.canonical_path && fs.existsSync(repo.canonical_path)) {
      try { index = await coChangeIndex(repo.canonical_path, { home: quillHome(worker.env), repoId: before.repo_id }); } catch (err) { worker.log(`co-change index not built for ${before.repo_id}: ${err.message}`); }
    }
    if (this.stopped) return;
    const ticket = worker.state.tickets.get(id);
    if (!ticket) return;
    const card = contextCard(worker.state, ticket, index, { now: worker.now() });
    writeContextCard(worker.env, id, { format: 1, ticket_id: id, repo_id: ticket.repo_id ?? null, head: index ? index.head : null, computed_at: worker.now(), ...card });
  }

  /** Resolves when no compute is running (tests, worker stop). */
  async idle() {
    while (this.inflight) await this.inflight;
  }

  async stop() {
    this.stopped = true;
    await this.idle();
  }
}
