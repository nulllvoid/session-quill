// Dashboard projections: one complete generation at a time, published through MANIFEST.json so
// readers never see a half-written generation (TRD §Durability 4, DATA-CONTRACT §Dashboard projection).
import { proposalState } from '../publish/run-proposals.js';
import fs from 'node:fs';
import path from 'node:path';
import { projectionsDir } from '../lib/paths.js';
import { ensureDir, writeJsonAtomic, readJsonIfExists } from '../lib/atomic-fs.js';
import { addMs, HOUR } from '../lib/time.js';
import { environmentStatus } from '../deploy/environments.js';
import { descriptionProblems, parseDescription } from '../core/description.js';
import { dryRunTwin, DRY_RUN_SCOPES } from '../gate/dry-run.js';

export const SNAPSHOT_TIMELINE_LIMIT = 20;

// The repository chip (ADR 0024): no-code when the owner said so, cloning while a repo-clone request
// for the ticket is open, needs-clone when the resolver found a remote without a registered clone.
export function repoState(ticket, { cloning = null } = {}) {
  if ((ticket.tags ?? []).includes('quill/no-code')) return 'no-code';
  if (ticket.repo_id) return null;
  if (cloning && cloning.has(ticket.id)) return 'cloning';
  return ticket.repo_resolution && ticket.repo_resolution.state === 'needs-clone' ? 'needs-clone' : null;
}

export function ticketSummary(ticket, { environmentsFor = null, cloning = null } = {}) {
  const { timeline, ...rest } = ticket;
  const out = { ...rest, timeline: timeline.slice(-SNAPSHOT_TIMELINE_LIMIT), timeline_total: timeline.length };
  // Per-environment status (ADR 0009) for the configured environments of the ticket's repository.
  out.environments = environmentStatus(ticket, environmentsFor ? environmentsFor(ticket.repo_id) : []);
  // The description parsed for display (ADR 0014); the text itself stays in `summary`.
  const problems = descriptionProblems(ticket.summary);
  out.description = { valid: problems.length === 0, problems, ...(problems.length ? {} : parseDescription(ticket.summary)) };
  out.repo_state = repoState(ticket, { cloning });
  return out;
}

export function buildMeta(state, { now, capture, worker_seen_at, active_sync_request_id = null, key_example = 'PROJ-123', next_sync_due, handoff_limits = null, onboarding = null, autonomy = null }) {
  const counts = { todo: 0, active: 0, blocked: 0, review: 0, 'deploy-pending': 0, done: 0 };
  let stale = 0;
  for (const t of state.tickets.values()) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    if (t.stale) stale += 1;
  }
  const lastSync = state.lastSync ?? null;
  return {
    store_id: state.meta.store_id,
    store_name: state.meta.store_name,
    tracker_version: state.meta.tracker_version,
    schema_version: 1,
    owner_machine_id: state.meta.machine_id,
    timezone: state.meta.timezone,
    sync_interval_hours: state.meta.sync_interval_hours,
    last_sync: lastSync,
    // The scheduler knows the real next reconcile run; without one, fall back to the fixed interval.
    next_sync_due: next_sync_due !== undefined ? next_sync_due : (lastSync ? addMs(lastSync, state.meta.sync_interval_hours * HOUR) : null),
    last_capture_at: state.lastCaptureAt ?? null,
    oldest_pending_event_at: capture.oldest_pending_event_at ?? null,
    worker_seen_at,
    worker_autostart: capture.autostart === true,
    capture_health: capture.health,
    projection_health: { status: 'ok', reason: null, observed_at: now },
    provider_health: state.providerHealth ?? [],
    counts_by_status: counts,
    stale_ticket_count: stale,
    unresolved_event_count: state.unresolved.length,
    active_sync_request_id,
    key_example,
    // Concurrent run caps (ADR 0023), shown where bulk runs are queued.
    handoff_limits,
    // Clone hosts and folder (ADR 0024), shown by the clone dialog before the owner confirms.
    onboarding,
    // What the Run dialog says about autonomous runs on this machine (ADR 0026): the latest init
    // inventory and credential report, configured read-only systems. Never exported.
    autonomy,
  };
}

// ADR 0031: what the Needs you item says about a run-origin proposal whose pinned shell action is
// a k8s.write or db.write while [critical] require_dry_run is on: the dry-run twin the approved run
// must pass first, or null when it has none (the run will then refuse the action). Owner snapshot
// only: run proposals never reach an export.
function dryRunNote(p, on) {
  if (!on || p.origin !== 'run' || !(Array.isArray(p.scopes) && p.scopes.some((s) => s && DRY_RUN_SCOPES.has(s.name)))) return null;
  const pin = p.action_pin && typeof p.action_pin.guard === 'string' && p.action_pin.kind !== 'mcp' ? p.action_pin.guard : null;
  const twin = pin ? dryRunTwin({ tool_name: 'Bash', tool_input: { command: pin } }) : null;
  return { twin: twin ? twin.text : null };
}

