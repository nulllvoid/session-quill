// Planned files and drift (ADR 0037, FR-3.1). A plan approved with ExitPlanMode, or a run request's
// `planned_paths`, names the repository files the work expects to change; a later file write
// outside them is counted as drift. Drift is an observation only: nothing here allows, refuses or
// pauses anything, so it can never widen what the gate or a run's guard decides.
//
// Pure functions with no Quill imports: the hook, the reducer and the run guard all load this.
import path from 'node:path';

export const MAX_PLANNED = 50;
export const PLANNED_CHARS = 200;
export const MAX_WILDCARDS = 4;
/** How much of a plan's text is searched for paths: plans are agent output of any size. */
export const PLAN_TEXT_CHARS = 64 * 1024;

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// The scheme is bounded, so a long run of scheme characters with no `://` stays linear.
const URL_RE = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s)>\]`'"]*/gi;
const WWW_RE = /\bwww\.[^\s)>\]`'"]*/gi;
// The characters a path token in prose may hold. Anything else (spaces, quotes, brackets, colons,
// commas, backticks) ends it, so `C:\x`, `~/x` and `[a](b)` split into parts the checks reject.
const TOKEN_RE = /[A-Za-z0-9_@+\-.*?/\\]+/g;

const slashes = (s) => s.replace(/\\/g, '/');
// `s` without its trailing dots. A loop, not `/\.+$/`, which is quadratic on a long run of dots.
function trimDots(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === '.') end -= 1;
  return s.slice(0, end);
}

// One planned entry in canonical form (forward slashes, no leading `./`, no trailing `/`), or
// null when it is not a repo-relative path or glob: absolute, drive- or home-relative, a URL,
// climbing with `..`, holding control characters or a colon, empty, longer than PLANNED_CHARS, or
// with more than MAX_WILDCARDS wildcards (`*`, `**`, `?`; a run of `*` counts as one `**`).
function canonicalEntry(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw || raw.length > PLANNED_CHARS || CONTROL.test(raw) || raw.includes(':')) return null;
  if (/^[\\/~]/.test(raw)) return null;
  let s = slashes(raw.trim()).replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+$/, '').replace(/\*{3,}/g, '**');
  if (!s || s.split('/').some((seg) => seg === '..')) return null;
  if ((s.match(/\*\*|\*|\?/g) || []).length > MAX_WILDCARDS) return null;
  if (!/[A-Za-z0-9]/.test(s)) return null;
  return s;
}

/** Valid entries of `list`, canonical, deduplicated, at most MAX_PLANNED. Never throws. */
export function normalizePlanned(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const s = canonicalEntry(raw);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_PLANNED) break;
  }
  return out;
}

/** The first invalid entry of a request's list, or null when every entry is a repo-relative path or glob. */
export function invalidPlannedEntry(list) {
  for (const raw of list) if (!canonicalEntry(raw)) return typeof raw === 'string' ? raw : String(raw);
  return null;
}

// A prose token looks like a path when it has a directory part, or a name and an extension with a
// letter in it (so `1.1.1`, `e.g` and `i.e` are not files).
function looksLikePath(token) {
  if (token.startsWith('-')) return false;
  const s = trimDots(token);
  if (s.includes('/') || s.includes('\\')) return true;
  const dot = s.lastIndexOf('.');
  if (dot < 0) return false;
  const name = s.slice(0, dot);
  const ext = s.slice(dot + 1);
  return /^[A-Za-z0-9*?]{1,10}$/.test(ext) && /[A-Za-z*?]/.test(ext) && (name.length >= 2 || /[*?]/.test(name));
}

/**
 * Repo-relative paths and globs a plan's text names, in first-seen order, at most MAX_PLANNED.
 * URLs, absolute and home paths, `..` climbs, command flags and version numbers are ignored.
 * @param {string} text
 * @returns {string[]}
 */
export function extractPlannedPaths(text) {
  if (typeof text !== 'string' || !text) return [];
  const clean = text.slice(0, PLAN_TEXT_CHARS).replace(URL_RE, ' ').replace(WWW_RE, ' ');
  const out = [];
  for (const m of clean.matchAll(TOKEN_RE)) {
    const token = m[0];
    // A token right after a colon is the rest of a drive path (`C:\x`) or a scheme: never a repo path.
    if (m.index > 0 && clean[m.index - 1] === ':') continue;
    if (!looksLikePath(token)) continue;
    const s = canonicalEntry(trimDots(token));
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_PLANNED) break;
  }
  return out;
}

// A glob as matcher tokens. `**/` matches nothing or anything ending in `/`; `**` anything; `*`
// anything within one level; `?` one character other than `/`; every other character itself.
const tokenCache = new Map();
function globTokens(glob) {
  let tokens = tokenCache.get(glob);
  if (tokens) return tokens;
  tokens = [];
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      while (glob[i + 1] === '*') i += 1;
      if (glob[i + 1] === '/') { tokens.push('dirs'); i += 1; } else tokens.push('any');
    } else if (c === '*') tokens.push('star');
    else if (c === '?') tokens.push('one');
    else tokens.push({ c: c.toLowerCase() });
  }
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(glob, tokens);
  return tokens;
}

