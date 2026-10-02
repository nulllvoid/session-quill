import { loadContext, sessionFromFlags, cliEvent, submitAndWait, latestSnapshot } from '../context.js';
import { readBindingSnapshot } from '../../hooks/binding-snapshot.js';
import { sessionKey } from '../../core/state.js';
import { TrackerError } from '../../lib/errors.js';

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

export async function run({ command, flags, io, env }) {
  const ctx = loadContext(env);
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
