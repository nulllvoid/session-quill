import { loadContext, workerStatus, latestSnapshot } from '../context.js';
import { statusLine, parseStatusInput, bindingFor } from '../statusline.js';
import { countIngress } from '../../core/ingress.js';
import fs from 'node:fs';
import { pausePath } from '../../runtime/readiness.js';

export async function run({ flags, io, env }) {
  const ctx = loadContext(env, { requireStore: false });
  if (flags.statusline) {
    let raw = '';
    try { raw = await io.readStdin(); } catch { raw = ''; }
    io.out(statusLine(ctx, parseStatusInput(raw)));
    return 0;
  }
  const session = flags.session ? { session_id: flags.session, agent_id: flags.agent ?? null } : null;
  const binding = ctx.initialized ? bindingFor(ctx, session) : null;
  const ws = ctx.initialized ? workerStatus(ctx) : { healthy: false, heartbeat_at: null };
  const snap = ctx.initialized ? latestSnapshot(ctx) : null;
  const sessionRecord = binding && snap ? snap.sessions.find((s) => s.id === binding.session_id) ?? null : null;
  const info = {
    initialized: ctx.initialized,
    paused: fs.existsSync(pausePath(env)),
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
  if (!ctx.initialized) { io.println('Session Quill is not initialized. Run /session-quill:start (or quill start).'); return 1; }
  io.println(`Store: ${ctx.storeMeta.store_name} (${ctx.config.store_path})`);
  io.println(`Worker: ${info.paused ? 'paused by you' : ws.healthy ? 'healthy' : 'unavailable'}${ws.heartbeat_at ? ` (heartbeat ${ws.heartbeat_at})` : ''}; ingress backlog: ${info.backlog}`);
  if (ctx.storeMeta.owner_machine_id !== ctx.machineId) io.println('This store belongs to another machine; this copy is read-only.');
  else if (info.paused || !ws.healthy) io.println('Run /session-quill:start (or quill start) to resume processing. Saved activity will catch up.');
  io.println(`Last sync: ${info.last_sync ?? 'never'}`);
  if (session) {
    if (binding && binding.ticket_id) io.println(`Session ${session.session_id}: bound to ${binding.ticket_key} (revision ${binding.binding_revision}, gate ${binding.gate_enabled ? 'on' : 'OFF'})`);
    else {
      io.println(`Session ${session.session_id}: no ticket linked${binding && binding.gate_enabled === false ? ' (gate OFF)' : ''}`);
      io.println('Choose the task before working: /session-quill:ticket work "<task title>" reuses or creates it; ticket bind <KEY> resumes a known task.');
    }
  }
  return 0;
}
