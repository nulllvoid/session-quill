# ADR 0016 — Done when check for tickets without a repository

Date: 2026-10-07 · Status: accepted · Builds on [ADR 0005](0005-gate-modes-and-auto-binding.md) and [ADR 0014](0014-ticket-descriptions.md)

## Context

Status moves on evidence: a write makes a ticket active, an opened PR moves it to review, a merge to deploy-pending, cleared deployments to done. A ticket without a repository has no PRs, so it reaches Active and stays there until someone sets it by hand, and in practice nobody does. Every ticket an agent creates now has Done when items (ADR 0014), which say exactly when the work is finished.

## Decision

- **When.** At the end of a turn (the Stop hook) in a session bound to a ticket that has no repository, is To do or Active, has a valid description with Done when items, and on which the turn did work. Work is any successful tool call other than reading (Read, Glob, Grep, LS, web fetch and search, the to-do list). Repository tickets are left to their PR evidence.
- **What.** The hook blocks the stop once with a reason that lists the Done when items and asks Claude to check them against what was done. If every item is met, Claude sets the ticket to Review and says so in one line, or to Done only when the user already confirmed the work; otherwise it says which items remain. It changes nothing else and asks the user to run nothing.
- **How often.** Never on Claude's own follow-up (`stop_hook_active`), so it cannot loop. After a check, it repeats only when new work happened and at least 30 minutes have passed, so a long session on one ticket is asked occasionally, not every turn. Work on another ticket does not count. Handoff and recipe sessions are never asked; their runs report on their own.
- **Facts from the binding snapshot.** The worker adds the bound ticket's status, repository and Done when items to the binding snapshot hooks already read, and republishes it when any of them changes (as for description validity), so a ticket set to Review stops being checked at once and ordinary tool calls add no writes.

## Consequences

- Repo-less tickets move to Review as their work finishes, which Pick next and the board show, instead of sitting at Active.
- A check costs one short extra turn when it fires. The quiet period bounds that.
- Claude decides whether the items are met. A wrong "met" puts the ticket in Review, not Done, so the owner still confirms.

## Alternatives considered

- **Ask every turn.** Rejected: most turns do not finish a ticket, and an extra turn each time is noise.
- **Ask in the next prompt's context instead of blocking the stop.** Rejected: the check belongs at the moment the work ends; the next prompt may be about something else.
- **Include repository tickets.** Rejected: their PRs already move status, and a Done when check could disagree with what review and deployment evidence say.
