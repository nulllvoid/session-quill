// `quill agent`: list, show and run recipes, and resolve the suggestions their runs leave (ADR 0008).
import { loadContext, findTicketByKey, latestSnapshot } from '../context.js';
import { createRecipeCatalog, PERMISSION_KEYS } from '../../agents/recipes.js';
import { validateHandoffRequest } from '../../handoff/permissions.js';
import { TrackerError } from '../../lib/errors.js';
import { submitCliRequest } from './handoff.js';

const USAGE = 'usage: agent list [--ticket KEY] [--json] | agent show <recipe> [--ticket KEY] | agent run <recipe> <KEY> [--note text] [--no-read-source] [--commit] [--push-branch <b>] [--draft-pr] [--retry-of <id>] | agent suggestions <KEY> [--json] | agent accept|dismiss <run-id> <suggestion-id>';

const grants = (p) => (p ? PERMISSION_KEYS.filter((k) => p[k]).join(', ') : '') || 'none';

function repoIdFor(ctx, flags) {
  if (!flags.ticket) return null;
  const t = findTicketByKey(ctx, String(flags.ticket));
  if (!t) throw new TrackerError('ticket-unknown', `unknown ticket key ${flags.ticket}`);
  return t.repo_id ?? null;
}

function catalog(ctx) {
  return createRecipeCatalog({ env: ctx.env, config: ctx.config, ttlMs: 0 });
}

function list(ctx, io, flags) {
  const recipes = [...catalog(ctx).forRepo(repoIdFor(ctx, flags)).effective.values()];
  if (flags.json) { io.json(recipes.map(({ path, body, ...r }) => r)); return 0; }
  for (const r of recipes) {
    if (r.error) { io.println(`${r.name.padEnd(20)} ${r.source.padEnd(9)} invalid: ${r.error}`); continue; }
    io.println(`${r.name.padEnd(20)} ${r.source.padEnd(9)} ${r.mode.padEnd(18)} ${grants(r.permissions).padEnd(24)} ${String(r.timeout_min).padStart(2)} min  ${r.description}`);
  }
  return 0;
}

function show(ctx, io, args, flags) {
  const [name] = args;
  if (!name) throw new TrackerError('usage', USAGE);
  const r = catalog(ctx).get(name, repoIdFor(ctx, flags));
  if (!r) throw new TrackerError('recipe-unknown', `no recipe named ${name}`);
  io.println(`${r.name} (${r.source}${r.overridden_by ? `, overridden by ${r.overridden_by}` : ''})`);
  if (r.error) { io.println(`invalid: ${r.error}`); return 1; }
  io.println(r.description);
  io.println(`mode: ${r.mode}`);
  io.println(`permissions (at most): ${grants(r.permissions)}`);
  io.println(`tools: ${r.tools ? r.tools.join(', ') : 'default for its permissions'}`);
  io.println(`timeout: ${r.timeout_min} min`);
  io.println(`inputs: ${r.inputs.join(', ')}`);
  io.println(`outputs: ${r.outputs.join(', ')}`);
  io.println('');
  io.println(r.body);
  return 0;
}

