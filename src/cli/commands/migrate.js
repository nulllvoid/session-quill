import path from 'node:path';
import readline from 'node:readline/promises';
import { loadContext } from '../context.js';
import { loadProfile } from '../../migrate/pmla.js';
import { runMigration, rollback } from '../../migrate/run.js';
import { TrackerError } from '../../lib/errors.js';

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

function printInventory(io, inv) {
  io.println(`source: ${inv.source}`);
  io.println(`${inv.counts.total} ticket(s) mapped, ${inv.counts.ambiguous} ambiguous, ${inv.counts.ignored} file(s) ignored (no frontmatter)`);
  io.println(`by status: ${Object.entries(inv.counts.by_status).map(([s, n]) => `${s}=${n}`).join(', ') || 'none'}`);
  for (const t of inv.tickets) {
    io.println(`  ${t.mapped.key.padEnd(40)} ${t.mapped.status.padEnd(15)} ${t.mapped.title}${t.mapped.parent_key ? `  (parent ${t.mapped.parent_key})` : ''}${t.mapped.deployments.length ? `  deployments: ${t.mapped.deployments.map((d) => d.state).join('/')}` : ''}${t.issues.length ? `  issues: ${t.issues.join(', ')}` : ''}`);
  }
  if (inv.ambiguous.length) {
    io.println('ambiguous records (imported with validation issues; review after import):');
    for (const a of inv.ambiguous) io.println(`  ${a.rel}: ${a.issues.join(', ')}`);
  }
  for (const f of inv.ignored) io.println(`  ignored: ${f}`);
}

export async function run({ args, flags, io, env }) {
  const ctx = loadContext(env);
  if (args[0] === 'rollback') {
    if (!flags.manifest) throw new TrackerError('usage', 'usage: migrate rollback --manifest <migration-manifest.json> [--yes]');
    const ok = flags.yes === true || (await confirm('Restore source notes and settings from the migration backup and export newer tracker events?'));
    if (!ok) { io.error('rollback not performed'); return 1; }
    const r = rollback(ctx, path.resolve(String(flags.manifest)));
    io.println(`restored ${r.restored.length} backup entr${r.restored.length === 1 ? 'y' : 'ies'} (source notes and settings); journal and blobs left intact`);
    io.println(`exported ${r.exported} newer tracker event(s) to ${r.exportPath} for reconciliation`);
    io.println('Re-enable the legacy hooks from the restored settings yourself; the tracker worker keeps running until you stop it.');
    return 0;
  }
  if (!flags.source) throw new TrackerError('usage', 'usage: migrate --source <dir> [--profile pmla] [--project <id>] [--dry-run] [--backup <dir>] [--yes]');
  const profile = loadProfile(flags.profile ?? 'pmla');
  const projectId = flags.project ?? ctx.config.default_project ?? Object.keys(ctx.config.projects)[0];
  if (!projectId) throw new TrackerError('project-required', 'pass --project <id> (configure projects with tracker init)');
  const dryRun = flags['dry-run'] === true;
  if (dryRun) {
    const r = await runMigration(ctx, { sourceDir: String(flags.source), profile, projectId, dryRun: true });
    printInventory(io, r.inventory);
    io.println('dry run: no files written, no events created, no backup taken.');
    return 0;
  }
  const preview = await runMigration(ctx, { sourceDir: String(flags.source), profile, projectId, dryRun: true });
  printInventory(io, preview.inventory);
  io.println('Import will: back up source notes, hooks/settings, journal and blobs; create one replayable migration event per note; leave every original file in place.');
  const ok = flags.yes === true || (await confirm('Proceed with import?'));
  if (!ok) { io.error('import not performed (re-run with --yes to accept the preview)'); return 1; }
  const r = await runMigration(ctx, { sourceDir: String(flags.source), profile, projectId, dryRun: false, backupDir: flags.backup ? path.resolve(String(flags.backup)) : null, log: (m) => io.println(m) });
  io.println(`imported ${r.inventory.counts.total} ticket(s) as migration events${r.workerConfirmed ? ' (worker confirmed)' : ' (persisted in ingress; the worker applies them when running)'}`);
  io.println(`manifest: ${r.manifestPath}`);
  io.println('Verify counts, links, checkpoints and deployment obligations in the dashboard; keep the legacy dashboard read-only for at least a week before retiring it.');
  return 0;
}
