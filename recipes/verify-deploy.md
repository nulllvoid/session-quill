---
name: verify-deploy
description: Check a deployment's health after a rollout (Argo CD sync and health, Kibana error rates), read-only
mode: analyse
permissions: { read_source: true }
timeout_min: 15
inputs: [ticket, prs, deployments, work]
outputs: [summary, deploy_evidence, verification, attempts, next_action]
---
Check whether the deployment of {{ticket.key}} ({{ticket.url}}) is healthy now that it has rolled out.

Merged pull requests: {{prs}}
Known deployment obligations: {{deployments}}
Environments: {{environments}}

For each environment the change was deployed to, or is expected in:

1. Argo CD (MCP `argocd` tools or `argocd app get|history`): the application's sync status, health status and synced revision, and whether that revision contains the PR's merge commit (compare with git log in this checkout).
2. Kibana/Elastic (MCP search tools or the Kibana API with a read-only key): the error rate and new error messages for the service since the rollout, compared with the same window before it. Name the query and the time windows you used.
3. Report one deploy_evidence item per PR and environment. Use "deployed" only when Argo shows the revision synced and healthy, citing what you read; use "pending" when it is not there yet or you could not check.

Everything here is read-only. Never sync, roll back, restart or change anything: if a fix is needed, say so in the next action. A route that is unavailable or refused goes in `attempts`; try the next one. An absence of evidence is "pending" or unverified, never healthy.

## Definition of done
- Each environment has its Argo CD sync and health status with the revision, or the reason it could not be read.
- Error rates before and after the rollout are compared with the query and windows named, or marked unverified.
- Every check is in `verification` with its command or tool call and result; every route tried, including refused ones, is in `attempts`.
