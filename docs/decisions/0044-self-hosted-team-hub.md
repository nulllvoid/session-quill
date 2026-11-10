# ADR 0044 — A self-hosted team hub

Date: 2026-11-11 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md), [ADR 0002](0002-local-store-mandatory.md), [ADR 0019](0019-read-only-mirror.md) and [ADR 0022](0022-always-on-dashboard.md)

## Context

One machine owns and writes a store. A team that wants to see each other's boards has three options today: pass exported HTML files around, sync mirror folders through a file service (ADR 0019), or publish to a claude.ai page (ADR 0010). None gives a team one place it controls that shows everyone's open work and the deployments still owed.

The PRD deferred "hosted live dashboards" until an authenticated adapter existed. The project's direction is open source and self-hosted: there is no hosted service, so the team view has to be something a team runs itself, from this repository, under the same licence.

## Decision

- **A hub is a mirror over HTTPS, not a second writer.** `quill hub serve` is a small HTTP service. Each member's worker pushes the output of the export sanitizer to it; the hub stores one snapshot per member store and serves them read-only. Nothing flows back: the hub cannot change a ticket, queue a run or reach a member's machine. ADR 0001 and ADR 0002 hold unchanged.
- **Same privacy rules as a shared snapshot, enforced twice.** The member side sends `sanitizeSnapshot` output with `includeCheckpoints: false`, the `[hub] projects` and `fields` filters, and links only with `include_links = true`. The hub refuses anything that is not sanitizer output or that carries checkpoint text, keeps only the snapshot keys an export has, forces every capability but `read` off, drops agent result summaries, suggestions, run notes and critical-change specs, and redacts absolute paths and known secret formats again on every string (`src/hub/accept.js`).
- **The hub never serves what a member sent as markup.** It stores JSON and renders each board with its own copy of the dashboard bundle (`renderStaticHtml`). A board page's Content-Security-Policy names its two inline scripts by SHA-256, so no other script runs on the hub's origin. The overview and sign-in pages are server-rendered, carry no script, and escape every value.
- **Tokens, two roles.** `quill hub token add <name> [--role member|viewer]` runs on the hub's host and prints a 32-byte random token once; the hub keeps its SHA-256. A member token pushes its own boards and reads; a viewer token only reads. Boards are stored under the token's name, so one member cannot overwrite or delete another's. There is no admin API: tokens are managed with the CLI against the data folder.
- **Browser sessions.** Signing in with any token sets an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie valid for 7 days (`Secure` with `--secure-cookies`, or behind a proxy with `--trust-proxy`). Each request checks that the token still exists, so revoking a token signs its browsers out. Form posts must be same-origin (`Sec-Fetch-Site`, else `Origin`). Ten failed sign-ins or bearer attempts from one address lock it out for five minutes.
- **Consent on the member side.** `[hub]` is a user-only config table: a repository's `.quill.toml` cannot set it. `quill hub join <url>` prints what would be sent and what never is, and changes nothing. Only `--confirm` saves the address, records it as `confirmed_url` and switches pushing on; editing `url` afterwards stops pushing until it is confirmed again. The address must be `https`, except for localhost or with an explicit `allow_http = true`. The token is read from an environment variable named in config (`QUILL_HUB_TOKEN` by default) and is never written to a file. Redirects are refused so the token cannot follow one to another host.
- **When the worker pushes.** When a new generation exists, at most once per `interval_seconds` (default 300, floor 60), never two at once, and once more when the worker stops. A failed push is logged, recorded in `state/hub.json` and retried after the interval; it never blocks the worker. Only the owner machine pushes. `quill hub push` pushes once by hand; `quill hub leave [--remove]` stops and optionally deletes the hub's copy.
- **No runtime dependencies, no database.** The hub uses Node built-ins. Its data folder holds `tokens.json`, `secret.key` and `boards/<name>/<store_id>/{snapshot,info}.json`, written atomically. Backing up the hub is copying that folder. `quill hub serve` needs no Quill store on the host.
- **TLS is the operator's.** The hub speaks HTTP and binds to `127.0.0.1` by default. `deploy/hub/` has a compose file that puts Caddy in front of it.

## Consequences

- A team gets one page with every member's open work, the tickets that are blocked, and the deployments merged pull requests still owe, plus each member's full read-only dashboard.
- The hub's copy is as fresh as each owner's worker makes it. A board not pushed for over a day is marked, never hidden.
- Anyone with any token reads every board on the hub. A team that needs finer separation runs more than one hub.
- A member's machine sends ticket titles, statuses, next actions and the selected fields to a host the member confirmed. Source, prompts, command output, checkpoint text, memory, run notes, scope names and local paths stay local, as with a shared snapshot.
- The hub renders with its own dashboard copy. A hub older than a member's plugin shows that member's board with the older dashboard; fields it does not know are kept but not shown.

## Not in this change

- **Edits from the hub.** Teammates cannot change a status or propose a run from the hub. The path exists (revision-checked requests, ADR 0011; owner-approved proposals, ADR 0025) and can be added behind the same rule: the worker pulls requests and may refuse them. The hub would then supply a verified editor identity, which ADR 0025 names as the precondition for anything beyond owner approval.
- **Organization policy and evidence receipts on the hub**, per-user accounts or SSO, and a hub-side history of snapshots.
- **A live board.** Pages are built when requested; there is no push to the browser.

## Alternatives considered

- **Expose the owner dashboard over the network.** Rejected, as in ADR 0019: it is the owner's read-write surface and loopback-only by design.
- **Sync journals and replay on a server.** Rejected: that is the deferred multi-writer store, and it would put unsanitized events on a shared host.
- **Let members upload the exported HTML.** Rejected: the hub would serve member-supplied script to every viewer.
- **A database and an account system.** Rejected for now: files and tokens are enough for a team, keep the image dependency-free, and make backup and audit trivial.
