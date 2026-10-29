# ADR 0033 — Evidence receipts and recipe stats

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0021](0021-pr-closes-its-tickets.md), [ADR 0022](0022-always-on-dashboard.md), [ADR 0023](0023-bulk-runs-and-test-gate.md) and [ADR 0028](0028-critical-changes.md) · Spec: `docs/research/2.0.0/00-prd.md` FR-5.1, FR-5.2 as adopted by `docs/research/2.0.0/01-gap-analysis.md`

## Context

A draft PR opened by a fix run said one thing about itself: the test gate line ("Tests passed (worker): `npm test` exited 0", ADR 0023). A reviewer could not tell from the PR whether the commit was the tree the tests ran on, how many calls the guard refused, whether an owner approval was behind the run, or how much of the change touched configuration or critical paths. That evidence existed only in part: the gate kept only its last attempt, the tree it tested was never recorded, guard decisions lived only in the run's `ledger.jsonl`, and everything reached the journal at the very end of the run, after the PR had already been opened.

The PRD asks for a "cryptographic-style" receipt built from the journal (FR-5.1), attached by `quill publish`. `quill publish` runs tracker publishers (ADR 0010), not PRs; the only PR Quill opens is a fix run's draft PR. It also asks for an "autonomy score" and a per-recipe change failure rate (FR-5.2). Neither the merge commit nor reverts were observed, and an opaque score would hide what it counts.

## Decision

1. **The receipt is built from journaled facts, before the PR.** After the commit, and before the push and the PR, the worker journals the run's evidence with one `handoff-tx` update: `test_gate`, `tested_tree`, `commit_sha`, `commit_tree`, `guard_summary`, `change_summary` and `changed_files`. The receipt is then built from the reduced state (`buildReceipt(state, handoffId)` in `src/handoff/receipt.js`, pure) and appended to the PR body after the existing gate line, which keeps its wording. The run records `receipt: { sha256, through_sequence }`. Nothing in the receipt comes from the agent's reply.

