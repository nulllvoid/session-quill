# ADR 0015 — File runs on a ticket's attached files

Date: 2026-10-07 · Status: accepted · Builds on [ADR 0008](0008-agent-recipes.md) and [ADR 0013](0013-recipe-context-and-reply-contract.md)

## Context

Agent runs work in an isolated checkout of a registered repository. Tickets without a repository, such as "delete the leftover readme-install.cjs" (PROJ-1), could only get a notes-only analysis, so a two-minute chore needed a Claude session. The owner chose to let dashboard runs change files on such tickets, limited to the files already attached to the ticket.

## Decision

- **Mode `files`.** A recipe in mode `files` works on the ticket's attached files: the absolute paths recorded in its files touched (repository tickets record paths relative to their repository and keep using checkouts). At most 25 files of up to 1 MiB each; a missing file is listed, a directory, link or larger file is not staged. A run needs at least one attached file.
- **The agent never touches originals.** At dispatch the worker copies each attached file into the run's sandbox as `files/<id>-<name>`, and the prompt lists each id with its original path. The agent's tools are path-scoped to the sandbox: `Read(./**)`, and with `edit_files` also `Edit(./**)`, `Write(./**)` and `MultiEdit(./**)`; Bash, PowerShell, Glob, Grep, LS, web and sub-agent tools are denied. Checked against Claude Code on Windows: reads and writes outside the sandbox are refused by the permission gate in `dontAsk` mode, and reads inside succeed.
- **Two permissions, off by default.** `edit_files` and `delete_files` exist only for mode `files`, which has no repository permissions. The Run dialog lists the files in reach and leaves both unticked; `quill agent run <recipe> <KEY>` grants them only with `--edit-files` / `--delete-files`. A files recipe is never schedulable.
- **The worker applies the result.** To delete, the agent lists file ids in `delete_files`; to edit, it edits the copy. Only after a run finishes cleanly does the worker act, and only on attached files whose content is unchanged since staging (a file someone changed meanwhile is left alone and reported). A deletion moves the original into `<quill home>/trash/<run>/`; an edit first copies the original there. A failed, cancelled or timed-out run changes nothing.
- **Undo.** Each change is recorded on the run (`file_effects`) and on the ticket's timeline. The `undo-file-effect` request restores a deleted file if nothing has taken its path, or reverts an edit if the file is still as the run left it; otherwise it refuses and says where the saved copy is. Undo goes through the usual request queue, so it has the 10-second window and shows its outcome.
- **Owner confirms.** A run that changed files moves a To do or Active ticket to Review, never to Done. The built-in `file-task` recipe follows the ticket's description and reports, per file, what it did and why.
- **Exports** never carry file paths, staged files or trash locations; an exported run shows only how many changes it made.

## Consequences

- Repo-less chores (deleting or tidying an attached artifact, small text edits) run from the dashboard, with every change reversible from the same place.
- The trash folder grows with each deletion and edit; it is not cleaned automatically.
- A file attached by mistake is in reach of a files run once the owner ticks a permission; the Run dialog lists every path so that is visible before queueing.

## Alternatives considered

- **Paths entered in the Run dialog.** Rejected for now by the owner: what the agent can reach would depend on what is typed. Attached files cover the cleanup case.
- **Letting the agent delete with a shell command.** Rejected: shell rules match text, deletion would be immediate and irreversible, and the run would need shell access to the real paths.
- **Permanent deletion.** Rejected: a wrong deletion by an agent must be one click to reverse.
