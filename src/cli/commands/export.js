import path from 'node:path';
import readline from 'node:readline/promises';
import { loadContext, latestSnapshot } from '../context.js';
import { previewExport } from '../../export/sanitize.js';
import { writeStaticHtml } from '../../export/static.js';
import { nowIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

async function confirm(io) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Save this snapshot? [y/N]: ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function run({ flags, io, env }) {
  const ctx = loadContext(env);
  const snapshot = latestSnapshot(ctx);
  if (!snapshot) throw new TrackerError('no-snapshot', 'no published generation yet; start the worker once to publish projections');
  const options = { projects: flags.projects, fields: flags.fields, includeLinks: flags['include-links'] === true, includeCheckpoints: flags['include-checkpoints'] === true, exportedAt: nowIso() };
  const preview = previewExport(snapshot, options);
  const out = flags.out ? String(flags.out) : path.join(process.cwd(), `session-quill-snapshot-${options.exportedAt.replace(/[:]/g, '-')}.html`);
  io.println('Export preview (exact content of the snapshot):');
  io.println(`  projects: ${preview.projects.join(', ')}`);
  io.println(`  fields:   ${preview.fields.join(', ')}`);
  io.println(`  tickets:  ${preview.ticket_count}; sessions: ${preview.session_count}`);
  io.println(`  last sync shown: ${preview.last_sync ?? 'never'}; exported_at: ${options.exportedAt}`);
  io.println('  excluded:');
  for (const x of preview.excluded) io.println(`    - ${x}`);
  io.println(`  output:   ${out}`);
  io.println('This is a copy: it will not update, cannot be revoked after you share it, and nothing is uploaded or messaged.');
  if (flags.json) io.json(preview);
  const ok = flags.yes === true || (await confirm(io));
  if (!ok) {
    io.error('not saved: re-run with --yes to accept the preview (or confirm interactively in a terminal)');
    return 1;
  }
  const result = writeStaticHtml(snapshot, out, options);
  io.println(`saved ${result.path} (${result.bytes} bytes)`);
  return 0;
}
