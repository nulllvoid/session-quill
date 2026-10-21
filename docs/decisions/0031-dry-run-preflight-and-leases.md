# ADR 0031 — Dry-run preflight and approval leases for critical runs

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0017](0017-run-access-levels.md), [ADR 0026](0026-autonomous-access-and-guard.md) and [ADR 0028](0028-critical-changes.md) · PRD FR-3.2 and FR-3.4, as the gap analysis (`docs/research/2.0.0/01-gap-analysis.md`) adopts them

## Context

An approved critical change (ADR 0028) queues one autonomous run whose frozen grant holds the proposal's scopes and an exact action pin. The guard allows that one action and nothing else in the scope. Two gaps remained.

1. **The pinned write runs blind.** Server-side dry runs already classify as reads (`kubectl … --dry-run=server` on a mutating verb, `EXPLAIN` without `ANALYZE`), so a run *could* check a Kubernetes or database write against the live server before making it. Nothing made it do so.
2. **An approval lasts as long as the run.** The owner approves at one moment, but the run may start later and work for its whole time cap. The PRD asks for just-in-time leases through `quill approve --ttl`.

Rulings that constrain the design: blunt, exact fail-safe rules rather than modelling shells (R43, exact pins); the guard is defence in depth and credentials are the boundary (ADR 0026); full access only observes; critical approval is a dashboard action by the owner (ADR 0028 §4, R59). Review Focus 5 for 2.0.0: nothing added here may allow a call the 1.1 guard refuses.

## Decision

1. **The dry-run twin.** Every pinned shell action has at most one *twin*, derived by an exact rule (`src/gate/dry-run.js`):
   - **kubectl:** the same words, any `--dry-run` or `--dry-run=*` word removed, and `--dry-run=server` added at the end (before a `--` if there is one). A client dry run never counts. It does not touch the server's admission checks.
   - **psql:** the same words, with `EXPLAIN ` put before its one `-c`/`--command` statement. The statement must start with a keyword PostgreSQL's EXPLAIN takes (INSERT, UPDATE, DELETE, MERGE, SELECT, WITH, VALUES). Never `ANALYZE`, which runs the statement.
   - A twin exists only if the guard's own classifier reads it as a read, and if it parses back to exactly those words. Otherwise the pin has no twin: a `kubectl rollout restart`, `exec` or `cp`, a statement list, two `-c` options, DDL, an MCP pin, or any other tool.

2. **Preflight in the guard.** The grant gains `requireDryRun`. The worker sets it on every run with action pins, from `[critical] require_dry_run` (default `true`, user config only; only an explicit `false` turns it off). When it is true, a pinned `k8s.write` or `db.write` call that every other 1.1 check has already allowed is still refused unless the run ledger shows its twin:
   - an allowed `guard` line whose `argv_sha` is the twin's hash, and
   - after it, the latest `tool_result` line with the same `tool_use_id` reporting `exit_code` 0.

   The refusal is `QUILL_DENIED dry-run-required: run <twin> first, with the <tool> tool…`, or, when the pin has no twin, a `dry-run-required` reason that says so. The guard hook writes `argv_sha` on every ledger line of such a run: the SHA-256 of the canonical JSON of the tool name and the call's one plain command (argv, redirects, stdin) as the guard parses it. The stream collector already writes each shell result with its exit code (`src/handoff/stream.js`). The ledger is a protected run-dir file, so a run cannot write either kind of line itself. The ledger is read only for a pinned k8s or db write, so every other call keeps the guard's usual cost. A ledger that cannot be read refuses.

3. **Leases on the dashboard approval.** The critical change item gets a **Valid for** select (Whole run by default, 5 min, 15 min, 1 h). The approve-run request carries `ttl_minutes` ∈ {5, 15, 60}, or nothing for the whole run. Anything else is `invalid-ttl`, both at submit and again when the worker evaluates the request. So is a `ttl_minutes` on a page proposal. The run records `lease_minutes`. Dispatch writes `notAfter` = dispatch time + lease into the grant, so it is frozen by the grant's hash like everything else there. After `notAfter` the guard refuses every scoped write and pinned action with `QUILL_DENIED lease-expired`, before any coverage or preflight check. Reads, git under its own permissions and the run's scratch files are not scoped and still pass. A `notAfter` that does not parse counts as passed. A resumed critical run keeps `lease_minutes`, counted from its own dispatch. More time needs a new approval, which means a new run.

