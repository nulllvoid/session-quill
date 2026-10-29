# Unified Work control centre verification

Implementation scope: [approved design](superpowers/specs/2026-10-30-unified-work-control-centre-design.md), [ADR 0043](decisions/0043-unified-work-and-daily-continuity.md). Application baseline `403eda6`; spec baseline `afa3254`. This record distinguishes deterministic tests, browser measurements and unavailable live-provider checks.

## Acceptance coverage

| Scenarios | Evidence |
| --- | --- |
| W01–W04 | `tests/core/work.test.js`, closure regressions: required/independent/unknown counts, deployment blockers, non-delivery resolutions, reopened nested work and done-child contradictions. Actual manual statuses remain unchanged. |
| W05–W06 | `tests/ui/work.test.js` + browser Work filters/expansion: full ancestor paths, distinct matching/context rows, complete authorized counts. Export tests recompute eligible counts and omit owner rollups. |
| W07 | `tests/server/work-requests.test.js`: child/old/new-parent revisions, cycle rejection, deterministic creation, inherited privacy, unlink readiness without automatic closure. |
| W08 | Work filters retain context across repositories; execution still validates one target repository through intent/permission tests. |
| W09–W10 | Browser polling, inline/bulk action and dialog tests preserve opening revisions, drafts and explicit selected IDs; pending/conflict receipts remain visible. |
| W11 | Work unit tests cover deep/cyclic/orphan data, unique rows and no mutation during render; large browser fixture includes 50 levels. |
| A01–A02 | Browser short/narrow dialog, Escape/focus and cancellation tests; legacy composer retains reachable controls; Stop is an existing durable worker request, separate from closing the composer. |
| A03–A05 | `tests/handoff/intents.test.js`, existing guard tests and composer tests: real grant predicates, incompatible writes rejected, explicit delivery/branch, Full access not remembered. |
| A06–A07 | Plan/intent and server tests: immutable revisions, semantic context changes, pinned base, missing artifacts, queued drift and built-in shadowing. Browser Plan review/edit/execute exercises actual manifests. |
| A08 | Existing changed-files/test-gate/fix-outcome suites cover committed clean diffs, Git errors, no-change and tested/unverified outcomes. |
| A09–A10 | Source-free Plan/Read-only tests, unusable-repository errors, suggestions-only runtime and reducer defense; legacy request behavior retained. Ready-parent Plan bookkeeping does not auto-close its task. |
| D01–D02 | Daily evidence tests: long-lived parent context, source dedupe, exact period changes and capture-path commit identity. |
| D03–D04 | Daily window/reducer/worker tests: local DST days vs rolling 24 hours, half-open bounds, late evidence, immutable retry input and no cursor on partial/failure. |
| D05 | Daily scheduler tests: disabled default, one latest-slot catch-up, repeat/restart identity, timezone slots, guarded configuration fingerprint and preservation of unrelated settings. |
| D06–D07 | Fake synthesizer failure/unsupported-claim tests; existing memory conflict/staleness selectors and capture/provider coverage. No credentials required for structured generation. |
| D08 | Daily sharing tests + export tests: eligible facts only, private descendants/memory/owner edits excluded, Windows/UNC/POSIX/internal locations removed, counts scoped to shared tasks. |
| D09–D10 | Extension/reducer/real-worker tests: duplicate generation, concurrent joins, cancellation/restart, checkpoint recovery and versioned owner edits/regeneration. |
| D11 | Model output is only an evidence selection; no ticket mutation output surface. Intent results also retain suggestions-only behavior. |
| D12 | Evidence carryover/cursor tests and real-worker historical generation: unreported evening work and late facts remain distinct; historical reports and regeneration never advance continuity. |
| C01 | Route aliases, legacy templates, catalog expectations, original digest/standup tests, static API and offline browser export. |
| C02 | Real-worker update checkpoint/replay tests, reducer-version invalidation, missing-blob partial coverage, worker-only event ingress and owner-only content reachability. |

