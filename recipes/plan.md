---
name: plan
description: Produce a reviewable implementation plan without editing source or changing tickets
mode: analyse
permissions: { read_source: true }
inputs: [ticket, notes, prs, deployments, work, related, history, docs]
outputs: [summary, plan, next_action, blocker]
---
Investigate the owner's objective and produce an implementation plan for review. Do not implement, change files, create tickets, run write commands, or publish anything.

In summary include the objective, proposed files and repositories, assumptions, dependencies and blockers, verification commands, and explicit done-when criteria. Put the ordered implementation steps in the plan array, including each step's dependencies and verification. Distinguish observed facts from assumptions. If source access is unavailable, state that this plan uses ticket context only and identify what needs source inspection before implementation.

The owner may edit and separately authorize execution of this saved plan. A successful plan run does not authorize implementation.