4. **The item shows the preflight.** For a run-origin proposal with a k8s or db scope, while `require_dry_run` is on, the worker projects `dry_run: { twin }` onto the owner snapshot. The item then reads "Dry run required in run: the guard refuses the action until `<twin>` exits 0 in the same run." When there is no twin, it shows a warning chip "Dry run required in run" with "This action has no dry run Quill accepts, so the approved run refuses it while [critical] require_dry_run is on." Run proposals never reach an export.

5. **The recipe tells the agent.** `recipes/critical-change.md` says to run the server-side dry run first and record it in `verification`, not to run the action if the dry run fails, and that `lease-expired` means the approval ran out of time.

## Narrow, never widen (Review Focus 5)

Both checks sit inside the loop that already decides scoped writes. Each one can only turn an allow into a deny:
- The lease runs before `coverOf` and returns only denials.
- The preflight runs only after `coverOf` allowed the call through its pin. It never adds a pin and never changes coverage.
- The twin itself gets no new allowance. It is allowed only because the 1.1 classifier already reads it as a read. A dry run the classifier reads as a write (helm's `--dry-run`, `kubectl rollout restart --dry-run`) stays refused by the pin as before. So those pins have no twin and stay refused while the setting is on. The classifier was deliberately not widened to read them.
- A grant without `requireDryRun` or `notAfter` decides exactly as in 1.1. That covers every grant written before this change, standard and full-access runs, and manual scope grants.

## Why not `quill approve --ttl`

The PRD's form is a CLI flag. It was not built for three reasons:
- **Approval of a critical change is a dashboard action by the owner** (ADR 0028 §4, R59). A CLI that approves or extends anything would be the weaker second path ADR 0028 closed. Ingress requests cannot prove they came from the owner's dashboard.
- **The grant is frozen by its hash at dispatch.** A lease that a later command could extend would mean rewriting the grant of a running run, which the guard refuses as `grant-tampered` by design. A side file the guard trusted beside the grant would be an unhashed way to change what a run may do.
- **The owner already chooses at approval time.** That is when they read the action.

So the lease is chosen once, on the dashboard, and frozen. No CLI path grants, extends or shortens one.

## Deferred: terraform, gh, aws

- **terraform:** a plan is not a twin of an apply. An apply is not pinnable as one exact action (it applies whatever the plan holds), so there is nothing to tie a dry run to.
- **gh:** no dry-run mode.
- **aws:** `--dry-run` exists only for EC2 APIs, and the classifier does not read it as a read elsewhere.

Their pinned writes are unaffected by `require_dry_run`, whatever their scope. Helm and the other `k8s.write`/`db.write` tools (mysql, redis-cli, MCP tools) have no twin under this rule, so they are refused while the setting is on. The owner can set `[critical] require_dry_run = false` for them. The item says so before approval.

## Consequences

- Turning on the default changes 1.1 behaviour for critical runs whose pin is a kubectl or psql write: the run needs one more call. A pin without a twin can no longer run until the owner turns the setting off. This is intended: the setting narrows.
- An agent that runs the twin and the action in the same message is refused, because the twin's result is not yet in the ledger. The refusal says what to run.
- A twin must run with the same tool as the pinned call, because the tool name is part of `argv_sha`. Pins are proposed and approved as Bash commands. A PowerShell result carries an exit code only when Claude Code reports one, so a twin run through PowerShell usually never counts. That is fail-safe: the pin stays refused.
- A twin is matched by exact words. A reordered option is not the twin, as a reordered pin is not the pin (R43).
- The lease counts from dispatch, not approval. A queued run does not lose its time while it waits. The agent's start-up comes out of the lease.
- `lease_minutes`, `argv_sha`, `notAfter`, `requireDryRun` and `dry_run` are local only: no export, mirror, vault note or publisher carries them (`tests/export/privacy-sentinel.test.js`).

## Not done

- Twins for helm, mysql, redis-cli and MCP tools.
- A lease countdown on the running run's detail. The lease end is in the grant, and the run record has the minutes.
- Server dry runs that the classifier would have to be widened to read (`rollout restart`, helm).
