## What changes

<!-- Behaviour, not files. Link the issue. -->

## Spec

<!-- Which PRD/TRD/data-contract requirement this implements or changes. If it deviates, say so and why (an ADR under docs/decisions/ for anything lasting). -->

## How it was tested

- [ ] A test failed before the change and passes after it (name it: `tests/...`)
- [ ] `npm test` is green locally
- [ ] If a scenario in `docs/ACCEPTANCE.md` is affected, `docs/ACCEPTANCE-RESULTS.md` is updated

## Checklist

- [ ] No new runtime dependencies; hook path makes no network or model calls
- [ ] Fail-closed behaviour preserved for covered tools
- [ ] No absolute paths, credentials or prompts added to anything that leaves the machine
- [ ] UI changes keep both themes at 4.5:1 contrast and work at 390 px
- [ ] `CHANGELOG.md` updated under *Unreleased*
