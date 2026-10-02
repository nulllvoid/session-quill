// `quill publish`: list publishers, publish now, or drive an artifact publish from a Claude Code
// session (ADR 0010). The first publish to a destination needs --confirm; the worker records it.
//   quill publish list [--json]
//   quill publish [<name>] [--confirm]           markdown, html, and artifact with executor = "cli"
//   quill publish <name> --plan [--confirm]       artifact: write the next plan for this session
//   quill publish <name> --result <result.json>   artifact: record what the session did
import fs from 'node:fs';
import path from 'node:path';
import { loadContext, latestSnapshot, cliEvent } from '../context.js';
import { normalizePublishers, destinationOf, KIND_LABELS } from '../../publish/config.js';
import { rowsFor } from '../../publish/content.js';
import { beginArtifactPublish, continueArtifactPublish } from '../../publish/artifact.js';
import { executorPrompt } from '../../publish/artifact-client.js';
import { writeIngress } from '../../core/ingress.js';
import { readJsonIfExists, writeJsonAtomic } from '../../lib/atomic-fs.js';
import { quillHome } from '../../lib/paths.js';
import { uuid } from '../../lib/ids.js';
import { nowIso } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';
import { submitCliRequest } from './handoff.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const publishDir = (ctx, name) => path.join(quillHome(ctx.env), 'publish', name);

function find(ctx, name) {
  const { publishers } = normalizePublishers(ctx.config);
  const p = publishers.find((x) => x.name === name);
  if (!p) throw new TrackerError('publisher-unknown', `no publisher named ${name}`);
  return p;
}

function list(ctx, io, flags) {
  const { publishers } = normalizePublishers(ctx.config);
  const snap = latestSnapshot(ctx);
  const info = new Map(((snap && snap.publishers) || []).map((p) => [p.name, p]));
  if (flags.json) { io.json(publishers.map((p) => ({ ...p, ...(info.get(p.name) ?? {}) }))); return 0; }
  if (!publishers.length) { io.println('No publishers. Add [[publish]] tables to ~/.claude/quill/config.toml.'); return 0; }
  for (const p of publishers) {
    const i = info.get(p.name);
    const where = p.kind === 'artifact' ? ((i && i.url) || p.url || 'new artifact') : (i ? i.destination_label : p.path.split(/[\\/]/).pop());
    io.println(`${p.name.padEnd(18)} ${KIND_LABELS[p.kind].padEnd(5)} ${String(where).padEnd(28)} ${i && i.confirmed ? 'confirmed' : 'not confirmed'}${i && i.last_outcome ? `  last: ${i.last_outcome}${i.last_published_at ? ` ${i.last_published_at}` : ''}` : ''}`);
  }
  return 0;
}

async function run(ctx, io, name, flags) {
  const { publishers } = normalizePublishers(ctx.config);
  if (name) find(ctx, name);
  if (!publishers.length) throw new TrackerError('publisher-unknown', 'no publishers are configured; add [[publish]] tables to config.toml');
  const confirm = flags.confirm === true;
  const timeout = flags.timeout ? Number(flags.timeout) : 15 * 60_000;
  const terminal = await submitCliRequest(ctx, io, { kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: name ?? null, confirm } }, { ...flags, timeout });
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `publish ${terminal.state}: ${err.message ?? ''}`);
  }
  const runId = terminal.result && terminal.result.run_id;
  const targets = name ? [name] : publishers.map((p) => p.name);
  let rows = [];
  for (let i = 0; i < 40; i += 1) {
    const snap = latestSnapshot(ctx);
    rows = targets.map((n) => { const p = ((snap && snap.publishers) || []).find((x) => x.name === n); const r = p && p.runs.find((x) => x.run_id === runId); return r ? { p, r } : null; });
    if (rows.every(Boolean)) break;
    await sleep(100);
  }
  for (const [i, n] of targets.entries()) {
    const row = rows[i];
    const kind = publishers.find((p) => p.name === n).kind;
    if (!row) { io.println(`${n} (${KIND_LABELS[kind].toLowerCase()}): published; see \`quill publish list\` for the result`); continue; }
    io.println(`${n} (${KIND_LABELS[kind].toLowerCase()}): ${row.r.outcome === 'failed' ? `failed: ${row.r.error}` : row.r.summary}${row.p.url && kind === 'artifact' ? ` — ${row.p.url}` : ''}`);
    if (row.r.outcome === 'needs-confirmation') io.println(`Nothing was sent. Run \`quill publish ${n} --confirm\` to confirm this destination.`);
  }
  return 0;
}

