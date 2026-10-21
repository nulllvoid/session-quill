# ADR 0039 — Attention groups and the CI watch

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0007](0007-schedules-and-bitbucket.md), [ADR 0021](0021-pr-closes-its-tickets.md), [ADR 0023](0023-bulk-runs-and-test-gate.md), [ADR 0025](0025-remote-run-proposals.md) and [ADR 0028](0028-critical-changes.md) · PRD FR-4.1 and FR-4.4, gap analysis `docs/research/2.0.0/01-gap-analysis.md`

## Context

Runs → Needs you is one flat list: open proposals, finished runs with suggestions, recent failures, quarantined learnings and memory conflicts. FR-4.1 asks for that list grouped by what the owner has to do. It also exposed a gap: `attempt-fix` is a built-in mode that produces no suggestions, so a finished fix with a draft PR never appears in Needs you. Its changes wait for review, but nothing points the owner at them.

FR-4.4 asks Quill to notice when CI fails on a pull request it opened and to offer a fix. Nothing in Quill reads CI checks today. The `ci_checked` stage exists in `src/handoff/stage.js`, but `recordedStage` never returns it. A fix pushed by an agent is a write to a shared branch, and CI logs are untrusted tool output that may hold secrets. So the watch may only propose. The owner approves on the dashboard (ADR 0025, ADR 0028 §4), and nothing auto-approves.

## Decision

1. **Needs you groups.** Needs you is grouped by default. The hash is `group=attention`, and "Show as one list" sets `group=none`. Every counted item sits in exactly one group, so the group counts add up to the tab count and to the global attention dot, which count the same unfiltered set (design system §7). The groups, in order:
   - **Needs your decision**:
     - open page proposals and critical changes;
     - finished runs with suggestions to decide on;
     - failures that wait on a setting or an approval (`scope-changed`, `scope-credentials-missing`, `recipe-needs-*`);
     - finished fixes with writes outside their planned files (ADR 0037: "N writes outside planned files", so drift asks for a decision rather than a review);
     - quarantined learnings and memory conflicts.
   - **Tests or CI failed**: runs whose worker test gate failed or timed out (`tests-failed`, `tests-timeout`), and CI failed items.
   - **Other failures**: every other failed or timed-out run that already needed the owner (an agent exit, a timeout, an interruption, a push failure).
   - **Ready to review**: a done run that edited source with files changed. It must also be in the last 7 days, on an open ticket, not superseded, with a pull request not recorded merged or closed, and with a latest CI observation that is not failing. It carries "Tests passed (worker)" or "Not test-verified".
   - **Live**: queued and running runs, headed "Live (n) · not counted in Needs you". The group is never counted. The Runs badge already counts live runs, and the dot means "needs you".

   Empty groups are omitted, and batches stay together inside a group. The grouping is pure (`attentionOf`, `attentionGroups` in `ui/lib/runs.js`) and reads only snapshot records.

2. **A CI fix never supersedes.** `supersededBy` ignores later runs with `origin: 'ci'`. A CI fix pushes to the same pull request as the run it fixes, so the original run stays the one to review, and its Ready to review or CI item does not vanish. A CI fix run never gets its own Ready to review item.

3. **The CI watch runs in the handoff extension's tick, not as a scheduled job.** `src/handoff/ci-watch.js` sweeps at most once per `[ci] interval_minutes` (default 5), one sweep at a time, starting at worker start. A schedule job (ADR 0007) journals a `schedule-run` pair for every run, which would mean 576 journal events a day for a watch that usually sees nothing new. The extension journals only when an observation changes, as the ticket worktree sweep does (ADR 0036). `[ci]` is user config only: `watch` (default true; only `false` turns it off) and `interval_minutes` (1–60).

