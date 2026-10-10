# ADR 0022 — An always-on dashboard, and runs that report their own timings

Date: 2026-10-11 · Status: accepted · Builds on [ADR 0013](0013-recipe-context-and-reply-contract.md) and [ADR 0017](0017-run-access-levels.md)

## Context

The dashboard was easy to lose. Every worker start picked a random port, so a bookmark or an open tab broke on the next restart. The owner session lived only in the worker's memory, so a restart also signed the browser out, and a signed-out browser saw a JSON error rather than instructions. Nothing showed the address once the first link was used. Getting the worker to start at login meant a hand-made Task Scheduler task or systemd unit.

Two smaller gaps sat on the agent side. A fix run (`edit_source`) skipped the self-check when its recipe did not ask for it. Nobody could say where a run's time went: queueing, creating the worktree or the agent itself. The orchestration plan wants that measured before it optimises anything.

## Decision

- **Stable port.** `ui_port` defaults to `47321`. The server tries it first. If the port is taken (`EADDRINUSE`) or reserved by the OS (`EACCES`), it falls back to a random port and logs that, so a busy port never stops the worker. `ui_port = 0` keeps the random port. `state/ui-endpoint.json` still records host, port and pid.
- **Durable sign-in.** Owner sessions are stored in `state/ui-sessions.json` as SHA-256 hashes with an expiry. A session lasts 7 days and is renewed on use (sliding). A renewal is written at most once an hour per session, so polling does not rewrite the file. Expired entries are pruned on load and on use. The plain token exists only in the browser's HttpOnly cookie. The CSRF token is an HMAC keyed by the session token, so it is as unguessable as the cookie and an open page keeps working across a restart.
- **Revocation.** `quill ui --revoke` deletes the stored hashes and every outstanding one-use secret. If the worker is running, it also writes `control/ui-revoke.json`; the worker then drops the sessions it holds in memory and deletes the file. The command waits up to 5 s for that and reports an error if the worker never confirms.
- **Sign-in page.** A request for the dashboard page (`/` or any `.html` under `/ui/`) without a valid session gets a 401 HTML page. It tells the reader to run `/session-quill:ui`, or `quill ui` from a terminal. It uses the dashboard stylesheet and tokens and has no script and no data. Scripts, styles and fonts stay public because they hold no data. The `/v1` API keeps its JSON errors.
- **Status line link.** `quill status --statusline` appends the dashboard base URL as an OSC 8 hyperlink. It does so only when `ui-endpoint.json` names the pid of the worker whose heartbeat is healthy. A stopped worker or a stale file prints nothing. The link never carries a secret: opening it lands on the sign-in page, or on the dashboard if the browser is already signed in.
- **`quill worker install` / `uninstall`.** Install registers a per-user login entry that runs `quill worker start` once. It needs no administrator rights:
  - Windows: a Task Scheduler task named `Session Quill worker (quill)` with a logon trigger for the current user and an interactive token. It is registered from a generated XML file with `schtasks /Create /XML … /F`. The task runs `wscript.exe` on a generated `worker-login.vbs`, which starts node without a console window.
  - macOS: a LaunchAgent at `~/Library/LaunchAgents/com.session-quill.worker.plist` with `RunAtLoad` true and `KeepAlive` false, loaded with `launchctl bootstrap`.
  - Linux: a `Type=oneshot` systemd user unit with no `Restart=`, enabled with `systemctl --user enable`.

  A custom `QUILL_HOME` is passed to the entry. Installing twice leaves one entry: `/F` replaces the task, `bootout` runs before `bootstrap`, and `enable` is idempotent. Uninstalling when nothing is installed succeeds and changes nothing. Install writes `state/autostart.json`. `quill doctor` and the snapshot's `meta.worker_autostart` read only that marker (plus the plist or unit file where there is one), so neither spawns an OS tool. Crash restarts stay with `ensureReady`'s rate-limited backoff in the hooks, not with OS keep-alive. Every OS call goes through an injectable runner, so the tests use fakes.
- **Mandatory self-check.** A run whose permissions include `edit_source` always gets the read-only self-check turn of ADR 0013, whatever its recipe's `self_check` says.
- **Run timings.** A run records `timings`. `queue_wait_ms` runs from the request to dispatch on the worker clock. `worktree_ms` is the time to create the checkout and is present only when one was created. `agent_ms` covers the agent process from spawn to its last turn, including repair and self-check. Only fields that were measured are written; there is no `test_ms` until there is a worker test gate. The timings travel through `handoff-tx` like other handoff fields. The dashboard shows them on each run ("Queue wait 2.0 s · Setup 850 ms · Agent 1 min 35 s") and `quill handoff list` prints them.
- **Dashboard.** The top-bar address gets a copy button through the existing `data-copy` handler. When a login entry is installed, the worker health item opens a popover saying "Starts at login". The item still reads "Worker: connected".

## Consequences

- A bookmark to `http://127.0.0.1:47321/` survives restarts and reboots, unless another program holds the port, in which case `quill ui` and the status line show the fallback address.
- Anyone who can read the state directory can see which sessions exist and when they expire, but cannot sign in with that. They could already read the store.
- Signing out every browser is a deliberate step (`quill ui --revoke`); otherwise a browser idle for more than 7 days has to sign in again.
- Fix runs cost one more short turn when their recipe did not already self-check.
- The decision on worktree reuse can now rest on measured `worktree_ms`, not guesses.

## Alternatives considered

- **A prewarmed worktree pool.** Rejected for now. A pool adds cleanup, staleness and disk cost, and we have no measurement showing worktree creation matters. `worktree_ms` provides that measurement; recycling stays deferred until it shows a real cost.
- **A shared secret in a `ui.lock` file** that the browser or status line could present. Rejected: it would put a plain secret on disk and, through the status line, on screen. Hashed sessions plus a one-use link keep every plain secret in memory or in the HttpOnly cookie.
- **A separate always-on dashboard daemon.** Rejected: it would be a second process to own the store, with its own lifecycle and lock. The worker already serves the dashboard and owns the store. Starting it at login makes it always on without a second owner.
- **OS keep-alive** (`KeepAlive`, `Restart=always`, a repeating task). Rejected: a worker that crashes on start would loop. `ensureReady` already restarts with backoff and respects `quill worker stop`, which an OS keep-alive would ignore.
