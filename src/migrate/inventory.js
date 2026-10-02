// Inventories legacy notes without writing anything (TRD §Migration: `quill migrate --dry-run`).
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../worker/markdown.js';
import { deterministicId } from '../lib/ids.js';
import { toIso } from '../lib/time.js';
import { mapRecord, keyFor } from './pmla.js';

const AMBIGUOUS = new Set(['status-unknown', 'missing-waiver-reason', 'blocker-missing', 'title-missing', 'pr-missing']);

function tolerantYaml(text) {
  try {
    return parseYaml(text);
  } catch {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (v === '' || v === 'null') v = null;
      out[m[1]] = v;
    }
    return out;
  }
}

function sections(body, names) {
  const lines = body.split(/\r?\n/);
  const found = {};
  let current = null;
  const rest = [];
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { current = h[1].trim().toLowerCase(); if (!found[current]) found[current] = []; continue; }
    if (current) found[current].push(line);
    else rest.push(line);
  }
  const pick = (name) => (found[name.toLowerCase()] ? found[name.toLowerCase()].join('\n').trim() : null);
  return { pick, rest: rest.join('\n').trim(), headings: Object.keys(found) };
}

export function parseSourceNote(file, profile = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { path: file, frontmatter: null, authored: { summary: text.trim(), notes: '' }, hasTimeline: false, text };
  const frontmatter = tolerantYaml(m[1]);
  const names = profile.authored_sections ?? { summary: 'Summary', notes: 'Notes', timeline: 'Timeline' };
  const s = sections(m[2], names);
  const summary = s.pick(names.summary) ?? (s.headings.length ? s.rest : m[2].trim());
  const notes = s.pick(names.notes) ?? '';
  const timeline = s.pick(names.timeline);
  return { path: file, frontmatter, authored: { summary: summary ?? '', notes }, hasTimeline: !!(timeline && timeline.split('\n').some((l) => l.trim())), text };
}

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Several notes with one key: the note named after the key wins, else the most recently active one;
// the others become its children with derived keys (KEY.1, KEY.2) instead of being dropped (issue #2).
function resolveDuplicates(tickets) {
  const groups = new Map();
  for (const t of tickets) groups.set(t.mapped.key, [...(groups.get(t.mapped.key) ?? []), t]);
  const taken = new Set(tickets.map((t) => t.mapped.key));
  const duplicates = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const stem = (t) => path.basename(t.rel, path.extname(t.rel)).toLowerCase();
    const named = group.find((t) => stem(t) === key.toLowerCase());
    const winner = named ?? [...group].sort((a, b) => (b.mapped.last_activity ?? '').localeCompare(a.mapped.last_activity ?? ''))[0];
    const losers = group.filter((t) => t !== winner).sort((a, b) => a.rel.localeCompare(b.rel));
    let n = 0;
    for (const t of losers) {
      do { n += 1; } while (taken.has(`${key}.${n}`));
      t.mapped.key = `${key}.${n}`;
      taken.add(t.mapped.key);
      t.mapped.parent_key = key;
      t.mapped.jira = null;
      t.mapped.jira_key = null;
      t.issues.push('duplicate-key');
    }
    duplicates.push({ key, kept: winner.rel, children: losers.map((t) => ({ rel: t.rel, key: t.mapped.key })) });
  }
  return duplicates;
}

export function inventory(sourceDir, profile, { project_id = null, key_prefix = 'LOCAL', repos = {} } = {}) {
  const root = path.resolve(sourceDir);
  const ignores = (profile.ignore_globs ?? ['templates/**']).map(globToRegExp);
  const files = walk(root, profile.glob_extensions ?? ['.md']);
  const tickets = [];
  const ignored = [];
  const repoBySlug = new Map(Object.keys(repos ?? {}).map((id) => [slug(id), id]));
  const unregistered = new Map();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (ignores.some((re) => re.test(rel))) { ignored.push(file); continue; }
    const note = parseSourceNote(file, profile);
    if (!note.frontmatter || (!note.frontmatter.title && !note.frontmatter.status)) { ignored.push(file); continue; }
    const mtime = toIso(fs.statSync(file).mtime);
    const mapped = mapRecord(note, profile, { fallbackTime: mtime });
    mapped.id = deterministicId(`pmla:${rel}`);
    mapped.key = keyFor(mapped, rel, key_prefix);
    mapped.project_id = project_id;
    if (mapped.repo_value) {
      mapped.repo_id = repoBySlug.get(slug(mapped.repo_value)) ?? null;
      if (!mapped.repo_id) unregistered.set(mapped.repo_value, (unregistered.get(mapped.repo_value) ?? 0) + 1);
    }
    tickets.push({ path: file, rel, frontmatter: note.frontmatter, authored: note.authored, mapped, issues: mapped.issues });
  }
  const warnings = [];
  if (tickets.length && profile.fields.jira && !tickets.some((t) => t.mapped.jira_key)) {
    const names = [].concat(profile.fields.jira).join(', ');
    warnings.push(`no tracker keys found in ${tickets.length} notes; check the profile's jira field names (${names})`);
  }
  const duplicates = resolveDuplicates(tickets);
  const keys = new Map(tickets.map((t) => [t.mapped.key, t]));
  for (const t of tickets) {
    if (t.mapped.parent_key && !keys.has(t.mapped.parent_key)) t.issues.push('parent-unresolved');
  }
  const ambiguous = tickets.filter((t) => t.issues.some((i) => AMBIGUOUS.has(i) || i === 'parent-unresolved'));
  const by_status = {};
  for (const t of tickets) by_status[t.mapped.status] = (by_status[t.mapped.status] ?? 0) + 1;
  const unregistered_repos = [...unregistered].map(([value, count]) => ({ value, count }));
  return { source: root, tickets, ignored, ambiguous, duplicates, unregistered_repos, warnings, counts: { total: tickets.length, ambiguous: ambiguous.length, ignored: ignored.length, duplicates: duplicates.length, by_status } };
}
