// The single local writer. Owns ingestion, journal, state, projections, note materialization,
// heartbeat and (through extensions) requests, reconciliation and handoffs (ADR 0001, TRD §Durability).
import path from 'node:path';
import fs from 'node:fs';
import { Journal } from '../core/journal.js';
import { validateEvent, makeEvent } from '../core/events.js';
import { listIngress, removeIngress, quarantineIngress } from '../core/ingress.js';
import { createState, sessionKey } from '../core/state.js';
import { applyEvent } from '../core/reducer.js';
import { safeKeyFileName } from '../core/keys.js';
import { journalPath, stateDir, requestsDir } from '../lib/paths.js';
import { ensureDir, writeJsonAtomic, readJsonIfExists, listFiles, removeIfExists } from '../lib/atomic-fs.js';
import { toIso, SECOND } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';
import { storeLayout } from '../config/store.js';
import { acquireLock } from './lock.js';
import { writeBindingSnapshot, writeHeartbeat, writeRuntimeIdentity, snapshotFileName } from '../hooks/binding-snapshot.js';
import { renderSessionNote, renderHandoffNote, writeNote, writeGeneratedNote } from './notes.js';
import { publishGeneration, buildSnapshot } from './projections.js';
import { captureHealth } from './health.js';

export const NOTE_FLUSH_MS = 30 * SECOND;
export const HEARTBEAT_MS = 5 * SECOND;

export class Worker {
  constructor({ config, storeMeta, env = process.env, clock = Date.now, derive = null, log = () => {} }) {
    this.config = config;
    this.storeMeta = storeMeta;
    this.env = env;
    this.clock = clock;
    this.derive = derive;
    this.log = log;
    this.layout = storeLayout(config.store_path);
    this.journal = new Journal(journalPath(env), { clock });
    this.journalInfo = null;
    this.lock = null;
    this.state = null;
    this.dirtyTickets = new Set();
    this.dirtySessions = new Set();
    this.dirtyHandoffs = new Set();
    this.firstDirtyAt = null;
    this.flushRequested = false;
    this.generationDirty = false;
    this.generationNumber = 0;
    this.lastHeartbeatMs = 0;
    this.lastSnapshot = null;
    this.notesIndex = {};
    this.extensions = [];
    this.running = false;
    this.pendingEffects = [];
  }

  now() {
    return toIso(this.clock());
  }

  async start() {
    this.lock = await acquireLock(this.storeMeta.store_id, this.storeMeta.owner_machine_id, this.env);
    this.journalInfo = this.journal.open();
    if (this.journalInfo.corrupt) {
      await this.lock.release();
      throw new TrackerError('journal-corrupt', 'journal has mid-log corruption; run `tracker doctor` and recover before starting the worker');
    }
    this.state = createState({
      store_id: this.storeMeta.store_id,
      machine_id: this.storeMeta.owner_machine_id,
      machine_name: this.config.machine_name,
      store_name: this.storeMeta.store_name,
      timezone: this.storeMeta.timezone ?? this.config.timezone,
      key_prefix: this.config.key_prefix,
      stale_days: this.config.stale_days,
      sync_interval_hours: this.config.sync_interval_hours,
      approval_phrases_enabled: this.config.approval_phrases_enabled,
      projects: this.config.projects,
      repos: this.config.repos,
      tracker_version: this.config.tracker_version ?? '0.1.0',
    });
    for (const ev of this.journal.read()) applyEvent(this.state, ev);
    this.notesIndex = readJsonIfExists(path.join(stateDir(this.env), 'notes-index.json')) ?? {};
    const manifest = readJsonIfExists(path.join(stateDir(this.env), '..', 'projections', 'MANIFEST.json'));
    this.generationNumber = manifest ? Number(manifest.generation_id.replace('gen-', '')) || 0 : 0;
    ensureDir(this.layout.tickets);
    ensureDir(this.layout.sessions);
    ensureDir(this.layout.handoffs);
    ensureDir(requestsDir(this.env));
    writeRuntimeIdentity({
      store_id: this.storeMeta.store_id, machine_id: this.storeMeta.owner_machine_id, store_path: this.config.store_path,
      gate_enabled: this.config.gate_enabled !== false, approval_phrases_enabled: this.config.approval_phrases_enabled === true,
      allow_tools: (this.config.gate && this.config.gate.allow_tools) || [],
    }, this.env);
    this.publishAllBindings();
    this.markStaleNotesDirty();
    this.heartbeat(true);
    for (const ext of this.extensions) if (ext.onStart) await ext.onStart(this);
    this.running = true;
    this.markGenerationDirty();
    this.publishGeneration();
    return this;
  }

