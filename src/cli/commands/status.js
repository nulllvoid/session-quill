import { loadContext, workerStatus, latestSnapshot } from '../context.js';
import { readBindingSnapshot } from '../../hooks/binding-snapshot.js';
import { sessionKey } from '../../core/state.js';
import { countIngress } from '../../core/ingress.js';

function bindingFor(ctx, session) {
  if (!session) return null;
  return readBindingSnapshot(sessionKey(session), ctx.env);
}

export async function run({ flags, io, env }) {
  const ctx = loadContext(env, { requireStore: false });
  if (flags.statusline) {
    let input = {};
    try { input = JSON.parse((await io.readStdin()) || '{}'); } catch { input = {}; }
    if (!ctx.initialized) { io.out('⌁ tracker: not initialized'); return 0; }
    const session = input.session_id ? { session_id: input.session_id, agent_id: null } : null;
    const b = bindingFor(ctx, session);
    const ws = workerStatus(ctx);
    const warn = ws.healthy ? '' : ' ⚠ worker';
    if (b && b.ticket_id) io.out(`⌁ ${b.ticket_key} ${b.ticket_title ?? ''}${b.gate_enabled === false ? ' (gate off)' : ''}${warn}`.trim());
    else io.out(`⌁ unbound${b && b.gate_enabled === false ? ' (gate off)' : ''}${warn}`);
    return 0;
  }
  const session = flags.session ? { session_id: flags.session, agent_id: flags.agent ?? null } : null;
  const binding = ctx.initialized ? bindingFor(ctx, session) : null;
  const ws = ctx.initialized ? workerStatus(ctx) : { healthy: false, heartbeat_at: null };
  const snap = ctx.initialized ? latestSnapshot(ctx) : null;
  const sessionRecord = binding && snap ? snap.sessions.find((s) => s.id === binding.session_id) ?? null : null;
  const info = {
    initialized: ctx.initialized,
    store: ctx.storeMeta ? { store_id: ctx.storeMeta.store_id, store_name: ctx.storeMeta.store_name, path: ctx.config.store_path, owner_machine_id: ctx.storeMeta.owner_machine_id, this_machine_id: ctx.machineId } : null,
    session,
    binding,
    session_record: sessionRecord,
    worker: ws,
    backlog: ctx.initialized ? countIngress(ctx.env) : 0,
    last_sync: snap ? snap.meta.last_sync : null,
    generation: snap ? snap.generation_id : null,
  };
  if (flags.json) { io.json({ ...info, session: sessionRecord ?? session }); return 0; }
  if (!ctx.initialized) { io.println('Session Tracker is not initialized. Run `tracker init`.'); return 1; }
  io.println(`Store: ${ctx.storeMeta.store_name} (${ctx.config.store_path})`);
  io.println(`Worker: ${ws.healthy ? 'healthy' : 'unavailable'}${ws.heartbeat_at ? ` (heartbeat ${ws.heartbeat_at})` : ''}; ingress backlog: ${info.backlog}`);
  io.println(`Last sync: ${info.last_sync ?? 'never'}`);
  if (session) {
    if (binding && binding.ticket_id) io.println(`Session ${session.session_id}: bound to ${binding.ticket_key} (revision ${binding.binding_revision}, gate ${binding.gate_enabled ? 'on' : 'OFF'})`);
    else io.println(`Session ${session.session_id}: unbound${binding && binding.gate_enabled === false ? ' (gate OFF)' : ''}`);
  }
  return 0;
}
