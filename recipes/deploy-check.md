---
name: deploy-check
description: Check whether each merged PR reached each deployment environment, with evidence
mode: analyse
permissions: { read_source: true }
tools: [Read, Grep, Glob, "Bash(git log:*)", "Bash(git show:*)"]
timeout_min: 10
inputs: [ticket, prs, deployments]
outputs: [summary, deploy_evidence, next_action]
---
Check the deployment state of {{ticket.key}} ({{ticket.url}}).

Merged pull requests: {{prs}}
Known deployment obligations: {{deployments}}
Environments: {{environments}}

For each merged PR and each environment, look for evidence in this repository's history that the change was deployed there: a values-file or manifest tag bump that includes the merge commit, an ArgoCD application change, a release tag, or a deployment commit. Report one deploy_evidence item per environment with state "deployed" (cite the commit or file), "pending" (no evidence yet) or "n-a" (this change does not deploy to that environment, with the reason). Suggest a next action only if something is still pending. Never deploy, tag or push anything yourself.
