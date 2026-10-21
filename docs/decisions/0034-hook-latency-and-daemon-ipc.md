# ADR 0034 — Hook latency: measure it, trim module loading, defer daemon IPC

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md) and [ADR 0022](0022-always-on-dashboard.md)

## Context

The 2.0.0 PRD (§4) asked for a Unix-socket daemon on `~/.quill/daemon.sock`, a hook "thin client" that forwards each event to it in under 5 ms, and a hook and status-line P99 under 15 ms. The gap analysis (`docs/research/2.0.0/01-gap-analysis.md`) found the premise does not hold on the machines Quill runs on: a bare `node -e ""` already takes about 47 ms on the reference Windows machine, so no Node entry point can answer in 5 ms, and Quill's own hook logic (`runHook`, in process) takes under 2 ms p95 at 100,000 events (`ACCEPTANCE-RESULTS.md`, A19). What the host waits for is Node start-up plus module loading.

Before this change, `scripts/bench-hooks.mjs` reported p50/p95/max for PreToolUse and PostToolUse only, and it passed `hook <Event>` to `bin/quill-hook.js`, which takes the event name alone; that entry measured an "unsupported hook event" early return (the 94 ms figure of 0.6.1 is that early return plus module loading). Nothing measured SessionStart or the status line, the two entries that load the most.

## Decision

**Measure first.** `scripts/bench-hooks.mjs` now reports p50, p95, p99 and max (200 calls each by default) for a bare `node` start, `quill-hook PreToolUse`, `PostToolUse` and `SessionStart`, the status-line script, and the in-process `runHook` for PreToolUse and PostToolUse. It sets up a throwaway `QUILL_HOME` with an initialized store, a bound session and a stand-in worker (a child process that holds the store lock and writes heartbeats and a dashboard endpoint), so SessionStart takes its normal "worker ready" path and the status line prints its link. `--json` prints the numbers as one object; `--entry bin/quill.js` adds the full CLI entry for comparison; `--baseline <checkout>` measures another checkout's entries too, alternating call by call with this one, so a loaded machine slows both alike.

**Keep a change only if it moves p95 by at least 3 ms.** Two did:

1. **A lean status line.** `scripts/statusline.js` no longer runs `src/cli/main.js` (the command table) and `status.js`, whose import of `runtime/readiness.js` pulled in the whole worker module graph: 67 modules. The line is now built by one function, `statusLine(ctx, input)` in `src/cli/statusline.js`, which both the lean script and `quill status --statusline` call; the script loads 18 modules. The output is unchanged byte for byte (`tests/cli/status.test.js` checks 14 states against the 1.1.1 output, including the OSC 8 link, the port-fallback note, a stale endpoint pid and an unreadable store, which still prints nothing).
2. **Lazy worker module in the readiness check.** `src/runtime/readiness.js` imports `cli/commands/worker.js` (and with it the worker) only when it is about to launch a worker. A SessionStart hook that finds the worker ready, paused, or starting no longer loads it. `quill status` and `quill doctor`, which import the readiness module for `pausePath`, benefit too.

**Before and after.** Windows 11, Node 24.19.0, 200 calls per case, `node scripts/bench-hooks.mjs --json --baseline <1.1.1 checkout>`, so each row pair was measured call by call on the same machine at the same time. The machine was heavily loaded throughout (ten agents running test suites; CPU at 88–99%), so absolute numbers sit well above the 0.6.1 figures and the tails are noisy. Three runs; the table shows the least loaded one (run 3, bare start closest to the 47 ms reference), with the p95 deltas of all three runs in the last column.

| Case | Before p50 / p95 / p99 | After p50 / p95 / p99 | p95 change, runs 1 / 2 / 3 |
| --- | --- | --- | --- |
| bare `node -e ""` | 50.8 / 62.1 / 68.8 ms | (same series) | |
| `quill-hook PreToolUse` | 129.9 / 176.1 / 208.2 ms | 131.1 / 178.5 / 207.5 ms | −8 / −30 / +2 ms (noise) |
| `quill-hook PostToolUse` | 118.6 / 132.2 / 146.1 ms | 118.5 / 131.7 / 143.2 ms | +13 / +33 / −0.5 ms (noise) |
| `quill-hook SessionStart` | 220.8 / 322.3 / 628.2 ms | 149.3 / 228.8 / 496.6 ms | −441 / −108 / −94 ms |
| `scripts/statusline.js` | 192.3 / 223.6 / 242.3 ms | 112.0 / 132.0 / 140.4 ms | −217 / −92 / −92 ms |
| in-process `runHook` PreToolUse | | 5.5 / 6.8 / 10.8 ms | |
| in-process `runHook` PostToolUse | | 6.4 / 7.8 / 12.1 ms | |

