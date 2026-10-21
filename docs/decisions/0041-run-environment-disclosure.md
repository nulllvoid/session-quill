# ADR 0041 — Run environment disclosure and environment-anchored memory

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0026](0026-autonomous-access-and-guard.md), [ADR 0027](0027-run-memory.md) and [ADR 0032](0032-anchored-memory-and-failure-ledger.md) · Source: `docs/research/2.0.0/02-issue-mcp-credentials.md` (fixes 2 and 4) · Plan task 14

## Context

An autonomous run's child environment loses the owner's credential variables by design (`src/handoff/cred-env.js`, ADR 0026). Three cases from the report:

- `CRE_JENKINS_TOKEN` goes through the generic secret-name pass.
- `BITBUCKET_API_TOKEN` goes through the git system's list unless push or a draft PR is granted.
- `ARGOCD_*` goes through the Argo list.

Stdio MCP servers that read those variables from the inherited environment then fail inside the run. The same calls work in the owner's interactive session. The servers still report "connected", nothing at dispatch says what the run lost, and the agent filed a machine-scope pitfall saying the servers are broken. Nothing ever invalidated that pitfall once the owner fixed the environment.

The credential boundary is right and stays as it is. What was missing:

- telling the owner and the agent which variables were removed;
- recording which learnings rest on that environment, so they stop reaching runs when it changes.

## Decision

### What was removed, by name

- `buildChildEnv` collects the inherited names step 1 removes: each system's list, the generic `SECRET_NAME` pass and `stripNames`.
- `report.removed` holds them as `string[]`, sorted and de-duplicated, at most 200.
- On win32 names match in any case. The report keeps the inherited spelling, once per name in any case.
- A name step 2 then points at a stub or read-only profile is still listed (`KUBECONFIG`, `GH_TOKEN`), because the owner's value did not reach the run.
- Session markers and git program variables are not listed. Every tier removes them, and they are not credentials a tool would miss.
- `full` access keeps the owner's environment and has no `removed`.
- The report holds names only, never a value. The tests check that no synthetic value appears in the report or the prompt.

### Fingerprint

- `envFingerprint({ removed, keepEnv, report, readonlyKeys })` is 16 hex of sha256 over four things:
  - the sorted removed names;
  - the sorted `keep_env` names;
  - each `CRED_SYSTEMS` report word, in order;
  - the sorted `[prod.readonly]` key names (`readonlyKeyNames`: each key, and `<table>.<NAME>` for `db_env` and `argocd_env`).
- Values never enter it. Residual sentences and scope errors do not count.
- On win32 variable names count in any case, as `buildChildEnv` matches them: removed names, `keep_env` names and the variable part of `<table>.<NAME>` are compared upper-cased, so `keep_env = ["Cre_Token"]` and `["CRE_TOKEN"]` give one fingerprint.
- `prepareAutonomous` stores it as `cred_report.env_fingerprint` beside `removed`.

### Disclosure

- **Prompt.** An autonomous run with removed names gets them inside the data fence under "Run environment": at most 60, then ", and N more". Each name is flattened so it cannot close the fence.
- After the method it gets one worker-authored line, outside the fence: "Quill removed some environment variables from this run by design (listed under Run environment). A tool or MCP server that needs one is unavailable in this run, not broken on the machine; say so in the learning."
- Other access levels get neither, and neither does a run with nothing removed.
- **Run dialog.** Under Access, after the production command-line tools, a details element reads "Removed from autonomous runs: N variables (as recorded when run <id8> started)". It holds the escaped names and one line saying a tool needing one is unavailable there, not broken.
  - It comes from the latest autonomous run's report (`meta.autonomy.credentials`), the same idiom as the connected tools.
  - With no such report, or one recorded before this ADR, nothing is claimed.
- **Run detail.** An owner-only "Environment" section shows "Removed by design (n)", the names and "Fingerprint <hex>".
  - The data comes from the snapshot's `run_env`: `{ removed, env_fingerprint }`, projected from `cred_report`, which the snapshot still strips.
  - `run_env` is in no export allow-list, so an export, the mirror, publishers and vault notes never have it. The section is then absent, never empty.

### Environment-anchored memory

