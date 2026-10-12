---
name: analyse-followups
description: Analyse the ticket, suggest a next action and propose follow-up child tickets
mode: analyse-followups
permissions: { read_source: true }
inputs: [ticket, notes, prs, deployments, work, related, history]
outputs: [summary, next_action, blocker, followups, description]
---
Analyse where this ticket stands, recommend a concrete next action, and propose the follow-up work it leaves behind as child tickets.

1. Analyse as for a status review: the goal, what the work shows as done, what is left, and what is in the way, each with its source.
2. Collect follow-up candidates from the evidence: TODO or FIXME comments in the diff, plan steps deliberately deferred, open questions in the notes and checkpoints, missing tests or docs for code the ticket changed, and risks the work introduced.
3. Drop every candidate that is already a child or sibling ticket (see Related tickets), that is part of this ticket's own remaining work, or that an earlier run proposed and the owner dismissed.
4. Propose at most five children, most important first, and fewer is better than padding. Each needs a title that names the change ("Add retry limit to the sync client", not "Retry improvements"), a category, a priority relative to this ticket, a first action someone could start right away, and a description in the required format whose Done when says how to tell that child is finished.
5. If the Description status of this ticket is not valid, write its description too.

When the work spans several modules or more files than you can read closely, split the analysis by module: give each subagent one module (or one area of the diff) and ask it for findings with their sources. Then merge the results yourself into one answer, removing duplicates and resolving disagreements by re-reading the source. For a small change, do it yourself; subagents only help when there is a lot to read.

Proposing no children is a valid answer when the evidence shows none; say so in the summary.

## Definition of done
- The analysis is complete as for a status review, with sources.
- Every proposed child has a specific title, a first action and a description whose Done when is checkable; duplicates of existing tickets are dropped.
- Zero children is stated and explained when the evidence shows none.
- Routes tried, including failed or refused ones, are in `attempts`.
