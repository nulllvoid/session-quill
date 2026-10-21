# Issue review: handoff runs strip the credentials stdio MCP servers rely on

Date: 21 October 2026. Draft issue by the owner (not filed), reported against 1.1.1 (2658268) on macOS. Reviewed against `main` 2658268. Fixes 2 and 4 below are adopted into 2.0.0 as plan Task 14; fixes 1 and 3 are candidates for a 1.1.x patch.

## The report

Three local stdio MCP servers (`jenkins`, `bitbucket`, `argocd`) read their credentials from the inherited environment rather than an MCP config `env` block. In autonomous handoff runs every call fails (`Set CRE_JENKINS_HOST...`, `BITBUCKET_API_TOKEN is not set`, `Set ARGOCD_URL...`); the same calls succeed in an interactive session on the same machine. The servers still report "connected", nothing at dispatch warns, and the run filed a machine-scope pitfall saying the servers are broken (quarantined: `5eeb330e`, `e2297238`, `be5e5795`).

## Verified causes

1. **Autonomous runs remove the variables, by design** (`src/handoff/cred-env.js`):
   - `CRE_JENKINS_TOKEN` by the generic `SECRET_NAME` pass (line 260);
   - `BITBUCKET_API_TOKEN` by `REMOVE.git` (`BITBUCKET_.*`), unless push or a draft PR is granted;
   - `ARGOCD_*` by `REMOVE.argo`; `ARGOCD_OPTS` becomes an empty `--config` stub.
   `spawnAgent` starts `claude` with that environment and stdio MCP servers inherit it. Literal values in an MCP config `env` block survive; `${VAR}` expansions in it resolve against the stripped environment.
2. **The macOS worker never had the variables.** The LaunchAgent sets only `PATH` and `QUILL_HOME` (`src/worker/autostart.js:74-80`), so nothing exported in `~/.zshrc` reaches the worker. `CRE_JENKINS_HOST` is not secret-named and is removed by nothing, so its absence shows this. This also breaks `full` and `standard` runs.

## Corrections to the draft

- `keep_env` exempts names from the generic pass only. It cannot keep `BITBUCKET_*` or `ARGOCD_*`. ArgoCD's route is `[prod.readonly.argocd_env]` with a read-only token; git-provider tokens have no read-only slot, so only push permission keeps them today.
- Any token passed into an autonomous run should be read-only: credentials are the boundary (ADR 0026).
- Memory is delivered to agent runs only (ADR 0027), not interactive sessions. The pitfall is true for runs today, but nothing invalidates it once the environment is fixed.

## Fixes

1. `quill doctor` warns about likely-missing worker variables; an opt-in `[worker] env_passthrough` written into the LaunchAgent / systemd unit. (1.1.x patch candidate.)
2. **Adopted, Task 14.** Record the removed variable names (never values) in the run's credential report; show them in the Run dialog and run detail; tell the agent in the prompt that a tool needing one is unavailable in this run, not broken.
3. A `[prod.readonly.git_env]` slot so provider API reads do not need push. (1.1.x patch candidate.)
4. **Adopted, Task 14.** Environment-dependent learnings from autonomous runs carry a `run-env` anchor on a fingerprint of the run environment (removed names, `keep_env`, credential report, configured read-only keys) and go stale when it changes, reusing Task 4's anchors and `staled` op.
5. Guard refusals of variable paths and `/tmp` writes stay (blunt fail-safe rules); the refusal message could name the literal-path alternative.
