import { loadContext, sessionFromFlags, cliEvent, submitAndWait, latestSnapshot, findTicketByKey, effectiveDefaults, commandName } from '../context.js';
import { allocateKey, slugify, validateKey } from '../../core/keys.js';
import { createState } from '../../core/state.js';
import { CATEGORIES, PRIORITIES, loadRepoConfig, resolveTracker } from '../../config/config.js';
import { renderUrl, isSafeExternalUrl, TRACKER_SYSTEMS } from '../../core/external-keys.js';
import { uuid, shortId } from '../../lib/ids.js';
import { isDate } from '../../lib/time.js';
import { readBindingSnapshot } from '../../hooks/binding-snapshot.js';
import { sessionKey } from '../../core/state.js';
import { TrackerError } from '../../lib/errors.js';

function timeout(flags) {
  return flags.timeout ? Number(flags.timeout) : 10_000;
}

function keyIndexFromSnapshot(snapshot) {
  const state = createState({ store_id: 'x', machine_id: 'y' });
  for (const t of snapshot ? snapshot.tickets : []) {
    state.tickets.set(t.id, t);
    state.keyIndex.set(t.key, t.id);
    for (const a of t.aliases ?? []) state.keyIndex.set(a, t.id);
    const m = t.parent_id && /\.(\d+)$/.exec(t.key);
    if (m) state.counters.childByParent.set(t.parent_id, Math.max(state.counters.childByParent.get(t.parent_id) ?? 0, Number(m[1])));
  }
  return state;
}

async function bind(ctx, io, session, ticket, flags) {
  const ev = cliEvent(ctx, { kind: 'bind', payload: { ticket_id: ticket.id, project_id: ticket.project_id }, session, ticket_id: ticket.id });
  const ack = await submitAndWait(ctx, ev, { timeoutMs: timeout(flags) });
  if (ack.rejected) throw new TrackerError(ack.rejected, `bind rejected: ${ack.rejected}`);
  const snap = readBindingSnapshot(sessionKey(session), ctx.env);
  io.println(`Bound session ${session.session_id}${session.agent_id ? ` (agent ${session.agent_id})` : ''} to ${ticket.key} — ${ticket.title} (binding revision ${snap ? snap.binding_revision : '?'}).`);
  return snap;
}

async function create(ctx, io, args, flags) {
  const title = args.join(' ').trim();
  if (!title) throw new TrackerError('title-required', 'a ticket title is required');
  const defaults = effectiveDefaults(ctx, process.cwd(), flags);
  if (!CATEGORIES.includes(defaults.category)) throw new TrackerError('category-invalid', `category must be one of ${CATEGORIES.join(', ')}`);
  if (!PRIORITIES.includes(defaults.priority)) throw new TrackerError('priority-invalid', `priority must be one of ${PRIORITIES.join(', ')}`);
  if (flags.due && !isDate(flags.due)) throw new TrackerError('due-invalid', 'due must be YYYY-MM-DD');
  const project_id = defaults.project_id || Object.keys(ctx.config.projects)[0];
  if (!project_id) throw new TrackerError('project-required', 'no project configured; pass --project or run quill init');
  const project = ctx.config.projects[project_id] ?? {};
  const snapshot = latestSnapshot(ctx);
  const index = keyIndexFromSnapshot(snapshot);
  let parent = null;
  if (flags.parent) {
    validateKey(flags.parent);
    parent = findTicketByKey(ctx, flags.parent);
    if (!parent) throw new TrackerError('parent-invalid', `unknown parent ticket key ${flags.parent}`);
  }
  const key = allocateKey(index, { prefix: ctx.config.key_prefix ?? 'LOCAL', title, parent_id: parent ? parent.id : null });
  const session = flags.session || flags.bind ? sessionFromFlags(flags, ctx.env) : null;
  const ticket = {
    id: uuid(), key, title: title.slice(0, 200), project_id, project_name: project.name ?? project_id, category: defaults.category, priority: defaults.priority,
    parent_id: parent ? parent.id : null, repo_id: defaults.repo_id ?? project.repo_id ?? null, due: flags.due ?? null, jira: null,
  };
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'ticket-create', payload: { ticket }, session, ticket_id: ticket.id }), { timeoutMs: timeout(flags) });
  if (ack.rejected) {
    if (ack.rejected === 'key-collision') {
      // Extremely unlikely with an 8-hex suffix; retry once with a fresh id.
      ticket.key = `${ctx.config.key_prefix ?? 'LOCAL'}-${slugify(title)}-${shortId()}`;
      const retry = await submitAndWait(ctx, cliEvent(ctx, { kind: 'ticket-create', payload: { ticket }, session, ticket_id: ticket.id }), { timeoutMs: timeout(flags) });
      if (retry.rejected) throw new TrackerError(retry.rejected, `ticket creation rejected: ${retry.rejected}`);
    } else {
      throw new TrackerError(ack.rejected, `ticket creation rejected: ${ack.rejected}`);
    }
  }
  io.println(`Created ${ticket.key} — ${ticket.title} [${ticket.category}, ${ticket.priority}, project ${project_id}${parent ? `, child of ${parent.key}` : ''}]`);
  if (flags.bind) await bind(ctx, io, session, ticket, flags);
  else io.println(`Bind with: ${commandName('ticket')} bind ${ticket.key}`);
  if (flags.json) io.json({ ticket });
  return 0;
}