// Whether `text` matches the glob, or lies below a directory the glob matches (`src/hooks` covers
// `src/hooks/a.js`). A dynamic programme over the text positions, one pass per token: O(glob x text)
// whatever the wildcards, never the backtracking a regular expression does on agent-chosen globs.
function globMatches(glob, text) {
  const tokens = globTokens(glob);
  const n = text.length;
  const low = Array.from({ length: n }, (_, j) => text[j].toLowerCase());
  let cur = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  cur[0] = 1;
  for (const tok of tokens) {
    next.fill(0);
    let any = false;
    if (tok === 'star' || tok === 'any') {
      for (let j = 0; j <= n; j += 1) {
        next[j] = cur[j] || (j > 0 && next[j - 1] && (tok === 'any' || text[j - 1] !== '/')) ? 1 : 0;
        any ||= next[j] === 1;
      }
    } else if (tok === 'dirs') {
      let seen = false;
      for (let j = 0; j <= n; j += 1) {
        if (j > 0 && cur[j - 1]) seen = true;
        next[j] = cur[j] || (seen && text[j - 1] === '/') ? 1 : 0;
        any ||= next[j] === 1;
      }
    } else {
      for (let j = 0; j < n; j += 1) {
        if (cur[j] && (tok === 'one' ? text[j] !== '/' : low[j] === tok.c)) { next[j + 1] = 1; any = true; }
      }
    }
    if (!any) return false;
    [cur, next] = [next, cur];
  }
  if (cur[n]) return true;
  for (let k = 0; k < n; k += 1) if (cur[k] && text[k] === '/') return true;
  return false;
}

/**
 * Whether a repo-relative path is one the planned entries cover. An entry with a `/` is anchored at
 * the repository root and covers what lies below it; one without (such as `README.md` or `docs`)
 * matches a file or directory name at any depth, as in .gitignore. `*` and `?` stay inside one directory level; `**` crosses levels. Matching
 * ignores case, so on a case-sensitive file system it errs towards fewer drift flags.
 */
export function matchesPlanned(p, globs) {
  if (typeof p !== 'string' || !p || !Array.isArray(globs) || !globs.length) return false;
  let rel = slashes(p);
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (!rel) return false;
  const segments = rel.split('/').filter(Boolean);
  return globs.some((g) => typeof g === 'string' && g && g.length <= PLANNED_CHARS
    && (g.includes('/') ? globMatches(g, rel) : segments.some((seg) => globMatches(g, seg))));
}

const isAbsoluteAny = (p) => /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p);

/**
 * The repo-relative writes the planned entries do not cover. A hook's write path is absolute only
 * when it lies outside the session's directory (src/hooks/payload.js): that is not the project's
 * work (plan files, memory notes), so it is never drift. No planned entries, no drift.
 */
export function outsidePlan(writePaths, globs) {
  if (!Array.isArray(writePaths) || !Array.isArray(globs) || !globs.length) return [];
  const out = [];
  for (const p of writePaths) {
    if (typeof p !== 'string' || !p || isAbsoluteAny(p) || matchesPlanned(p, globs) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/**
 * The reducer's session update for an approved plan: its planned files replace the previous plan's
 * and the drift count starts again. Returns whether the session changed.
 */
export function applyPlannedPaths(session, list) {
  const next = normalizePlanned(list);
  const prev = Array.isArray(session.planned_paths) ? session.planned_paths : [];
  if (prev.length === next.length && prev.every((x, i) => x === next[i]) && !session.drift) return false;
  session.planned_paths = next;
  session.drift = null;
  return true;
}

/** The reducer's session update for a captured file write. Returns whether drift was counted. */
export function recordSessionDrift(session, writePaths, at) {
  const out = outsidePlan(writePaths, session.planned_paths);
  if (!out.length) return false;
  const count = (session.drift && Number.isInteger(session.drift.count) ? session.drift.count : 0) + out.length;
  session.drift = { count, last_path: out[out.length - 1].slice(0, PLANNED_CHARS * 2), at };
  return true;
}

function writeTargets(toolName, toolInput) {
  if (!WRITE_TOOLS.has(toolName) || !toolInput || typeof toolInput !== 'object') return [];
  const raw = [toolName === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path];
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) for (const e of toolInput.edits) raw.push(e && e.file_path);
  return raw.filter((x) => typeof x === 'string' && x);
}

/**
 * For the run guard, after it has decided a call: whether this file write lands inside the run's
 * checkout but outside the grant's frozen `plannedPaths`. A write outside the checkout is the
 * writable roots' business, not drift. Shell commands are not measured.
 */
export function driftOfCall(toolName, toolInput, grant, cwd) {
  const planned = grant && Array.isArray(grant.plannedPaths) ? grant.plannedPaths : [];
  if (!planned.length) return false;
  const root = typeof grant.checkoutRoot === 'string' && grant.checkoutRoot ? grant.checkoutRoot : cwd;
  if (typeof root !== 'string' || !root) return false;
  for (const target of writeTargets(toolName, toolInput)) {
    const rel = path.relative(root, path.resolve(cwd || root, target));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!matchesPlanned(rel, planned)) return true;
  }
  return false;
}

/** How many allowed calls the run's guard marked as drift, one per call (`tool_use_id`). */
export function countRunDrift(lines) {
  if (!Array.isArray(lines)) return 0;
  const ids = new Set();
  let n = 0;
  for (const l of lines) {
    if (!l || l.kind !== 'guard' || l.decision !== 'allow' || l.drift !== true) continue;
    if (typeof l.tool_use_id === 'string' && l.tool_use_id) {
      if (ids.has(l.tool_use_id)) continue;
      ids.add(l.tool_use_id);
    }
    n += 1;
  }
  return n;
}

/** The status line segment for a session's drift count. */
export function driftSuffix(count) {
  return Number.isInteger(count) && count > 0 ? ` ⚠ drift ${count}` : '';
}
