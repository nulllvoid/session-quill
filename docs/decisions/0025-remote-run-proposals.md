# ADR 0025 — Runs proposed from a shared page

Date: 2026-10-11 · Status: accepted · Builds on [ADR 0008](0008-agent-recipes.md), [ADR 0011](0011-tracker-sync-and-two-way.md), [ADR 0017](0017-run-access-levels.md) and [ADR 0022](0022-always-on-dashboard.md)

## Context

A two-way artifact page (ADR 0011) lets people the owner shares it with change a ticket's status and next action. The orchestration plan's next step lets them ask for an agent run from the same page: a teammate looking at the board can say "analyse PROJ-42" without a terminal.

A run is a different kind of change from a status edit. It spends the owner's model usage, reads the owner's checkouts, and at higher access levels can use the owner's connectors and credentials. The page's editors are people the owner trusts less than themselves, and what the page reports about them is whatever the artifact's `user` capability returned. So the trust boundary from the plan applies: a run started from a shared page needs the owner's approval.

## Decision

- **Opt-in per publisher.** `run_agent = true` on a two-way artifact publisher adds a **Run agent** select to each row for page editors. It is ignored, with a config warning, on a one-way publisher. Turning it on changes the publisher's consent fingerprint, so the first publish after it asks the owner to confirm again. Existing two-way consents stay valid while it is off.
- **What the page offers.** By default only read-only recipes: valid recipes of the built-in and personal layers whose mode is `analyse` or `analyse-followups` and whose permissions allow at most `read_source`. Today that is analyse, analyse-followups, deploy-check, standup and workspace-setup. `run_recipes = [...]` adds names the owner allows, which may be repository recipes or recipes that edit. Names must be recipe names (`[a-z][a-z0-9-]*`), so a name cannot break out of the page's script.
- **A pick is a proposal, never a run.** The page writes the recipe name to the row's `run` field and `_edits.run` { by, at }, like any two-way edit. The next publish brings it back as an edit, and the publish after that clears the select. A recipe the page does not offer, or one that is invalid for the ticket's repository, is refused and logged. A valid pick becomes a `run-proposal` event. It records:
  - the editor, as the page reported it, cleaned to one line of at most 120 characters with dash runs broken up;
  - the publisher, the recipe { name, source, hash } and mode;
  - the permissions the run would get: `read_source` and `edit_source` only when the recipe allows them and the repository is registered, `edit_files` and `delete_files` from the recipe, and never `commit`, `push_branch` or `open_draft_pr`;
  - the access level, always `standard`;
  - `read_only`, `auto`, the published revision, and `proposed_at` (the event time).
