# ADR 0021 — A merged PR closes every ticket whose work it carried

Date: 2026-10-11 · Status: accepted · Builds on [ADR 0009](0009-environments-and-today.md)

## Context

After the 0.7.0 release, nine tickets stayed in review and the release PR still showed as open, although everything had merged. There were five causes:
1. The repository had no PR provider, so Quill never saw the merge.
2. A PR was linked only to the ticket whose session ran `gh pr create`.
3. Commits made with `git commit -q` print no `[branch sha]` line, so no commit was captured.
4. The repository required a production deployment before done.
5. Reconciliation skipped done tickets, so their PRs stayed open on the board.

## Decision

- **Branches are captured.** A write or commit attributed to a ticket records the branch it landed on, read from `.git/HEAD` in the written file's folder (worktrees included; git is never spawned on the hook path). A ticket keeps its 20 most recent branches.
- **PRs are found by branch.** Each reconciliation asks the repository's provider for the PRs whose head is one of an open ticket's branches touched in the last 30 days. It makes one lookup per repository and branch, at most 50 per run, and runs in the repository's checkout so `gh` resolves the remote. Default branches (`main`, `master`, the configured one) are never looked up. A PR found this way is linked to every such ticket and then goes through the normal evidence path: open → review, merged → deploy-pending or done. GitHub supports this through `gh pr list --head`; Bitbucket keeps linking PRs only through `gh pr create` output for now.
- **`deploy_on = "merge"` per repository.** For repositories where merging is the release (a plugin installed from its default branch, a library), the merge is recorded as the deployment in every environment (`evidence_kind = "merge"`), and the ticket moves to done when nothing else is outstanding. The setting travels with the merge evidence, so replay gives the same result if the config later changes. Without it, behaviour is unchanged: a merge creates pending obligations and deploy-pending.
- **Done tickets' PRs stay current.** Nonterminal PRs on done tickets are polled like the rest (within the 200-poll limit). Evidence never moves a done ticket, so this only corrects what the board, notes and briefs show.

## Consequences

- One merge closes all the tickets whose work it carried, including quiet commits and work from other sessions, as long as the work happened on the PR's branch.
- Work done directly on the default branch is never linked by branch; it needs its own PR or a manual status.
- Each run costs up to 50 extra `gh pr list` calls while there are open tickets with recent branches.

## Alternatives considered

- **Match PR commits against captured commit SHAs.** Rejected as the only mechanism: quiet, amended and rebased commits are not captured or change SHA, which is exactly how 0.7.0's tickets were missed.
- **Treat an empty environment list as "no deployment".** Rejected: ADR 0009 defaults an empty list to production, and changing its meaning would silently close tickets in existing setups. `deploy_on` is explicit.
