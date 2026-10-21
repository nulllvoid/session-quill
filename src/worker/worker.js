// The single local writer. Owns ingestion, journal, state, projections, note materialization,
// heartbeat and (through extensions) requests, reconciliation and handoffs (ADR 0001, TRD §Durability).
import path from 'node:path';
import fs from 'node:fs';
import { Journal } from '../core/journal.js';
import { validateEvent, makeEvent, INGRESS_KINDS } from '../core/events.js';
import { listIngress, removeIngress, quarantineIngress } from '../core/ingress.js';
import { createState, sessionKey } from '../core/state.js';
import { applyEvent } from '../core/reducer.js';
import { readCheckpoint, writeCheckpoint, metaFingerprint } from '../core/checkpoint.js';
import { safeKeyFileName } from '../core/keys.js';
import { journalPath, stateDir, requestsDir, configPath, quillHome } from '../lib/paths.js';
import { ensureDir, writeJsonAtomic, readJsonIfExists, listFiles, removeIfExists } from '../lib/atomic-fs.js';
import { toIso, SECOND } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';
import { storeLayout } from '../config/store.js';
import { loadUserConfig, criticalSettings } from '../config/config.js';
import { buildRuntimeIdentity, identityStamp } from '../config/runtime.js';
import { onboardSettings } from '../onboard/settings.js';
import { keyExample } from '../core/external-keys.js';
import { acquireLock } from './lock.js';
import { writeBindingSnapshot, readBindingSnapshot, writeHeartbeat, writeRuntimeIdentity, snapshotFileName } from '../hooks/binding-snapshot.js';
import { renderSessionNote, writeNote, writeGeneratedNote, writeHandoffNote, handoffHasVaultNote } from './notes.js';
import { publishGeneration, buildSnapshot } from './projections.js';
import { captureHealth } from './health.js';
import { effectiveEnvironments } from '../deploy/environments.js';
import { descriptionProblems, parseDescription } from '../core/description.js';
import { writeProjections as writeMemoryProjections } from '../memory/project.js';
import { memoryPaths } from '../memory/paths.js';
import { latestInventory } from '../handoff/inventory.js';
import { ContextCards } from '../memory/blast-radius.js';

// What hooks need to know about a bound ticket, with a signature to tell when it changed.
function ticketFacts(ticket) {
  const valid = descriptionProblems(ticket.summary).length === 0;
  const done = valid ? parseDescription(ticket.summary).done.slice(0, 10).map((d) => d.slice(0, 300)) : [];
  return { valid, done, signature: JSON.stringify([valid, ticket.status, ticket.repo_id ?? null, done]) };
}

export const NOTE_FLUSH_MS = 30 * SECOND;
export const HEARTBEAT_MS = 5 * SECOND;
export const IDENTITY_CHECK_MS = 10 * SECOND;
export const PROVISIONAL_MAX_MS = 30 * SECOND;
// Memory projections are rewritten after memory events apply, and at least this often so entries
// move to ## Stale as they age (unchanged files are not rewritten).
export const MEMORY_REFRESH_MS = 60 * 60 * SECOND;
// A state checkpoint (ADR 0030) is written on an idle tick once this many events were journaled
// since the last one ([worker] checkpoint_every), and on stop.
export const CHECKPOINT_EVERY = 500;

function checkpointEvery(config) {
  const n = config && config.worker ? config.worker.checkpoint_every : undefined;
  return Number.isInteger(n) && n > 0 ? n : CHECKPOINT_EVERY;
}

