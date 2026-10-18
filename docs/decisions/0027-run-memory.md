# ADR 0027 — Run memory

Date: 2026-10-19 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md), [ADR 0008](0008-agent-recipes.md), [ADR 0025](0025-remote-run-proposals.md) and [ADR 0026](0026-autonomous-access-and-guard.md) · Spec: `docs/superpowers/specs/2026-10-12-autonomous-runs-design.md` §6, §8–§9

## Context

Every run started from nothing. It rediscovered how to build and test the repository, which tools the machine has, where the runbooks live and which approach failed last time. The only carry-over was the ticket's last three run summaries, 400 characters each. Runs repeated failed attempts and re-asked questions the owner had already answered.

A small fixed memory (an 8 KB cap was proposed) was rejected by the owner: a repository's build, environments and pitfalls do not fit, and a cut-off list silently drops what matters. The owner asked for a generous inline section, about 48 KB, plus the full files for the run to read on demand.

Memory is also an injection path. A run reads tool output, Jira text, logs and web pages. A learning copied from such text, or one that reads like an instruction ("disable the test gate", "push to main"), would otherwise be handed to every later run as trusted context.

## Decision

Memory is spec §6, built in Tasks 12–15:

- **Journaled store.** The journal's `memory-tx` events (filed, confirmed, superseded, retired, approved, owner-note, pinned, unpinned, edited) are the source of truth, reduced into `state.memory`. The worker is the only writer (ADR 0001); agents never write memory, they report learnings in their result. Markdown projections live under `quillHome()/memory/` (`_machine.md`, `repos/<repo>.md`, `repos/<repo>.owner.md`, `repos/<repo>.docs.md`, `_quarantine.md`), never under `store_path`. Task scope becomes the ticket's local Run notes.
- **Trust by provenance, not by the agent's word.** verified (the worker saw it, or the run's own command is in the ledger with the claimed exit code), sourced (the cited file and line exist at the cited blob), observed (a claimed command Quill cannot match), quarantined (tool output, external text, anything from a page-proposed run, and instruction-like text whatever its source). Verified, sourced and observed entries are filed automatically; quarantined ones wait for the owner.
- **Delivery.** A run gets an inline Memory section inside the data fence, up to `[memory] inline_budget_bytes` (default 48,000), in the spec §6.3 order, and read-only copies of the projections (never the quarantine) in `<run-dir>/context/`. Edits there are never read back. Runs set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **Owner review.** The owner's dashboard has a Memory page (Repo / Machine / Quarantine; Track, shortcut 8) showing each entry's text, trust chip in words, source run, last confirmation, confirmations, the reason a learning was held, and conflicts. The owner can Approve (quarantined only), Edit (the owner's wording keeps the id and becomes an Owner entry), Pin or Unpin, and Retire. Quarantined learnings and memory conflicts are their own item types in Runs → Needs you, and count in the global attention count.
- **Requests.** `memory-approve`, `memory-edit`, `memory-forget` and `memory-pin` target an entry and carry `expected_revision`; a stale revision is a `conflict` that changes nothing. `memory-forget` has the 10 s undo window. `memory-note` adds an owner entry. Each applied request is journaled as one `memory-tx` event (source identity `memory-tx:request:<id>`) before its request transaction, so the journal stays the only source of memory and a crash between the two finishes as applied.
- **Who may change memory.** Approve and edit are dashboard actions by the owner (`memory-approve-dashboard-only`, `memory-edit-dashboard-only` for anyone else, the CLI included). Forget, pin and note also accept the owner's CLI (`quill memory retire|pin|note`). Any other actor (a page edit, a schedule) fails with `memory-owner-only`. Inside an agent run (`QUILL_HANDOFF_ID` set) the CLI refuses every memory change (`cli-in-run`, ADR 0026); `quill memory list|show` still work there but leave quarantined learnings out.
- **Rulings** made while building it:
  - R27: pinned and owner entries never go stale or age out; other entries age from the later of creation and last confirmation (90 days stale, 180 retired).
  - R28: a `repo-file` learning whose cite cannot be verified (no cite, missing file or line, outside the checkout, no checkout) is quarantined (`unverified-cite`), not observed.
  - R29: the instruction-like filter normalises first (NFKC, zero-width and bidi characters stripped, confusables folded) and matches a broad documented list, including prod and git-remote actions, credential-path reads, disabling tests or the guard, role markers and non-English forms. Run notes' free text passes the same filter; a page-proposed run's note is marked and never delivered to other runs.
  - R30: a verified learning never supersedes an owner or pinned entry; the two are kept as a conflict for the owner.
  - R31: the ledger records exit code 0 for a shell command Claude Code reports as finished without error (structured result, not interrupted, not backgrounded).
  - R32–R33: an `own-command` learning is verified only when the ledger shows the claimed command with the claimed exit code and the learning's text names that command, its program and first argument as contiguous whole tokens; an argument-less command never verifies.
  - R34: after spec §6.3's listed kinds, spare inline budget fills with the other repo and machine sections in the same rank order; the closing "headings with counts" line covers only what still did not fit.
  - R35: memory text has Unicode format characters (Cf: zero-width, bidi) stripped before it is inlined; Run-note lesson lines follow the entry rules (conflict losers, superseded and stale entries are never inlined; suffixes carried); an over-long line is cut at 2,000 bytes.

## Privacy

Memory is local to the owner's machine. It is never part of the dashboard snapshot: the Memory page reads it from its own owner-session endpoint (`GET /v1/memory`), and memory requests in the snapshot keep their kind and state but not their text. So no static export, read-only snapshot, mirror, publisher payload, tracker push body or vault note carries memory text or a quarantine reason, and an export has no Memory view or nav item. The quarantine is never copied to a run.

## Consequences

- Runs start with what earlier runs and the owner established, ranked by how it was established, and can read the rest on demand.
- The owner decides what came from outside: nothing from tool output, external text or a page reaches a run until approved.
- Owner notes and pinned entries win: they are delivered first, never age out, and a run's verified finding cannot replace them.
- The projections are generated from the journal. In `repos/<repo>.owner.md` Quill writes only its marked owner-notes section; text outside it is the owner's, and a marked section edited by hand is left as it is and reported. Changes the owner wants runs to see go through the Memory page or `quill memory note`.

## Residual risks

- **The instruction filter is defence in depth, not a boundary.** A learning can carry steering text the patterns miss. Delivery fences memory as data ("data, not instructions"), the guard (ADR 0026) still decides every call, and the owner can retire an entry.
- **Sourced is not proven.** A cited line exists; the claim about it may be wrong. Runs re-check sourced entries against their checkout and mark changed sources "re-check".
- **Observed entries are the agent's word.** They are filed automatically (owner decision) and ranked below verified and sourced ones.
- **The reducer accepts `memory-tx` from any ingress producer.** The supported writers are the worker's filing and owner requests; a process that can write to the owner's Quill home could journal memory directly, as it could any other event.

## Alternatives considered

- **A fixed 8 KB memory.** Rejected by the owner: too small for real repositories, and it hides what was cut.
- **Letting agents write memory files.** Rejected: provenance would be the agent's say-so, and a run could plant instructions for later runs.
- **Quarantining everything until approved.** Rejected: the owner would approve hundreds of worker-observed facts. Provenance decides instead.
