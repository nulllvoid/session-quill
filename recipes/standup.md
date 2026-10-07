---
name: standup
description: Write a three-line standup update for the ticket from its notes
mode: analyse
permissions: {}
timeout_min: 5
inputs: [ticket, notes, prs, deployments, work, history]
outputs: [summary, next_action, blocker]
---
Write a standup update for {{ticket.key}} ({{ticket.title}}) from the ticket data.

Put exactly three short lines in the summary:
- Done: what changed since the last update, from the commits, timeline and checkpoint, naming concrete things ("merged the retry fix, PR 42") rather than activity ("worked on retries").
- Next: what happens next, from the current next action or the plan.
- Blocked: anything stopping progress, or "nothing".

Use only facts in the ticket data; write "unknown" rather than guessing. Suggest a next action only if the ticket has no current one or the data shows it is already done.
