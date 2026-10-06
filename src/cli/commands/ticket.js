import { loadContext, sessionFromFlags, cliEvent, submitAndWait, latestSnapshot, findTicketByKey, effectiveDefaults, commandName } from '../context.js';
import { validateKey } from '../../core/keys.js';
import { CATEGORIES, PRIORITIES, loadRepoConfig, resolveTracker } from '../../config/config.js';
import { renderUrl, isSafeExternalUrl, TRACKER_SYSTEMS } from '../../core/external-keys.js';
import { uuid } from '../../lib/ids.js';
import { isDate } from '../../lib/time.js';
import { readBindingSnapshot } from '../../hooks/binding-snapshot.js';
import { sessionKey, TICKET_STATUSES } from '../../core/state.js';
import { TrackerError } from '../../lib/errors.js';

function timeout(flags) {
  return flags.timeout ? Number(flags.timeout) : 10_000;
}

async function bind(ctx, io, session, ticket, flags) {
  const ev = cliEvent(ctx, { kind: 'bind', payload: { ticket_id: ticket.id, project_id: ticket.project_id }, session, ticket_id: ticket.id });
  const ack = await submitAndWait(ctx, ev, { timeoutMs: timeout(flags) });
  if (ack.rejected) throw new TrackerError(ack.rejected, `bind rejected: ${ack.rejected}`);
  const snap = readBindingSnapshot(sessionKey(session), ctx.env);
  io.println(`Bound session ${session.session_id}${session.agent_id ? ` (agent ${session.agent_id})` : ''} to ${ticket.key} — ${ticket.title} (binding revision ${snap ? snap.binding_revision : '?'}).`);
  return snap;
}

async function create(ctx, io, args, flags, { work = false } = {}) {
  const title = args.join(' ').trim();
  if (!title) throw new TrackerError('title-required', 'a ticket title is required');
  const defaults = effectiveDefaults(ctx, process.cwd(), flags);
  if (!CATEGORIES.includes(defaults.category)) throw new TrackerError('category-invalid', `category must be one of ${CATEGORIES.join(', ')}`);
  if (!PRIORITIES.includes(defaults.priority)) throw new TrackerError('priority-invalid', `priority must be one of ${PRIORITIES.join(', ')}`);
  if (flags.due && !isDate(flags.due)) throw new TrackerError('due-invalid', 'due must be YYYY-MM-DD');
  const project_id = defaults.project_id || Object.keys(ctx.config.projects)[0];
  if (!project_id) throw new TrackerError('project-required', 'no project configured; pass --project or run quill init');
  const project = ctx.config.projects[project_id] ?? {};
  let parent = null;
  if (flags.parent) {
    validateKey(flags.parent);
    parent = findTicketByKey(ctx, flags.parent);
    if (!parent) throw new TrackerError('parent-invalid', `unknown parent ticket key ${flags.parent}`);
  }
  const session = work || flags.session || flags.bind ? sessionFromFlags(flags, ctx.env) : null;
  const ticket = {
    id: uuid(), allocate_internal_key: true, key_prefix: ctx.config.key_prefix, title: title.slice(0, 200), project_id, project_name: project.name ?? project_id, category: defaults.category, priority: defaults.priority,
    parent_id: parent ? parent.id : null, repo_id: defaults.repo_id ?? project.repo_id ?? null, due: flags.due ?? null, jira: null,
  };
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'ticket-create', payload: { ticket, ...(work ? { reuse_task: true } : {}) }, session, ticket_id: ticket.id }), { timeoutMs: timeout(flags) });
  if (ack.rejected) throw new TrackerError(ack.rejected, ack.rejected === 'task-ambiguous' ? 'Multiple open tasks have that title. Use ticket list, then ticket bind <KEY> to choose the intended task.' : `ticket creation rejected: ${ack.rejected}`);
  Object.assign(ticket, ack.ticket);
  if (!ticket.key) throw new TrackerError('worker-upgrade-required', 'Restart the Quill worker to enable sequential internal ticket keys.');
  delete ticket.allocate_internal_key;
  delete ticket.key_prefix;
  delete ticket.reused;
  io.println(`${ack.ticket?.reused ? 'Reused' : 'Created'} ${ticket.key} — ${ticket.title}${work ? '' : ` [${ticket.category}, ${ticket.priority}, project ${project_id}${parent ? `, child of ${parent.key}` : ''}]`}`);
  if (work) io.println(`Working on ${ticket.key} in session ${session.session_id}. Earlier work keeps its original ticket attribution.`);
  else if (flags.bind) await bind(ctx, io, session, ticket, flags);
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
  const rawExt = flags.external ?? flags.jira;
  const extKey = typeof rawExt === 'string' ? rawExt.trim().toUpperCase() : rawExt;
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

