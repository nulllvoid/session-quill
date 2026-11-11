// `quill hub …` (ADR 0044): run a self-hosted team hub, and push this machine's board to one.
//
// On the hub's host (no Quill store needed there):
//   hub serve --dir <data> [--host 127.0.0.1] [--port 47400] [--name "<team>"] [--secure-cookies] [--trust-proxy]
//   hub token add <name> [--role member|viewer] [--boards a,b] --dir <data>
//   hub token list --dir <data> [--json]      hub token revoke <name> --dir <data> [--purge]
//
// On a member's machine:
//   hub join <url> [--token-env NAME] [--projects a,b] [--fields k1,k2] [--include-links] [--accept-edits] [--interval-seconds n] [--confirm]
//   hub push        hub status [--json]        hub leave [--remove]
import path from 'node:path';
import { loadUserConfig, saveUserConfig } from '../../config/config.js';
import { loadContext, latestSnapshot } from '../context.js';
import { previewExport, SELECTABLE_FIELDS } from '../../export/sanitize.js';
import { hubSettings, normalizeHubUrl, pingHub, pushSnapshot, removeRemoteBoard, readHubState, exportOptions, shareableTicketCount, DEFAULT_TOKEN_ENV } from '../../hub/client.js';
import { initHub, addToken, listTokens, revokeToken, removeBoardsOf, ROLES } from '../../hub/store.js';
import { createHub, DEFAULT_PORT } from '../../hub/server.js';
import { nowIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const USAGE = 'usage: hub serve|token add|token list|token revoke --dir <data> …  |  hub join <url> [--confirm] | hub push | hub status | hub leave';
const truthy = (v) => v === true || v === '1' || v === 'true' || v === 'yes';
const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function dataDir(flags, env) {
  const raw = typeof flags.dir === 'string' ? flags.dir : env.QUILL_HUB_DIR;
  if (typeof raw !== 'string' || !raw.trim()) throw new TrackerError('hub-dir', 'name the hub data folder with --dir <folder> (or QUILL_HUB_DIR)');
  return path.resolve(raw.trim());
}

async function serve({ flags, io, env }) {
  const dir = dataDir(flags, env);
  const host = typeof flags.host === 'string' ? flags.host : env.QUILL_HUB_HOST || '127.0.0.1';
  const portRaw = typeof flags.port === 'string' ? flags.port : env.QUILL_HUB_PORT;
  const port = portRaw === undefined || portRaw === '' ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TrackerError('hub-port', '--port must be a whole number from 0 to 65535');
  const name = (typeof flags.name === 'string' ? flags.name : env.QUILL_HUB_NAME || 'Team hub').slice(0, 80);
  const maxMb = Number(typeof flags['max-body-mb'] === 'string' ? flags['max-body-mb'] : env.QUILL_HUB_MAX_BODY_MB || 8);
  if (!Number.isFinite(maxMb) || maxMb < 1 || maxMb > 64) throw new TrackerError('hub-max-body', '--max-body-mb must be from 1 to 64');
  const hub = createHub({
    dir, name,
    secureCookies: truthy(flags['secure-cookies']) || truthy(env.QUILL_HUB_SECURE_COOKIES),
    trustProxy: truthy(flags['trust-proxy']) || truthy(env.QUILL_HUB_TRUST_PROXY),
    maxBody: Math.round(maxMb * 1024 * 1024),
    log: (msg) => io.println(`${new Date().toISOString()} ${msg}`),
  });
  const address = await hub.listen(port, host);
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  io.println(`Session Quill team hub "${name}" listening on http://${shown}:${address.port} (data: ${dir}).`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) io.println('Reachable beyond this machine: put it behind TLS (a reverse proxy) and pass --secure-cookies or --trust-proxy.');
  if (!listTokens(dir).length) io.println(`No tokens yet. Create one with: quill hub token add <name> --dir ${dir}`);
  if (flags.once === true) { await hub.close(); return 0; }
  return new Promise((resolve) => {
    const stop = () => hub.close().then(() => { io.println('hub stopped'); resolve(0); });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function token({ args, flags, io, env }) {
  const [, verb, name] = args;
  const dir = dataDir(flags, env);
  if (verb === 'add') {
    initHub(dir, { now: nowIso() });
    const role = typeof flags.role === 'string' ? flags.role : 'member';
    const boards = typeof flags.boards === 'string' ? csv(flags.boards) : null;
    const t = addToken(dir, { name, role, boards, now: nowIso() });
    if (flags.json) { io.json(t); return 0; }
    io.println(`Token for ${t.name} (${t.role}). It is shown once; the hub keeps only its hash:`);
    io.println('');
    io.println(`  ${t.token}`);
    io.println('');
    io.println(t.role === 'member'
      ? `Give it to ${t.name}. They set ${DEFAULT_TOKEN_ENV} to it and run: quill hub join <this hub's address> --confirm`
      : `Give it to ${t.name}. They paste it on the hub's sign-in page. A viewer token cannot push or propose changes.`);
    io.println(t.boards ? `It reads only these members' boards: ${t.boards.join(', ')}.` : 'It reads every board on the hub (limit it with --boards alice,bob).');
    return 0;
  }
  if (verb === 'list') {
    const tokens = listTokens(dir);
    if (flags.json) { io.json(tokens); return 0; }
    if (!tokens.length) { io.println('No tokens. Create one with: quill hub token add <name>'); return 0; }
    for (const t of tokens) io.println(`${t.name.padEnd(24)} ${t.role.padEnd(7)} boards ${t.boards ? t.boards.join(',') : 'all'}  created ${t.created_at}  id ${t.id}`);
    return 0;
  }
  if (verb === 'revoke') {
    if (typeof name !== 'string') throw new TrackerError('usage', 'usage: hub token revoke <name> --dir <data> [--purge]');
    const gone = revokeToken(dir, name);
    if (!gone) throw new TrackerError('hub-no-token', `no token named "${name}"`);
    const purged = flags.purge === true ? removeBoardsOf(dir, gone.name) : 0;
    io.println(`Revoked ${gone.name} (${gone.role}). Browsers signed in with it are signed out on their next request.${flags.purge === true ? ` Removed ${purged} board(s).` : gone.role === 'member' ? ' Its boards stay until you revoke with --purge.' : ''}`);
    return 0;
  }
  throw new TrackerError('usage', `usage: hub token add <name> [--role ${ROLES.join('|')}] | hub token list | hub token revoke <name> [--purge]   (each with --dir <data>)`);
}

function ownerContext(env) {
  const ctx = loadContext(env, { requireStore: true });
  if (ctx.storeMeta.owner_machine_id !== ctx.machineId) throw new TrackerError('not-owner', 'this machine does not own the store; only the owner machine pushes its board');
  return ctx;
}

async function join({ args, flags, io, env }) {
  const ctx = ownerContext(env);
  const cfg = loadUserConfig(env);
  const current = cfg.hub && typeof cfg.hub === 'object' ? cfg.hub : {};
  const allowHttp = flags['allow-http'] === true || current.allow_http === true;
  // `--confirm <url>` parses the address as the flag's value; accept that order too.
  const confirmed = flags.confirm === true || typeof flags.confirm === 'string';
  const given = args[1] ?? (typeof flags.confirm === 'string' ? flags.confirm : undefined);
  const { url, problem } = normalizeHubUrl(given ?? current.url, { allowHttp });
  if (!url) throw new TrackerError('hub-url', `${problem}. usage: hub join <https://hub.example.org> [--confirm]`);
  const next = { ...current, url };
  if (allowHttp) next.allow_http = true;
  if (typeof flags['token-env'] === 'string') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(flags['token-env'])) throw new TrackerError('hub-token-env', '--token-env takes the name of an environment variable, not the token itself');
    next.token_env = flags['token-env'];
  }
  if (typeof flags.projects === 'string') next.projects = csv(flags.projects);
  if (typeof flags.fields === 'string') {
    const fields = csv(flags.fields);
    const unknown = fields.filter((f) => !SELECTABLE_FIELDS.includes(f));
    if (unknown.length) throw new TrackerError('hub-fields', `unknown field(s): ${unknown.join(', ')}. Choose from: ${SELECTABLE_FIELDS.join(', ')}`);
    next.fields = fields;
  }
  if (flags['include-links'] === true) next.include_links = true;
  if (flags['accept-edits'] === true) next.accept_edits = true;
  if (flags['no-accept-edits'] === true) next.accept_edits = false;
  if (typeof flags['interval-seconds'] === 'string') {
    const n = Number(flags['interval-seconds']);
    if (!Number.isInteger(n) || n < 60) throw new TrackerError('hub-interval', '--interval-seconds must be a whole number, at least 60');
    next.interval_seconds = n;
  }
  const settings = hubSettings({ ...cfg, hub: { ...next, enabled: true, confirmed_url: url } }, env);
  const snap = latestSnapshot(ctx);
  const preview = snap ? previewExport(snap, exportOptions(settings, nowIso())) : null;
  io.println(`Hub: ${url}`);
  io.println(`Token: read from the ${settings.token_env} environment variable${settings.token ? '' : ' (not set in this shell)'}. It is never written to a config file.`);
  if (preview) {
    io.println(`Would push: ${preview.ticket_count} ticket(s) of project(s) ${preview.projects.join(', ') || '(none)'}; fields ${preview.fields.join(', ')}.`);
    io.println('Never pushed:');
    for (const line of preview.excluded.filter((l) => !l.startsWith('Field '))) io.println(`  - ${line}`);
    io.println('  - Local-only tickets, run notes, memory and the request queue');
  } else {
    io.println('No published generation yet; start the worker once to see a preview.');
  }
  io.println(settings.accept_edits
    ? 'Edits from the hub: accepted. A member signed in on the hub can propose a status or next action for your tickets; each arrives here as a request under their name, applies after the 10-second undo window, and is refused if the ticket changed first.'
    : 'Edits from the hub: not accepted (add --accept-edits to let teammates propose a status or next action).');
  if (!confirmed) {
    io.println('');
    io.println('Nothing was changed and nothing was sent. Re-run with --confirm to save this hub and let the worker push to it.');
    return 0;
  }
  const health = await pingHub(settings);
  cfg.hub = { ...next, enabled: true, confirmed_url: url };
  saveUserConfig(cfg, env);
  io.println('');
  io.println(`Saved. ${url} answered as a Session Quill hub (API ${health.api}). The worker pushes after each change, at most once every ${Math.round(settings.interval_ms / 1000)} s; run \`quill hub push\` to push now.`);
  if (!settings.token) io.println(`Set ${settings.token_env} where the worker starts, then restart it (quill worker stop; quill start).`);
  return 0;
}

async function push({ io, env }) {
  const ctx = ownerContext(env);
  const settings = hubSettings(ctx.config, env);
  if (!settings.url) throw new TrackerError('hub-not-configured', 'no hub is configured; run `quill hub join <url> --confirm` first');
  if (!settings.confirmed) throw new TrackerError('hub-not-confirmed', 'this hub address has not been confirmed; run `quill hub join <url> --confirm`');
  const snap = latestSnapshot(ctx);
  if (!snap) throw new TrackerError('no-snapshot', 'no published generation yet; start the worker once');
  const r = await pushSnapshot(snap, settings, { now: nowIso(), storeId: ctx.storeMeta.store_id, machineName: ctx.config.machine_name ?? null, env });
  io.println(`Pushed ${r.ticket_count} ticket(s), generation ${r.generation_id}, to ${settings.url} as ${r.member}.${settings.switched_on ? '' : ' The worker pushes on its own only with [hub] enabled = true.'}`);
  return 0;
}

function status({ flags, io, env }) {
  const ctx = loadContext(env, { requireStore: false });
  const settings = hubSettings(ctx.config, env);
  const state = readHubState(env);
  const snap = ctx.initialized ? latestSnapshot(ctx) : null;
  const out = {
    url: settings.url, configured: settings.configured, confirmed: settings.confirmed, enabled: settings.enabled, token_env: settings.token_env, token_present: !!settings.token,
    interval_seconds: Math.round(settings.interval_ms / 1000), projects: settings.projects, include_links: settings.include_links, accept_edits: settings.accept_edits, problems: settings.problems,
    shareable_tickets: snap ? shareableTicketCount(snap, settings) : null,
    last_success_at: state && state.url === settings.url ? state.last_success_at ?? null : null,
    last_attempt_at: state && state.url === settings.url ? state.last_attempt_at ?? null : null,
    last_error: state && state.url === settings.url ? state.last_error ?? null : null,
  };
  if (flags.json) { io.json(out); return 0; }
  if (!settings.configured) { io.println('No hub configured. To push this board to a team hub: quill hub join <url> --confirm'); return 0; }
  io.println(`Hub: ${settings.url ?? '(invalid address)'}`);
  io.println(`Pushing: ${settings.enabled ? `on, at most once every ${out.interval_seconds} s` : 'off'}`);
  io.println(`Edits from the hub: ${settings.accept_edits ? 'accepted as revision-checked requests' : 'not accepted'}`);
  for (const p of settings.problems) io.println(`  - ${p}`);
  if (out.last_success_at) io.println(`Last push accepted: ${out.last_success_at}`);
  if (out.last_error) io.println(`Last attempt (${out.last_attempt_at}) failed: ${out.last_error.message}`);
  if (!out.last_success_at && !out.last_error) io.println('No push recorded on this machine yet.');
  return 0;
}

async function leave({ flags, io, env }) {
  const cfg = loadUserConfig(env);
  if (!cfg.hub || typeof cfg.hub !== 'object') { io.println('No hub configured.'); return 0; }
  let removed = '';
  if (flags.remove === true) {
    const ctx = ownerContext(env);
    await removeRemoteBoard(hubSettings(cfg, env), ctx.storeMeta.store_id);
    removed = ' Your board was removed from the hub.';
  }
  const { enabled: _enabled, confirmed_url: _confirmed, ...rest } = cfg.hub;
  cfg.hub = { ...rest, enabled: false };
  saveUserConfig(cfg, env);
  io.println(`Stopped pushing to ${rest.url ?? 'the hub'}.${removed}${flags.remove === true ? '' : ' The copy already on the hub stays; `quill hub leave --remove` deletes it, or ask whoever runs the hub.'}`);
  return 0;
}

export async function run({ args, flags, io, env }) {
  const [verb] = args;
  if (verb === 'serve') return serve({ flags, io, env });
  if (verb === 'token') return token({ args, flags, io, env });
  if (verb === 'join') return join({ args, flags, io, env });
  if (verb === 'push') return push({ io, env });
  if (verb === 'status' || verb === undefined) return status({ flags, io, env });
  if (verb === 'leave') return leave({ flags, io, env });
  throw new TrackerError('usage', USAGE);
}