  // After replay, notes whose recorded revision lags the rebuilt state (or were never written)
  // are re-materialized by the normal flush path.
  markStaleNotesDirty() {
    for (const ticket of this.state.tickets.values()) {
      const prior = this.notesIndex[ticket.id];
      if (!prior || prior.revision !== ticket.revision || !fs.existsSync(prior.path)) this.dirtyTickets.add(ticket.id);
    }
    for (const key of this.state.sessions.keys()) this.dirtySessions.add(key);
    for (const id of this.state.handoffs.keys()) this.dirtyHandoffs.add(id);
    if ((this.dirtyTickets.size || this.dirtySessions.size || this.dirtyHandoffs.size) && this.firstDirtyAt === null) this.firstDirtyAt = this.clock();
  }

  use(extension) {
    this.extensions.push(extension);
    return this;
  }

  heartbeat(force = false) {
    const ms = this.clock();
    if (!force && ms - this.lastHeartbeatMs < HEARTBEAT_MS) return;
    this.lastHeartbeatMs = ms;
    writeHeartbeat({ at: toIso(ms), pid: process.pid, store_id: this.storeMeta.store_id, generation: this.generationNumber }, this.env);
  }

  // Small control markers written by the CLI: flush now, restore a conflicted note, stop.
  processControl() {
    const dir = path.join(stateDir(this.env), 'control');
    if (removeIfExists(path.join(dir, 'flush.json'))) this.flushRequested = true;
    for (const name of listFiles(path.join(dir, 'restore'), (f) => f.endsWith('.json'))) {
      const ticketId = name.replace(/\.json$/, '');
      const ticket = this.state.tickets.get(ticketId);
      if (ticket) {
        writeNote(this.ticketNotePath(ticket), ticket, { state: this.state, index: this.notesIndex, force: true });
        this.markGenerationDirty();
      }
      removeIfExists(path.join(dir, 'restore', name));
    }
    if (fs.existsSync(path.join(dir, 'stop.json'))) {
      removeIfExists(path.join(dir, 'stop.json'));
      this.stopRequested = true;
    }
  }

  tick() {
    this.heartbeat();
    this.processControl();
    this.ingestOnce();
    const nowMs = this.clock();
    if (this.flushRequested || (this.firstDirtyAt !== null && nowMs >= this.firstDirtyAt + NOTE_FLUSH_MS)) this.flushNotes();
    for (const ext of this.extensions) if (ext.tick) ext.tick(this);
    if (this.generationDirty) this.publishGeneration();
  }

  // Serial ingestion: validate, dedupe, journal (fsync), apply, remove ingress (TRD §Durability 3).
  ingestOnce() {
    const entries = listIngress(this.env);
    let ingested = 0;
    for (const entry of entries) {
      if (entry.error) {
        this.log(`quarantining ${entry.name}: ${entry.error}`);
        quarantineIngress(entry.name, this.env);
        continue;
      }
      const ev = entry.event;
      try {
        validateEvent(ev);
      } catch (err) {
        this.log(`quarantining ${entry.name}: ${err.message}`);
        quarantineIngress(entry.name, this.env);
        continue;
      }
      if (ev.store_id !== this.storeMeta.store_id) {
        quarantineIngress(entry.name, this.env);
        continue;
      }
      if (this.journal.hasEvent(ev.event_id) || this.journal.hasSource(ev.source_identity)) {
        removeIngress(entry.name, this.env);
        continue;
      }
      const record = this.journal.append(ev);
      this.applyRecord(record);
      removeIngress(entry.name, this.env);
      ingested += 1;
    }
    return ingested;
  }

  // Worker-produced events (reconcile, request-tx, handoff-tx) bypass ingress but share the journal lane.
  emit(kind, payload, extra = {}) {
    const ev = makeEvent({ kind, payload, store_id: this.storeMeta.store_id, machine_id: this.storeMeta.owner_machine_id, producer: 'worker', occurred_at: this.now(), ...extra });
    const record = this.journal.append(ev);
    const result = this.applyRecord(record);
    return { event: record, result };
  }

  // CLI producers wait for this acknowledgement: it exists only after the journal transaction.
  ack(record, result) {
    if (record.producer !== 'cli') return;
    writeJsonAtomic(path.join(stateDir(this.env), 'acks', `${record.event_id}.json`), {
      event_id: record.event_id, sequence: record.sequence, kind: record.kind, rejected: result.rejected ?? null, duplicate: result.duplicate === true, at: this.now(),
    });
  }

  applyRecord(record) {
    const result = applyEvent(this.state, record);
    this.ack(record, result);
    if (result.duplicate) return result;
    for (const id of result.changed) {
      if (this.state.tickets.has(id)) this.dirtyTickets.add(id);
    }
    if (record.session_id) this.dirtySessions.add(sessionKey(record));
    for (const id of result.handoffsChanged) this.dirtyHandoffs.add(id);
    for (const key of result.bindingChanged) this.publishBinding(key);
    for (const id of result.requestsChanged) this.publishRequest(id);
    if ((result.changed.size || result.handoffsChanged.size || record.session_id) && this.firstDirtyAt === null) this.firstDirtyAt = this.clock();
    for (const effect of result.effects) {
      if (effect.type === 'flush') this.flushRequested = true;
      else this.pendingEffects.push(effect);
    }
    if (record.kind === 'stop' || record.kind === 'subagent-stop') this.flushRequested = true;
    this.markGenerationDirty();
    return result;
  }

