import { loadContext, sessionFromFlags, cliEvent, submitAndWait, latestSnapshot } from '../context.js';
import { readBindingSnapshot } from '../../hooks/binding-snapshot.js';
import { sessionKey } from '../../core/state.js';
import { TrackerError } from '../../lib/errors.js';
import { submitCliRequest } from './handoff.js';

function currentCheckpoint(ctx, session, explicitId) {
  const binding = readBindingSnapshot(sessionKey(session), ctx.env);
  if (!binding || !binding.session_id) throw new TrackerError('session-unknown', `session ${session.session_id} is unknown to the quill`);
  if (!binding.ticket_id) throw new TrackerError('no-checkpoint', 'session is not bound to a ticket');
  const snap = latestSnapshot(ctx);
  const checkpoints = (snap ? snap.checkpoints : []).filter((c) => c.session_id === binding.session_id && c.complete);
  if (explicitId) {
    const cp = checkpoints.find((c) => c.id === explicitId || c.id.startsWith(explicitId));
    if (!cp) throw new TrackerError('no-checkpoint', `checkpoint ${explicitId} is unknown, incomplete, or belongs to another session`);
    if (cp.ticket_id !== binding.ticket_id) throw new TrackerError('checkpoint-mismatch', 'checkpoint belongs to a different ticket than the current binding');
    return { cp, binding };
  }
  const eligible = checkpoints.filter((c) => c.ticket_id === binding.ticket_id && c.binding_revision === binding.binding_revision);
  eligible.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : (b.sequence ?? 0) - (a.sequence ?? 0)));
  if (!eligible.length) throw new TrackerError('no-checkpoint', 'no complete checkpoint exists for the current binding (a Stop hook must have captured one)');
  return { cp: eligible[0], binding };
}

// Runs proposed from a shared page (ADR 0025): `approve --run` lists the open ones, `approve --run
// <id>` queues one as an ordinary run, and `dismiss --run <id>` dismisses it. A unique id prefix is enough.
async function proposedRun(ctx, command, flags, io) {
  const snap = latestSnapshot(ctx);
  const open = ((snap && snap.run_proposals) || []).filter((p) => p.state === 'proposed').sort((a, b) => (a.proposed_at < b.proposed_at ? -1 : 1));
  if (flags.run === true) {
    if (flags.json) { io.json(open); return 0; }
    if (!open.length) { io.println('No proposed runs. A Run agent pick on a two-way page appears here after its next publish.'); return 0; }
    for (const p of open) io.println(`${p.id.slice(0, 8)}  ${String(p.ticket_key ?? '?').padEnd(12)} ${p.recipe.name.padEnd(18)} ${p.access.padEnd(9)} ${String(p.editor ?? 'unknown editor').padEnd(16)} ${p.publisher}  ${p.proposed_at}`);
    io.println('Approve with `quill approve --run <id>`, or dismiss with `quill dismiss --run <id>`.');
    return 0;
  }
  const prefix = String(flags.run).toLowerCase();
  const matches = open.filter((p) => p.id.startsWith(prefix));
  if (!matches.length) throw new TrackerError('proposal-unknown', `no open proposed run starts with ${prefix}; list them with \`quill approve --run\``);
  if (matches.length > 1) throw new TrackerError('proposal-ambiguous', `${prefix} matches ${matches.length} proposed runs; give more of the id`);
  const p = matches[0];
  const kind = command === 'approve' ? 'approve-run' : 'dismiss-run';
  const terminal = await submitCliRequest(ctx, io, { kind, target_id: p.ticket_id, expected_revision: null, payload: { proposal_id: p.id } }, flags);
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `${command} ${terminal.state}: ${err.message ?? ''}`);
  }
  if (kind === 'approve-run') io.println(`Approved the proposed ${p.recipe.name} run on ${p.ticket_key}; run ${terminal.result.handoff_id.slice(0, 8)} is queued (${p.access} access). Its results arrive as suggestions.`);
  else io.println(`Dismissed the proposed ${p.recipe.name} run on ${p.ticket_key}.`);
  return 0;
}

export async function run({ command, flags, io, env }) {
  const ctx = loadContext(env);
  if (flags.run !== undefined) return proposedRun(ctx, command, flags, io);
  const session = sessionFromFlags(flags, env);
  const { cp, binding } = currentCheckpoint(ctx, session, flags.checkpoint ?? null);
  if (command === 'approve') {
    if (cp.approved_at) {
      io.println(`Checkpoint ${cp.id.slice(0, 8)} already approved at ${cp.approved_at} (${cp.approval_provenance}). Approval is idempotent.`);
      return 0;
    }
    const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'approve', payload: { checkpoint_id: cp.id, ticket_id: binding.ticket_id, provenance: 'explicit' }, session, ticket_id: binding.ticket_id, source_identity: `approve:${cp.id}:${binding.ticket_id}` }), { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
    if (ack.rejected) throw new TrackerError(ack.rejected, `approval rejected: ${ack.rejected}`);
    io.println(`Approved checkpoint ${cp.id.slice(0, 8)} for ${binding.ticket_key} (explicit). Recorded approval is not permission to commit, push or deploy.`);
    return 0;
  }
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'dismiss', payload: { checkpoint_id: cp.id }, session, ticket_id: binding.ticket_id, source_identity: `dismiss:${cp.id}` }), { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
  if (ack.rejected) throw new TrackerError(ack.rejected, `dismiss rejected: ${ack.rejected}`);
  io.println(`Dismissed checkpoint ${cp.id.slice(0, 8)}; it stays retrievable but no longer counts as unpromoted.`);
  return 0;
}
