---
name: deploy-check
description: Check whether each merged PR reached each deployment environment, with evidence
mode: analyse
permissions: { read_source: true }
tools: [Read, Grep, Glob, "Bash(git log:*)", "Bash(git show:*)"]
timeout_min: 10
inputs: [ticket, prs, deployments, work]
outputs: [summary, deploy_evidence, next_action]
self_check: true
---
Check the deployment state of {{ticket.key}} ({{ticket.url}}).

Merged pull requests: {{prs}}
Known deployment obligations: {{deployments}}
Environments: {{environments}}

For each merged PR and each environment:

1. Find the merge commit of the PR in this repository's history (git log, searching for the PR number or its branch).
2. Look for evidence that a deployment to that environment includes it: a values-file or manifest tag bump at or after the merge commit, an ArgoCD application change, a release tag that contains the commit, or a deployment commit naming the environment.
3. Report one deploy_evidence item per PR and environment, naming the PR URL. Use "deployed" only with a cited commit or file, and give deployed_at when the commit time shows it. Use "pending" when you found no evidence yet. Use "n-a" only when the repository shows this change does not deploy to that environment, and give the reason.

An absence of evidence is "pending", never "deployed". Suggest a next action only if something is still pending, naming the environment and what to check. Never deploy, tag or push anything yourself.
