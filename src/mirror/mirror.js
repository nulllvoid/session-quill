// Read-only mirror for other machines (PRD: one machine writes a store; copies elsewhere are
// read-only). The owner's worker keeps a sanitized snapshot and a standalone dashboard in a folder
// that the owner syncs however they like (OneDrive, Dropbox, Syncthing, a git repository). Any
// machine can open it; nothing on the other machine writes to the store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStaticHtml } from '../export/static.js';
import { sanitizeSnapshot, isExportableTicket } from '../export/sanitize.js';
import { writeFileAtomic, readJsonIfExists, ensureDir } from '../lib/atomic-fs.js';
import { ageMs } from '../lib/time.js';

export const MIRROR_DIRNAME = '.quill-mirror';
const MIN_INTERVAL_MS = 30_000;

export function mirrorSettings(config = {}) {
  const m = config.mirror && typeof config.mirror === 'object' ? config.mirror : {};
  const raw = typeof m.path === 'string' ? m.path.trim() : '';
  const expanded = /^~(?=$|[\\/])/.test(raw) ? path.join(os.homedir(), raw.slice(1)) : raw;
  const dir = expanded ? path.resolve(expanded) : config.store_path ? path.join(config.store_path, MIRROR_DIRNAME) : null;
  const seconds = Number.isFinite(m.interval_seconds) ? m.interval_seconds : 60;
  return {
    enabled: m.enabled === true && !!dir,
    dir,
    interval_ms: Math.max(MIN_INTERVAL_MS, seconds * 1000),
    projects: Array.isArray(m.projects) && m.projects.length ? m.projects.filter((p) => typeof p === 'string') : null,
    include_links: m.include_links === true,
  };
}

export function writeMirror(snapshot, settings, { now, machineName = null, storeId = null }) {
  const options = { exportedAt: now, projects: settings.projects, includeLinks: settings.include_links, includeCheckpoints: false };
  ensureDir(settings.dir);
  writeFileAtomic(path.join(settings.dir, 'dashboard.html'), buildStaticHtml(snapshot, options));
  writeFileAtomic(path.join(settings.dir, 'snapshot.json'), JSON.stringify(sanitizeSnapshot(snapshot, options)));
  const info = { schema_version: 1, written_at: now, generation_id: snapshot.generation_id, generated_at: snapshot.generated_at, machine_name: machineName, store_id: storeId, ticket_count: snapshot.tickets.filter((t) => isExportableTicket(t) && (!settings.projects || settings.projects.includes(t.project_id))).length };
  // mirror.json last: a reader that sees it knows the files it describes are complete.
  writeFileAtomic(path.join(settings.dir, 'mirror.json'), JSON.stringify(info, null, 2));
  return info;
}

export function readMirror(dir, { now }) {
  const info = readJsonIfExists(path.join(dir, 'mirror.json'));
  if (!info) return null;
  const age = ageMs(info.written_at, now);
  return { ...info, dir, dashboard: path.join(dir, 'dashboard.html'), age_ms: age, fresh: age < 15 * 60_000, has_dashboard: fs.existsSync(path.join(dir, 'dashboard.html')) };
}

// Worker extension: rewrite the mirror when a new generation exists, at most once per interval,
// and once more when the worker stops so the copy ends current.
export function createExtension(ctx) {
  let lastGeneration = null;
  let lastAt = 0;
  const write = (w, reason) => {
    const settings = mirrorSettings(w.config);
    if (!settings.enabled) return;
    const snap = w.lastSnapshot;
    if (!snap || snap.generation_id === lastGeneration) return;
    try {
      writeMirror(snap, settings, { now: w.now(), machineName: w.config.machine_name ?? null, storeId: ctx.storeMeta ? ctx.storeMeta.store_id : null });
      lastGeneration = snap.generation_id;
      lastAt = w.clock();
    } catch (err) {
      w.log(`mirror (${reason}) failed: ${err.message}`);
    }
  };
  return {
    tick(w) {
      if (w.clock() - lastAt < mirrorSettings(w.config).interval_ms) return;
      write(w, 'tick');
    },
    async onStop(w) { write(w, 'stop'); },
  };
}
