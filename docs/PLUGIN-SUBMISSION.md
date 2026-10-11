# Claude directory submission packet

Prepared on 2026-10-11. This is a review packet, not evidence of directory acceptance. Metadata is prepared for 1.0.0; no release tag or directory submission is created by this document.

## Source and listing

| Field | Value |
| --- | --- |
| Submission type | Plugin bundle |
| Repository | `nulllvoid/session-quill` |
| Plugin path | Repository root; leave the optional path blank |
| Tracked branch | `main`, after the preparation changes have been reviewed and merged |
| Name / display name | `session-quill` / Session Quill |
| Publisher | Shivam Shah |
| Intended surface | Claude Code; do not claim Cowork or Claude web compatibility without testing |
| License | MIT |
| Website | https://nulllvoid.github.io/session-quill/ |

Short description:

> Connect Claude Code sessions to tickets, preserve local work history, and run agents in isolated worktrees with worker-run test checks.

Use cases:

- Resume an interrupted task using its previous notes, plan, files and next action.
- Connect work across sessions and repositories to Jira, GitHub or local tasks.
- Queue bounded agent work and review its suggestions and actual test evidence.

Prerequisites: Node 22 or later on PATH, Claude Code and a Git repository. Agent runs additionally need an authenticated Claude CLI. Tracker credentials, `gh`, Bitbucket and artifact access are feature-specific, not required for the first local tracking task.

## Data-handling answers to review in the portal

- **Reads or stores personal data: yes.** Ticket text, assignee names, notes, paths and work history may identify people or contain confidential information. The local owner controls the store.
- **Sends data to other services: yes, for configured features.** There are no declared MCP connectors. Tracker and PR integrations call their configured services; agent runs use the configured model provider; clones, pushes and publishing contact their chosen hosts. Do not answer this question "no" merely because storage is local.
- **Retention:** local history is retained until owner removal, with no general automatic expiry. Dashboard authentication expires separately. External providers and exported copies have their own retention.
- **Under-18 audience:** the product is a developer workflow tool. The publisher must confirm the intended-age answer; this audit does not establish an age policy.
- **Contact email:** the publisher must supply and verify a reachable address. Do not infer it from Git history.

The [data-handling document](DATA-HANDLING.md) contains the detailed execution, destination and removal disclosures.

## Audit findings

Fixed in this preparation:

- Package and plugin metadata now agree on the prepared 1.0.0 version; descriptions agree across the marketplace entry and plugin manifest.
- The README offers a first task without tracker credentials and links data-handling details.
- Security support text no longer claims main is 0.1.x.
- The website explicitly identifies Claude Code and no longer says no data leaves the machine until an agent run or publication. Configured sync also contacts external services.

Reviewer considerations that remain:

- Tracker/provider authentication reads environment credentials. The [directory checklist](https://claude.com/docs/plugins/pre-submission-checklist) identifies this as a reviewer hold. Disclose it; do not claim a clean portal validation or silently replace the credential architecture with untested configuration.
- The plugin contains runtime code, hooks, background processing, user-configured test commands and optional network integrations. Local validators do not certify their security.
- The dashboard loads bundled fonts and the repository contains website build assets. The portal may require review of asset references. No website dependencies are installed by the root package.
- Directory name availability, account eligibility, connected GitHub access and portal scan findings remain unverified.
- The publisher still needs a real Claude session installation/run check and a recorded demo. The automated smoke test simulates hook payloads and does not establish end-to-end Claude UI loading or a real model run.

## Verification

Run from the repository root:

```sh
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
npm run check:submission
npm test
node scripts/install-smoke.mjs
npm run build --prefix site
npm run check --prefix site
```

See [submission audit results](SUBMISSION-AUDIT.md) for this run's evidence and limits.

## Portal handoff

Use the [official submission instructions](https://claude.com/docs/plugins/submit). Run portal validation against the final pushed commit, then use this packet to check the listing and answer data questions. The publisher should personally confirm the contact address, intended audience, legal acknowledgements and update policy. Any later source change needs fresh validation. Prefer manual publication for the first version.

## Real demo plan, 60 to 90 seconds

Use a disposable repository and synthetic ticket text. Do not record a private tracker, user home, token, sign-in link or real customer issue.

1. Show the install commands and Node prerequisite. Start a fresh Claude session with the plugin loaded.
2. Run `/session-quill:start`, then ask Claude to create and work on one small README task.
3. Open `/session-quill:ui` off-camera to consume the one-use URL. Record the dashboard with the bound ticket and changed file.
4. Resume the same ticket in a new session and show the recovered context.
5. In a separate prepared code fixture, configure a fast test command, authorize an attempt-fix run and show the worker's recorded test exit code. Disclose any time cuts; do not portray a simulated result as a real model run.
6. End with the repository URL and exact installation commands.

If the recording omits the agent/test step, label it as a local tracking demo rather than a verified-fix demo. A recording has not yet been produced.
