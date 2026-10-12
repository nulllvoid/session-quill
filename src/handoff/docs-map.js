// A map of a repository's own documentation, so a run can find the doc it needs by reading a short
// index instead of guessing. Entry docs, docs/**/*.md, runbooks/** and RUNBOOK* only; the map is
// data for the prompt (titles and headings are repository text, never instructions).
import fs from 'node:fs';
import path from 'node:path';

export const DOCS_MAP_MAX_ENTRIES = 300;
export const DOCS_MAP_MAX_BYTES = 16 * 1024;
const MAX_HEADINGS = 8;
const HEAD_BYTES = 64 * 1024;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'venv', 'target', '.next', 'coverage']);
const ENTRY_DOC = /^(claude|agents)\.md$/i;
const README = /^readme(\.[a-z0-9]+)?$/i;
const RUNBOOK = /^runbook/i;
const MARKDOWN = /\.(md|mdx|markdown)$/i;

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return []; }
}

function walk(root, rel, depth, accept, out, limit) {
  if (depth > MAX_DEPTH || out.length >= limit) return;
  for (const e of listDir(path.join(root, rel))) {
    if (out.length >= limit) return;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, child, depth + 1, accept, out, limit);
    } else if (e.isFile() && accept(e.name)) out.push(child);
  }
}

function describe(root, rel) {
  let head = '';
  try {
    const fd = fs.openSync(path.join(root, rel), 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally { fs.closeSync(fd); }
  } catch { /* unreadable: listed without a title */ }
  let title = '';
  const headings = [];
  let fence = false;
  for (const raw of head.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    if (!title && /^# /.test(raw)) title = raw.slice(2).trim().slice(0, 200);
    else if (/^## /.test(raw) && headings.length < MAX_HEADINGS) headings.push(raw.slice(3).trim().slice(0, 120));
  }
  return { path: rel, title, headings };
}

export function buildDocsMap(repoPath, { maxEntries = DOCS_MAP_MAX_ENTRIES } = {}) {
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  const paths = [];
  const seen = new Set();
  const add = (list) => { for (const p of list) if (!seen.has(p) && paths.length < maxEntries) { seen.add(p); paths.push(p); } };
  // Entry docs first, so the cap never cuts them.
  add(listDir(repoPath).filter((e) => e.isFile() && (ENTRY_DOC.test(e.name) || README.test(e.name) || RUNBOOK.test(e.name))).map((e) => e.name));
  const docs = [];
  // A committed symlink or junction named docs/ or runbooks/ could point outside the checkout.
  const realDir = (name) => { try { return !fs.lstatSync(path.join(repoPath, name)).isSymbolicLink(); } catch { return false; } };
  if (realDir('docs')) walk(repoPath, 'docs', 0, (n) => MARKDOWN.test(n), docs, maxEntries);
  add(docs);
  const runbooks = [];
  if (realDir('runbooks')) walk(repoPath, 'runbooks', 0, () => true, runbooks, maxEntries);
  add(runbooks);
  return paths.map((p) => describe(repoPath, p));
}

// One line per document, never longer than `maxBytes` overall; the cut says how many were left out.
export function renderDocsMap(entries, { maxBytes = DOCS_MAP_MAX_BYTES } = {}) {
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const e of entries ?? []) {
    const line = `- ${e.path}${e.title ? ` - ${e.title}` : ''}${e.headings && e.headings.length ? ` (${e.headings.join('; ')})` : ''}`;
    if (used + Buffer.byteLength(line) + 1 > maxBytes - 80) break;
    lines.push(line);
    used += Buffer.byteLength(line) + 1;
    shown += 1;
  }
  const left = (entries ?? []).length - shown;
  if (left > 0) lines.push(`... ${left} more document${left === 1 ? '' : 's'} not listed (size limit)`);
  return lines.join('\n');
}
