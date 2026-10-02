# Security Policy

Session Quill runs inside your Claude Code sessions, decides whether tool calls may proceed, stores a record of your work on disk, serves a dashboard on loopback, and can execute an agent inside a Git worktree. Those are all security-relevant, so please report problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability** at https://github.com/nulllvoid/session-quill/security/advisories/new. Do not open a public issue for security problems.

Include what you observed, how to reproduce it (a failing test under `tests/` is ideal), and the impact you believe it has. You should hear back within seven days. Fixes ship in a patch release with credit to the reporter unless you ask otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (main) | Yes |

## What counts

Reports are especially welcome for:

- **Gate bypasses**: a covered tool call that proceeds while unbound and the gate was enabled and healthy, including read-only shell grammar escapes (see `src/gate/`).
- **Fail-open paths**: a hook error, malformed input or storage failure that lets a covered call through instead of denying it.
- **Loopback API**: authentication, CSRF, Origin/Host or generation-consistency flaws in `src/server/`; any way to reach the API from another origin or without the owner cookie.
- **Export leaks**: credentials, request endpoints, local absolute paths, private links or checkpoint bodies appearing in a static export despite the defaults (`src/export/sanitize.js`).
- **Handoff containment**: an agent run escaping its worktree or sandbox directory, obtaining permissions it was not granted, or pushing to a protected branch (`src/handoff/`).
- **Durability**: journal corruption, lost acknowledged events, or replay producing different state.

## What the design does not promise

These are documented limits, not vulnerabilities (see the TRD and the README's *Privacy and limits* section):

- The gate is a workflow aid, not a sandbox. It covers tool calls delivered to its hooks; external processes, disabled hooks, host timeouts and unsupported tools are outside its guarantee. A valid binding never bypasses normal Claude Code permissions.
- An *attempt-fix* handoff runs the repository's own tests in the isolated worktree, which executes repository code with the owner's account. Push and draft-PR permissions are enforced by tool allow-lists and by stripping provider tokens from the agent's environment unless granted; they are policy, not a sandbox.
- The dashboard binds to loopback only. Anyone with code execution on the owner machine can read the local store.
- Exports are copies: once shared they cannot be revoked.

## Hardening defaults worth knowing

- No telemetry, no network or model calls on the hook path.
- One-use bootstrap secrets are delivered to the worker as hashes; the raw secret appears only in the URL the CLI opens and is redirected away immediately.
- Owner session cookies are `HttpOnly; SameSite=Strict`; mutations also require a CSRF token bound to the cookie.
- Static exports contain no request code or endpoints; absolute paths are redacted everywhere.