- **Exactly one per pick.** The proposal id is `editRequestId(publisher, edit)` (ADR 0011), and the event's source identity is `run-proposal:<id>`. A retry after a crash, a lost result or a second reconcile that reads the same row adds nothing. A second pick of the same recipe for the same ticket while one is open is rejected (`run-already-proposed`), so a page cannot pile up identical requests. A proposal adds a `proposal` timeline entry without a revision bump, so a pick never makes an owner's edit conflict.
- **Only the owner approves.** `approve-run` and `dismiss-run` are ticket requests with payload { proposal_id }. The dashboard sends them through its CSRF-protected `/v1/requests` endpoint on loopback. `quill approve --run <id>` and `quill dismiss --run <id>` send them from a terminal, by unique id prefix, and `quill approve --run` lists open proposals. The worker evaluates each request against the actor: only `owner` (the dashboard) and `cli` may approve or dismiss. Any other actor fails with `approval-refused`, including `artifact:<publisher>` and schedules. Page edits never produce these requests. Approve has no undo delay, like `handoff`. Dismiss has the 10-second undo window, like dismissing a suggestion, and is journaled as a `request-tx` with a `run-proposal-dismiss` mutation and a timeline entry.
- **Approval is an ordinary run.** Approving evaluates a normal handoff from the proposal: recipe, permissions, `standard` access, `suggest: true`, and a note naming the page and editor. It goes through the same validation, recipe-hash check and reservation as the Run dialog. The resulting run carries `proposal_id`, and the proposal records `approved`, `resolved_by`, `request_id` and `handoff_id`. When the ticket already has a queued or running run, the request fails with `handoff-reserved` and the message "PROJ-1 already has a queued run (…); approve the proposal again once it finishes", and the proposal stays open. Results arrive as suggestions, whoever proposed the run.
- **Auto-queue is opt-in and narrow.** `auto_run_editors = [...]` (editor ids exactly as the page reports them, which the owner can copy from a proposal) and `auto_run_recipes = [...]` mark a proposal `auto`. Both lists must match, and the recipe must be read-only and not grant `edit_source`. A listed recipe that edits is never auto-queued. The worker (or the session's `quill publish --result`) then submits `approve-run` with a request id derived from the proposal and actor `auto-run:<publisher>`. The worker accepts that actor only for an `auto` proposal of that publisher. The run still goes through the reservation and still only suggests.
- **Expiry and cleanup.** An open proposal lapses ("expired") after 7 days, or as soon as its ticket is done or gone. Expiry is computed from the proposal's time and the ticket at read time, not journaled, so replay stays deterministic. A lapsed proposal cannot be approved (`proposal-expired`) and does not block a new pick. Approved, dismissed and lapsed proposals are dropped from state 30 days after they were proposed or resolved, when the next proposal is recorded.
- **Where it shows.** The snapshot's `run_proposals[]` carries each proposal with its state as of the snapshot and its ticket key. Exports and mirrors leave it out. Today lists open proposals above the days, and ticket detail lists the ticket's own. Each shows recipe, access, a Read-only or Edits source chip, the editor as `<code>`, the page and time, with **Approve** and **Dismiss**. Detail notes when the ticket already has an active run. A poll that brings a new open proposal announces it in the live region and sets the receipt; the first poll after opening the dashboard announces nothing old.
- **Both executors.** The worker's `cli` executor (`publish` job) and a session publish (`quill publish --plan`/`--result`) use the same pure `proposalFromEdit`, so the same pick makes the same proposal either way. The session path writes the event, and an auto approval request, through ingress.

## Not in this change

- **Run groups and nested run display** do not ship. A proposal becomes one ordinary run.
- **Worktree recycling** stays deferred. ADR 0022 added `timings.worktree_ms` so the decision can rest on measurements. Until phase-1 timings show worktree creation is a real share of run time, every run gets a fresh checkout. That keeps cleanup, staleness and disk cost out of the picture.

## Consequences

- Anyone the owner lets edit the page can ask for a run. They cannot start one, choose its access or give it side effects, and a page can never approve on its own behalf.
- An owner who allowlists an editor for auto-run trusts that editor's page identity. Auto-run spends model usage without a click, and it is limited to read-only recipes for that reason.
- The editor id is only what the page reported. It is shown as data and never used as a name the dashboard vouches for.
- A proposal approved after its recipe file changed fails with `recipe-changed`, because the hash is checked when the request applies (built-in recipes included, for example after an upgrade). The owner then reviews the recipe and runs it themselves.

## Alternatives considered

- **Queue the run straight from the page, like a status edit.** Rejected: a run is not a field change that a revision check can undo, and the plan requires owner consent at this boundary.
- **Let the page choose the access level.** Rejected: settings and full access reach the owner's connectors and credentials (ADR 0017). A proposal always asks for standard. The owner can queue a stronger run themselves.
- **Approve from the page for allowlisted editors.** Rejected: approval must come from the owner's machine. Auto-run is the owner's own config, evaluated by the worker, and covers only read-only recipes.
- **Journal expiry as events.** Rejected: expiry depends only on time and the ticket's state, both known at read time, and an event per lapse would add journal noise without new information.
