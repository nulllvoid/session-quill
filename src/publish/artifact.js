// The artifact publisher (ADR 0010): one live claude.ai page per publisher whose rows live in the
// artifact's shared db. The first publish creates the page and its rows; later publishes read the
// rows and write only fields nobody else changed, each write pinned to the version just read.
//
// A publish is a short sequence of plans that something with the Artifact tools executes: a
// headless runtime (executor = "cli") or a Claude Code session (executor = "session", through
// `quill publish --plan` / `--result`). The phases below are pure, so both executors share them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TrackerError } from '../lib/errors.js';
import { renderArtifactPage, PAGE_CAPABILITIES } from './artifact-page.js';

export const PROTOCOL = 'quill-artifact/1';
const BATCH_MAX = 50;
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function docId(key) {
  const id = String(key).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 200);
  return id === '.' || id === '..' || !id ? `_${id}` : id;
}

// local and last: { docId: fields }. remote: { docId: { version, data } }.
export function planRowWrites({ local, last = {}, remote = {}, now }) {
  const writes = [];
  const conflicts = [];
  const published = {};
  const stamp = (inScope) => ({ _quill: { in_scope: inScope, published_at: now } });
  for (const [id, row] of Object.entries(local)) {
    const r = remote[id];
    if (!r) {
      writes.push({ op: 'set', collection: 'tickets', doc_id: id, data: { ...row, ...stamp(true) } });
      published[id] = { ...row };
      continue;
    }
    const prev = last[id] ?? null;
    const patch = {};
    const record = { ...(prev ?? {}) };
    for (const [f, lv] of Object.entries(row)) {
      const rv = r.data[f];
      if (eq(lv, rv)) { record[f] = lv; continue; }
      const pv = prev ? prev[f] : undefined;
      if (pv === undefined || eq(rv, pv)) { patch[f] = lv; record[f] = lv; continue; }
      // Someone edited this field on the page since Quill last wrote it: their value stands.
      if (!eq(lv, pv)) conflicts.push({ key: row.key ?? id, field: f, kept: rv });
      record[f] = pv;
    }
    const outOfScope = r.data._quill && r.data._quill.in_scope === false;
    if (Object.keys(patch).length || outOfScope) writes.push({ op: 'update', collection: 'tickets', doc_id: id, if_version: r.version, data: { ...patch, ...stamp(true) } });
    published[id] = record;
  }
  for (const [id, r] of Object.entries(remote)) {
    if (local[id] || !r.data || !r.data._quill || r.data._quill.in_scope === false) continue;
    writes.push({ op: 'update', collection: 'tickets', doc_id: id, if_version: r.version, data: stamp(false) });
    if (last[id]) published[id] = last[id];
  }
  return { writes, conflicts, published };
}

function batchSteps(writes) {
  const files = {};
  const steps = [];
  for (let i = 0, n = 1; i < writes.length; i += BATCH_MAX, n += 1) {
    files[`batch-${n}.json`] = JSON.stringify(writes.slice(i, i + BATCH_MAX));
    steps.push({ op: 'batch', file: `batch-${n}.json` });
  }
  return { files, steps };
}

function checkSteps(result) {
  if (!result || !Array.isArray(result.steps)) throw new TrackerError('artifact-failed', 'the executor result has no steps');
  for (const s of result.steps) if (!s.ok) throw new TrackerError('artifact-failed', `artifact ${s.op} failed: ${s.error ?? 'no reason given'}`);
}

