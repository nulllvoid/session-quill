---
name: Bug report
about: Something behaves differently from the spec or the README
title: ''
labels: bug
assignees: ''
---

**What happened**

**What you expected** (link the PRD/TRD/data-contract line if you know it)

**How to reproduce**

1.
2.
3.

**Output of `node bin/quill.js doctor`**

```
paste here (it contains no secrets)
```

**Environment**

- OS and version:
- Node version (`node --version`):
- Claude Code version (`claude --version`):
- How the plugin is loaded (`--plugin-dir` / marketplace):

**Logs**

Relevant lines from `~/.claude/quill/logs/` or `state/health-errors.jsonl`, with any local paths removed.

> Security problems (gate bypass, credential or path leaks, handoff escaping its worktree) go through [SECURITY.md](../../SECURITY.md), not a public issue.
