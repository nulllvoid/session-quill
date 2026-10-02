# Contributing to Session Quill

Thanks for your interest. This guide gets you from a clone to a green test run and a reviewable pull request. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## What kind of project this is

Session Quill is a Claude Code plugin with a small, deliberately conservative core: a workflow gate on hooks, a durable single-writer worker, markdown notes, a loopback dashboard, and isolated agent handoffs. The spec in [docs/](docs/README.md) is the authority for behaviour; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the code realises it. When the spec and the code disagree, open an issue rather than silently changing either.

Guiding constraints you will be held to in review:

- **Node built-ins only.** No runtime dependencies. The hooks must start fast and never make network or model calls.
- **Fail closed.** Anything the gate cannot evaluate denies covered tools. Anything the worker cannot apply is recorded, not guessed.
- **Nothing is guessed from the working directory.** Session identity comes from the host; bindings never fall back to `cwd`.
- **Authored text is sacred.** Generated note sections are rewritten; user sections are preserved byte for byte, and unrecognized files are conflicts, never overwrites.
- **Privacy by default.** No telemetry, no full prompts, no credentials, no absolute paths in anything that leaves the machine.

## Setup

```bash
git clone https://github.com/nulllvoid/session-quill.git
cd session-quill
node --version   # 22 LTS or newer
npm test
```

There is nothing to install: the test runner is `node:test`. Git is needed for the handoff worktree tests. The `claude` CLI is optional (one test validates the plugin manifest with it and skips otherwise).

### Try the plugin locally

```bash
claude --plugin-dir "$(pwd)"
```

Then in another terminal, from a repository you want to track:

```bash
node /path/to/session-quill/bin/quill.js init --yes --store /tmp/quill-store
```

### See the dashboard with sample data

```bash
node scripts/dev-seed.mjs
```

This starts an in-process worker on a throwaway store seeded with tickets, sessions, a merged PR obligation, a provider error and a stale ticket, and prints a one-use owner URL. It never touches `~/.claude/quill`.

## Running tests

| Command | What it runs |
| --- | --- |
| `npm test` | Everything under `tests/` (unit, integration, acceptance, scaled performance) |
| `npm run test:acceptance` | Only the scenario suite mapped to [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) |
| `QUILL_PERF_FULL=1 node --test tests/acceptance/perf.test.js` | The full A19 profile (10,000 tickets / 100,000 events, about 40 s) |
| `node --test tests/gate/*.test.js` | One area (any directory under `tests/`) |

CI runs the suite on Ubuntu, macOS and Windows with Node 22 and 24.

### Test conventions

- Tests are written first and watched failing. A pull request that adds behaviour without a test that failed before the change will be asked for one.
- Tests exercise real code paths: real files in a temp directory, a real in-process worker, a real HTTP server on a random loopback port, a real `git`. The only stand-in is `tests/fixtures/fake-claude.js`, which replaces the `claude` CLI with a scripted subprocess.
- Acceptance tests are named after their scenario id (`A08 …`) so [docs/ACCEPTANCE-RESULTS.md](docs/ACCEPTANCE-RESULTS.md) can point at them.
- Hook fixtures in `tests/fixtures/hooks/` use the exact field names from the Claude Code hooks reference. If you change them, say which host version you verified against.

## Project layout

```
bin/quill.js            CLI entry (also what hooks/hooks.json invokes)
src/cli/                commands: init, ticket, approve, status, doctor, worker, sync, ui, export, handoff, migrate, hook
src/hooks/              hook adapter: host JSON in, ingress event + gate decision out
src/gate/               shell grammar and tool decision matrix
src/core/               events, ingress, journal, blobs, pure reducer, transitions, keys, approval
src/worker/             single writer: lock, ingestion, notes, projections, health
src/reconcile/          lifecycle, pick-next ranking, PR providers, scheduled runs
src/server/             loopback API, auth/CSRF, request state machine
src/handoff/            reservation, worktrees, agent runner, results, permissions
src/export/             sanitized static HTML export
src/migrate/            inventory, PMLA profile mapping, backup, run/rollback
ui/                     dashboard (plain ES modules, no build step)
agents/, commands/, hooks/, .claude-plugin/   plugin packaging
profiles/               migration profiles
tests/                  node:test suites; tests/acceptance mirrors docs/ACCEPTANCE.md
docs/                   PRD, TRD, data contract, UI spec, ADRs, acceptance scenarios and results
```

## Making a change

1. **Start from the spec.** Find the requirement in the PRD/TRD/data contract. If it is not there, propose it in an issue first; small clarifications can be an ADR under `docs/decisions/`.
2. **Write the failing test**, then the smallest change that passes it, then run `npm test`.
3. **Keep the UI buildable without a bundler.** Modules under `ui/` use named exports only and unique top-level names across files, because the static exporter concatenates them (`src/export/static.js`). Run `node --test tests/ui/*.test.js tests/export/*.test.js` after touching them. Colours are tokens in `ui/styles.css`; the contrast test enforces 4.5:1 for both themes.
4. **Update documentation that the change affects**: README for user-facing behaviour, `docs/ACCEPTANCE-RESULTS.md` if you ran or changed a scenario, `CHANGELOG.md` under *Unreleased*.
5. **Open a pull request** using the template. Describe the behaviour change, how you tested it, and any spec deviation.

### Commit messages

Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`), imperative mood, one logical change per commit. Reference issues in the body.

### Adding a hook event or tool

- Decision rules live in `src/gate/decide.js`; shell forms in `src/gate/shell-grammar.js`. New read-only shell forms require fixtures in `tests/gate/shell-grammar.test.js`; the project never adds a write-command blacklist.
- Payload extraction lives in `src/hooks/payload.js`. Keep events to the fields the data contract allows.

### Adding a reducer event kind

Add it to `EVENT_KINDS` in `src/core/events.js`, handle it in `src/core/reducer.js`, keep the handler idempotent (duplicate `event_id` or `source_identity` must have one effect), derive any new ids with `deterministicId`, and add a replay test.

### Adding a PR provider

Implement `{ name, fetchPr(url) }` under `src/reconcile/providers/` returning the contract fields (`state`, `opened_at`, `merged_at`, `base_branch`, `head_branch`). Failures must throw; the reconciliation run records them as provider errors without touching existing evidence.

## Reporting bugs and requesting features

Use the issue templates. For anything security-relevant (gate bypass, credential exposure, path leaks in exports, handoff escaping its worktree) follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
