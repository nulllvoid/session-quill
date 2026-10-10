# ADR 0020 — Installing shared recipes

Date: 2026-10-11 · Status: accepted · Builds on [ADR 0008](0008-agent-recipes.md) and [ADR 0017](0017-run-access-levels.md)

## Context

Recipes are Markdown files (ADR 0008), so teams already pass them around by copying files. Copying loses where a recipe came from, which version it was and whether it was edited since, and a copied recipe gets no review of what it may do. A recipe is a prompt that runs under the owner's Claude Code account with a permission ceiling, so installing one from someone else is a decision about trust, like installing code.

## Decision

- **Sources.** `quill agent install <source>` takes an `https://` Git URL (optionally `--ref` a branch, tag or commit) or a local folder. Recipes are the `*.md` files (README and similar excluded, at most 50, each at most 32 KiB) in the first of `.quill/agents/`, `recipes/`, `agents/` or the top folder that has any.
- **Safe fetch.** Git clones are shallow, https only (`protocol.allow=never` except https), without submodules, without prompts and with a 60-second limit. URLs with credentials, other schemes (`ssh://`, `file://`, `ext::`) and refs that are not plain names are refused before git runs. The clone is deleted afterwards.
- **Preview, then confirm.** Without `--confirm`, the command lists each recipe with its mode, time limit, permissions and tools, calls out the permissions that can change things (edit, commit, push, draft PR, file edits and deletes), and lists invalid recipes with the validator's reason. Nothing is written. With `--confirm`, the valid recipes are copied byte for byte into the personal recipes folder.
- **Provenance and ownership.** `~/.claude/quill/agents/.installed.json` records each installed recipe's source, ref, commit, file and content hash. `agent list` labels them `installed`. A hand-written personal recipe with the same name is never overwritten, and an installed one is replaced only with `--replace`. `agent uninstall` removes only recipes it installed, and only while they are unchanged (`--force` to remove an edited one).
- **No new powers.** An installed recipe is an ordinary personal recipe: its frontmatter is a ceiling, each run is still granted permissions explicitly, attempt-fix and file recipes are never scheduled, and full access is never the default (ADR 0017). A repository's own `.quill/agents/` recipes still win over personal ones.

## Consequences

- Teams can publish a recipe repository and pin a tag; owners see what changed by previewing a newer ref before `--replace`.
- Updates are deliberate. There is no automatic update, so a compromised upstream cannot change an installed recipe without the owner's command.

## Alternatives considered

- **A central registry.** Rejected for now: it would need hosting, moderation and identity, and a Git URL already names a source the owner chose.
- **Install into the repository's `.quill/agents/`.** Rejected as the default: that changes the project for everyone who uses the repository. Teams can still commit recipes there deliberately.
