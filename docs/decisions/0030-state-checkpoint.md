# ADR 0030 — State checkpoint for fast worker start

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md) and [ADR 0002](0002-local-store-mandatory.md) · Spec: PRD 2.0.0 §4 "Journal snapshot compaction" as adopted in `docs/research/2.0.0/01-gap-analysis.md` · Plan: `docs/superpowers/plans/2026-10-21-quill-2.0.0.md` Task 2

## Context

The worker builds its state by replaying the whole journal on every start (`Worker.start`), and `quill memory list|show` do the same through `replayState`. The journal is one append-only file. `Journal.open()` reads and parses all of it to check sequences and collect the event and source ids it deduplicates by, and replay then reads and parses it a second time.

The PRD asked for a "materialized state checkpoint every 500 events in store.js" that the reducer hydrates. It called that a snapshot; Quill already uses "snapshot" for the dashboard projection (`MANIFEST.json` and each generation's `snapshot.json`), for shared read-only exports (ADR 0002) and for run snapshots (Task 7), so this ADR says "state checkpoint". Turn checkpoints (a captured Stop) are a third, unrelated thing.

### Where start time goes (measured first)

A19 records "Replay on start" as 3.9 s at 20,000 events and 12.9 s at 100,000 (`docs/ACCEPTANCE-RESULTS.md`). That figure is the whole `start()`, not the replay. Split on this machine (Windows 11, Node 24.19, ten agents sharing the CPU, so absolute numbers run high), with the A19 journal shape:

| Phase | 20k events | 100k events |
| --- | --- | --- |
| `Journal.open` (read, parse, sequence and id check) | 49 ms | 263 ms |
| Replay: read and parse again | 47 ms | 228 ms |
| Replay: reducer apply | 126 ms | 473 ms |
| `publishAllBindings` (200 sessions) | 510 ms | 580 ms |
| First `publishGeneration` (every ticket detail written) | 6.4 s | 25.3 s |

So the reducer replay is 0.2 s at 20k and about 1 s at 100k. The heartbeat is written after replay and bindings, before extensions start and before the first generation publish, so the replay is on the path to a healthy worker for the hooks; the generation publish is not, and this ADR leaves it alone (see Consequences).

## Decision

- **What is written.** `src/core/checkpoint.js` writes `<stateDir>/state.checkpoint.json` with `writeFileAtomic` (temp file, fsync, rename): `{ format: 1, reducer_version, package_version, code_fingerprint, meta_fingerprint, sequence, byte_offset, last_event_id, state }`. `state` is the reduced state without `state.meta`. Maps, Sets, `undefined`, non-finite numbers and `-0` are tagged values (`$m`, `$s`, `$u`, `$n`); an object whose key starts with `$` or is `__proto__` is written as key/value pairs (`$o`) so it can never read as a tag or a prototype; an object or array reached twice is written once and then referenced (`$r`), so records the state reaches by two paths (a session under `sessions` and under `sessionsById`) are one object again after hydration. A value that is not plain data (a Date, a class instance) refuses to encode, and the checkpoint is not written.
- **Who writes it.** Only the worker (ADR 0001), and never inside the ingest loop: serialising blocks the event loop (65 ms at 20k events, 6 MB; about 340 ms at 100k, 29 MB, on this loaded machine). It writes on `stop()` when anything was journaled since the last checkpoint, and on an idle tick (a tick that ingested nothing) once `[worker] checkpoint_every` events (default 500; anything but a positive integer keeps the default) were journaled since the last one. Every journaled event is applied in the same synchronous step as its append, so the state written always matches `journal.position()`. A write failure is logged and recorded once per message as a `state-checkpoint` health error, and retried after another `checkpoint_every` events. After a live configuration change the reducer can see (`refreshIdentity` picking up an edited `config.toml`), the worker writes no checkpoint until it restarts: its state then mixes events reduced under both configurations, which no replay reproduces, and the restart replays the journal under the new one as it always did.
- **Who reads it.** Worker start (`Worker.loadState`) reads the checkpoint, opens the journal with `Journal.open({ resume })`, hydrates, sets `meta` built from current configuration, and replays only the events after `byte_offset`. `quill memory list|show` (`replayState(ctx, { readOnly: true })`) hydrate the same way without opening the journal and never write a checkpoint. A rebuild (`replayToStaging`, not read-only) always replays the whole journal, so recovery never depends on generated state.
- **When it is ignored.** Any of these makes the reader replay the whole journal; the worker records a health error "state checkpoint ignored: <reason>" (a missing file is not a problem and records nothing):
  - unreadable file or invalid JSON, a format other than 1, a malformed position or state;
  - `reducer_version` other than `REDUCER_VERSION` (exported from `src/core/reducer.js`; bump it whenever existing events reduce differently or state fields change);
  - `package_version` other than `package.json`'s;
  - `code_fingerprint` other than the sha256 of `src/core/reducer.js` and every module it reaches through relative imports. This catches a reducer change that forgot the bump, which matters because the owner runs Quill from a git checkout (`npm link`) where the package version only moves at release;
  - `meta_fingerprint` other than the one of the meta the reducer reads now (store id, machine id, machine name, approval phrases, projects, repositories). Replaying old events reads current repository configuration (`src/core/transitions.js`: merge evidence without journaled environments falls back to the repository's), so after such a change only a full replay gives what a full replay gives;
  - the journal no longer matches the position: it is shorter than `byte_offset`, or the line ending exactly at `byte_offset` is not the event with `last_event_id` and `sequence` (truncated, rewritten, restored or recovered journal). `Journal.open` then reads the whole file as before, so a torn tail is still quarantined and mid-log corruption still stops the worker. A torn or out-of-sequence line after the offset also falls back to the full read.
- **Journal resume.** `Journal.open({ resume: { byteOffset, sequence, lastEventId, eventIds, sourceIds } })` checks the resume point (`checkResumePoint`, read-only), then reads and checks only the bytes after it; the duplicate-suppression sets start from the checkpoint's `appliedEvents` and `appliedSources` (copied) plus the tail's ids. The result carries `resumed` and, when false, `resume_ignored`. `Journal` tracks its byte length and last event id so `position()` gives what a checkpoint records. `read({ fromByte })` yields only events after an offset.
- **Equivalence is the contract.** Hydrating at sequence N and replaying events N+1… deep-equals a full replay, for every cut point of a scripted journal covering tickets and children, sessions and subagents, tool results that wait for their call across the cut, stop checkpoints and heuristic approval, requests and their transactions, a handoff and its result child, memory, reconcile with a PR and a duplicate delivery (`tests/core/checkpoint.test.js`), with configuration held fixed.

## Measured result

`stateLoad` on the worker records `{ source: 'checkpoint' | 'journal', events_replayed, checkpoint_ignored, ms }` for each start. On this machine:

| Journal | Full replay | From checkpoint | Speed-up |
| --- | --- | --- | --- |
| 20k events (acceptance, best of three) | 212 ms | 42 ms | 5.0× |
| 100k events (one run, machine heavily loaded) | 4.2 s | 0.29 s | 15× |

`tests/acceptance/perf.test.js` asserts at least 3× at 20k events and that the hydrated state deep-equals the replayed state.

## Consequences

- A restart replays only what arrived since the last checkpoint: nothing after a clean stop, at most about `checkpoint_every` events (plus whatever arrived after the last idle tick) after a crash.
- The checkpoint is a cache. Deleting it is always safe; the next start replays the journal and the next idle tick writes a new one. It is local generated state under the Quill home, never exported, published, mirrored or written to the vault, and it holds everything the state holds (memory text and the quarantine included), so it has the journal's sensitivity.
- Replay problems (an apply error, a refused critical proposal) for events before the checkpoint are not recorded again at each start; they were recorded when the events were first applied.
- A restart after a configuration change the reducer can see replays the whole journal under the new configuration, exactly as before this ADR: the meta fingerprint ignores the older checkpoint, and a worker whose configuration changed while it ran writes none. Adding a repository therefore costs one full replay at the next restart.
- Worker start as a whole stays dominated by the first projection generation, which writes every ticket's detail file (about 6 s of the 20k start here). That is the next lever; it is outside this task.

## Residual risks

- **Same-size edits before the offset.** The resume check proves the event at the offset is the checkpointed one; an edit to an earlier line that keeps every byte offset is not detected. The journal is append-only and only the worker writes it; recovery rewrites change offsets or ids.
- **A reducer change outside the import graph.** The code fingerprint follows `src/core/reducer.js`'s relative imports; behaviour that reaches the reducer another way (a dynamic import, data files) would need a `REDUCER_VERSION` bump.

## Alternatives considered

- **A checkpoint every 500th event inside ingestion (the PRD).** Rejected: a synchronous multi-megabyte write in the ingest loop delays hook acknowledgements. Idle ticks and stop give the same bound without that.
- **Per-collection checkpoint files, or a binary format.** Rejected for now: one JSON file with an atomic rename is simple to verify and the load is already well under the 3× target.
- **Trusting the checkpoint's sequence without the offset check.** Rejected: a restored or recovered journal can reuse sequences for different events.
- **Letting `quill memory` write a checkpoint after a full replay.** Rejected: only the worker writes generated state (ADR 0001).
