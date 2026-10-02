import fs from 'node:fs';
import path from 'node:path';
import { loadContext, cliEvent, submitAndWait, writeControl, findTicketByKey, latestTicketDetail, workerStatus } from '../context.js';
import { Journal } from '../../core/journal.js';
import { journalPath } from '../../lib/paths.js';
import { createState, sessionKey } from '../../core/state.js';
import { applyEvent } from '../../core/reducer.js';
import { renderTicketNote, renderSessionNote, renderHandoffNote, parseNote } from '../../worker/notes.js';
import { safeKeyFileName, validateKey } from '../../core/keys.js';
import { writeFileAtomic, ensureDir } from '../../lib/atomic-fs.js';
import { snapshotFileName } from '../../hooks/binding-snapshot.js';
import { TrackerError } from '../../lib/errors.js';
import { isDate } from '../../lib/time.js';
import { PRIORITIES, CATEGORIES } from '../../config/config.js';
import { TICKET_STATUSES } from '../../core/state.js';
import { uuid } from '../../lib/ids.js';
import { nowIso } from '../../lib/time.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sync(ctx, io, flags) {
  if (flags.notes) {
    writeControl(ctx, 'flush.json');
    await sleep(flags.wait ? Number(flags.wait) : 300);
    io.println('note flush requested');
    return 0;
  }
  // Immediate reconciliation goes through the durable request queue (Task 10 transport); the CLI
  // submits the same request kind the dashboard uses.
  const request = { id: uuid(), kind: 'refresh', target_id: null, expected_revision: null, payload: {}, created_at: nowIso(), not_before: nowIso(), actor_id: 'cli' };
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'request', payload: request, source_identity: `request:${request.id}` }), { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
  if (ack.rejected) throw new TrackerError(ack.rejected, `refresh rejected: ${ack.rejected}`);
  io.println(`refresh request ${request.id} queued; the worker runs reconciliation within 5 s when idle. Worker: ${workerStatus(ctx).healthy ? 'healthy' : 'unavailable'}.`);
  return 0;
}

export function replayToStaging(ctx, into) {
  const j = new Journal(journalPath(ctx.env));
  const info = fs.existsSync(journalPath(ctx.env)) ? j.open() : { lastSequence: 0 };
  j.close();
  if (info.corrupt) throw new TrackerError('journal-corrupt', 'journal has mid-log corruption; recovery required');
  const state = createState({
    store_id: ctx.storeMeta.store_id, machine_id: ctx.storeMeta.owner_machine_id, machine_name: ctx.config.machine_name, store_name: ctx.storeMeta.store_name,
    timezone: ctx.storeMeta.timezone, key_prefix: ctx.config.key_prefix, stale_days: ctx.config.stale_days, sync_interval_hours: ctx.config.sync_interval_hours,
    approval_phrases_enabled: ctx.config.approval_phrases_enabled, projects: ctx.config.projects, repos: ctx.config.repos,
  });
  for (const ev of j.read()) applyEvent(state, ev);
  ensureDir(path.join(into, 'tickets'));
  ensureDir(path.join(into, 'sessions'));
  ensureDir(path.join(into, 'handoffs'));
  // Authored text comes from the live store when present; the journal rebuilds only generated content.
  let authoredRecovered = 0;
  let authoredMissing = 0;
  for (const t of state.tickets.values()) {
    const livePath = path.join(ctx.config.store_path, 'tickets', `${safeKeyFileName(t.key)}.md`);
    let authored = {};
    if (fs.existsSync(livePath)) { authored = parseNote(fs.readFileSync(livePath, 'utf8')).authored; authoredRecovered += 1; } else authoredMissing += 1;
    writeFileAtomic(path.join(into, 'tickets', `${safeKeyFileName(t.key)}.md`), renderTicketNote(t, { state, authored }));
  }
  for (const [key, s] of state.sessions) writeFileAtomic(path.join(into, 'sessions', `${snapshotFileName(key).replace(/\.json$/, '')}.md`), renderSessionNote(s, { state }));
  for (const h of state.handoffs.values()) writeFileAtomic(path.join(into, 'handoffs', `${h.id}.md`), renderHandoffNote(h, { state }));
  fs.copyFileSync(path.join(ctx.config.store_path, 'store.json'), path.join(into, 'store.json'));
  return { events: info.lastSequence, tickets: state.tickets.size, sessions: state.sessions.size, handoffs: state.handoffs.size, authoredRecovered, authoredMissing };
}

