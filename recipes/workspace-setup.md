---
name: workspace-setup
description: Suggest which repository a ticket's code lives in when the resolver found none
mode: analyse
permissions: {}
timeout_min: 5
inputs: [ticket, notes, related]
outputs: [summary, next_action]
---
{{ticket.key}} ({{ticket.title}}, {{ticket.url}}) has no repository, and Quill's rules did not find one. Work out where its code most likely lives, from the ticket data only: the title, the description, the owner notes, the tracker's remote data, and the repositories of its parent, siblings and children.

You only suggest. Do not clone, register, configure or run anything, and do not guess a remote that nothing in the data names.

Summary, in at most five lines:
- The repository you think it belongs to, as a registered repository id or an https/ssh remote, and the evidence for it, quoting the ticket data.
- How sure you are (high, medium or low), and what would settle it.
- The setting that would let Quill find it next time, as a `[tracker.repo_map]` line such as `PROJ = "backend"` or `"PROJ/Payments" = "git@github.com:acme/payments.git"`.
- If the ticket clearly needs no code (a document, a meeting, a decision), say so instead.

Next action: the one command the owner should run, for example `quill repo clone {{ticket.key}} --url <remote>` (it previews before anything is cloned), `quill ticket set {{ticket.key}} --repo <id>`, or `quill ticket set {{ticket.key}} --no-code yes`. Suggest none when the evidence is too weak, and say what is missing in the summary.

## Definition of done
- The summary names a repository with its evidence, or says the ticket needs no code, with how sure you are.
