# ADR 0005 — Gate modes and zero-command binding

Date: 2026-10-02 · Status: accepted · Supersedes the v0.2 default "gate on" (PRD defaults, TRD §Configuration)

## Context

The v0.2 gate denied every supported write, unknown shell command and MCP tool until someone ran `/session-quill:ticket bind` or `create` by hand. A real session on 2026-10-02 showed six points of friction:

1. Writes, piped or quoted reads, doc and note writes and every MCP tool were denied mid-task until bound.
2. Ticket keys in the prompt were ignored; the prompt only contributed a session title.
3. The git branch (`feat/PROJ-1234-...`) was never read.
4. Binding needed `--session <id>`, which exists only if SessionStart ran after `quill init`.
5. Keys were local slugs (`LOCAL-<slug>-<id>`); an external key could only be attached later with `relink --jira`.
6. Naming was tracker-specific (`--jira`) and links had no URL template.

The proposal "Session Quill: zero-command ticket tracking" asks for tracking with no commands: mention a ticket key and the session is bound.

## Decision

- **Gate modes.** `[gate] mode` is `off` (capture only), `nudge` (new default) or `strict` (the v0.2 behaviour). Legacy `gate_enabled = false` means `off`. A repository `.quill.toml` may tighten the user's mode but never loosen it; an unrecognized value fails closed to `strict`. A runtime identity without `gate_mode` (written by an older worker) is treated as `strict`.
- **Nudge.** In `nudge` mode the gate never denies a tool call. When an unbound session changes files or commits, the next `Stop` returns `decision: "block"` once per session, asking Claude to find out which ticket the work belongs to. It never fires while `stop_hook_active` is true.
- **Tracker config.** One `[tracker]` table (user config, overridden field by field by a repository's `.quill.toml`) defines `system`, `domain`, `url_template` (`{domain}`, `{key}`, `{repo}`, `{number}`), `key_pattern`, `prefixes`, `sources` and `on_new_key`. No tracker host is built in. Patterns are validated when the worker loads config: at most 200 characters, must compile, no nested quantifiers. Scans stop after 4,000 characters and 10 keys. Without a prefix allowlist, common tokens such as `UTF-8` or `SHA-256` are ignored.
- **Auto-binding.** `UserPromptSubmit` scans the prompt and `SessionStart` scans the current branch (read from `.git/HEAD`, never by spawning git). On a configured key, the hook writes a provisional binding snapshot and then persists a `bind` event carrying the external key, so later tool calls in the same turn already see the binding. The worker keeps a fresh provisional snapshot (under 30 s, event not yet applied) through unrelated republishes and replaces it with the confirmed one once the event is applied. If the event cannot be persisted, the hook restores the previous snapshot. A branch never switches an existing binding. A prompt switches it (`on_new_key = "switch"`), records a mention only (`add`) or does nothing (`ignore`); mentioning the bound key or one of its aliases changes nothing.
- **External keys are first-class.** The reducer binds to the ticket whose key or alias equals the external key, or creates it under that key with a deterministic id (`external-ticket:<store>:<key>`) and an `external` record `{ system, key, url, validation, validated_at, error }`. `LOCAL-` keys stay legal. `ticket relink --external` replaces `--jira`, which stays as an alias.
- **Late-init sessions.** The first prompt from a session the worker has never published a snapshot for injects the session id and how to link it.
- **Forward-only.** Bindings never move earlier captured work.

## Consequences

- The PRD guarantee "supported mutating tool calls require a binding" and acceptance scenarios A01, A07 and A13 now describe `strict` mode. `nudge` enforces nothing; it only asks.
- Hooks still read one identity file and one snapshot per call: no TOML parsing, journal reads, network or subprocesses. Edits to `config.toml` or a registered `.quill.toml` are picked up by the worker within 10 seconds.
- Work done while unbound in `nudge` mode stays unattributed until the step 2 "unbound work inbox" lets the user attach it.
- The UI still shows `jira` links only; tickets from other systems show their key without a link until step 2 adds external key chips.

## Alternatives considered

- **Keep `strict` as the default.** Rejected: it is the friction the proposal sets out to remove. Teams that want it set `mode = "strict"`.
- **Per-key index files so hooks know existing ticket ids.** Rejected for now: the reducer attributes pre-tool records that name an unknown id to the session's confirmed binding, which covers the only case where the provisional id is wrong.
- **Spawning `git` from hooks for the branch.** Rejected: reading `.git/HEAD` (including worktree `gitdir:` files) is enough and keeps hooks offline and fast.
