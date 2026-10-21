---
name: critic-review
description: Review a fix run's diff as a sceptical second reader, after the worker's tests passed; read-only, opinion only
mode: analyse
permissions: { read_source: true }
timeout_min: 10
max_turns: 20
inputs: [ticket]
outputs: [summary, review_findings]
requires: [run_diff]
quill_min_version: 2.0.0
---
Review the change in the run diff above as a sceptical second reader. Another agent wrote it for this ticket, and the worker's own tests passed on it. You did not write it, so do not defend it: look for what the tests would not catch.

1. Read the diff hunk by hunk. Open the changed files and their callers in the checkout where a hunk's effect depends on code you cannot see in the diff.
2. Check the change against the review documents above (the repository's own rules), the ticket's goal and the owner's note.
3. Look in particular for: behaviour the ticket did not ask for; a case the change breaks (empty input, an error path, concurrency, a Windows path, a large input); a test weakened, skipped or asserting less than before; a missing test for the new behaviour; secrets, credentials or local paths written into the code; a rule in the review documents the change does not follow.
4. Report only what you can point to: a file, a line and, where it helps, the hunk header. Say what is wrong and what would fix it. Do not restate the change, praise it or list style nits the review documents do not ask for.

Each finding is your opinion. The owner decides what to do with it; nothing you write changes the run, its tests or its result.

Summary: one or two sentences on whether the change does what the ticket asks and the most important finding, if any.

## Definition of done
- Every hunk was read; changed code whose effect is not visible in the diff was opened in the checkout.
- Each finding names a file (and a line when there is one), says what is wrong and what would fix it.
- No finding repeats what the review documents or the tests already settle.
- With nothing to report, `review_findings` is `[]`.