async function run(ctx, io, args, flags) {
  const [name, key] = args;
  if (!name || !key) throw new TrackerError('usage', USAGE);
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const recipe = catalog(ctx).get(name, ticket.repo_id ?? null);
  if (!recipe) throw new TrackerError('recipe-unknown', `no recipe named ${name}`);
  if (recipe.error) throw new TrackerError('recipe-invalid', `recipe ${name} is invalid: ${recipe.error}`);
  const repo = ticket.repo_id && ctx.config.repos[ticket.repo_id] ? { id: ticket.repo_id, ...ctx.config.repos[ticket.repo_id] } : null;
  // Source access the recipe allows is granted by default; anything with a side effect only by flag.
  const readSource = flags['read-source'] !== false && flags['no-read-source'] !== true && recipe.permissions.read_source && !!repo;
  const permissions = {
    read_source: readSource,
    edit_source: recipe.mode === 'attempt-fix' && readSource,
    commit: flags.commit === true,
    push_branch: typeof flags['push-branch'] === 'string',
    open_draft_pr: flags['draft-pr'] === true,
  };
  const payload = validateHandoffRequest({ recipe: name, note: flags.note ?? '', permissions, branch: typeof flags['push-branch'] === 'string' ? flags['push-branch'] : null }, { repo, recipe });
  const terminal = await submitCliRequest(ctx, io, { kind: 'handoff', target_id: ticket.id, expected_revision: ticket.revision, payload, retry_of: flags['retry-of'] ?? null }, flags);
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `run request ${terminal.state}: ${err.message ?? ''}`);
  }
  io.println(`${name} queued for ${ticket.key} (permissions: ${grants(payload.permissions)}; capped at ${recipe.timeout_min} min). Run ${terminal.result.handoff_id}.`);
  io.println('Queued is not finished: follow it with `quill handoff list` or on the ticket in the dashboard.');
  if (flags.json) io.json(terminal);
  return 0;
}

function describe(s) {
  if (s.type === 'followup') return `${s.title}${s.next_action ? ` — ${s.next_action}` : ''}`;
  if (s.type === 'deploy-evidence') return (s.items ?? []).map((i) => `${i.environment}: ${i.state}${i.evidence ? ` (${i.evidence})` : ''}`).join('; ');
  return s.text ?? '';
}

function suggestions(ctx, io, args, flags) {
  const [key] = args;
  const ticket = key ? findTicketByKey(ctx, key) : null;
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key ?? ''}`);
  const snap = latestSnapshot(ctx);
  const rows = (snap ? snap.handoffs : []).filter((h) => h.ticket_id === ticket.id).flatMap((h) => (h.suggestions ?? []).map((s) => ({ run: h.id, recipe: h.recipe ? h.recipe.name : h.mode, ...s })));
  if (flags.json) { io.json(rows); return 0; }
  if (!rows.length) { io.println(`No suggestions for ${ticket.key}.`); return 0; }
  for (const r of rows) io.println(`${r.run.slice(0, 8)} ${r.id.padEnd(4)} ${r.type.padEnd(16)} ${describe(r)}  [${r.state}, ${r.recipe}]`);
  io.println('Resolve one with `quill agent accept <run> <id>` or `quill agent dismiss <run> <id>`. A comment draft is never posted for you.');
  return 0;
}

async function resolve(ctx, io, verb, args, flags) {
  const [runId, sid] = args;
  if (!runId || !sid) throw new TrackerError('usage', USAGE);
  const snap = latestSnapshot(ctx);
  const h = snap ? snap.handoffs.find((x) => x.id === runId || x.id.startsWith(runId)) : null;
  if (!h) throw new TrackerError('handoff-unknown', `unknown run ${runId}`);
  const ticket = snap.tickets.find((t) => t.id === h.ticket_id);
  const kind = verb === 'accept' ? 'accept-suggestion' : 'dismiss-suggestion';
  const terminal = await submitCliRequest(ctx, io, { kind, target_id: h.ticket_id, expected_revision: kind === 'accept-suggestion' && ticket ? ticket.revision : null, payload: { handoff_id: h.id, suggestion_id: sid } }, flags);
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `${verb} ${terminal.state}: ${err.message ?? ''}`);
  }
  io.println(`Suggestion ${sid} ${verb === 'accept' ? 'accepted' : 'dismissed'}${ticket ? ` on ${ticket.key}` : ''}.`);
  return 0;
}

export async function run_({ args, flags, io, env }) {
  const ctx = loadContext(env);
  const [verb, ...rest] = args;
  if (verb === 'list' || !verb) return list(ctx, io, flags);
  if (verb === 'show') return show(ctx, io, rest, flags);
  if (verb === 'run') return run(ctx, io, rest, flags);
  if (verb === 'suggestions') return suggestions(ctx, io, rest, flags);
  if (verb === 'accept' || verb === 'dismiss') return resolve(ctx, io, verb, rest, flags);
  throw new TrackerError('usage', USAGE);
}

export { run_ as run };