function journal(ctx, payload) {
  writeIngress(cliEvent(ctx, { kind: 'publish-run', payload, source_identity: `publish-run:${payload.run_id}:${payload.publisher}:${payload.outcome}` }), ctx.env);
}

function writeRun(ctx, io, p, step, pending) {
  const dir = path.join(publishDir(ctx, p.name), 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${uuid().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(step.files)) fs.writeFileSync(path.join(dir, file), content);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(step.plan, null, 2));
  const resolved = { ...step.plan, steps: step.plan.steps.map((s) => ({ ...s, ...(s.file ? { file_path: path.join(dir, s.file) } : {}), ...(s.out_dir ? { out_dir: path.join(dir, s.out_dir) } : {}) })) };
  writeJsonAtomic(path.join(publishDir(ctx, p.name), 'pending.json'), { ...pending, dir, context: step.context });
  const result = path.join(dir, 'result.json');
  io.println(`Run directory: ${dir}`);
  io.println('');
  io.println(executorPrompt(resolved));
  io.println('');
  io.println(`Save that final JSON block (just the JSON) to ${result}, then run: quill publish ${p.name} --result "${result}"`);
}

function plan(ctx, io, name, flags) {
  const p = find(ctx, name);
  if (p.kind !== 'artifact') throw new TrackerError('usage', `${name} is a ${p.kind} publisher; run \`quill publish ${name}\` instead`);
  const snap = latestSnapshot(ctx);
  if (!snap) throw new TrackerError('worker-offline', 'no published snapshot yet; start the worker with `quill worker start`');
  const info = (snap.publishers ?? []).find((x) => x.name === name);
  const destination = destinationOf(p);
  const confirmed = !!(info && info.confirmed);
  if (!confirmed && flags.confirm !== true) {
    throw new TrackerError('confirmation-required', `nothing has been sent to ${p.url ?? 'a new claude.ai artifact'} yet; rerun with --confirm to send ${p.fields.join(', ')} of tickets in ${p.projects ? p.projects.join(', ') : 'every project'} there`);
  }
  const now = nowIso();
  const statePath = path.join(publishDir(ctx, name), 'state.json');
  const prior = readJsonIfExists(statePath);
  const step = beginArtifactPublish(p, rowsFor(snap, p, { exportedAt: now }), { prior: prior && (!p.url || prior.url === p.url) ? prior : null, now });
  writeRun(ctx, io, p, step, { publisher: name, run_id: uuid(), destination, confirm: flags.confirm === true, started_at: now });
  return 0;
}

function result(ctx, io, name, file) {
  const p = find(ctx, name);
  const pendingPath = path.join(publishDir(ctx, name), 'pending.json');
  const pending = readJsonIfExists(pendingPath);
  if (!pending) throw new TrackerError('usage', `no publish of ${name} is in progress; start one with \`quill publish ${name} --plan\``);
  let outcome;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    outcome = continueArtifactPublish(pending.context, parsed, pending.dir);
  } catch (err) {
    fs.rmSync(pendingPath, { force: true });
    journal(ctx, { publisher: name, run_id: pending.run_id, outcome: 'failed', error: err.message, destination: pending.destination, confirmed: pending.confirm, trigger: 'session' });
    throw new TrackerError(err.code ?? 'artifact-failed', `${name}: ${err.message}`);
  }
  if (!outcome.done) {
    io.println('Next plan:');
    writeRun(ctx, io, p, outcome, { publisher: name, run_id: pending.run_id, destination: pending.destination, confirm: pending.confirm, started_at: pending.started_at });
    return 0;
  }
  writeJsonAtomic(path.join(publishDir(ctx, name), 'state.json'), outcome.done.state);
  fs.rmSync(pendingPath, { force: true });
  journal(ctx, { publisher: name, run_id: pending.run_id, outcome: 'ok', summary: outcome.done.summary, url: outcome.done.url, destination: pending.destination, confirmed: pending.confirm, trigger: 'session' });
  io.println(`${name}: ${outcome.done.summary} — ${outcome.done.url}`);
  return 0;
}

export async function run_({ args, flags, io, env }) {
  const ctx = loadContext(env);
  const [verb] = args;
  if (verb === 'list') return list(ctx, io, flags);
  if (flags.plan) return plan(ctx, io, verb, flags);
  if (typeof flags.result === 'string') return result(ctx, io, verb, flags.result);
  return run(ctx, io, verb ?? null, flags);
}

export { run_ as run };
