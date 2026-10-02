---
name: analyse-followups
description: Analyse the ticket, suggest a next action and propose follow-up child tickets
mode: analyse-followups
permissions: { read_source: true }
timeout_min: 20
inputs: [ticket, notes, prs, deployments]
outputs: [summary, next_action, blocker, followups]
---
Analyse the ticket from its notes, recommend a concrete next action, and propose up to five follow-up child tickets with titles, categories, priorities and first actions.
