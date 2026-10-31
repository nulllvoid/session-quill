# Contributing to Session Quill

Thanks for your interest. This guide gets you from a clone to a green test run and a reviewable pull request. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## What kind of project this is

Session Quill is a Claude Code plugin with a small, deliberately conservative core: a workflow gate on hooks, a durable single-writer worker, markdown notes, a loopback dashboard, and isolated agent handoffs. The spec in [docs/](docs/README.md) is the authority for behaviour; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the code realises it. When the spec and the code disagree, open an issue rather than silently changing either.

Guiding constraints you will be held to in review:

- **Keep the worker and hooks dependency-free.** Their runtime uses Node built-ins, starts quickly, and makes no network or model calls on the hook path. The approved Cloudscape/React UI dependencies are bundled locally; the worker and hooks do not import them.
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

The test runner is `node:test` and needs no package installation. Git is needed for the handoff worktree tests. The `claude` CLI is optional (one test validates the plugin manifest with it and skips otherwise). To change the live shell, run `npm ci`, then `npm run build:ui` and `npm run check:ui`; the checked-in browser bundle lets plugin users run the dashboard without those packages.

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

After installing frontend dependencies, `npm run dev:ui` rebuilds the shell before starting the seed worker. `npm run review:ui` serves the production-renderer fixture gallery without mutation endpoints. See [Studio development notes](docs/design-system/AFTERHOURS.md).

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

### Browser interaction checks

The dashboard browser suite uses an isolated loopback server and fixture data. It checks keyboard actions, native controls, drafts and disclosures across polling, pagination, and mobile/desktop layouts in both themes. It needs an existing Playwright installation and Chrome; it is separate from the dependency-free `npm test` suite.

```bash
NODE_PATH=/path/to/node_modules node --test tests/ui/browser.mjs
```

Set `PLAYWRIGHT_CHANNEL` to use another installed Chromium channel, such as `msedge`.

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
ui/                     dashboard renderers (plain ES modules) and locally bundled Cloudscape shell in ui/platform
agents/, commands/, hooks/, .claude-plugin/   plugin packaging
profiles/               migration profiles
tests/                  node:test suites; tests/acceptance mirrors docs/ACCEPTANCE.md
docs/                   PRD, TRD, data contract, UI spec, ADRs, acceptance scenarios and results
```

## Making a change

1. **Start from the spec.** Find the requirement in the PRD/TRD/data contract. If it is not there, propose it in an issue first; small clarifications can be an ADR under `docs/decisions/`.
2. **Write the failing test**, then the smallest change that passes it, then run `npm test`.
3. **Keep workflow renderers export-compatible.** Renderer modules under `ui/` use named exports and unique top-level names because the static exporter concatenates them (`src/export/static.js`). The live shell under `ui/platform/` is a separate React/Cloudscape bundle, removed from standalone exports. Rebuild it with `npm run build:ui` and verify it with `npm run check:ui`. Run `node --test tests/ui/*.test.js tests/export/*.test.js` after UI changes. Shared tokens in `ui/styles.css` and `ui/platform/theme.mjs` keep both themes aligned; contrast tests enforce 4.5:1.
4. **Update documentation that the change affects**: README for user-facing behaviour, `docs/ACCEPTANCE-RESULTS.md` if you ran or changed a scenario, `CHANGELOG.md` under *Unreleased*.
5. **Open a pull request** using the template. Describe the behaviour change, how you tested it, and any spec deviation.

### Commit messages

Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`), imperative mood, one logical change per commit. Reference issues in the body.

### Adding a hook event or tool

- Decision rules live in `src/gate/decide.js`; shell forms in `src/gate/shell-grammar.js`. New read-only shell forms require fixtures in `tests/gate/shell-grammar.test.js`; the project never adds a write-command blacklist.
- Payload extraction lives in `src/hooks/payload.js`. Keep events to the fields the data contract allows.

### Adding a reducer event kind

Add it to `EVENT_KINDS` in `src/core/events.js`, dispatch it in `src/core/reducer.js` (put a handler of any size in the matching `src/core/reduce/` module), keep the handler idempotent (duplicate `event_id` or `source_identity` must have one effect), derive any new ids with `deterministicId`, and add a replay test.

### Adding a PR provider

Implement `{ name, fetchPr(url) }` under `src/reconcile/providers/` returning the contract fields (`state`, `opened_at`, `merged_at`, `base_branch`, `head_branch`). Failures must throw; the reconciliation run records them as provider errors without touching existing evidence.

## Reporting bugs and requesting features

Use the issue templates. For anything security-relevant (gate bypass, credential exposure, path leaks in exports, handoff escaping its worktree) follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