function show(ctx, io, flags) {
  const session = sessionFromFlags(flags, ctx.env);
  const snap = readBindingSnapshot(sessionKey(session), ctx.env);
  const ticket = snap && snap.ticket_id ? (latestSnapshot(ctx)?.tickets ?? []).find((t) => t.id === snap.ticket_id) : null;
  if (flags.json) {
    io.json({ session, binding: snap, ticket });
    return 0;
  }
  if (!snap || !snap.ticket_id) {
    io.println(`Session ${session.session_id} is unbound${snap && snap.gate_enabled === false ? ' (gate OFF)' : ''}. Use ${commandName('ticket')} create "<title>" --bind or ${commandName('ticket')} bind <KEY>.`);
    return 0;
  }
  io.println(`Session ${session.session_id} → ${snap.ticket_key} — ${snap.ticket_title ?? ''} (binding revision ${snap.binding_revision}, gate ${snap.gate_enabled ? 'on' : 'OFF'})`);
  if (ticket) {
    io.println(`  status: ${ticket.status}${ticket.stale ? ' (stale)' : ''}  priority: ${ticket.priority}  category: ${ticket.category}`);
    if (ticket.next_action) io.println(`  next action: ${ticket.next_action}`);
    if (ticket.blocker) io.println(`  blocker: ${ticket.blocker}`);
    io.println(`  files touched: ${ticket.files_touched_count}  plans: ${ticket.plans_count}  sessions: ${ticket.session_ids.length}`);
  }
  return 0;
}

async function gate(ctx, io, flags, enable) {
  const session = sessionFromFlags(flags, ctx.env);
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: enable ? 'gate-on' : 'gate-off', payload: {}, session }), { timeoutMs: timeout(flags) });
  if (ack.rejected) throw new TrackerError(ack.rejected, `gate change rejected: ${ack.rejected}`);
  io.println(enable
    ? `Ticket gate ON for session ${session.session_id}; supported writes require a binding again.`
    : `Ticket gate OFF for session ${session.session_id}. This is audited and visible in the dashboard; re-enable with ${commandName('ticket')} on.`);
  return 0;
}

