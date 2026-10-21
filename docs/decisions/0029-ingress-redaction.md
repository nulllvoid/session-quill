# ADR 0029 — Ingress secret redaction

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md), [ADR 0003](0003-settings-hooks-over-mods.md), [ADR 0018](0018-tracker-write-back.md) and [ADR 0026](0026-autonomous-access-and-guard.md) · Spec: `docs/research/2.0.0/00-prd.md` FR-3.3 as amended by `docs/research/2.0.0/01-gap-analysis.md` (row 3.3)

## Context

Secret redaction existed only for agent runs: `src/handoff/stream.js` redacted the run ledger and the log, and memory filing reused it. The journal itself had none. Every hook and CLI event goes through one function, `writeIngress`, and it stored what it was given. Free text reached the journal and the blob store unredacted: a Stop message (its blob, preview and conclusions), an ExitPlanMode plan (blob and preview), `pre-tool` `write_target` (the first 120 characters of a shell command), a `tool-failure` error, the first prompt's title candidate, a commit message from `git commit` output, and a `quill tracker push --comment` body (sent to the tracker as typed). A token pasted into any of them stayed in `events.jsonl` and in the blobs for good, and reached the dashboard.

The PRD asked to move `src/export/sanitize.js` into ingress. The gap analysis corrected that: `sanitize.js` redacts absolute paths for exports, which the journal needs (bindings, write paths, repository roots); the secret patterns live in `stream.js`.

## Decision