- **Anchor.** Filing gives an autonomous run's learning a `{ kind: 'run-env', env_fingerprint }` anchor and `observed_in: 'autonomous'` when the learning is environment-dependent (`envDependent`):
  - (a) it is machine scope in Tools or Connectors & MCP;
  - (b) its text, key or evidence names a removed variable (whole name, any case); or
  - (c) it names an MCP server of the run (whole word, or the `mcp__<server>__` tool form). The servers come from `<runDir>/mcp-servers.json`, else the run's init inventory.
- This applies whatever the learning's trust. The report's own pitfalls would be found by (b) and (c).
- **Anchor list.** An entry keeps at most one run-env anchor beside its file anchors. Every ADR 0032 reader uses `fileAnchors`, so anchor checks and delivery verdicts are unchanged.
- **Verdict.** At each autonomous dispatch the worker compares the run's fingerprint with each live run-env anchor. This happens after the run is marked running and before its Memory section is gathered.
  - Live means active, not superseded, not pinned, not owner and not quarantined.
  - On a mismatch the worker journals `memory-tx` `{ op: 'staled', reason: 'run-env-changed', anchor: { kind: 'run-env', env_fingerprint, current_env_fingerprint } }`, with source identity `memory-tx:runenv:<id>:<fingerprint>`.
  - The reducer refuses a verdict whose `env_fingerprint` is not the entry's own anchor. It also refuses one for a pinned or owner entry (R27).
- **Revival.** A later run that files the same learning confirms it. The `confirmed` op carries the new run-env anchor, which replaces the old one, and the entry revives as in ADR 0032.
- **Owner view.** The Memory page shows "Seen in autonomous runs" when `observed_in` is set. It shows "Run environment changed · not delivered to runs" for such a stale entry.
- **Other surfaces.** Delivery counts these entries under "Run environment changed since recorded, not delivered". The projection and `quill memory list` name the reason too.

## Consequences

- The owner sees which variables autonomous runs lose, without reading cred-env.js. The agent is told why a connector fails, so it records "unavailable in this run" rather than "broken".
- A pitfall about the run environment stops reaching runs once the owner changes `keep_env`, a read-only profile or what the worker inherits. A run that learns it again brings it back.
- The README's "MCP servers in autonomous runs" says which fix applies to which variable.

## Residual risks

- **Per-run grants change the fingerprint.** Push or a draft PR keeps the git system's tokens (`report.git` becomes `owner`, and `BITBUCKET_*` is not removed). A scope or a Bedrock/Vertex sign-in changes report words. So a run with different grants stales entries learned under others. That is intended, since what one run lacked another may have. A stale entry stays stale until a run confirms it.
- **The source identity is per entry and fingerprint.** An entry confirmed at A, then staled going to B, then confirmed at B and back at A, is not staled again when B returns: `memory-tx:runenv:<id>:<B>` is already journaled. This matches ADR 0032's per-version rule.
- **Text matching.** (b) and (c) match names as words. A learning that describes a server without naming it, or a removed variable in other words, is not anchored. A short or common server name anchors more than needed, which only costs an earlier stale.
- **A worker that never had the variable.** A variable that is not secret-named and was never in the worker's environment, such as `CRE_JENKINS_HOST` under a macOS LaunchAgent, is not "removed". The fingerprint does not see it. The report's fix 1 (a doctor warning and `env_passthrough`) is a 1.1.x candidate, not part of this ADR.
- **Resume.** A resumed run continues the interrupted run's session. That first prompt already carried the run environment, so its first turn does not repeat it.

## Alternatives considered

- **Values or value hashes in the fingerprint.** Rejected: a rotated token would stale every entry, and a hash of a short secret can be brute-forced. Names say what the run could reach.
- **Passing selected variables through.** Rejected here: credentials are the boundary (ADR 0026). `keep_env` and `[prod.readonly.argocd_env]` are the owner's existing routes. A read-only git-provider slot is the report's fix 3, a 1.1.x candidate.
- **Staling on every changed report.** Rejected: residual sentences and scope errors change with the machine's files, not with what a tool can read.
- **A new event kind or a separate store.** Rejected by the plan: an anchor kind and a `staled` reason reuse ADR 0032's machinery.