async function relink(ctx, io, args, flags) {
  const usage = 'usage: ticket relink <KEY> --external <EXT-KEY> [--system jira|linear|github|custom] [--url <https url>] (--jira <KEY> is an alias)';
  const [key] = args;
  if (!key) throw new TrackerError('key-required', usage);
  validateKey(key);
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const extKey = flags.external ?? flags.jira;
  if (typeof extKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(extKey)) throw new TrackerError('external-invalid', `an external key like PROJ-123 is required (--external; --jira is an alias). ${usage}`);
  validateKey(extKey);
  let tracker = null;
  try { tracker = resolveTracker(ctx.config, loadRepoConfig(process.cwd())); } catch { tracker = null; }
  const system = typeof flags.system === 'string' ? flags.system : (flags.jira ? 'jira' : tracker ? tracker.system : 'custom');
  if (!TRACKER_SYSTEMS.includes(system)) throw new TrackerError('system-invalid', `--system must be one of ${TRACKER_SYSTEMS.join(', ')}`);
  if (flags.url !== undefined && !isSafeExternalUrl(flags.url)) throw new TrackerError('external-url-invalid', 'the external link must be an https:// URL without spaces or quotes');
  const url = flags.url ?? (tracker && tracker.system === system ? renderUrl(extKey, tracker) : null);
  // Remote validation requires a configured provider; without one the link stays locally bound and pending.
  const pending = { validation: 'pending', validated_at: null, error: 'no tracker provider configured; remote validation pending' };
  const payload = { ticket_id: ticket.id, new_key: extKey, external: { system, key: extKey, url, ...pending } };
  if (system === 'jira') payload.jira = { key: extKey, url, ...pending };
  const session = flags.session ? sessionFromFlags(flags, ctx.env) : null;
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'relink', payload, session, ticket_id: ticket.id }), { timeoutMs: timeout(flags) });
  if (ack.rejected === 'key-collision') throw new TrackerError('key-collision', `key collision: ${extKey} already identifies another ticket (alias or key)`);
  if (ack.rejected) throw new TrackerError(ack.rejected, `relink rejected: ${ack.rejected}`);
  io.println(`Relinked ${key} → ${extKey} (alias ${key} kept; ${system} link ${url ?? 'not configured'}; validation pending: ${pending.error}).`);
  return 0;
}

function list(ctx, io, flags) {
  const snap = latestSnapshot(ctx);
  let tickets = snap ? snap.tickets : [];
  if (flags.status) tickets = tickets.filter((t) => t.status === flags.status);
  if (flags.project) tickets = tickets.filter((t) => t.project_id === flags.project);
  tickets.sort((a, b) => (a.key < b.key ? -1 : 1));
  if (flags.json) { io.json(tickets); return 0; }
  if (!tickets.length) { io.println('No tickets.'); return 0; }
  for (const t of tickets) io.println(`${t.key.padEnd(44)} ${t.status.padEnd(15)} ${t.priority} ${t.stale ? 'stale ' : ''}${t.title}`);
  io.println(`${tickets.length} ticket(s)`);
  return 0;
}

function children(ctx, io, args, flags) {
  const [key] = args;
  if (!key) throw new TrackerError('key-required', 'usage: ticket children <KEY>');
  const parent = findTicketByKey(ctx, key);
  if (!parent) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const snap = latestSnapshot(ctx);
  const kids = snap.tickets.filter((t) => t.parent_id === parent.id);
  if (flags.json) { io.json(kids); return 0; }
  io.println(`${parent.key} — ${parent.title}: ${kids.length} child(ren), ${parent.children_done_count} done`);
  for (const k of kids) io.println(`  ${k.key.padEnd(44)} ${k.status.padEnd(15)} ${k.title}`);
  return 0;
}

export async function run({ args, flags, io, env }) {
  const [verb, ...rest] = args;
  const ctx = loadContext(env);
  switch (verb) {
    case 'create': return create(ctx, io, rest, flags);
    case 'bind': {
      const [key] = rest;
      if (!key) throw new TrackerError('key-required', 'usage: ticket bind <KEY> --session <id>');
      validateKey(key);
      const session = sessionFromFlags(flags, env);
      const ticket = findTicketByKey(ctx, key);
      if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
      await bind(ctx, io, session, ticket, flags);
      return 0;
    }
    case 'show': return show(ctx, io, flags);
    case 'off': return gate(ctx, io, flags, false);
    case 'on': return gate(ctx, io, flags, true);
    case 'relink': return relink(ctx, io, rest, flags);
    case 'list': return list(ctx, io, flags);
    case 'children': return children(ctx, io, rest, flags);
    default:
      throw new TrackerError('usage', 'usage: ticket create|bind|show|off|on|relink|list|children');
  }
}
