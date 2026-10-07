---
name: attempt-fix
description: Attempt the fix in an isolated checkout and report changed files and test results
mode: attempt-fix
permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }
timeout_min: 20
inputs: [ticket, notes, prs, deployments, work, related, history]
outputs: [summary, next_action, blocker, test_results, changed_files]
self_check: true
---
Attempt the fix inside the isolated checkout you are running in. Do not push, merge or deploy.

1. Restate the problem and what "fixed" means, from the owner note for this run, the notes and the latest plan. If they disagree or the target is unclear, stop and report that as the blocker instead of guessing.
2. Find the cause before changing anything: read the code the diff and files touched point to, and reproduce the failure with the relevant test when one exists.
3. Make the smallest change that fixes the cause. Follow the conventions of the surrounding code and do not refactor beyond the fix.
4. Add or update a test that fails without the fix and passes with it, where the repository has tests for that area.
5. Run the relevant tests and report the exact command and its result. Never report a test as passing that you did not run.

Summary: the cause, the change, and how it was verified. If the fix is partial or a test still fails, say so plainly and make the next action what remains.