PreToolUse and PostToolUse load the same modules before and after, so their rows only show the noise floor. The in-process rows include the fsync of each ingress file; in the more loaded runs 1 and 2 their p99 reached 19–31 ms, which is disk contention rather than hook logic.

**Where the KPI stands.** In-process hook logic meets its p99 target on the least loaded run. Whole-process PreToolUse and PostToolUse do not yet come within 15 ms of a bare Node start: they sit about 70–115 ms above it at p95 here (about 53 ms on the unloaded 0.6.1 run), almost all of it loading the hook's roughly 30 modules. Reaching the target needs fewer modules on the per-tool-call path (see "Alternatives"), not IPC.

**Daemon IPC is deferred.** The hook keeps writing one fsynced ingress file per event (ADR 0001) and the status line keeps reading the binding snapshot, heartbeat and endpoint file. A socket client is not built, for these reasons:

- **ADR 0022 rejected a separate daemon.** The worker owns the store and serves the dashboard; a second long-lived process would need its own lifecycle and lock. Routing hooks through the worker instead makes hook capture depend on the worker being up, which ADR 0001 deliberately avoided: today a hook persists during a worker outage and the worker catches up.
- **Per-caller environment.** A hook's meaning depends on the environment of the process the host started: `QUILL_HANDOFF_ID`, `QUILL_HANDOFF_TICKET_ID`, `QUILL_HANDOFF_TICKET_KEY` and `QUILL_HANDOFF_GUARD` attribute an agent run's tool calls and switch the hook to capture-only; `QUILL_HOME` picks the store; `CLAUDE_PLANS_DIR` picks the plans folder. A daemon would have to receive and trust each caller's environment per request, which turns a local environment variable into a protocol field that any local process could forge.
- **Duplicate events on fallback.** A client must fall back to writing ingress itself when the daemon is slow or gone. If the daemon accepted the event but the reply missed the client's timeout, both copies land. The journal deduplicates by `source_identity`, but the identities of `prompt` and `subagent-start` events are `<kind>:<event_id>` with a fresh UUID per call, and `session-start`, `stop` and `subagent-stop` identities include the hook's timestamp, so a retried send is a new event, not a duplicate. Making every identity deterministic is a contract change of its own.
- **A busy worker delays hooks.** The worker replays, publishes projections and runs agents on one event loop. A hook waiting on its reply would inherit those pauses; the file path costs the same whatever the worker is doing.
- **Windows pipe ACLs.** The worker's named pipe (`src/worker/lock.js`) only answers an ownership banner. Accepting events on it would need a security descriptor limiting it to the current user; Node's `net` module cannot set one, and the default named-pipe ACL lets other local accounts connect.
- **It cannot reach the PRD's number.** The host starts a fresh `node` for every hook, so a client still pays Node start-up, which is most of the time measured below.

**Restated KPI.** In-process hook logic (`runHook`) p99 under 15 ms, and whole-process hook p95 within 15 ms of a bare Node start on the same machine, both as measured by `scripts/bench-hooks.mjs`. The TRD's 200 ms p95 hook budget is unchanged.

## Consequences

- The status line refreshes faster and loads no worker code. A later status-line segment (planned files and drift, Task 9) belongs in `statusLine()` so both entries keep printing the same line.
- SessionStart stays the slowest hook: it loads configuration and the readiness check and probes the worker's lock. It runs once per session start or compaction, not per tool call.
- Whole-process PreToolUse and PostToolUse remain dominated by Node start-up and about 30 modules of hook code; see "Alternatives" for what was measured and left.

## Alternatives considered

- **Lazy-loading event-specific modules inside `src/hooks/adapter.js`** (the resume brief, approval matching, auto-bind, usage collection). `runHook` is synchronous and is called synchronously by tests, the guard and the hook entry; a dynamic `import()` would make it asynchronous, and a synchronous `require()` of ES modules needs Node 22.12 or later while the package supports Node 22.0. Each module costs about 1–2 ms to load, so the gain is a few milliseconds per event. Left for a time when the adapter is restructured anyway.
- **Moving `sessionKey` out of the reducer module** so the hook does not load `core/state.js`. It would drop two modules (the reducer and its memory reducer) from every hook. Measured with `--baseline` against the change above, PreToolUse and PostToolUse moved by less than the run-to-run noise on the loaded machine, not a demonstrated 3 ms at p95, and it would edit `src/hooks/adapter.js`, which the redaction work (Task 1) changes; not kept.
- **Bundling the hook path into one file.** It would cut per-module overhead, but adds a build step and a generated file that must stay in sync with the sources; not worth it while the KPI holds.
- **Node's compile cache** (`module.enableCompileCache()`). Measured in 0.6.1 with no measurable difference (`ACCEPTANCE-RESULTS.md`).