const CLEAR = 'none';

// One ticket-update event for every field given; values are validated here because the reducer applies what it is sent.
async function set(ctx, io, args, flags) {
  const usage = 'usage: ticket set <KEY> [--title t] [--status s] [--blocker text] [--next text] [--priority P0-P3] [--category c] [--due YYYY-MM-DD|none] [--parent KEY|none] [--repo <repo-id>|none]';
  const [key] = args;
  if (!key) throw new TrackerError('key-required', usage);
  validateKey(key);
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const str = (name) => (typeof flags[name] === 'string' ? flags[name].trim() : undefined);
  const fields = {};
  const title = str('title');
  if (title !== undefined) {
    if (!title) throw new TrackerError('title-required', 'the title cannot be empty');
    fields.title = title.slice(0, 200);
  }
  const status = str('status');
  const blocker = str('blocker');
  if (status !== undefined) {
    if (!TICKET_STATUSES.includes(status)) throw new TrackerError('status-invalid', `status must be one of ${TICKET_STATUSES.join(', ')}`);
    if (status === 'blocked' && !blocker && !(ticket.status === 'blocked' && ticket.blocker)) throw new TrackerError('blocker-required', 'blocked needs --blocker "<what you are waiting on>"');
    fields.status = status;
  }
  if (blocker !== undefined) {
    if (!blocker) throw new TrackerError('blocker-required', 'the blocker cannot be empty');
    if ((status ?? ticket.status) !== 'blocked') throw new TrackerError('blocker-not-blocked', `--blocker applies only to a blocked ticket; add --status blocked (${ticket.key} is ${ticket.status})`);
    fields.blocker = blocker;
  }
  if (status === 'blocked' && blocker === undefined) fields.blocker = ticket.blocker;
  if (typeof flags.next === 'string') fields.next_action = flags.next.trim();
  const priority = str('priority');
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority)) throw new TrackerError('priority-invalid', `priority must be one of ${PRIORITIES.join(', ')}`);
    fields.priority = priority;
  }
  const category = str('category');
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) throw new TrackerError('category-invalid', `category must be one of ${CATEGORIES.join(', ')}`);
    fields.category = category;
  }
  const due = str('due');
  if (due !== undefined) {
    if (due !== CLEAR && !isDate(due)) throw new TrackerError('due-invalid', 'due must be YYYY-MM-DD (or none to clear it)');
    fields.due = due === CLEAR ? null : due;
  }
  const parentKey = str('parent');
  if (parentKey !== undefined) {
    if (parentKey === CLEAR) fields.parent_id = null;
    else {
      validateKey(parentKey);
      const parent = findTicketByKey(ctx, parentKey);
      if (!parent) throw new TrackerError('parent-invalid', `unknown parent ticket key ${parentKey}`);
      fields.parent_id = parent.id;
    }
  }
  const repo = str('repo');
  if (repo !== undefined) {
    if (repo !== CLEAR && !Object.hasOwn(ctx.config.repos ?? {}, repo)) {
      const known = Object.keys(ctx.config.repos ?? {});
      throw new TrackerError('repo-unknown', `unknown repository ${repo}; registered: ${known.length ? known.join(', ') : 'none'} (see quill repo list)`);
    }
    fields.repo_id = repo === CLEAR ? null : repo;
  }
  if (!Object.keys(fields).length) throw new TrackerError('usage', `nothing to change. ${usage}`);
  const session = flags.session ? sessionFromFlags(flags, ctx.env) : null;
  const ack = await submitAndWait(ctx, cliEvent(ctx, { kind: 'ticket-update', payload: { ticket_id: ticket.id, fields, source: 'manual' }, session, ticket_id: ticket.id }), { timeoutMs: timeout(flags) });
  if (ack.rejected) throw new TrackerError(ack.rejected, `update rejected: ${ack.rejected}`);
  const shown = Object.entries(fields).map(([k, v]) => `${k}=${v === null ? CLEAR : k === 'parent_id' ? parentKey : v}`).join(', ');
  io.println(`Updated ${ticket.key}: ${shown}`);
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
    case 'work': return create(ctx, io, rest, flags, { work: true });
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
    case 'set': return set(ctx, io, rest, flags);
    case 'list': return list(ctx, io, flags);
    case 'children': return children(ctx, io, rest, flags);
    default:
      throw new TrackerError('usage', 'usage: ticket work|create|bind|show|set|off|on|relink|list|children');
  }
}