async function replay(ctx, io, flags) {
  if (!flags.into) throw new TrackerError('usage', 'usage: replay --into <staging-dir> [--switch]');
  const into = path.resolve(flags.into);
  if (fs.existsSync(into) && fs.readdirSync(into).length) throw new TrackerError('staging-not-empty', `staging directory ${into} is not empty`);
  const summary = replayToStaging(ctx, into);
  io.println(`replayed ${summary.events} event(s) into ${into}`);
  io.println(`tickets: ${summary.tickets}, sessions: ${summary.sessions}, handoffs: ${summary.handoffs}`);
  io.println(`authored sections recovered from the live store: ${summary.authoredRecovered}; tickets with no live note (generated content only): ${summary.authoredMissing}`);
  if (flags.switch) {
    if (workerStatus(ctx).healthy) throw new TrackerError('worker-running', 'stop the worker before switching stores (`tracker worker stop`)');
    const backup = `${ctx.config.store_path}.replaced-${nowIso().replace(/[:]/g, '-')}`;
    fs.renameSync(ctx.config.store_path, backup);
    fs.renameSync(into, ctx.config.store_path);
    io.println(`switched generations; previous store kept at ${backup}`);
  } else {
    io.println('live store unchanged; compare and re-run with --switch (worker stopped) to adopt the staging store');
  }
  return 0;
}

const IMPORTABLE = ['status', 'next_action', 'priority', 'due', 'blocker', 'title', 'category', 'summary', 'user_notes'];

function validateImport(fields) {
  if (fields.status !== undefined && !TICKET_STATUSES.includes(fields.status)) throw new TrackerError('status-invalid', `invalid status ${fields.status}`);
  if (fields.priority !== undefined && !PRIORITIES.includes(fields.priority)) throw new TrackerError('priority-invalid', `invalid priority ${fields.priority}`);
  if (fields.category !== undefined && !CATEGORIES.includes(fields.category)) throw new TrackerError('category-invalid', `invalid category ${fields.category}`);
  if (fields.due !== undefined && fields.due !== null && !isDate(fields.due)) throw new TrackerError('due-invalid', 'due must be YYYY-MM-DD');
  if (fields.status === 'blocked' && !(fields.blocker && String(fields.blocker).trim())) throw new TrackerError('blocker-required', 'blocked requires blocker text');
}

// Explicit import of supported generated-field changes made by hand in a note: creates journal
// events instead of silently absorbing the edit (TRD §Durability).
async function importNote(ctx, io, args, flags) {
  const [file] = args;
  if (!file) throw new TrackerError('usage', 'usage: import <ticket-note.md>');
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const parsed = parseNote(text);
  if (!parsed.frontmatter || !parsed.frontmatter.id) throw new TrackerError('note-invalid', 'note has no tracker frontmatter with an id');
  const current = latestTicketDetail(ctx, parsed.frontmatter.id);
  if (!current) throw new TrackerError('ticket-unknown', `ticket ${parsed.frontmatter.id} is not in the current projection`);
  const fields = {};
  for (const f of IMPORTABLE) {
    const incoming = parsed.frontmatter[f];
    if (incoming === undefined) continue;
    const normalizedIncoming = incoming === null ? (f === 'next_action' || f === 'summary' || f === 'user_notes' ? '' : null) : incoming;
    if (JSON.stringify(normalizedIncoming) !== JSON.stringify(current[f] ?? null)) fields[f] = normalizedIncoming;
  }
  // Authored sections live in the note itself; mirror them into the projection fields too.
  const summary = parsed.authored.summary.trim();
  const notes = parsed.authored.notes.trim();
  if (summary !== (current.summary ?? '')) fields.summary = summary;
  if (notes !== (current.user_notes ?? '')) fields.user_notes = notes;
  if (fields.status === 'blocked' && fields.blocker === undefined) fields.blocker = current.blocker;
  if (!Object.keys(fields).length) { io.println('no supported field changes to import'); return 0; }
  validateImport(fields);
  io.println(`importing: ${Object.keys(fields).join(', ')}`);
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'import', payload: { ticket_id: current.id, fields }, ticket_id: current.id }), { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
  if (ack.rejected) throw new TrackerError(ack.rejected, `import rejected: ${ack.rejected}`);
  writeControl(ctx, path.join('restore', `${current.id}.json`), { ticket_id: current.id });
  io.println(`imported ${Object.keys(fields).length} field(s) for ${current.key} as journal events; the note will be regenerated from the journal`);
  return 0;
}

async function note(ctx, io, args) {
  const [verb, key] = args;
  if (verb !== 'restore' || !key) throw new TrackerError('usage', 'usage: note restore <KEY>');
  validateKey(key);
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  io.println(`restoring generated blocks for ${ticket.key}; authored Summary/Notes are preserved, edited generated blocks are overwritten from the journal.`);
  writeControl(ctx, path.join('restore', `${ticket.id}.json`), { ticket_id: ticket.id });
  return 0;
}

export async function run({ command, args, flags, io, env }) {
  const ctx = loadContext(env);
  switch (command) {
    case 'sync': return sync(ctx, io, flags);
    case 'replay': return replay(ctx, io, flags);
    case 'import': return importNote(ctx, io, args, flags);
    case 'note': return note(ctx, io, args);
    default: throw new TrackerError('usage', 'unknown command');
  }
}
