// Dashboard projections: one complete generation at a time, published through MANIFEST.json so
// readers never see a half-written generation (TRD §Durability 4, DATA-CONTRACT §Dashboard projection).
import fs from 'node:fs';
import path from 'node:path';
import { projectionsDir } from '../lib/paths.js';
import { ensureDir, writeJsonAtomic, readJsonIfExists } from '../lib/atomic-fs.js';
import { addMs, HOUR } from '../lib/time.js';
import { environmentStatus } from '../deploy/environments.js';

export const SNAPSHOT_TIMELINE_LIMIT = 20;

export function ticketSummary(ticket, { environmentsFor = null } = {}) {
  const { timeline, ...rest } = ticket;
  const out = { ...rest, timeline: timeline.slice(-SNAPSHOT_TIMELINE_LIMIT), timeline_total: timeline.length };
  // Per-environment status (ADR 0009) for the configured environments of the ticket's repository.
  out.environments = environmentStatus(ticket, environmentsFor ? environmentsFor(ticket.repo_id) : []);
  return out;
}

export function buildMeta(state, { now, capture, worker_seen_at, active_sync_request_id = null, key_example = 'PROJ-123', next_sync_due }) {
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
    capture_health: capture.health,
    projection_health: { status: 'ok', reason: null, observed_at: now },
    provider_health: state.providerHealth ?? [],
    counts_by_status: counts,
    stale_ticket_count: stale,
    unresolved_event_count: state.unresolved.length,
    active_sync_request_id,
    key_example,
  };
}

export function buildSnapshot(state, { generation_id, generated_at, derived = {}, capture = { health: { status: 'ok', reason: null, observed_at: generated_at } }, worker_seen_at = generated_at, active_sync_request_id = null, capabilities, key_example, schedules = [], next_sync_due, recipes = [], environmentsFor = null, publishers = [] }) {
  const dayAgo = addMs(generated_at, -24 * HOUR);
  const requests = [...state.requests.values()].filter((r) => !['applied', 'conflict', 'failed', 'cancelled'].includes(r.state) || r.updated_at >= dayAgo);
  return {
    schema_version: 1,
    generation_id,
    generated_at,
    capabilities: capabilities ?? { read: true, edit_tickets: true, handoff: true, refresh: true, cancel_requests: true, export: true },
    tickets: [...state.tickets.values()].map((t) => ticketSummary(t, { environmentsFor })),
    sessions: [...state.sessions.values()],
    checkpoints: [...state.checkpoints.values()],
    handoffs: [...state.handoffs.values()],
    requests,
    schedules,
    recipes,
    publishers,
    picknext: derived.picknext ?? [],
    blocked: derived.blocked ?? [],
    deployments_outstanding: derived.deployments_outstanding ?? [],
    today: derived.today ?? null,
    meta: buildMeta(state, { now: generated_at, capture, worker_seen_at, active_sync_request_id, key_example, next_sync_due }),
    repos: Object.entries(state.meta.repos).map(([id, r]) => ({ id, project_id: r.project_id ?? null, display_name: r.display_name ?? id, default_branch: r.default_branch ?? 'main', deployment_environments: r.deployment_environments ?? ['production'] })),
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