  markGenerationDirty() {
    this.generationDirty = true;
  }

  publishBinding(key) {
    const session = this.state.sessions.get(key);
    if (!session) return;
    const ticket = session.current_ticket_id ? this.state.tickets.get(session.current_ticket_id) : null;
    writeBindingSnapshot(key, {
      session_id: session.id,
      ticket_id: ticket ? ticket.id : null,
      ticket_key: ticket ? ticket.key : null,
      ticket_title: ticket ? ticket.title : null,
      project_id: session.project_ids[session.project_ids.length - 1] ?? null,
      binding_revision: session.current_binding_revision,
      gate_enabled: session.gate_enabled,
      revision_committed_at: this.now(),
    }, this.env);
  }

  publishAllBindings() {
    for (const key of this.state.sessions.keys()) this.publishBinding(key);
  }

  publishRequest(id) {
    const req = this.state.requests.get(id);
    if (!req) return;
    writeJsonAtomic(path.join(requestsDir(this.env), `${id}.json`), req);
  }

  ticketNotePath(ticket) {
    return path.join(this.layout.tickets, `${safeKeyFileName(ticket.key)}.md`);
  }

  // Dirty notes flush no later than 30 s after the first unmaterialized event (TRD §Durability 5).
  flushNotes() {
    const outcomes = { written: 0, unchanged: 0, conflict: 0 };
    for (const id of this.dirtyTickets) {
      const ticket = this.state.tickets.get(id);
      if (!ticket) continue;
      const file = this.ticketNotePath(ticket);
      const prior = this.notesIndex[ticket.id];
      if (prior && prior.path && prior.path !== file && fs.existsSync(prior.path) && !fs.existsSync(file)) {
        // Key changed (relink): move the note so authored text travels with the ticket.
        try { fs.renameSync(prior.path, file); } catch { /* fall through to fresh write */ }
      }
      const outcome = writeNote(file, ticket, { state: this.state, index: this.notesIndex });
      outcomes[outcome] += 1;
      if (outcome === 'conflict') this.markGenerationDirty();
    }
    for (const key of this.dirtySessions) {
      const session = this.state.sessions.get(key);
      if (!session) continue;
      writeGeneratedNote(path.join(this.layout.sessions, `${snapshotFileName(key).replace(/\.json$/, '')}.md`), renderSessionNote(session, { state: this.state }));
    }
    for (const id of this.dirtyHandoffs) {
      const handoff = this.state.handoffs.get(id);
      if (!handoff) continue;
      writeGeneratedNote(path.join(this.layout.handoffs, `${id}.md`), renderHandoffNote(handoff, { state: this.state }));
    }
    writeJsonAtomic(path.join(stateDir(this.env), 'notes-index.json'), this.notesIndex);
    this.dirtyTickets.clear();
    this.dirtySessions.clear();
    this.dirtyHandoffs.clear();
    this.firstDirtyAt = null;
    this.flushRequested = false;
    return outcomes;
  }

  derived() {
    return this.derive ? this.derive(this.state, this.now()) : {};
  }

  snapshotOptions() {
    const now = this.now();
    const capture = captureHealth(this.env, { now, journalInfo: this.journalInfo ?? {} });
    const active = [...this.state.requests.values()].find((r) => r.kind === 'refresh' && ['pending', 'applying'].includes(r.state));
    return { derived: this.derived(), capture, worker_seen_at: now, active_sync_request_id: active ? active.id : null };
  }

  publishGeneration() {
    this.generationNumber += 1;
    this.lastSnapshot = publishGeneration(this.state, { env: this.env, now: this.now(), generationNumber: this.generationNumber, snapshotOptions: this.snapshotOptions() });
    this.generationDirty = false;
    return this.lastSnapshot;
  }

  getSnapshot() {
    if (!this.lastSnapshot || this.generationDirty) return this.publishGeneration();
    return this.lastSnapshot;
  }

  liveSnapshot() {
    return buildSnapshot(this.state, { generation_id: this.lastSnapshot ? this.lastSnapshot.generation_id : 'gen-00000000', generated_at: this.now(), ...this.snapshotOptions() });
  }

  async stop({ flush = true, ...extOptions } = {}) {
    this.running = false;
    for (const ext of this.extensions) if (ext.onStop) await ext.onStop(this, extOptions);
    if (flush && this.state) {
      try { this.flushNotes(); } catch (err) { this.log(`flush on stop failed: ${err.message}`); }
    }
    this.journal.close();
    if (this.lock) await this.lock.release();
    this.lock = null;
  }
}

export function pendingRequestFiles(env) {
  return listFiles(requestsDir(env), (f) => f.endsWith('.json'));
}

export function removeRequestFile(id, env) {
  return removeIfExists(path.join(requestsDir(env), `${id}.json`));
}