// Rows the executor saved under <dir>/read/<collection>/<id>.json, with versions from its result.
export function readRemote(dir, result, collection) {
  const versions = new Map();
  for (const s of result.steps) if (s.op === 'read' && Array.isArray(s.documents) && (s.collection === undefined || s.collection === collection)) for (const d of s.documents) versions.set(`${s.collection ?? collection}/${d.doc_id}`, d.version);
  const remote = {};
  const base = path.join(dir, 'read', collection);
  let files = [];
  try { files = fs.readdirSync(base).filter((f) => f.endsWith('.json')); } catch { /* empty collection */ }
  for (const f of files) {
    const id = f.slice(0, -5);
    let body;
    try { body = JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')); } catch { continue; }
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' && 'version' in body ? body.data : body;
    const fromResult = versions.get(`${collection}/${id}`);
    const version = Number.isInteger(fromResult) ? fromResult : Number.isInteger(body && body.version) ? body.version : null;
    if (version === null) throw new TrackerError('artifact-failed', `the executor reported no version for ${collection}/${id}`);
    remote[id] = { version, data };
  }
  return remote;
}

// Phase 1. Returns { plan, files, context } for the first executor run.
export function beginArtifactPublish(publisher, rows, { prior = null, now }) {
  const page = renderArtifactPage({ title: publisher.title ?? publisher.name, fields: publisher.fields });
  const pageHash = crypto.createHash('sha256').update(page).digest('hex');
  const local = Object.fromEntries(rows.map((r) => [docId(r.key), r]));
  const meta = { title: publisher.title ?? publisher.name, fields: publisher.fields, published_at: now, publisher: publisher.name, generator: 'session-quill' };
  const url = (prior && prior.url) || publisher.url || null;
  const publishStep = { op: 'publish', file: 'page.html', title: meta.title, capabilities: PAGE_CAPABILITIES };
  const context = { phase: url ? 'read' : 'create', url, page_hash: pageHash, local, last: (prior && prior.rows) || {}, meta, now, rows: rows.length };
  if (!url) {
    const { writes, published } = planRowWrites({ local, last: {}, remote: {}, now });
    writes.push({ op: 'set', collection: 'meta', doc_id: 'page', data: meta });
    const b = batchSteps(writes);
    return { plan: { protocol: PROTOCOL, url: null, steps: [publishStep, ...b.steps] }, files: { 'page.html': page, ...b.files }, context: { ...context, published } };
  }
  const steps = [];
  if (!prior || prior.page_hash !== pageHash) steps.push(publishStep);
  steps.push({ op: 'read', collection: 'tickets', out_dir: 'read' }, { op: 'read', collection: 'meta', out_dir: 'read' });
  return { plan: { protocol: PROTOCOL, url, steps }, files: { 'page.html': page }, context };
}

// After an executor run. Returns { done: { url, summary, state, conflicts } } or the next
// { plan, files, context }.
export function continueArtifactPublish(context, result, dir) {
  checkSteps(result);
  if (context.phase === 'create') {
    if (!result.url) throw new TrackerError('artifact-failed', 'the executor did not report the new artifact URL');
    return { done: { url: result.url, summary: `published ${plural(context.rows, 'row')} to a new artifact`, conflicts: [], state: { url: result.url, page_hash: context.page_hash, rows: context.published } } };
  }
  if (context.phase === 'read') {
    const remote = readRemote(dir, result, 'tickets');
    const remoteMeta = readRemote(dir, result, 'meta').page ?? null;
    const { writes, conflicts, published } = planRowWrites({ local: context.local, last: context.last, remote, now: context.now });
    const counts = { added: writes.filter((w) => w.op === 'set').length, out: writes.filter((w) => w.op === 'update' && w.data._quill && w.data._quill.in_scope === false).length };
    counts.updated = writes.length - counts.added - counts.out;
    writes.push(remoteMeta ? { op: 'update', collection: 'meta', doc_id: 'page', if_version: remoteMeta.version, data: context.meta } : { op: 'set', collection: 'meta', doc_id: 'page', data: context.meta });
    const b = batchSteps(writes);
    return { plan: { protocol: PROTOCOL, url: context.url, steps: b.steps }, files: b.files, context: { phase: 'write', url: context.url, page_hash: context.page_hash, published, conflicts, counts } };
  }
  if (context.phase === 'write') {
    const kept = context.conflicts.length ? ` (${plural(context.conflicts.length, 'field')} edited on the page kept)` : '';
    return { done: { url: context.url, summary: summarize(context.counts, kept), conflicts: context.conflicts, state: { url: context.url, page_hash: context.page_hash, rows: context.published } } };
  }
  throw new TrackerError('artifact-failed', `unknown publish phase ${context.phase}`);
}

function summarize({ added, updated, out }, kept) {
  const parts = [added ? `added ${plural(added, 'row')}` : null, updated ? `updated ${plural(updated, 'row')}` : null, out ? `${out} out of scope` : null].filter(Boolean);
  return `${parts.length ? parts.join(', ') : 'no row changes'}${kept}`;
}

// The headless executor path: run every phase through `client.run`.
export async function publishArtifact(publisher, rows, { client, prior = null, now }) {
  let step = beginArtifactPublish(publisher, rows, { prior, now });
  for (;;) {
    const { result, dir } = await client.run(step.plan, step.files);
    const next = continueArtifactPublish(step.context, result, dir);
    if (next.done) return next.done;
    step = next;
  }
}
