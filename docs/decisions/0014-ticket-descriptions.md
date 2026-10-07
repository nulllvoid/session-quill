# ADR 0014 — Mandatory ticket descriptions

Date: 2026-10-07 · Status: accepted · Builds on [ADR 0013](0013-recipe-context-and-reply-contract.md)

## Context

Tickets had a title and little else. The Summary section was owner-authored and stayed empty unless someone edited the note by hand, so the dashboard showed nothing about what a ticket was for, and recipe runs, which now read the ticket's notes as context (ADR 0013), started from a title. Almost every ticket is created by Claude through `ticket work` or `ticket create`, at the moment it best knows what the task is.

## Decision

- **One format.** A description is Markdown with three parts: `**Goal:**` (one sentence), `**Context:**` (why and where), and `**Done when:**` followed by at least one `- ` item. Common spellings of the labels (`Goal:`, `## Done when`) are accepted; the text is stored as written, never rewritten. It is at most 4000 characters. A `\n` typed as two characters in a shell argument becomes a line break when the description has no real ones.
- **Stored as the Summary.** The description is the ticket's existing `summary` field and the note's Summary section, so imports, exports and replay need nothing new. The snapshot adds the parsed form (`description.valid`, `problems`, `goal`, `context`, `done`) for display.
- **Mandatory where an agent creates tickets.** `ticket create` and `ticket work` refuse a missing or malformed `--description` (or `--description-file`) and print the format with what is wrong, so Claude corrects and retries in the same turn. `ticket set --description` writes or replaces one. When `ticket work` reuses a task that has no valid description, the one it brings is stored; a valid description is never replaced by reuse.
- **Instructions.** The per-prompt task instruction names `--description` and the format. `/session-quill:ticket` tells Claude to write the description itself from the conversation when the user did not pass one.
- **Flagged, not refused, elsewhere.** Tickets created without an agent (a tracker key in a prompt or branch, migration, the dashboard's Create from key) cannot be refused. The binding snapshot records whether the bound ticket's description is valid, and while it is not, each prompt asks the session to write one with `ticket set`. The worker republishes a binding only when that validity flips, so ordinary tool calls cost no extra writes.
- **Agents write them too.** Follow-up children in a run's reply must carry a description; a missing or malformed one is a contract problem and earns the repair turn (ADR 0013), checked only for outputs the recipe declared. A new `description` output lets a run write the ticket's own description when its Description status (now part of the prompt) is not valid. Built-in modes apply it directly only when the ticket has no valid description; other recipes offer it as a suggestion.
- **Shown.** Ticket detail shows Goal, Context and Done when, or "Missing description" / "Description not in the required format" with how it gets written. Exports carry the parsed description only with the `summary` field.

## Consequences

- Existing tickets keep whatever Summary they have. Those without a valid description are flagged in the dashboard and fixed by the next session that works on them, or by an `analyse` run.
- Owner text in the Summary section that does not follow the format is shown as written with a warning, and a session bound to that ticket is asked to replace it. Owners who want their own wording keep it by writing it in the format.
- Scripts that call `ticket create` must now pass a description.

## Alternatives considered

- **A separate `description` field beside the summary.** Rejected: two overlapping fields, and the note already has a Summary section people edit.
- **Free-form text with a minimum length.** Rejected: it does not tell a reader or an agent when the task is done.
- **Refuse every ticket without one, including tracker-key auto-binding.** Rejected: auto-binding happens before Claude's first tool call, with only the prompt as input; refusing it would break linking.
