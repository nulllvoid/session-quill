// Migration run: inventory -> backup -> replayable migration events -> manifest; and rollback that
// restores settings and source notes while exporting newer quill events (TRD §Migration and rollout).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inventory } from './inventory.js';
import { backup, restoreBackup } from './backup.js';
import { makeEvent } from '../core/events.js';
import { writeIngress } from '../core/ingress.js';
import { Journal } from '../core/journal.js';
import { quillHome, journalPath, blobsDir, configPath } from '../lib/paths.js';
import { nowIso } from '../lib/time.js';
import { submitAndWait, workerStatus } from '../cli/context.js';

export function migrationsDir(env) {
  return path.join(quillHome(env), 'migrations');
}

function ticketPayload(t, projectId, projectName) {
  const m = t.mapped;
  return {
    id: m.id, key: m.key, title: m.title, project_id: projectId, project_name: projectName, category: m.category, priority: m.priority,
    parent_id: null, repo_id: null, due: m.due, jira: m.jira, status: m.status, blocker: m.blocker, next_action: m.next_action,
    summary: t.authored.summary ?? '', user_notes: t.authored.notes ?? '', aliases: [], validation_issues: [...new Set(t.issues)],
    prs: m.prs, deployments: m.deployments, last_activity: m.last_activity, created_at: m.created_at,
    source: { profile: 'pmla', path: t.rel, status: m.source_status },
  };
}

export async function runMigration(ctx, { sourceDir, profile, projectId, dryRun = false, backupDir = null, log = () => {} }) {
  const prefix = ctx.config.key_prefix ?? 'LOCAL';
  const inv = inventory(sourceDir, profile, { project_id: projectId, key_prefix: prefix });
  if (dryRun) return { dryRun: true, inventory: inv };
  const projectName = (ctx.config.projects[projectId] ?? {}).name ?? projectId;
  const j = new Journal(journalPath(ctx.env));
  const info = fs.existsSync(journalPath(ctx.env)) ? j.open() : { lastSequence: 0 };
  j.close();
  const dest = backupDir ?? path.join(quillHome(ctx.env), 'backups');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const bk = backup({
    paths: [
      { path: inv.source, role: 'source' },
      { path: settingsPath, role: 'settings' },
      { path: configPath(ctx.env), role: 'settings' },
      { path: journalPath(ctx.env), role: 'journal' },
      { path: blobsDir(ctx.env), role: 'blobs' },
    ],
    dest,
    label: 'pmla-migration',
  });
  log(`backup written to ${bk.dir} (${bk.entries.length} entries)`);
  const healthy = workerStatus(ctx).healthy;
  const byKey = new Map(inv.tickets.map((t) => [t.mapped.key, t]));
  const events = [];
  const submit = async (ev) => {
    if (healthy) {
      const ack = await submitAndWait(ctx, ev, { timeoutMs: 10_000 });
      return { event_id: ev.event_id, ack };
    }
    writeIngress(ev, ctx.env);
    return { event_id: ev.event_id, ack: null };
  };
  const base = { store_id: ctx.storeMeta.store_id, machine_id: ctx.machineId, producer: 'cli', occurred_at: nowIso() };
  for (const t of inv.tickets) {
    const ev = makeEvent({ ...base, kind: 'migration', payload: { ticket: ticketPayload(t, projectId, projectName) }, ticket_id: t.mapped.id, source_identity: `pmla:${t.rel}` });
    const r = await submit(ev);
    events.push({ path: t.rel, id: t.mapped.id, key: t.mapped.key, event_id: r.event_id, ack: r.ack ? (r.ack.duplicate ? 'duplicate' : r.ack.rejected ?? 'applied') : 'persisted' });
  }
  for (const t of inv.tickets) {
    if (!t.mapped.parent_key) continue;
    const parent = byKey.get(t.mapped.parent_key);
    if (!parent) continue;
    const ev = makeEvent({ ...base, kind: 'migration', payload: { ticket_id: t.mapped.id, fields: { parent_id: parent.mapped.id } }, ticket_id: t.mapped.id, source_identity: `pmla:${t.rel}:parent` });
    await submit(ev);
  }
  const manifestDir = migrationsDir(ctx.env);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `${nowIso().replace(/[:]/g, '-')}-pmla.json`);
  const manifest = {
    schema_version: 1, profile: profile.name, source: inv.source, project_id: projectId, created_at: nowIso(),
    journal_sequence_at_start: info.lastSequence, backup: { dir: bk.dir, manifest: bk.manifest, entries: bk.entries },
    tickets: events, ambiguous: inv.ambiguous.map((a) => ({ path: a.rel, issues: a.issues })), ignored: inv.ignored, worker_confirmed: healthy,
    notes: 'Original source files were not modified. Pause legacy PMLA hooks before enabling the quill gate; the settings snapshot in the backup restores them on rollback.',
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { dryRun: false, inventory: inv, manifestPath, manifest, backup: bk, workerConfirmed: healthy };
}

export function rollback(ctx, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = restoreBackup(manifest.backup.manifest, { roles: ['source', 'settings'] });
  const j = new Journal(journalPath(ctx.env));
  const newer = [];
  if (fs.existsSync(journalPath(ctx.env))) {
    j.open();
    for (const ev of j.read()) if (ev.sequence > (manifest.journal_sequence_at_start ?? 0)) newer.push(ev);
    j.close();
  }
  const exportPath = path.join(migrationsDir(ctx.env), `rollback-export-${nowIso().replace(/[:]/g, '-')}.jsonl`);
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, newer.map((e) => JSON.stringify(e)).join('\n') + (newer.length ? '\n' : ''));
  return { restored, exported: newer.length, exportPath, manifest };
}
