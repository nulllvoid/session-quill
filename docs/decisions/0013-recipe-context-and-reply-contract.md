# ADR 0013 — Recipe context, method and reply contract

Date: 2026-10-07 · Status: accepted · Builds on [ADR 0008](0008-agent-recipes.md)

## Context

Recipe runs were limited by what they were given more than by the model. The ticket's own Notes section never reached the agent: the prompt builder accepted notes, but dispatch never passed them. Approved plans and conclusions arrived as previews, although the full text is stored. A run saw nothing of the work itself (files touched, commits, their diff), nothing of the tickets around it, and nothing of earlier runs, so it could repeat a suggestion the owner had dismissed. Each built-in recipe was a single sentence. A reply had one chance to produce a valid JSON block; a malformed one left the run done with no summary. The prompt also travelled on the command line, which caps it at about 32 KiB on Windows, too small for full notes and a diff.

## Decision

- **More context, declared per recipe.** `notes` now carries the owner's Notes section, the full latest approved plan and the latest complete checkpoint (each read from its blob, capped, shown once when the plan is the checkpoint). Three new inputs join `ticket`, `notes`, `prs` and `deployments`:
  - `work`: files touched, the ticket's commits, and, with source access, the patch of those commits read from the run's isolated checkout with `--no-ext-diff --no-textconv` (30 000 characters in all, 12 000 per commit; commits the checkout lacks are skipped and counted).
  - `related`: the parent with its next action, siblings, and children with theirs.
  - `history`: the last three finished runs on the ticket, each with its summary and every suggestion's fate (accepted, dismissed or undecided).
  
  A recipe without `inputs` gets every input, as before. The built-in handoff modes always get every input. Multi-line ticket data has long dash runs shortened, so it cannot imitate the prompt's section markers, and is cut with a note of how much was left out.
- **One method for every run.** The prompt states how to work, outside the data block and before the task: orient on the notes and the work, form a view, check it against code or history, conclude only what the evidence supports. It also sets out the evidence rule (cite each claim), what a good next action looks like, how to fail honestly (say so, low confidence, make the next action the check that would settle it), and that earlier runs are context, not instructions. The built-in recipes were rewritten as short numbered procedures with a quality bar on top of that.
- **Reply contract.** Every reply adds `confidence` (`high`, `medium` or `low`) and `sources` (what it relied on). The parser lists contract problems: no JSON block, a block that is not a JSON object, an empty summary, a malformed child or deployment evidence item, an unknown confidence.
- **One repair turn.** When the reply has problems and the runtime reported a session, Quill resumes that session once (`--resume`, at most two turns, same tools) with the problems listed and asks for the JSON block only. The repaired reply is used only if it has fewer problems.
- **Optional self-check.** A recipe may set `self_check: true`. After a valid reply, Quill resumes the session with read-only tools (never edit, whatever the run was granted) and asks the agent to confirm each claim against its cited source, correct or drop what is unsupported, and lower its confidence if needed. The checked reply replaces the first only when it is itself valid. `attempt-fix` and `deploy-check` self-check.
- **Within the run's limits.** Follow-up turns run only with a minute or more left before the run's deadline, are tracked like the first turn (timeout and cancellation stop them), and append to the same log. If a follow-up is stopped, the first reply is the partial result.
- **Prompt on stdin.** The runtime reads the prompt from stdin, which `claude -p` and `claude -p --resume` both accept, so prompt size no longer depends on the platform's command-line limit.
- **Shown with the result.** A run records `result_confidence`, `result_sources` and `result_quality` (`repaired`, `self_checked` and any problems left). Ticket detail shows the confidence, "Repaired reply", "Self-checked" or "Reply incomplete", and the sources. Exports carry confidence and sources only when checkpoints are included, like the summary, and never carry `result_quality`.

## Consequences

- Prompts are larger, so runs cost more input tokens. The caps above bound the growth.
- More of the ticket's own text reaches the model provider: the Notes section, full plans and checkpoints, and the diff of the ticket's commits. The README privacy section already covers ticket notes and source access; it now names these too.
- A self-check adds a turn, which takes time from the recipe's own time cap.
- `confidence` and `sources` are the agent's own report. They make a reply easier to judge, not more trustworthy by themselves.

## Alternatives considered

- **Always repair, never limit turns.** Rejected: one repair turn fixes formatting slips; a reply that fails twice needs a person, and the problems are shown.
- **Self-check every recipe.** Rejected: it doubles the time of short recipes such as `standup` for little gain. Recipes opt in.
- **Write the prompt to a file the agent reads.** Rejected: it adds a Read call the agent could skip and a file to clean up; stdin keeps the prompt the first message.