export class Worker {
  constructor({ config, storeMeta, env = process.env, clock = Date.now, derive = null, log = () => {}, identityCheckMs = IDENTITY_CHECK_MS }) {
    this.config = config;
    this.identityCheckMs = identityCheckMs;
    this.identityStampValue = null;
    this.lastIdentityCheckMs = 0;
    this.identityWarnings = new Set();
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
    this.publishedTicketFacts = new Map(); // session key -> ticket facts the hooks last saw
    this.firstDirtyAt = null;
    this.flushRequested = false;
    this.generationDirty = false;
    this.generationNumber = 0;
    this.detailDirty = null; // null = write every ticket detail on the next publish
    this.lastHeartbeatMs = 0;
    this.lastSnapshot = null;
    this.notesIndex = {};
    this.extensions = [];
    this.running = false;
    this.pendingEffects = [];
    this.memoryDirty = true;
    this.lastMemoryProjectionMs = -Infinity;
    this.memoryProblems = new Set();
    this.contextCards = new ContextCards();
    this.checkpointEvery = checkpointEvery(config);
    this.checkpointSequence = 0; // journal sequence of the last checkpoint written or hydrated
    this.checkpointError = null;
    this.loadedMetaFingerprint = null; // the reducer-visible meta state was built with
    this.stateLoad = null; // how start() built state: { source, events_replayed, checkpoint_ignored, ms }
  }

  now() {
    return toIso(this.clock());
  }

  async start() {
    this.lock = await acquireLock(this.storeMeta.store_id, this.storeMeta.owner_machine_id, this.env);
    const ignored = this.loadState();
    if (ignored === null) {
      await this.lock.release();
      throw new TrackerError('journal-corrupt', 'journal has mid-log corruption; run `quill doctor` and recover before starting the worker');
    }
    this.notesIndex = readJsonIfExists(path.join(stateDir(this.env), 'notes-index.json')) ?? {};
    const manifest = readJsonIfExists(path.join(stateDir(this.env), '..', 'projections', 'MANIFEST.json'));
    this.generationNumber = manifest ? Number(manifest.generation_id.replace('gen-', '')) || 0 : 0;
    ensureDir(this.layout.tickets);
    ensureDir(this.layout.sessions);
    ensureDir(this.layout.handoffs);
    ensureDir(requestsDir(this.env));
    this.publishIdentity();
    for (const reason of ignored) {
      this.log(`state checkpoint ignored: ${reason}`);
      this.recordHealthError({ kind: 'state-checkpoint', error: `state checkpoint ignored: ${reason}` });
    }
    for (const e of this.replayErrors ?? []) this.recordHealthError({ kind: 'apply-error', phase: 'replay', ...e });
    this.replayErrors = [];
    this.publishAllBindings();
    this.contextCards.noteAllBound(this);
    this.markStaleNotesDirty();
    this.heartbeat(true);
    for (const ext of this.extensions) if (ext.onStart) await ext.onStart(this);
    this.running = true;
    this.markGenerationDirty();
    this.publishGeneration();
    this.publishMemory();
    return this;
  }