2. **What a receipt states.** Heading `### Session Quill evidence receipt`; the run id8, recipe and access tier in words (Autonomous, Autonomous + scopes (n), Full access, Standard access, My Claude Code settings); the test gate (command, each attempt's exit code and time, "after one repair turn", "Tests passed (worker)" only for a real pass; a skipped or absent gate says "not test-verified"); "Tested tree matches commit <sha7>" or "Tested tree differs from commit <sha7>"; guard counts (allowed, refused, critical, by guard class) or "not used" for a tier without the guard; owner approvals; change counts (files, config, tests:code, critical-path files, or "no critical paths configured"); "Digest sha256 <hex> over the run's journaled facts through sequence <n>."; and the last line "Not a deployment."

3. **A digest, never proof.** The digest is sha256 over canonical JSON (keys sorted) of the receipt's facts, so the same state always gives the same digest, and `quill receipt <run>` can rebuild it: it replays the journal through the recorded `through_sequence` and says whether the digest matches. It identifies a set of facts; it does not sign them, and anyone with the store can journal different ones. The receipt never calls it proof.

4. **Counts only leave the machine.** Spec §9 and ADR 0028 hold: no scope names, targets, local paths, test output or agent text appear in a receipt. The guard row and the change row are counts; scopes are a count. The test command is repository configuration, but absolute paths in it (POSIX, Windows drive or UNC, home-relative) are replaced with `<local path>`, in the receipt and in the existing gate line, which until now sent the command as written.

5. **The tested tree.** After the final passing test run the worker writes the checkout's tree with `git write-tree` on a temporary index (`read-tree HEAD`, `add -A`), so the checkout's own index is untouched. That is the tree `commitAll` would commit; `commit_tree` is read back from the commit. A difference means something changed the checkout between the tests and the commit.

6. **Every attempt is kept.** `test_gate.runs[]` holds `{ status, exit_code, ms }` for each attempt; the output tail stays only for the last one, as before. Exports keep their existing `test_gate` allow-list, so `runs` never leaves the machine.

7. **Guard summary.** `guard_summary: { allow, deny, critical, by_class }` counts the guard hook's own `guard` lines in the run's ledger (stream `denial` lines are not guard decisions), for autonomous and full-access runs. Classes are the classifier's fixed vocabulary; anything else counts as `other`.

8. **Change counts.** `[repos.<id>] critical_paths` and `config_globs` (glob lists, user config) count changed files; tests are recognized by path (`test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, `test_*.py`), docs by extension, everything else is code. `config_globs` defaults to a built-in list (JSON, TOML, YAML, INI, `.env*`, `*.config.*`, Dockerfile, Makefile, `.github/**`, …). The counts are journaled as `change_summary`, so a later config edit cannot change an old receipt.

9. **Recipe stats are counts, not a score.** `quill doctor` prints a Recipes section (and `--json` carries `recipes`) from `recipeStats` in `src/core/usage.js`: per recipe over 30 days, runs, done, failed (failed or timed out), tests passed by the worker first time and after a repair, owner interventions (applied `handoff-cancel` and `undo-file-effect` requests on the run, plus a later run that retries or resumes it), PRs merged, reverted within 48 hours of merge, not yet known, and the median time from run end to merge. No ratio is computed for the owner to misread.

10. **Merges and reverts of a run's PR.** Reconciliation polls the PR a run opened (`pr_url`, runs finished in the last 30 days, at most 50 per pass) and records it on the run as `pr_observed`; it never becomes ticket evidence, so a run's PR does not move its ticket by this path (ADR 0021 linking by branch is unchanged). The GitHub provider now reads `mergeCommit`; for a merged PR, `findRevert` looks for a default-branch commit whose message says `This reverts commit <merge commit>` or a merged PR that names this PR as the one it reverts (`Reverts <owner>/<repo>#<n>` in its body, or GitHub's head branch `revert-<n>-…`), within 48 hours of the merge. A title match alone is not enough: run PRs are titled `Handoff: <note>`, and the bulk dialog gives every run in a batch the same note, so a `Revert "<title>"` PR would have marked every PR of the batch as reverted. A merged PR is checked on every pass until a check at or after the end of its window; until then it counts as "not yet known". The update rides in `pr_updates[]` with `handoff_id`, `merge_commit`, `reverted_by`, `reverted_at` and `revert_checked_at`. Bitbucket has no revert check yet, so its merged run PRs stay "not yet known".

## Consequences

- A reviewer sees, in the PR, what the worker observed rather than what the agent said, and can rebuild it with `quill receipt`.
- One extra journal event per committed fix run, before the push.
- Up to 50 extra `gh pr view` calls per reconciliation while runs have open PRs, and up to three more (`pr view`, `api …/commits`, `pr list`) per merged run PR until its 48-hour window closes.
- The PRD's `RECEIPT_GENERATED` event is not added: the receipt is a field on the run's existing `handoff-tx` (Global Constraints of the 2.0.0 plan).

## Alternatives considered

- **Attach the receipt from `quill publish`.** Rejected: publishers write tracker and page content, not PRs (ADR 0010); the PR is opened by the fix run.
- **Sign the receipt.** Rejected for now: a key on the same machine as the store proves nothing about the facts, and the word "cryptographic" would overclaim.
- **An autonomy score.** Rejected: a single number hides which runs it counts; the doctor shows the counts it would be computed from.
- **Link a run's PR to its ticket as evidence.** Rejected here: it would change ticket statuses (open → review, merged → done) for runs that never did before. Recorded on the run, the observation feeds the stats without changing ticket behaviour.

## Amendment — 2026-10-30

[ADR 0042](0042-reconciliation-closure.md) supersedes the separation between run PR observations and ticket completion. Provider-confirmed evidence can now reach the exact originating ticket after validating the recorded run, repository, branch and PR URL. Free-text agent claims remain insufficient; metrics keep their separate run observation. Shared closure checks still gate task completion.