## Review corrections

Independent review reproduced and corrected hidden export count leakage, relationship-driven accidental closure, done-child contradictory evidence, intent lifecycle closure, Windows/UNC sharing leaks, stale run attention, missing delivery branch controls, hidden Plan manifests, incomplete history navigation, early composer dismissal and commit dedupe across capture paths. HTTP blob reads now require an explicit typed current-state reference; free text and generated JSON cannot grant access.

## Performance and visual verification

Browser fixture: 2,000 tasks / 20,000 timeline entries, a 1,000-child parent and 50-level chain. Five warm-ups and 30 filter/expand samples, Chrome 156 on Apple M2 / macOS arm64 (8 logical CPUs). Final independent measured p95 12.6 ms, maximum 13.4 ms (run alongside the full test suite), zero main-thread tasks over 100 ms; the expanded root renders 200 paged rows. This measures in-browser derivation/render/layout, excluding network and worker generation. It establishes a baseline for this new view, not a claim about improvement over an unmeasured prior release.

Both themes were checked at 1440, 1366×768, 1024, 768 and 390 px. At 1366×768 eight compact parent rows are visible, exceeding the six-row design target. Focused screens include an expanded hierarchy, four-mode composer and Daily continuity. The browser suite asserts no horizontal page overflow and reachable actions.

`node scripts/bench-control-centre.mjs` measures worker snapshot/evidence derivation separately, without live store access. Results vary with concurrent tests; retain the final isolated run below. Existing A19 also exercises actual replay of 2,000 tickets/20,000 journal events and verifies hooks never read the journal.

## Final check results

- `npm test`: **5,182 tests; 5,174 passed, 8 platform-specific skips, zero failures** (87.4 seconds on Node 26.5 / macOS).
- `node --test tests/ui/browser.mjs` with the bundled Playwright runtime: **41 passed, zero failures/skips**. This was independently rerun by the integration agent after domain verification.
- `node scripts/install-smoke.mjs`: **7/7 steps passed** (fresh setup, hooks, first ticket, status and dashboard owner link in an isolated temporary store).
- `git diff --check`: clean. No dependency additions or live owner configuration changes.
- Fresh independent code review: all six reported defects resolved; retained request identity after an ambiguous submission was also fixed and browser-tested. Final audits added Daily bookkeeping purity, real provider capability, objective recovery and evidence-budget priority regressions.
- Remote delivery/CI is recorded in the execution ledger and commit checks; the numbers above are local verification, not an assertion about an unobserved CI run.

Final separate worker benchmark, five warm-ups / 30 measured samples on Apple M2, Node 26.5:

| Operation | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Complete owner snapshot | 37.62 ms | 76.40 ms | 76.77 ms |
| Daily evidence projection | 74.81 ms | 81.37 ms | 91.13 ms |

The evidence benchmark allows all 20,000 fixture facts to measure collection cost. Normal generation keeps a 10,000-fact budget, prioritizing current changes/carryover/late facts before recent history; truncation is explicitly partial and never advances continuity. These are worker CPU timings, separate from browser rendering, network, model latency and journal replay.

## Screenshots

Synthetic fixtures demonstrate interaction and layout; they are not claims about real delivered work.

- [Expanded parent and subtasks](verification/control-centre/work.png)
- [Desktop agent composer](verification/control-centre/composer.png)
- [Phone composer with reachable actions](verification/control-centre/composer-phone.png)
- [Daily continuity draft](verification/control-centre/daily-update.png)

## Limits

No paid model invocation, external push from an agent, real Jira mutation or new live daily schedule was exercised. Runtime behavior is covered with the existing fake runtime plus actual permission/guard predicates; structured Daily generation needs no model. Cross-platform guard skips and remote CI results are reported with the final run. Optional narrative currently selects exact source facts instead of paraphrasing them; deterministic continuity and provenance remain the canonical output.