  // Opens the journal and builds state: the last state checkpoint hydrated plus the journal after it
  // (ADR 0030), else the whole journal. Any mismatch (versions, the configuration the reducer reads,
  // a journal that no longer ends the checkpointed event at its offset) replays the whole journal;
  // meta always comes from current configuration. Returns why a checkpoint was ignored (reasons for
  // a health note), or null when the journal is corrupt.
  loadState() {
    const loadStarted = performance.now();
    const fresh = createState({
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
      tracker_version: this.config.tracker_version ?? '1.0.0',
    });
    this.loadedMetaFingerprint = metaFingerprint(fresh.meta);
    const ignored = [];
    const checkpoint = readCheckpoint({ env: this.env, meta: fresh.meta, onIgnore: (reason) => ignored.push(reason) });
    this.journalInfo = this.journal.open(checkpoint ? { resume: { byteOffset: checkpoint.byteOffset, sequence: checkpoint.sequence, lastEventId: checkpoint.lastEventId, eventIds: checkpoint.state.appliedEvents, sourceIds: checkpoint.state.appliedSources } } : {});
    if (this.journalInfo.corrupt) return null;
    let fromByte = 0;
    if (checkpoint && this.journalInfo.resumed) {
      this.state = { meta: fresh.meta, ...checkpoint.state };
      this.checkpointSequence = checkpoint.sequence;
      fromByte = checkpoint.byteOffset;
    } else {
      if (checkpoint) ignored.push(this.journalInfo.resume_ignored ?? 'the journal could not be resumed');
      this.state = fresh;
      this.checkpointSequence = 0;
    }
    let replayed = 0;
    for (const ev of this.journal.read({ fromByte })) { this.safeApply(ev, { replay: true }); replayed += 1; }
    this.stateLoad = { source: fromByte ? 'checkpoint' : 'journal', events_replayed: replayed, checkpoint_ignored: ignored[0] ?? null, ms: Math.round(performance.now() - loadStarted) };
    return ignored;
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

  // Effective deployment environments for a repository (ADR 0009): its own list, else the tracker's
  // (repository .quill.toml first, then user config), else production.
  environmentsFor(repoId) {
    return this.environmentsResolution(repoId).list;
  }

  // { list, error }: error names why a repository's environments are unknown (an unreadable
  // .quill.toml, an invalid list). The list then falls back to production for display only;
  // reconciliation never journals a merge against it.
  environmentsResolution(repoId) {
    const repo = repoId ? (this.config.repos ?? {})[repoId] : null;
    if (repo && Array.isArray(repo.deployment_environments) && repo.deployment_environments.length) return { list: [...repo.deployment_environments], error: null };
    const scope = this.identity && repoId ? (this.identity.repos ?? []).find((r) => r.repo_id === repoId) : null;
    const source = scope ?? this.identity ?? {};
    return { list: effectiveEnvironments(null, { environments: source.environments ?? null }), error: source.environments_error ?? null };
  }

  publishIdentity() {
    const { identity, warnings } = buildRuntimeIdentity({ storeMeta: this.storeMeta, config: this.config });
    writeRuntimeIdentity(identity, this.env);
    this.identity = identity;
    for (const w of warnings) {
      if (this.identityWarnings.has(w)) continue;
      this.identityWarnings.add(w);
      this.log(`config: ${w}`);
      this.recordHealthError({ kind: 'config-invalid', error: w });
    }
    this.identityStampValue = identityStamp(this.config, this.env);
  }

  // Gate mode and tracker edits in config.toml or a registered .quill.toml apply without a restart.
  refreshIdentity() {
    const ms = this.clock();
    if (ms - this.lastIdentityCheckMs < this.identityCheckMs) return;
    this.lastIdentityCheckMs = ms;
    if (identityStamp(this.config, this.env) === this.identityStampValue) return;
    try {
      if (fs.existsSync(configPath(this.env))) {
        const fresh = loadUserConfig(this.env);
        // Repositories added or removed (quill init, quill repo) while the worker runs must reach the identity too.
        this.config = {
          ...this.config, gate_enabled: fresh.gate_enabled, gate: fresh.gate, tracker: fresh.tracker, schedule: fresh.schedule, publish: fresh.publish, claude_path: fresh.claude_path,
          repos: fresh.repos ?? {}, projects: { ...this.config.projects, ...fresh.projects }, default_project: fresh.default_project || this.config.default_project,
        };
        this.state.meta.repos = this.config.repos;
        this.state.meta.projects = this.config.projects;
      }
    } catch (err) {
      this.recordHealthError({ kind: 'config-invalid', error: `config.toml: ${err.message}` });
    }
    this.publishIdentity();
  }

  // Re-reads config.toml now rather than at the next identity check, so a repository registered a
  // moment ago (a clone, ADR 0024) can be linked to a ticket straight away.
  reloadConfig() {
    this.lastIdentityCheckMs = -Infinity;
    this.identityStampValue = null;
    this.refreshIdentity();
  }

  // Small control markers written by the CLI: reload config, flush now, restore a conflicted note, stop.
  processControl() {
    const dir = path.join(stateDir(this.env), 'control');
    if (removeIfExists(path.join(dir, 'reload-config.json'))) this.reloadConfig();
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
    this.refreshIdentity();
    this.processControl();
    const ingested = this.ingestOnce();
    const nowMs = this.clock();
    if (this.flushRequested || (this.firstDirtyAt !== null && nowMs >= this.firstDirtyAt + NOTE_FLUSH_MS)) this.flushNotes();
    for (const ext of this.extensions) if (ext.tick) ext.tick(this);
    this.publishMemory();
    this.contextCards.tick(this);
    if (this.generationDirty) this.publishGeneration();
    // Serialising state blocks the loop, so it waits for a tick with nothing to ingest.
    if (ingested === 0 && this.journal.lastSequence - this.checkpointSequence >= this.checkpointEvery) this.writeStateCheckpoint();
  }

  // The reduced state at the journal's current position (ADR 0030). Every journaled event has been
  // applied whenever this runs (append and apply happen together), so the two always agree. A
  // failure is logged once per message and retried after another checkpoint_every events. After a
  // live configuration change the reducer can see (refreshIdentity), state mixes events reduced
  // under both configurations, which no replay reproduces: no checkpoint is written until a restart
  // replays the journal under the new one.
  writeStateCheckpoint() {
    if (!this.state || this.journal.fd === null || this.journal.corrupt) return false;
    if (metaFingerprint(this.state.meta) !== this.loadedMetaFingerprint) return false;
    const position = this.journal.position();
    if (position.sequence < 1 || position.sequence === this.checkpointSequence) return false;
    try {
      writeCheckpoint(this.state, { ...position, env: this.env });
      this.checkpointError = null;
      return true;
    } catch (err) {
      if (this.checkpointError !== err.message) {
        this.checkpointError = err.message;
        this.log(`state checkpoint not written: ${err.message}`);
        this.recordHealthError({ kind: 'state-checkpoint', error: `state checkpoint not written: ${err.message}` });
      }
      return false;
    } finally {
      this.checkpointSequence = position.sequence;
    }
  }

  // The Markdown projections of memory under quillHome()/memory (spec §6.1), written from state after
  // the journal applied the events (ADR 0001). Nothing is created for a store that has no memory yet.
  publishMemory() {
    const ms = this.clock();
    if (!this.memoryDirty && ms - this.lastMemoryProjectionMs < MEMORY_REFRESH_MS) return;
    this.memoryDirty = false;
    this.lastMemoryProjectionMs = ms;
    try {
      const home = quillHome(this.env);
      if (!this.state.memory.entries.size && !latestInventory(this.state) && !fs.existsSync(memoryPaths(home).root)) return;
      const { problems } = writeMemoryProjections(this.state, home, { now: ms });
      for (const p of problems) {
        if (this.memoryProblems.has(p)) continue;
        this.memoryProblems.add(p);
        this.log(`memory: ${p}`);
      }
    } catch (err) {
      this.log(`memory projections not written: ${err.message}`);
      this.recordHealthError({ kind: 'memory-projection', error: err.message });
    }
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
      // R59 (final review I3): only the worker emits its own kinds (request-tx, handoff-tx, memory-tx,
      // reconcile, notify, critical-proposal …). One arriving through ingress (a page, the CLI, or
      // anything that can write the ingress folder, an autonomous run included) is never journaled,
      // whatever producer it claims, and the owner sees a health problem.
      if (!INGRESS_KINDS.has(ev.kind)) {
        this.log(`quarantining ${entry.name}: ${ev.kind} events come only from the worker`);
        quarantineIngress(entry.name, this.env);
        this.recordHealthError({ kind: 'ingress-forged', event_kind: ev.kind, event_id: ev.event_id, producer: typeof ev.producer === 'string' ? ev.producer.slice(0, 40) : null, error: `a ${ev.kind} event arrived through ingress; only the worker writes that kind, so it was quarantined` });
        continue;
      }
      // Requests the worker journals itself (dashboard, schedules) never arrive through ingress, so a
      // request there claiming the worker as producer is forged (ADR 0028: critical approval).
      if (ev.kind === 'request' && ev.producer === 'worker') {
        this.log(`quarantining ${entry.name}: a request through ingress cannot claim the worker as producer`);
        quarantineIngress(entry.name, this.env);
        continue;
      }
      if (this.journal.hasEvent(ev.event_id) || this.journal.hasSource(ev.source_identity)) {
        // Duplicate delivery has one effect; CLI producers still get an acknowledgement.
        this.ack({ ...ev, sequence: null }, { duplicate: true });
        removeIngress(entry.name, this.env);
        continue;
      }
      // A link to a repository registered moments ago (a clone, ADR 0024) must not race the config
      // reload: an unknown repository id makes the worker re-read config.toml before applying.
      const linkTo = ev.kind === 'ticket-update' && ev.payload && ev.payload.fields ? ev.payload.fields.repo_id : null;
      if (typeof linkTo === 'string' && !Object.hasOwn(this.state.meta.repos ?? {}, linkTo)) {
        removeIfExists(path.join(stateDir(this.env), 'control', 'reload-config.json'));
        this.reloadConfig();
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
      ...(result.ticket ? { ticket: result.ticket } : {}),
    });
  }