export function buildSnapshot(state, { generation_id, generated_at, derived = {}, capture = { health: { status: 'ok', reason: null, observed_at: generated_at } }, worker_seen_at = generated_at, active_sync_request_id = null, capabilities, key_example, schedules = [], next_sync_due, recipes = [], environmentsFor = null, publishers = [], handoff_limits = null, onboarding = null, autonomy = null, critical_dry_run = true }) {
  const dayAgo = addMs(generated_at, -24 * HOUR);
  // Memory requests keep their kind and state but not their text: memory never reaches a snapshot (spec §9).
  const requests = [...state.requests.values()].filter((r) => !['applied', 'conflict', 'failed', 'cancelled'].includes(r.state) || r.updated_at >= dayAgo)
    .map((r) => (typeof r.kind === 'string' && r.kind.startsWith('memory-') ? { ...r, payload: r.payload && typeof r.payload.pinned === 'boolean' ? { pinned: r.payload.pinned } : {} } : r));
  const cloning = new Set(requests.filter((r) => r.kind === 'repo-clone' && ['pending', 'applying'].includes(r.state)).map((r) => r.target_id));
  return {
    schema_version: 1,
    generation_id,
    generated_at,
    capabilities: capabilities ?? { read: true, edit_tickets: true, handoff: true, refresh: true, cancel_requests: true, export: true },
    tickets: [...state.tickets.values()].map((t) => ticketSummary(t, { environmentsFor, cloning })),
    sessions: [...state.sessions.values()],
    checkpoints: [...state.checkpoints.values()],
    // A run's init inventory and credential report stay on its record; the dashboard reads only the
    // latest of each (meta.autonomy), so the snapshot does not grow with them per run (ADR 0026).
    handoffs: [...state.handoffs.values()].map(({ inventory, cred_report, ...h }) => h),
    requests,
    schedules,
    recipes,
    publishers,
    // Runs proposed from shared pages (ADR 0025), with their state as of this snapshot.
    run_proposals: [...(state.runProposals ?? new Map()).values()].map((p) => { const t = state.tickets.get(p.ticket_id); const dry = dryRunNote(p, critical_dry_run); return { ...p, state: proposalState(p, t, generated_at), ticket_key: t ? t.key : null, ...(dry ? { dry_run: dry } : {}) }; }),
    picknext: derived.picknext ?? [],
    blocked: derived.blocked ?? [],
    deployments_outstanding: derived.deployments_outstanding ?? [],
    today: derived.today ?? null,
    meta: buildMeta(state, { now: generated_at, capture, worker_seen_at, active_sync_request_id, key_example, next_sync_due, handoff_limits, onboarding, autonomy }),
    repos: Object.entries(state.meta.repos).map(([id, r]) => ({ id, project_id: r.project_id ?? null, display_name: r.display_name ?? id, default_branch: r.default_branch ?? 'main', deployment_environments: r.deployment_environments ?? ['production'], test_command: typeof r.test_command === 'string' && r.test_command.trim() ? r.test_command.trim() : null })),
    unresolved: state.unresolved.slice(-200),
  };
}

export function ticketDetailPath(env, ticketId) {
  return path.join(projectionsDir(env), 'tickets', `${ticketId}.json`);
}

// Ticket detail files live in a stable directory and are rewritten only when the ticket changed;
// the detail endpoint serves them only for the current generation, so they are never mixed.
export function publishGeneration(state, { env, now, generationNumber, snapshotOptions, changedTickets = null }) {
  const root = projectionsDir(env);
  const generation_id = `gen-${String(generationNumber).padStart(8, '0')}`;
  const dir = path.join(root, generation_id);
  ensureDir(dir);
  ensureDir(path.join(root, 'tickets'));
  const snapshot = buildSnapshot(state, { generation_id, generated_at: now, ...snapshotOptions });
  writeJsonAtomic(path.join(dir, 'snapshot.json'), snapshot);
  const ids = changedTickets ?? [...state.tickets.keys()];
  for (const id of ids) {
    const ticket = state.tickets.get(id);
    if (ticket) writeJsonAtomic(ticketDetailPath(env, id), { ...ticket, generation_id });
  }
  // Commit manifest last: readers only read complete generations.
  writeJsonAtomic(path.join(root, 'MANIFEST.json'), { schema_version: 1, generation_id, generated_at: now, path: generation_id });
  pruneGenerations(root, generation_id);
  return snapshot;
}

function pruneGenerations(root, keepLatest) {
  let entries;
  try { entries = fs.readdirSync(root).filter((n) => n.startsWith('gen-')).sort(); } catch { return; }
  const keep = new Set(entries.slice(-2));
  keep.add(keepLatest);
  for (const name of entries) {
    if (keep.has(name)) continue;
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function readPublishedSnapshot(env) {
  const manifest = readJsonIfExists(path.join(projectionsDir(env), 'MANIFEST.json'));
  if (!manifest) return null;
  return readJsonIfExists(path.join(projectionsDir(env), manifest.path, 'snapshot.json'));
}
