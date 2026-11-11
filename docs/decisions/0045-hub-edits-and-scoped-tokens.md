# ADR 0045 — Proposals from the hub, and tokens limited to boards

Date: 2026-11-11 · Status: accepted · Builds on [ADR 0044](0044-self-hosted-team-hub.md), [ADR 0011](0011-tracker-sync-and-two-way.md) and [ADR 0001](0001-single-writer-cli.md)

## Context

ADR 0044 made the hub read-only and let any token read every board. Two gaps followed: a teammate who sees a wrong status on the hub can only message the owner, and a team cannot give a contractor or another group a token for some boards only.

Two-way pages (ADR 0011) already define how someone else's edit reaches a store: as a revision-checked request through ingress, with the 10-second undo window, refused if the ticket moved on. The page editor's name there is whatever the page reported. A hub knows who signed in.

## Decision

### Proposals

- **The owner opts in.** `[hub] accept_edits = true` (off by default; `quill hub join --accept-edits --confirm`). Each push tells the hub whether the board accepts proposals; the hub offers the form only then.
- **Who and what.** A signed-in **member** token may propose, on a ticket that is not done, a new status (to do, active, in review, deploy pending, done) or a new next action (at most 2,000 characters). Viewer tokens cannot. These are the fields and statuses a two-way page offers.
- **One change at a time.** A proposal carries the revision of the ticket copy it was made from. While a proposal for that revision exists, the hub takes no other for the ticket: a second would be checked against a revision the first is about to replace. The form returns when the owner's machine pushes a newer copy.
- **The hub holds proposals; the worker collects them.** They wait in `boards/<name>/<store>/edits.json`. The owner's worker asks `GET /v1/edits` once a minute with its own token, journals each as a `set-status` or `set-next-action` request with `expected_revision`, `not_before` 10 seconds later and `actor_id = hub:<token name>`, then acknowledges. Only the board's own token can collect or acknowledge.
- **The hub is not trusted to shape a request.** The worker accepts only those two fields, those statuses, a bounded string, a non-negative integer revision and a proposer name that is a valid token name. Anything else is dropped and logged. The request id is a UUID derived from the hub address and the hub's edit id, so an edit collected twice is one request. The reducer validates it again against the ticket as it is, exactly as for a page edit.
- **Nothing else changes on the owner's machine.** No run is queued, no critical change approved, no other field written. The owner sees the request with its proposer in the usual request list and can undo it in the window.
- **Honest states on the hub.** A proposal reads "Waiting for <owner>'s machine to collect it", then "Collected …; not visible in a push yet", then either "the board now shows this value" or "the ticket has changed since and does not show this value". The hub never says "applied": it knows only what was collected and what the next push shows.

### Tokens limited to boards

- `quill hub token add <name> --boards alice,bob` limits a token to those members' boards. The overview, `/v1/team`, board pages and ticket pages show only them; anything else answers 404. A member token always reads its own board. Without `--boards` a token reads every board, as before.

### Board pages

- A board opens under the hub's own bar (the way back, whose board it is, when it was pushed) with the dashboard in a same-origin frame. The dashboard keeps its full-height layout and its two-script policy; the framing page carries no script.

## Consequences

- A hub that accepts proposals is no longer read-only for the boards that opted in: a member token can change two fields of those boards' open tickets, subject to the owner's undo window and the revision check. Whoever holds a member token, and whoever runs the hub, can do that. A team that does not want it leaves `accept_edits` off.
- A proposal takes up to a minute to be collected and until the next push (up to `interval_seconds`) to show on the hub.
- `hub:<name>` in the owner's request history is the hub's word for who signed in. It is as trustworthy as the hub and its token handling.

## Not in this change

- Runs proposed from the hub (ADR 0025's proposals need the owner's recipe catalog; the path is the same and can follow).
- Organization policy, stored evidence receipts, accounts and SSO.
