---
name: analyse
description: Summarise where the ticket stands from its notes and work, and recommend what to do next
mode: analyse
permissions: { read_source: true }
timeout_min: 20
inputs: [ticket, notes, prs, deployments, work, related, history]
outputs: [summary, next_action, blocker, description]
---
Work out where this ticket really stands and what should happen next. Do not propose child tickets.

1. State the goal in one line, from the title, the owner notes and the latest plan.
2. Compare the plan with the work: which steps the commits, diff and files show as done, which are partly done, and which have not started. With source access, open the files to confirm; a commit message alone is not proof.
3. Look for what is in the way: failing or missing tests, open questions in the notes, an unmerged or stale PR, a deployment still pending, a sibling or parent this depends on.
4. Recommend the single most useful next step. If something outside the owner's control stops progress, report it as the blocker and make the next action what unblocks it.

If the Description status is not valid, also write the ticket's description from what you found: the goal, the context that matters, and checkable done-when conditions.

Summary: what is done, what is left, and the main risk, each with its source. Set a blocker only for something that actually stops progress now, not for a risk.
