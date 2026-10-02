// The artifact publisher (ADR 0010, ADR 0011): one live claude.ai page per publisher whose rows live
// in the artifact's shared db. The first publish creates the page and its rows; later publishes read
// the rows and write only fields nobody else changed, each write pinned to the version just read.
//
// A publish is a short sequence of plans that something with the Artifact tools executes: a
// headless runtime (executor = "cli") or a Claude Code session (executor = "session", through
// `quill publish --plan` / `--result`). The phases below are pure, so both executors share them.
// Every result is checked against the plan it answers before anything is recorded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TrackerError } from '../lib/errors.js';
import { renderArtifactPage, PAGE_CAPABILITIES } from './artifact-page.js';
import { ARTIFACT_URL_RE } from './config.js';

export const PROTOCOL = 'quill-artifact/1';
const BATCH_MAX = 50;
const DELETE = { __delete__: true };
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isMeta = (k) => k === 'key' || k.startsWith('_');

// The request id of a page edit, derived from the edit itself, so bringing the same edit back twice
// (a retry after a crash, a lost result) makes one request, and a later edit makes a new one.
export function editRequestId(publisher, e) {
  const h = crypto.createHash('sha256').update(JSON.stringify([publisher, e.ticket_id, e.field, e.value ?? null, e.expected_revision, e.at ?? null])).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function docId(key) {
  // Letters, digits and _ - . ~ @ + only: also safe as a file name on Windows (no ':').
  const id = String(key).replace(/[^A-Za-z0-9_\-.~@+]/g, '_').slice(0, 200);
  return id === '.' || id === '..' || !id ? `_${id}` : id;
}

function fail(message, extra = {}) {
  return Object.assign(new TrackerError('artifact-failed', message), extra);
}

// local: { docId: fields (+ _ticket { id, revision }) }; last: { docId: fields Quill last wrote };
// remote: { docId: { version, data } }. `editable` (two-way publishers, ADR 0011) lists fields whose
// page edits are handed back as edits to apply instead of being kept as conflicts.
export function planRowWrites({ local, last = {}, remote = {}, now, editable = null }) {
  const writes = [];
  const conflicts = [];
  const edits = [];
  const foreign = [];
  const missing = [];
  const published = {};
  const fieldsOf = (row) => Object.entries(row).filter(([k]) => !k.startsWith('_'));
  const stamp = (inScope, row, revision = row && row._ticket ? row._ticket.revision : undefined) => ({ _quill: { in_scope: inScope, published_at: now, ...(revision !== undefined ? { revision } : {}) } });
  for (const [id, row] of Object.entries(local)) {
    const r = remote[id];
    const plain = Object.fromEntries(fieldsOf(row));
    if (!r && last[id]) {
      // Published before but not in this read: deleted on the page, or a read that fell short.
      // Either way it is left alone; only a row Quill never published is created without a pin.
      missing.push(id);
      published[id] = last[id];
      continue;
    }
    if (!r) {
      writes.push({ op: 'set', collection: 'tickets', doc_id: id, data: { ...plain, ...stamp(true, row) } });
      published[id] = { ...plain };
      continue;
    }
    if (!r.data || typeof r.data !== 'object' || !r.data._quill) {
      // A row Quill did not create (for example on an artifact it took over): never touched.
      foreign.push(id);
      continue;
    }
    const prev = last[id] ?? null;
    const patch = {};
    const record = {};
    let edited = false;
    for (const [f, lv] of fieldsOf(row)) {
      const rv = r.data[f];
      if (eq(lv, rv)) { record[f] = lv; continue; }
      const pv = prev ? prev[f] : undefined;
      if (pv === undefined || eq(rv, pv)) { patch[f] = lv; record[f] = lv; continue; }
      // Someone edited this field on the page since Quill last wrote it.
      if (editable && editable.includes(f) && row._ticket && Number.isInteger(r.data._quill.revision)) {
        // Two-way: hand the edit back as a revision-checked request, and acknowledge it so the next
        // publish writes the ticket's value over it if the request does not apply.
        edits.push({ ticket_id: row._ticket.id, key: row.key ?? id, field: f, value: rv, expected_revision: r.data._quill.revision, by: (r.data._edits && r.data._edits[f] && r.data._edits[f].by) || null, at: (r.data._edits && r.data._edits[f] && typeof r.data._edits[f].at === 'string' && r.data._edits[f].at) || null });
        record[f] = rv;
        edited = true;
        continue;
      }
      // One-way: their value stands on the page.
      if (!eq(lv, pv)) conflicts.push({ key: row.key ?? id, field: f, kept: rv });
      record[f] = pv;
    }
    // A field this publisher no longer sends is removed, unless someone has changed it since.
    for (const [f, pv] of Object.entries(prev ?? {})) {
      if (isMeta(f) || f in plain) continue;
      if (eq(r.data[f], pv)) patch[f] = DELETE;
    }
    const outOfScope = r.data._quill.in_scope === false;
    // Two-way rows carry the revision they show, so a page edit is checked against what the editor saw.
    // A row still showing an edit keeps the revision its editor saw until it shows Quill's values again.
    const staleRevision = !!editable && !!row._ticket && !edited && r.data._quill.revision !== row._ticket.revision;
    const revision = edited ? r.data._quill.revision : undefined;
    if (Object.keys(patch).length || outOfScope || staleRevision) writes.push({ op: 'update', collection: 'tickets', doc_id: id, if_version: r.version, data: { ...patch, ...(edited ? stamp(true, row, revision) : stamp(true, row)) } });
    published[id] = record;
  }
  for (const [id, r] of Object.entries(remote)) {
    if (local[id] || !r.data || !r.data._quill || r.data._quill.in_scope === false) continue;
    // Leaving scope: only the key and the marker stay, so the page's readers no longer see the row.
    const blank = Object.fromEntries(Object.keys(r.data).filter((f) => !isMeta(f)).map((f) => [f, DELETE]));
    writes.push({ op: 'update', collection: 'tickets', doc_id: id, if_version: r.version, data: { ...blank, ...stamp(false) } });
  }
  return { writes, conflicts, edits, foreign, missing, published };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Maps page comments to published tickets by the key they name: in the comment, else in the text
// the thread is anchored to, else the key an earlier comment of the same thread named.
export function matchComments(threads = [], keys = new Map(), seen = new Set()) {
  const list = [...keys.keys()].sort((a, b) => b.length - a.length);
  const re = list.length ? new RegExp(`(?<![A-Za-z0-9_-])(${list.map(escapeRe).join('|')})(?![A-Za-z0-9_-])`) : null;
  const find = (text) => { if (!re || typeof text !== 'string') return null; const m = re.exec(text); return m ? m[1] : null; };
  const matched = [];
  const unmatched = [];
  for (const t of threads) {
    let threadKey = find(t.anchor);
    for (const c of t.comments ?? []) {
      if (!c || typeof c.comment_id !== 'string' || seen.has(c.comment_id)) continue;
      const key = find(c.text) ?? threadKey;
      if (!key) { unmatched.push(c.comment_id); continue; }
      threadKey = threadKey ?? key;
      matched.push({ thread_id: t.thread_id, comment_id: c.comment_id, ticket_id: keys.get(key), key, author: c.author ?? null, text: String(c.text ?? '').slice(0, 2000), at: c.at ?? null });
    }
  }
  return { matched, unmatched };
}

// One data file per document: the executor passes `file_path` entries straight to ArtifactData's
// batch, so ticket data never has to enter its context (ADR 0010).
function batchSteps(writes) {
  const files = {};
  const steps = [];
  let doc = 0;
  for (let i = 0; i < writes.length; i += BATCH_MAX) {
    const entries = writes.slice(i, i + BATCH_MAX).map((w) => {
      doc += 1;
      const file = `doc-${doc}.json`;
      files[file] = JSON.stringify(w.data);
      return { op: w.op, collection: w.collection, doc_id: w.doc_id, ...(Number.isInteger(w.if_version) ? { if_version: w.if_version } : {}), file };
    });
    steps.push({ op: 'batch', writes: entries });
  }
  return { files, steps };
}

// The result answers the plan: same steps in the same order, stopping at the first failure.
function checkSteps(result, plan, { url = null } = {}) {
  if (!result || !Array.isArray(result.steps)) throw fail('the executor result has no steps', { url });
  const steps = result.steps;
  const expected = plan.ops;
  if (steps.length > expected.length || steps.some((s, i) => !s || s.op !== expected[i])) throw fail('the executor result does not match the plan; run the plan again', { url });
  const publishUrl = (steps.find((s) => s && s.op === 'publish' && s.ok && s.url) ?? {}).url ?? null;
  // A reported URL is taken only when creating; an update keeps the artifact it was given.
  const known = url ?? validUrl(publishUrl);
  const failed = steps.find((s) => !s.ok);
  if (failed) throw fail(`artifact ${failed.op} failed: ${failed.error ?? 'no reason given'}`, { url: known });
  if (steps.length !== expected.length) throw fail('the executor result does not match the plan; run the plan again', { url: known });
  return known;
}

function validUrl(url) {
  if (url === null || url === undefined) return null;
  if (typeof url !== 'string' || !ARTIFACT_URL_RE.test(url)) throw fail(`${String(url).slice(0, 80)} is not a claude.ai artifact link`);
  return url;
}

// Rows the executor saved under <dir>/read/<collection>/<id>.json. Saved files hold the bare
// document; versions come from the read step's report, and every reported id must have its file.
export function readRemote(dir, result, collection) {
  const step = result.steps.find((s) => s.op === 'read' && s.collection === collection);
  if (!step || !Array.isArray(step.documents)) throw fail(`the executor did not report the ${collection} read`);
  if (step.complete !== true) throw fail(`the executor did not report reading every ${collection} document; run the publish again`);
  const remote = {};
  const base = path.join(dir, 'read', collection);
  for (const d of step.documents) {
    if (!d || typeof d.doc_id !== 'string' || !Number.isInteger(d.version)) throw fail(`the executor reported a ${collection} document without an id and version`);
    let body;
    try { body = JSON.parse(fs.readFileSync(path.join(base, `${d.doc_id}.json`), 'utf8')); } catch { throw fail(`${d.doc_id} was reported but not saved under read/${collection}`); }
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' && 'version' in body ? body.data : body;
    remote[d.doc_id] = { version: d.version, data: data && typeof data === 'object' ? data : {} };
  }
  let files = [];
  try { files = fs.readdirSync(base).filter((f) => f.endsWith('.json')); } catch { /* none saved */ }
  for (const f of files) if (!remote[f.slice(0, -5)]) throw fail(`read/${collection}/${f} was saved but not reported`);
  return remote;
}

function withOps(plan) {
  return { plan, ops: plan.steps.map((s) => s.op) };
}

// Phase 1. Returns { plan, files, context } for the first executor run.
export function beginArtifactPublish(publisher, rows, { prior = null, now }) {
  const twoWay = publisher.two_way === true;
  const page = renderArtifactPage({ title: publisher.title ?? publisher.name, fields: publisher.fields, twoWay });
  const pageHash = crypto.createHash('sha256').update(page).digest('hex');
  const local = Object.fromEntries(rows.map((r) => [docId(r.key), r]));
  const meta = { title: publisher.title ?? publisher.name, fields: publisher.fields, published_at: now, publisher: publisher.name, generator: 'session-quill' };
  const url = (prior && prior.url) || publisher.url || null;
  const publishStep = { op: 'publish', file: 'page.html', title: meta.title, capabilities: twoWay ? { ...PAGE_CAPABILITIES, user: {} } : PAGE_CAPABILITIES };
  const editable = twoWay ? ['status', 'next'].filter((f) => publisher.fields.includes(f)) : null;
  const keys = Object.fromEntries(rows.filter((r) => r._ticket).map((r) => [r.key, r._ticket.id]));
  const base = { url, page_hash: pageHash, local, last: (prior && prior.rows) || {}, meta, now, rows: rows.length, two_way: twoWay, editable, keys, seen_comments: (prior && prior.seen_comments) || [] };
  if (!url) {
    const { writes, published } = planRowWrites({ local, last: {}, remote: {}, now });
    writes.push({ op: 'set', collection: 'meta', doc_id: 'page', data: meta });
    const b = batchSteps(writes);
    const plan = { protocol: PROTOCOL, url: null, steps: [publishStep, ...b.steps] };
    return { plan, files: { 'page.html': page, ...b.files }, context: { ...base, phase: 'create', ops: withOps(plan).ops, published: stripTickets(published) } };
  }
  const steps = [];
  if (!prior || prior.page_hash !== pageHash) steps.push(publishStep);
  steps.push({ op: 'read', collection: 'tickets', out_dir: 'read' }, { op: 'read', collection: 'meta', out_dir: 'read' });
  if (twoWay) steps.push({ op: 'comments' });
  const plan = { protocol: PROTOCOL, url, steps };
  return { plan, files: { 'page.html': page }, context: { ...base, phase: 'read', ops: withOps(plan).ops } };
}

// After an executor run. Returns { done: { url, summary, state, conflicts, edits, comments } } or
// the next { plan, files, context }. A thrown error carries `url` when an artifact exists, so the
// caller can keep it instead of creating a second one next time.
export function continueArtifactPublish(context, result, dir) {
  const known = checkSteps(result, context, { url: context.url });
  if (context.phase === 'create') {
    if (!known) throw fail('the executor did not report the new artifact URL');
    return { done: { url: known, summary: `published ${plural(context.rows, 'row')} to a new artifact`, conflicts: [], edits: [], comments: [], state: { url: known, page_hash: context.page_hash, rows: context.published, seen_comments: context.seen_comments } } };
  }
  if (context.phase === 'read') {
    const remote = readRemote(dir, result, 'tickets');
    const remoteMeta = readRemote(dir, result, 'meta').page ?? null;
    const { writes, conflicts, edits, foreign, missing, published } = planRowWrites({ local: context.local, last: context.last, remote, now: context.now, editable: context.editable });
    const commentStep = result.steps.find((x) => x.op === 'comments');
    const { matched } = context.two_way && commentStep ? matchComments(commentStep.threads ?? [], new Map(Object.entries(context.keys ?? {})), new Set(context.seen_comments)) : { matched: [] };
    const seen = [...context.seen_comments, ...matched.map((m) => m.comment_id)].slice(-2000);
    const counts = { added: writes.filter((w) => w.op === 'set').length, out: writes.filter((w) => w.op === 'update' && w.data._quill && w.data._quill.in_scope === false).length, foreign: foreign.length, missing: missing.length };
    counts.updated = writes.length - counts.added - counts.out;
    writes.push(remoteMeta ? { op: 'update', collection: 'meta', doc_id: 'page', if_version: remoteMeta.version, data: context.meta } : { op: 'set', collection: 'meta', doc_id: 'page', data: context.meta });
    const b = batchSteps(writes);
    const plan = { protocol: PROTOCOL, url: context.url, steps: b.steps };
    return { plan, files: b.files, context: { phase: 'write', ops: withOps(plan).ops, url: context.url, page_hash: context.page_hash, published, conflicts, counts, edits, comments: matched, seen_comments: seen } };
  }
  if (context.phase === 'write') {
    const kept = context.conflicts.length ? ` (${plural(context.conflicts.length, 'field')} edited on the page kept)` : '';
    return { done: { url: context.url, summary: summarize(context.counts, kept) + feedback(context), conflicts: context.conflicts, edits: context.edits ?? [], comments: context.comments ?? [], state: { url: context.url, page_hash: context.page_hash, rows: context.published, seen_comments: context.seen_comments ?? [] } } };
  }
  throw fail(`unknown publish phase ${context.phase}`);
}

function feedback({ edits = [], comments = [] }) {
  const parts = [edits.length ? plural(edits.length, 'page edit') : null, comments.length ? plural(comments.length, 'comment') : null].filter(Boolean);
  return parts.length ? `; brought back ${parts.join(' and ')}` : '';
}

function stripTickets(published) {
  return Object.fromEntries(Object.entries(published).map(([id, row]) => [id, Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')))]));
}

function summarize({ added, updated, out, foreign = 0, missing = 0 }, kept) {
  const parts = [added ? `added ${plural(added, 'row')}` : null, updated ? `updated ${plural(updated, 'row')}` : null, out ? `${out} out of scope` : null, foreign ? `${plural(foreign, 'row')} not created by Quill left alone` : null, missing ? `${plural(missing, 'row')} missing from the page left alone` : null].filter(Boolean);
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

// Resolves a plan's relative file names to absolute paths inside the run directory.
export function resolvePlan(plan, dir) {
  return {
    ...plan,
    steps: plan.steps.map((s) => ({
      ...s,
      ...(s.file ? { file_path: path.join(dir, s.file) } : {}),
      ...(s.out_dir ? { out_dir: path.join(dir, s.out_dir) } : {}),
      ...(Array.isArray(s.writes) ? { writes: s.writes.map(({ file, ...w }) => ({ ...w, file_path: path.join(dir, file) })) } : {}),
    })),
  };
}
