// `quill mirror status|open|write`: the read-only copy for other machines. status and open work on
// any machine that can see the mirror folder; write (owner only) refreshes it now.
import path from 'node:path';
import { loadContext, latestSnapshot } from '../context.js';
import { mirrorSettings, readMirror, writeMirror, MIRROR_DIRNAME } from '../../mirror/mirror.js';
import { openInBrowser } from './ui.js';
import { nowIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const USAGE = 'usage: mirror status|open [--dir <folder>] [--json] | mirror write';

function ago(ms) {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} days ago`;
}

function mirrorDir(ctx, flags) {
  if (typeof flags.dir === 'string') return path.resolve(flags.dir);
  const s = mirrorSettings(ctx.config);
  if (s.dir) return s.dir;
  throw new TrackerError('mirror-unknown', `no mirror folder known on this machine; pass --dir <synced store>/${MIRROR_DIRNAME}`);
}

export async function run({ args, flags, io, env }) {
  const [verb = 'status'] = args;
  const ctx = loadContext(env, { requireStore: false });
  if (verb === 'write') {
    if (!ctx.initialized) throw new TrackerError('not-initialized', 'only the machine that owns the store writes its mirror');
    if (ctx.storeMeta.owner_machine_id !== ctx.machineId) throw new TrackerError('not-owner', 'this machine does not own the store; its copy is read-only. Use quill mirror open here instead.');
    const settings = mirrorSettings(ctx.config);
    if (!settings.dir) throw new TrackerError('mirror-unknown', 'set [mirror] path, or a store_path, first');
    const snap = latestSnapshot(ctx);
    if (!snap) throw new TrackerError('no-snapshot', 'no published generation yet; start the worker once');
    const info = writeMirror(snap, settings, { now: nowIso(), machineName: ctx.config.machine_name ?? null, storeId: ctx.storeMeta.store_id });
    io.println(`Mirror written to ${settings.dir} (${info.ticket_count} tickets, generation ${info.generation_id}).${settings.enabled ? '' : ' The worker keeps it current only with [mirror] enabled = true.'}`);
    return 0;
  }
  if (verb !== 'status' && verb !== 'open') throw new TrackerError('usage', USAGE);
  const dir = mirrorDir(ctx, flags);
  const m = readMirror(dir, { now: nowIso() });
  if (!m) throw new TrackerError('mirror-missing', `no mirror in ${dir}. On the owner machine set [mirror] enabled = true in config.toml (or run quill mirror write), then let your sync tool copy the folder.`);
  if (flags.json) { io.json(m); return 0; }
  io.println(`Mirror in ${dir}: written ${ago(m.age_ms)}${m.machine_name ? ` by ${m.machine_name}` : ''}, ${m.ticket_count} tickets, generation ${m.generation_id}${m.fresh ? '' : ' (stale: is the owner\'s worker running and the folder syncing?)'}.`);
  if (verb === 'open') {
    if (!m.has_dashboard) throw new TrackerError('mirror-incomplete', 'the mirror has no dashboard.html yet; wait for the sync to finish');
    const opened = await openInBrowser(m.dashboard);
    io.println(opened ? `Opened ${m.dashboard} (read-only).` : `Open ${m.dashboard} in a browser (read-only).`);
  }
  return 0;
}
