---
name: attempt-fix
description: Attempt the fix in an isolated checkout and report changed files and test results
mode: attempt-fix
permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }
timeout_min: 20
inputs: [ticket, notes, prs, deployments]
outputs: [summary, next_action, blocker, test_results, changed_files]
---
Attempt the fix inside the isolated checkout you are running in. Keep changes minimal, run the relevant tests, and report changed files and test results. Do not push, merge or deploy.
