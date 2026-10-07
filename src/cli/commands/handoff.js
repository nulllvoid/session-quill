import fs from 'node:fs';
import path from 'node:path';
import { loadContext, cliEvent, submitAndWait, findTicketByKey, latestSnapshot } from '../context.js';
import { validateHandoffRequest, MODES } from '../../handoff/permissions.js';
import { uuid } from '../../lib/ids.js';
import { nowIso } from '../../lib/time.js';
import { requestsDir, handoffsDir } from '../../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../../lib/atomic-fs.js';
import { TrackerError } from '../../lib/errors.js';
import { bodyHash } from '../../server/requests.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTerminal(ctx, requestId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = readJsonIfExists(path.join(requestsDir(ctx.env), `${requestId}.json`));
    if (r && ['applied', 'conflict', 'failed', 'cancelled'].includes(r.state)) return r;
    await sleep(100);
  }
  return null;
}

export async function submitCliRequest(ctx, io, body, flags) {
  const id = uuid();
  const now = nowIso();
  const request = { id, kind: body.kind, target_id: body.target_id, expected_revision: body.expected_revision, payload: body.payload, created_at: now, not_before: now, actor_id: 'cli', retry_of: body.retry_of ?? null, body_hash: bodyHash(body) };
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'request', payload: request, ticket_id: body.target_id, source_identity: `request:${id}` }), { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
  if (ack.rejected) throw new TrackerError(ack.rejected, `request rejected: ${ack.rejected}`);
  const terminal = await waitTerminal(ctx, id, flags.timeout ? Number(flags.timeout) : 10_000);
  if (!terminal) throw new TrackerError('request-pending', `request ${id} is persisted but not yet applied; check \`quill handoff list\``);
  return terminal;
}

async function queue(ctx, io, args, flags) {
  const [key] = args;
  if (!key) throw new TrackerError('usage', 'usage: handoff <KEY> [--mode m] [--note text] [--read-source] [--edit-source] [--commit] [--push-branch <branch>] [--draft-pr] [--retry-of <handoff-id>]');
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const repo = ticket.repo_id && ctx.config.repos[ticket.repo_id] ? { id: ticket.repo_id, ...ctx.config.repos[ticket.repo_id] } : null;
  const mode = flags.mode ?? 'analyse-followups';
  if (!MODES.includes(mode)) throw new TrackerError('mode-invalid', `mode must be one of ${MODES.join(', ')}`);
  const permissions = {
    read_source: flags['read-source'] === true || flags['edit-source'] === true || mode === 'attempt-fix',
    edit_source: flags['edit-source'] === true || mode === 'attempt-fix',
    commit: flags.commit === true,
    push_branch: typeof flags['push-branch'] === 'string',
    open_draft_pr: flags['draft-pr'] === true,
  };
  // Runs from the terminal use the owner's Claude Code settings unless --access says otherwise (ADR 0017).
  const access = typeof flags.access === 'string' ? flags.access : 'settings';
  const payload = validateHandoffRequest({ mode, note: flags.note ?? '', permissions, access, branch: typeof flags['push-branch'] === 'string' ? flags['push-branch'] : null }, { repo });
  if (access === 'full') io.println('! Full access: this run skips every permission check and can run any command, use connectors and push with your credentials.');
  const terminal = await submitCliRequest(ctx, io, { kind: 'handoff', target_id: ticket.id, expected_revision: ticket.revision, payload, retry_of: flags['retry-of'] ?? null }, flags);
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `handoff request ${terminal.state}: ${err.message ?? ''}${terminal.result && terminal.result.existing_handoff_id ? ` (existing run ${terminal.result.existing_handoff_id})` : ''}`);
  }
  io.println(`Handoff ${terminal.result.handoff_id} queued for ${ticket.key} (${payload.mode}; permissions: ${Object.entries(payload.permissions).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}).`);
  io.println('Request accepted is not execution complete: follow progress with `quill handoff list` or the dashboard. Execution is capped at 20 minutes.');
  if (flags.json) io.json(terminal);
  return 0;
}

function list(ctx, io, flags) {
  const snap = latestSnapshot(ctx);
  const handoffs = snap ? [...snap.handoffs].sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1)) : [];
  if (flags.json) { io.json(handoffs); return 0; }
  if (!handoffs.length) { io.println('No handoffs.'); return 0; }
  for (const h of handoffs) {
    const t = snap.tickets.find((x) => x.id === h.ticket_id);
    io.println(`${h.id}  ${h.state.padEnd(10)} ${h.mode.padEnd(18)} ${t ? t.key : h.ticket_id}  requested ${h.requested_at}${h.error && h.error.code ? `  error: ${h.error.code}` : ''}${h.children_ids && h.children_ids.length ? `  children: ${h.children_ids.length}` : ''}`);
  }
  return 0;
}

async function cancel(ctx, io, args, flags) {
  const [id] = args;
  const snap = latestSnapshot(ctx);
  const h = snap ? snap.handoffs.find((x) => x.id === id || x.id.startsWith(id ?? '')) : null;
  if (!h) throw new TrackerError('handoff-unknown', `unknown handoff ${id}`);
  const ticket = snap.tickets.find((x) => x.id === h.ticket_id);
  const terminal = await submitCliRequest(ctx, io, { kind: 'handoff-cancel', target_id: h.ticket_id, expected_revision: ticket ? ticket.revision : null, payload: { handoff_id: h.id } }, flags);
  if (terminal.state !== 'applied') throw new TrackerError(terminal.error ? terminal.error.code : terminal.state, `cancellation ${terminal.state}: ${terminal.error ? terminal.error.message : ''}`);
  io.println(`Cancellation recorded for handoff ${h.id}; partial results and logs are preserved.`);
  return 0;
}

// `quill handoff result <id> --json <file>`: an agent (or operator) hands back a structured result.
function result(ctx, io, args, flags) {
  const [id] = args;
  if (!id || !flags.json || flags.json === true) throw new TrackerError('usage', 'usage: handoff result <handoff-id> --json <file>');
  const payload = JSON.parse(fs.readFileSync(path.resolve(String(flags.json)), 'utf8'));
  const dir = path.join(handoffsDir(ctx.env), 'results');
  writeJsonAtomic(path.join(dir, `${id}.result.json`), { summary: payload.summary ?? null, next_action: payload.next_action ?? null, blocker: payload.blocker ?? null, children: payload.children ?? [], test_results: payload.test_results ?? [], changed_files: payload.changed_files ?? [] });
  io.println(`result recorded for handoff ${id}; the worker attaches it when the run finishes`);
  return 0;
}

export async function run({ args, flags, io, env }) {
  const ctx = loadContext(env);
  const [verb, ...rest] = args;
  if (verb === 'list') return list(ctx, io, flags);
  if (verb === 'cancel') return cancel(ctx, io, rest, flags);
  if (verb === 'result') return result(ctx, io, rest, flags);
  return queue(ctx, io, args, flags);
}