- **One module.** `src/lib/redact.js` holds the secret rules and imports nothing, so the hook path and the run guard can load it. `redactText(s)` applies them; `redactCapped(s, max)` redacts a bounded slice and cuts to `max` bytes without leaving a cut secret's prefix; `redactEvent(ev)` returns a copy whose payload's string leaves are redacted. `stream.js` keeps its exports (`redactLog`, `redactCapped`, `capBytes`) and builds them on the shared module, with the export path redaction after the secret pass as before; the run guard's `GUARD_CODE` lists the new module. `cred-env.js` takes its secret-name rule (`SECRET_NAME`) from it.
- **Rules.** Everything `redactLog` already caught (GitHub, GitLab, Slack, npm and `sk-` tokens, AWS `AKIA` key ids, `Bearer`/`Basic` credentials, URL userinfo, `secret=value` pairs, PEM private keys), plus AWS `ASIA` session key ids, `.env` lines whose upper-case name matches the secret-name rule, and a high-entropy rule: 32 or more base64/base64url characters with an entropy above a bar that rises with length, or more than 64 hex characters. The replacement is the existing `[secret redacted]`. Every pattern is bounded or anchored on a literal, so cost stays linear.
- **Redaction at ingress.** `writeIngress` writes `redactEvent(ev)`. The caller's event is not changed.
- **Worker re-check.** The worker applies `redactEvent` again to each ingress file before it validates and journals it. Ingress is a folder anything on the machine (an older Quill, an autonomous run) can write, so the producer's redaction is not trusted alone. Redaction is idempotent, so the second pass costs one scan and changes nothing for a file `writeIngress` wrote.
- **Redact before cutting and storing.** In the hook adapter the Stop message and the plan are redacted before `putBlob`, so the blob, its hash (`content_ref`, which is also part of the stop event's source identity), the preview and the conclusions all come from the same text; `write_target`, the failure `error`, the title candidate and the commit message are redacted, then cut. Cutting first could keep a token's first characters, too short for any rule to recognise. `quill tracker push` redacts `--comment` before the preview, so what is previewed is what is sent.
- **Identifiers survive byte for byte** (Review Focus 1). `redactEvent` never touches the envelope (event_id, session_id, ticket_id, source_identity …) and skips payload keys that hold identities at any depth: `id`, `ids`, `key`, `sha`, `hash`, `ref`, `write_paths`, `paths`, `files`, `source_identity`, `cwd`, `branch`, `url`, `pr_url`, and the suffixes `_id`, `_ids`, `_key`, `_sha`, `_hash`, `_ref`. A name that says it holds a credential (`api_key`, `access_key_id`, `token_hash`, `client_secret_ref`) is never an identifier. In free text the rules keep UUIDs, hex of 7–64 characters (abbreviated and full SHA-1, sha256), paths and slugs such as `LOCAL-unknown-status-record-57c8291c`.
- **Old journals are not rewritten.** Events, blobs and ingress files written before this change keep their text. Rewriting would change blob hashes and source identities that later events and dedupe rely on, and the journal is append-only (ADR 0001).
- **KPI.** The PRD's "100% secret interception" is restated as: every known credential format in `src/lib/redact.js` is redacted before the journal, and a test covers each format (`tests/lib/redact.test.js`). The high-entropy rule is a heuristic net, not a guarantee.

### Choices made while building it

- The plan listed `*_id`, `hash` and `ref` among the identifier keys; `key`, `*_key`, `*_ids`, `*_hash` and `*_ref` were added. The first full test run showed why: the high-entropy rule redacted a migrated ticket's key (`LOCAL-unknown-status-record-57c8291c`) under `payload.ticket.key`, and the worker rejected the import as `key-invalid`. Blob references (`content_ref`, `plan_ref`) and content hashes (`page_hash`, `body_hash`) are identities in the same way. The credential-name exception keeps the wider list from becoming a hiding place.
- The same failure tuned the high-entropy rule: a candidate must have a part between separators (`-`, `_`, `/`, `+`) holding upper case, lower case and a digit. Random base64 nearly always has one; slugs, ticket keys and paths do not. With the entropy bar (4.1 bits a character at 32 characters, rising 0.025 a character to 4.6), about 0.6% of random 32-character base64 strings and 0.15% of 40-character ones are missed (measured on 50,000 samples each); paths, camelCase names and MCP tool names measured near 4.1 and are kept.
- `Bearer` and `Basic` followed by a plain lower-case or capitalised word ("a basic understanding", "Bearer tokens") are prose and kept. This also applies to the run ledger, a narrowing of `redactLog`: a credential that is a single all-letter word goes unredacted.
- `.env` names must be upper case, as `.env` files write them: code in a Stop message such as `auth = auth.trim()` is left alone. Lower-case `password=…` is still caught by the `secret=value` rule.
- A stop event's `length` stays the original message length. `write_target` and `error` are now capped in UTF-8 bytes (120 and 300) rather than characters, as `redactCapped` cuts.

## Consequences

- No credential in a known format reaches `events.jsonl`, the blob store, the dashboard snapshot or a tracker comment from the hooks or the CLI.
- A stop event's `content_ref` is the hash of the redacted message, so the same message still gives the same blob and source identity (dedupe holds), and a message with a secret gets a different blob than it did before 2.0.0.
- Where a token stood, the dashboard and the checkpoint blob show `[secret redacted]`. The original text is gone for good; the session transcript under the host's own directory is untouched.
- Hook latency, `node scripts/bench-hooks.mjs` (100 calls each, Node 24.19, Windows 11, a machine shared with other test runs). Baseline measured first, before any change: `bin/quill-hook.js` Pre p95 138 ms, Post p95 132 ms; `bin/quill.js` Pre 157 ms, Post 167 ms; bare `node` 61 ms. With the change, run back to back with the unchanged tree at the same load (bare `node` p95 56–57 ms): `bin/quill-hook.js` Pre p95 122 ms against 127 ms, Post 120 ms against 125 ms; `bin/quill.js` Pre 131 ms against 143 ms, Post 134 ms against 192 ms. The difference is inside the machine's noise and well within the plan's 10 ms. In process, a `pre-tool` `redactEvent` takes about 0.007 ms and redacting a 5 KB Stop message about 0.15 ms; the run log's `redactLog` costs about 30 ms a megabyte (12 ms before the new rules), still linear.

## Residual risks

- **Formats the rules do not know.** A short or low-entropy secret with no known prefix and no `secret=` shape (a plain password typed into prose) is not caught. The high-entropy rule misses a small share of short random strings.
- **False positives.** Long random-looking text that is not a secret (a document id in a URL, a base64 image) is redacted in free text. Identifier fields are never touched, so this costs readability, not identity.
- **Identifier fields are trusted.** A producer that put a secret under an identifier-shaped key (`*_id`, `url`, `branch`) would keep it. Quill's own producers put only identifiers there; the credential-name exception covers the obvious names, and a URL's userinfo under `url` is kept as an identity.
- **Outside ingress.** Events the worker emits itself (run transitions, `memory-tx`, tracker sync) and requests the dashboard server journals do not pass through `redactEvent`. Run text is already redacted by the run ledger rules; dashboard input is the owner's own typing.
- **Old data.** Journals and blobs from before 2.0.0 keep any secrets they hold; removing them needs a manual rewrite of the store.

## Alternatives considered

- **Moving `sanitize.js` into ingress (the PRD's wording).** Rejected: it redacts paths, not secrets, and the journal needs paths.
- **Redacting only in the worker.** Rejected: the ingress folder and the blob store would still hold the secret until the worker ran, and a blob is written before its event.
- **Redacting every payload string, identifiers included.** Rejected: hashes and keys would change and break source identities, blob references and dedupe.
- **Rewriting old journals on upgrade.** Rejected: it changes recorded hashes and identities, and the journal is append-only.
