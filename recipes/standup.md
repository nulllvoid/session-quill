---
name: standup
description: Write a three-line standup update for the ticket from its notes
mode: analyse
permissions: {}
timeout_min: 5
inputs: [ticket, notes, prs, deployments]
outputs: [summary, next_action, blocker]
---
Write a standup update for {{ticket.key}} ({{ticket.title}}) from the notes below. Put three short lines in the summary: what was done since the last update, what happens next, and anything blocking. Use only facts from the notes; say "unknown" rather than guessing. Suggest a next action only if the notes do not already have a current one.