  // A reducer exception must never poison the journal: the event is marked applied (so replay is
  // deterministic), rejected with a health error, and the loop continues.
  safeApply(record, { replay = false } = {}) {
    try {
      const result = applyEvent(this.state, record);
      // A refused critical-proposal (spec §7.2) is never silent: it becomes a health error.
      if (record.kind === 'critical-proposal' && result.rejected) {
        const problem = { kind: 'critical-proposal-rejected', event_id: record.event_id, code: result.rejected };
        if (!replay) this.recordHealthError(problem);
        else this.replayErrors = [...(this.replayErrors ?? []), problem];
      }
      return result;
    } catch (err) {
      this.state.appliedEvents.add(record.event_id);
      if (record.source_identity) this.state.appliedSources.add(record.source_identity);
      if (Number.isInteger(record.sequence) && record.sequence > this.state.lastSequence) this.state.lastSequence = record.sequence;
      this.log(`apply-error on ${record.kind} ${record.event_id}: ${err.message}`);
      if (!replay) this.recordHealthError({ kind: 'apply-error', event_id: record.event_id, event_kind: record.kind, error: err.message });
      else this.replayErrors = [...(this.replayErrors ?? []), { event_id: record.event_id, event_kind: record.kind, error: err.message }];
      return { changed: new Set(), bindingChanged: new Set(), requestsChanged: new Set(), handoffsChanged: new Set(), effects: [], rejected: 'apply-error', error: err.message };
    }
  }

