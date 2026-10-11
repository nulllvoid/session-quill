// `quill tracker import` reads the issues assigned to you into tickets (ADR 0024).
// `quill tracker push <KEY>`: write one ticket's status (and optionally a comment) to its issue
// in the user's tracker (ADR 0018). Off unless config.toml sets [tracker] write_back = true; without
// --confirm it only shows what it would send.
import { loadContext, findTicketByKey, latestTicketDetail, cliEvent, submitAndWait, latestSnapshot, workerStatus } from '../context.js';
import { resolveTracker } from '../../config/config.js';
import { createTrackerClient, syncSettings, writeSettings, targetStatus, linkedTo } from '../../tracker/client.js';
import { planImport, importProject, importSourceIdentity, IMPORT_LIMIT } from '../../onboard/import.js';
import { writeIngress } from '../../core/ingress.js';
import { nowIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const USAGE = 'usage: tracker push <KEY> [--to "<remote status>"] [--comment "<text>"] [--confirm] [--json] | tracker import [--json]';

export async function push(ctx, io, args, flags, { fetchImpl } = {}) {
  const [key] = args;
  if (!key) throw new TrackerError('usage', USAGE);
  const raw = ctx.config.tracker;
  const settings = writeSettings(raw);
  if (!settings.enabled) throw new TrackerError('write-back-off', 'tracker write-back is off. To allow it, set write_back = true in the [tracker] table of your config.toml (a repository .quill.toml cannot turn it on). Each push is still previewed and needs --confirm.');
  const tracker = resolveTracker(ctx.config, null);
  if (!tracker || !['jira', 'github', 'linear'].includes(tracker.system)) throw new TrackerError('tracker-unsupported', 'write-back needs [tracker] system = "jira", "github" or "linear" in config.toml');
  const found = findTicketByKey(ctx, key);
  if (!found) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const ticket = latestTicketDetail(ctx, found.id) ?? found;
  if (!linkedTo(ticket, tracker)) throw new TrackerError('not-linked', `${ticket.key} is not linked to an issue on your ${tracker.system} tracker; link it with ticket relink ${ticket.key} --external <KEY>`);
  const issueKey = ticket.external.key;
  const to = typeof flags.to === 'string' ? flags.to.trim() : targetStatus(tracker.system, ticket.status, settings);
  const comment = typeof flags.comment === 'string' ? flags.comment : null;
  if (!to && !comment) throw new TrackerError('target-required', `no ${tracker.system} status is mapped to "${ticket.status}"; pass --to "<remote status>" or add it to [tracker.status_map]`);

  const client = createTrackerClient({ tracker, settings: syncSettings(raw), env: ctx.env, ...(fetchImpl ? { fetchImpl } : {}) });
  const current = await client.fetchIssue(issueKey);
  const statusChange = to && String(current.status ?? '').toLowerCase() !== to.toLowerCase() ? { from: current.status, to } : null;
  const plan = { system: tracker.system, issue: issueKey, url: ticket.external.url ?? null, ticket: ticket.key, quill_status: ticket.status, remote_status: current.status, status_change: statusChange, comment };

  if (!flags.confirm) {
    if (flags.json) { io.json({ preview: true, ...plan }); return 0; }
    io.println(`Preview: nothing has been sent to ${tracker.system}.`);
    io.println(`  issue ${issueKey}${plan.url ? ` (${plan.url})` : ''}, now "${current.status ?? 'unknown'}"; ticket ${ticket.key} is ${ticket.status}`);
    io.println(statusChange ? `  would move it to "${to}"` : to ? `  status already "${current.status}"; no change` : '  status unchanged');
    if (comment) io.println(`  would add a comment: ${comment.slice(0, 200)}${comment.length > 200 ? '…' : ''}`);
    io.println(statusChange || comment ? `Send it with: quill tracker push ${ticket.key}${flags.to ? ` --to "${to}"` : ''}${comment ? ' --comment "…"' : ''} --confirm` : 'Nothing to send.');
    return 0;
  }

  if (!statusChange && !comment) { io.println(`${issueKey} is already "${current.status}"; nothing sent.`); return 0; }
  let error = null;
  try {
    if (statusChange) await client.setStatus(issueKey, to);
    if (comment) await client.addComment(issueKey, comment);
  } catch (err) {
    error = err.message;
  }
  const ev = cliEvent(ctx, { kind: 'tracker-push', payload: { ticket_id: ticket.id, system: tracker.system, key: issueKey, from: statusChange ? statusChange.from : null, to: statusChange ? to : null, comment: !!comment, ok: !error, error }, session: null, ticket_id: ticket.id });
  await submitAndWait(ctx, ev, { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
  if (error) throw new TrackerError('push-failed', `${tracker.system} ${issueKey}: ${error}`);
  if (flags.json) { io.json({ sent: true, ...plan }); return 0; }
  io.println(`Sent to ${tracker.system} ${issueKey}:${statusChange ? ` status "${statusChange.from ?? 'unknown'}" → "${to}"` : ''}${statusChange && comment ? ',' : ''}${comment ? ' comment added' : ''}.`);
  return 0;
}

// `quill tracker import`: one assigned-issue import now (ADR 0024), the same step tracker-sync runs
// when [tracker] import_assigned = true. Read only on the tracker; idempotent in the store.
export async function importNow(ctx, io, flags, { fetchImpl } = {}) {
  const tracker = resolveTracker(ctx.config, null);
  if (!tracker || !['jira', 'github'].includes(tracker.system)) throw new TrackerError('tracker-unsupported', 'importing assigned issues needs [tracker] system = "jira" or "github" (with domain, and repo for GitHub) in config.toml');
  const project = importProject(ctx.config);
  if (!project) throw new TrackerError('project-required', 'no project configured; run quill init first');
  const client = createTrackerClient({ tracker, settings: syncSettings(ctx.config.tracker), env: ctx.env, ...(fetchImpl ? { fetchImpl } : {}) });
  const issues = await client.searchAssigned({ limit: IMPORT_LIMIT });
  const known = latestSnapshot(ctx)?.tickets ?? [];
  const plan = planImport(issues, { tracker, tickets: known, storeId: ctx.storeMeta.store_id, projectId: project.id, projectName: project.name, category: ctx.config.default_category || 'research', now: nowIso() });
  const live = workerStatus(ctx).healthy;
  const created = [];
  const existing = [...plan.existing];
  const collisions = [...plan.collisions];
  for (const ticket of plan.create) {
    const ev = cliEvent(ctx, { kind: 'ticket-create', payload: { ticket }, session: null, ticket_id: ticket.id, source_identity: importSourceIdentity(ticket.key) });
    // Without a worker the events wait in ingress and apply when it starts.
    if (!live) { writeIngress(ev, ctx.env); created.push(ticket); continue; }
    const ack = await submitAndWait(ctx, ev, { timeoutMs: flags.timeout ? Number(flags.timeout) : 10_000 });
    if (ack.duplicate || ack.rejected === 'ticket-exists') existing.push(ticket.key);
    else if (ack.rejected === 'key-collision') collisions.push({ key: ticket.key, ticket_key: ticket.key });
    else if (ack.rejected) throw new TrackerError(ack.rejected, `import of ${ticket.key} rejected: ${ack.rejected}`);
    else created.push(ticket);
  }
  if (flags.json) { io.json({ system: tracker.system, imported: created.map((t) => ({ key: t.key, title: t.title, url: t.external.url })), existing, collisions, pending: !live }); return 0; }
  if (!created.length) io.println(`No new assigned issues on ${tracker.system}${existing.length ? ` (${existing.length} already tracked)` : ''}.`);
  else {
    io.println(`Imported ${created.length} assigned issue${created.length === 1 ? '' : 's'} from ${tracker.system}${live ? '' : ' (the worker is not running; they apply when it starts)'}:`);
    for (const t of created) io.println(`  ${t.key}  ${t.title}`);
    if (existing.length) io.println(`${existing.length} already tracked.`);
  }
  for (const c of collisions) io.println(`! ${c.key} was not imported: ticket ${c.ticket_key} already uses that key for another issue`);
  return 0;
}

export async function run({ args, flags, io, env }) {
  const [verb, ...rest] = args;
  const ctx = loadContext(env);
  if (verb === 'push') return push(ctx, io, rest, flags);
  if (verb === 'import') return importNow(ctx, io, flags);
  throw new TrackerError('usage', USAGE);
}
