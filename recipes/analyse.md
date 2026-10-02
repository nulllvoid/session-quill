---
name: analyse
description: Summarise the ticket from its notes and recommend what to do next
mode: analyse
permissions: { read_source: true }
timeout_min: 20
inputs: [ticket, notes, prs, deployments]
outputs: [summary, next_action, blocker]
---
Analyse the ticket from its notes and recommend what to do next. Do not propose child tickets.