  recordHealthError(record) {
    try {
      const file = path.join(stateDir(this.env), 'health-errors.jsonl');
      ensureDir(path.dirname(file));
      fs.appendFileSync(file, JSON.stringify({ at: this.now(), ...record }) + '\n');
    } catch { /* storage unavailable */ }
  }

  applyRecord(record) {
    const result = this.safeApply(record);
    this.ack(record, result);
    if (result.duplicate) return result;
    for (const id of result.changed) {
      if (this.state.tickets.has(id)) { this.dirtyTickets.add(id); if (this.detailDirty) this.detailDirty.add(id); }
    }
    if (record.session_id) this.dirtySessions.add(sessionKey(record));
    for (const id of result.handoffsChanged) this.dirtyHandoffs.add(id);
    for (const key of result.bindingChanged) this.publishBinding(key);
    // Hooks act on the bound ticket's description, status, repository and Done when items from the
    // binding snapshot, so a session bound to a changed ticket is republished when any of those
    // change, and only then.
    if (result.changed.size) {
      for (const [key, session] of this.state.sessions) {
        if (result.bindingChanged.has(key) || !session.current_ticket_id || !result.changed.has(session.current_ticket_id)) continue;
        if (this.publishedTicketFacts.get(key) !== ticketFacts(this.state.tickets.get(session.current_ticket_id)).signature) this.publishBinding(key);
      }
    }
    this.contextCards.note(this, result);
    for (const id of result.requestsChanged) this.publishRequest(id);
    if ((result.changed.size || result.handoffsChanged.size || record.session_id) && this.firstDirtyAt === null) this.firstDirtyAt = this.clock();
    for (const effect of result.effects) {
      if (effect.type === 'flush') this.flushRequested = true;
      else this.pendingEffects.push(effect);
    }
    if (record.kind === 'stop' || record.kind === 'subagent-stop') this.flushRequested = true;
    if (record.kind === 'memory-tx' || (record.kind === 'handoff-tx' && record.payload && record.payload.update && record.payload.update.inventory)) this.memoryDirty = true;
    this.markGenerationDirty();
    return result;
  }

  markGenerationDirty() {
    this.generationDirty = true;
  }