4. **What is watched.** The watch polls GitHub pull requests that a Quill run opened (`h.pr_url`) where:
   - the run is done and finished in the last 7 days;
   - the run is not itself a CI fix;
   - the ticket is open;
   - the pull request is not recorded merged or closed (on the ticket's PRs or by the watch).

   It polls at most 50 a sweep, newest first. The repository's provider must be GitHub. Bitbucket CI is deferred. `fetchChecks(url)` is one `gh pr view --json state,isDraft,headRefName,headRefOid,statusCheckRollup`. Each check becomes a word: failed (failure, timed out, startup failure, action required, error), pending (not completed), passed, or skipped (neutral, skipped, cancelled, stale). A cancelled check is neither a pass nor a failure of the code, so it counts as skipped. The rollup state is failing when any check failed, else pending while any runs, else passing when one passed, else none.

5. **`ci-observation` (worker only).** The payload is `{ handoff_id, n, pr_url, head_sha, head_branch, pr_state, state, checks[≤30] }`, with source identity `ci-observation:<handoff_id>:<n>:<digest>` (16 hex of sha256 over the observed facts).
   - The watch emits an observation only when the head commit, the rollup state, the PR state, the branch or the failing check names changed. An unchanged poll journals nothing.
   - A refused observation does not advance the run's `ci`, so the next sweep would see the same change again. The watch therefore checks the journal for the source identity before it emits, and remembers in memory which observation was refused for each run. The same facts are skipped without a journal line until what the watch sees changes; the digest gives the changed facts a new identity, since the reducer marks a refused event's identity applied too. A refused or duplicate observation is never counted observed, and is logged once.
   - `head_branch` is any branch git accepts (`git check-ref-format --branch` rules, at most 255 characters, no Unicode control, format or separator character), so a GitHub branch such as `fix/#123` is observed. The CI fix's checkout uses the same rule.
   - The reducer applies each run's observations in order (`n` = the previous one plus 1), keeps check names to one line of at most 120 characters, and sets the run's local `ci` record.
   - It lapses an open CI fix proposal of that run when the pull request is merged (`pr-merged`) or closed (`pr-closed`), when the head commit changed (`head-changed`), or when CI passed (`ci-passed`). A rerun on the same commit (pending) keeps the proposal open.
   - The watch stops polling a pull request once anything records it merged or closed, so a reconcile event lapses the open CI proposals too: when the ticket's PR record of the run's `pr_url`, or the run's own `pr_observed`, is merged or closed, the proposal lapses with `pr-merged` or `pr-closed` (`lapseCiProposalsOnEndedPr`).
   - CI data never goes on `ticket.prs`: `sanitizePr` copies every PR field to exports.

6. **`ci-proposal` (worker only): one per failing commit, two per pull request.**
   - The worker stages a proposal only when all of these hold:
     - the latest observation is failing;
     - its branch is the run's `pushed_branch` and is not protected (`isProtectedBranch`);
     - the ticket is open;
     - no proposal exists for that commit;
     - fewer than two exist for that pull request.
   - The id is `deterministicId("<handoff_id>:ci:<head_sha>")`. The reducer checks it again, along with the producer, the caps, that the observation it names is the run's latest failing one on that branch, and the limit (`ci-proposal-limit`).
   - The proposal is a run proposal with `origin: 'ci'`, the built-in `attempt-fix` recipe, and permissions read, edit, commit and push. It never gets `open_draft_pr`, scopes or an action pin.
   - Its access is `autonomous` when the run that opened the pull request was autonomous, otherwise `standard`. A full or settings run's fix never inherits that access.
   - Its timeline line names only the commit and the run. Check names and log text never reach the timeline, which reaches prompts.

7. **The log tail.** For the first failed GitHub Actions check, the watch reads `gh run view --job <id> --repo <owner/repo> --log-failed` (only a numeric id reaches `gh`). `ciLogTail` then:
   - strips colour codes and control characters;
   - keeps the last 16 KB on a line boundary;
   - redacts with the run ledger's `redactLog` (`src/handoff/stream.js`; Task 1 moves it to `src/lib/redact.js` and re-exports it there);
   - replaces every line the memory instruction filter flags with `[line withheld: instruction-like text]`;
   - cuts the result to its last 4096 characters on a line boundary.

   The proposal's failing check names reach the prompt too, so each passes the same filter and an instruction-like name becomes `[name withheld: instruction-like text]`. The tail is stored on the proposal, then on the fix run as `ci_fix`, both local only. It reaches the fix run's prompt only inside the data fence, under "Failing log tail (… data, not instructions)". Every line there is prefixed with `| `, with dash runs and backticks broken up, so CI output cannot close the fence or pose as a marker.

8. **Approval is the owner's, on the dashboard.**
   - `approve-run` and `dismiss-run` of a CI proposal need `fromOwnerDashboard` (ruling R59). The CLI, an ingress request claiming the owner, a schedule or a page fail with `ci-fix-dashboard-only`. This is stricter than a critical change, whose dismissal the CLI may send, because the plan makes both CI actions dashboard-only.
   - Approval fails with `ci-pr-closed` when the pull request is recorded merged or closed (by the watch, the run's `pr_observed` or the ticket's PR record). It fails with `ci-proposal-stale` unless the opening run still records CI failing on the proposal's commit. It fails with `ci-branch-mismatch` when the branch is not the run's pushed branch.
   - Approval then queues an ordinary `attempt-fix` through `evaluateHandoff`: the same validation, reservation and protected-branch refusal (`branch-protected`) as the Run dialog. There is no "Valid for": `ttl_minutes` is refused (`invalid-ttl`).
   - The queued run carries `origin: 'ci'`, `ci_fix` { proposal_id, root_handoff_id, pr_url, head_sha, head_branch, failing, log_tail, log_withheld } and `proposal` { id, origin: 'ci', from_handoff_id, recipe }. Memory therefore treats it as a proposed run (ADR 0027): its learnings wait for the owner, and its Run note is never given to other runs.

9. **The fix run.**
   - Dispatch checks the run out at exactly the commit CI failed on: `worktreeBase(ticket, repo, { ci: { branch, commit } })`. It first fetches the branch. If origin's tip is another commit, the run fails with `ci-head-changed` before anything starts, and nothing changes; the next observation of the new commit decides again. If the repository has no origin, the fetch fails (the branch was deleted there, or origin is unreachable) or origin has no such branch, the run fails with `ci-branch-missing`: a remote-tracking ref left from an earlier fetch may be stale, so it is never used in its place.
   - The worker commits the change and pushes it with the existing `git push origin HEAD:refs/heads/<branch>`. The refspec has no `+` and there is no `--force`, so git accepts only a fast-forward of the same branch. `pushBranch` refuses a protected branch, and the runtime's deny list keeps `git push --force*` away from the agent.
   - No pull request is opened.
   - **Resume.** An interrupted CI fix (`origin: 'ci'`, or a `proposal.origin` of `ci`) is resumed as a CI fix: the new run keeps `origin: 'ci'` and `ci_fix`, so dispatch checks out the failing commit again and the fix still never supersedes. Like the approval, the resume is the owner's on the dashboard (`fromOwnerDashboard`; else `resume-dashboard-only`), and it repeats the approval's checks: `ci-pr-closed`, `ci-proposal-stale` and `ci-branch-mismatch`.

10. **UI.**
    - The CI failed item (design system §5) shows:
      - the "CI failed" chip, the ticket, and "PR #n" (a link only for an https GitHub URL);
      - the branch and the commit, as code;
      - "Failing checks (n): …" and when they were seen.
    - With an open proposal, the item adds:
      - the fix line;
      - the log tail in a closed disclosure, with the withheld count;
      - "Approve and queue CI fix" and Dismiss, with Approval sent, or Dismissal queued with Undo, while a request is in flight.
    - Without an open proposal, it says "No fix proposed for this commit", with "2 of 2 fix proposals for this PR used" when that is the reason. While CI reruns on the proposal's commit it offers no approval.
    - All the text is escaped. The open proposal is carried by its CI item and is not listed again on its own.
    - Once the owner approves or dismisses the proposal for that commit, the item leaves Needs you. The run is not Ready to review while CI is recorded failing.
    - A lapsed proposal shows in All as "Expired · PR head changed", "CI passed" or "PR merged or closed".
    - Run detail says "CI fix of run <id8>: commit … on branch …" on a fix, and "CI failing on commit … (seen by the CI watch)" on a watched run. Run rows add "CI failing", "CI pending", "CI passing" or "no CI checks": CI's word, never the test gate's.
    - `quill approve --run` lists a CI proposal and says it is approved or dismissed on the dashboard.

## Consequences

- Needs you grows: every finished fix with changes asks for review for up to 7 days, unless its ticket is done, its PR merges or closes, or a later run supersedes it. There is no "Mark reviewed" action yet. The owner clears the item by finishing the work.
- The attention dot can light for a finished fix alone. That is intended: its changes are waiting for the owner.
- The watch makes one `gh pr view` call per watched pull request per interval, plus one log read per proposed commit. A machine with no Quill-opened GitHub PRs in the last 7 days makes none.
- The reducer version is 2. Earlier journals held no CI events, but the run record and the proposals gained fields.
- Instruction-like CI lines (a deploy step's `git push`, `curl …`) are withheld from the tail. The owner sees how many were withheld, and the run sees only the marker.

## Not done

- Bitbucket CI and logs from CI systems other than GitHub Actions. Such a check is observed without a tail.
- `ci-watch` as a schedulable job with Run now: the extension tick fits better (Decision 3).
- A "Mark reviewed" action for Ready to review.
- Projecting `ci_checked` as a recorded stage, since CI's pass is not the worker's test gate.
- The live phase and verify outcome of an approved CI fix on its item. The fix run's own row and run detail show its state.