  publishBinding(key) {
    const session = this.state.sessions.get(key);
    if (!session) return;
    // A hook's provisional binding (ADR 0005) stands until its bind event is applied, so an
    // unrelated republish cannot undo a binding the user just made; stale ones are replaced.
    const existing = readBindingSnapshot(key, this.env);
    if (existing && existing.provisional === true && existing.provisional_event_id && !this.state.appliedEvents.has(existing.provisional_event_id)) {
      const age = Math.abs(this.clock() - Date.parse(existing.provisional_at ?? ''));
      if (age < PROVISIONAL_MAX_MS) return;
    }
    const ticket = session.current_ticket_id ? this.state.tickets.get(session.current_ticket_id) : null;
    const facts = ticket ? ticketFacts(ticket) : null;
    this.publishedTicketFacts.set(key, facts ? facts.signature : null);
    writeBindingSnapshot(key, {
      session_id: session.id,
      ticket_id: ticket ? ticket.id : null,
      ticket_key: ticket ? ticket.key : null,
      ticket_title: ticket ? ticket.title : null,
      ticket_aliases: ticket ? [...ticket.aliases] : [],
      project_id: session.project_ids[session.project_ids.length - 1] ?? null,
      binding_revision: session.current_binding_revision,
      gate_enabled: session.gate_enabled,
      has_title: !!session.title,
      ticket_has_description: facts ? facts.valid : null,
      ticket_status: ticket ? ticket.status : null,
      ticket_repo_id: ticket ? ticket.repo_id ?? null : null,
      ticket_done_when: facts ? facts.done : [],
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
    const outcomes = { written: 0, unchanged: 0, conflict: 0, skipped: 0 };
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
    // R49: a requested flush (`quill sync --notes`) also sweeps runs that have no vault note, so a
    // note an earlier version wrote for one is removed; worker start marks every run dirty anyway.
    if (this.flushRequested) for (const h of this.state.handoffs.values()) if (!handoffHasVaultNote(h, this.state)) this.dirtyHandoffs.add(h.id);
    for (const id of this.dirtyHandoffs) {
      const handoff = this.state.handoffs.get(id);
      if (!handoff) continue;
      writeHandoffNote(path.join(this.layout.handoffs, `${id}.md`), handoff, { state: this.state });
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
    const tracker = this.identity ? (this.identity.tracker ?? (this.identity.repos ?? []).map((r) => r.tracker).find(Boolean) ?? null) : null;
    const schedules = this.scheduleInfo ? this.scheduleInfo() : null;
    const reconcile = schedules ? schedules.find((s) => s.job === 'reconcile' && s.enabled) : null;
    return {
      derived: this.derived(), capture, worker_seen_at: now, active_sync_request_id: active ? active.id : null, key_example: keyExample(tracker),
      schedules: schedules ?? [], next_sync_due: schedules ? (reconcile ? reconcile.next_due : null) : undefined,
      recipes: this.recipeInfo ? this.recipeInfo() : [],
      environmentsFor: (repoId) => this.environmentsFor(repoId),
      publishers: this.publishInfo ? this.publishInfo() : [],
      handoff_limits: this.handoffLimits ? this.handoffLimits() : null,
      autonomy: this.autonomyInfo ? this.autonomyInfo() : null,
      critical_dry_run: criticalSettings(this.config ?? {}).requireDryRun,
      onboarding: (({ clone_hosts, auto_clone_dir, import_assigned }) => ({ clone_hosts, auto_clone_dir, import_assigned }))(onboardSettings(this.config.tracker)),
    };
  }

  publishGeneration() {
    this.generationNumber += 1;
    const changedTickets = this.detailDirty ? [...this.detailDirty] : null;
    this.lastSnapshot = publishGeneration(this.state, { env: this.env, now: this.now(), generationNumber: this.generationNumber, snapshotOptions: this.snapshotOptions(), changedTickets });
    this.detailDirty = new Set();
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
    await this.contextCards.stop();
    if (flush && this.state) {
      try { this.flushNotes(); } catch (err) { this.log(`flush on stop failed: ${err.message}`); }
    }
    this.writeStateCheckpoint();
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
