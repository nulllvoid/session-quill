import { parseArgs, Io } from './context.js';
import { TrackerError } from '../lib/errors.js';
import { isReadInRun, refuseInRun } from './in-run.js';

const COMMANDS = {
  start: () => import('./commands/start.js'),
  init: () => import('./commands/init.js'),
  ticket: () => import('./commands/ticket.js'),
  approve: () => import('./commands/approve.js'),
  dismiss: () => import('./commands/approve.js'),
  status: () => import('./commands/status.js'),
  doctor: () => import('./commands/doctor.js'),
  worker: () => import('./commands/worker.js'),
  sync: () => import('./commands/sync.js'),
  replay: () => import('./commands/sync.js'),
  import: () => import('./commands/sync.js'),
  note: () => import('./commands/sync.js'),
  hook: () => import('./commands/hook.js'),
  ui: () => import('./commands/ui.js'),
  export: () => import('./commands/export.js'),
  handoff: () => import('./commands/handoff.js'),
  agent: () => import('./commands/agent.js'),
  publish: () => import('./commands/publish.js'),
  migrate: () => import('./commands/migrate.js'),
  repo: () => import('./commands/repo.js'),
  tracker: () => import('./commands/tracker.js'),
  mirror: () => import('./commands/mirror.js'),
  memory: () => import('./commands/memory.js'),
  worktree: () => import('./commands/worktree.js'),
};

// Every command the dispatcher knows; tests enumerate it to check the in-run refusal.
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

export const HELP = `quill — Session Quill CLI

Usage: quill <command> [options]

  start [--repo <path>] [--store <path>] [--session <id>] [--share-settings]
  init [--store <path>] [--project <id>] [--project-name <name>] [--repo <path>] [--timezone <tz>] [--yes] [--bootstrap-from-tracker]
  ticket create "<title>" --description "<Goal/Context/Done when>" [--category c] [--priority P2] [--parent KEY] [--project id] [--due YYYY-MM-DD] [--bind] --session <id>
  ticket work "<task title>" --description "<Goal/Context/Done when>" [--category c] [--project id] [--repo id] [--worktree|--no-worktree] --session <id>  (reuse or create, then bind)
  ticket bind <KEY> [--worktree|--no-worktree] --session <id>   ticket show --session <id> [--json]
  ticket off --session <id>                 ticket on --session <id>
  ticket relink <KEY> --external <EXT-KEY> [--system s] [--url <url>] --session <id>   (--jira is an alias)
  ticket children <KEY>                     ticket list [--status s] [--json]
  ticket stale [--idle-days n] [--json]     ticket stale --apply  (closes shipped and children-done tickets)
  ticket set <KEY> [--description d] [--title t] [--status s] [--blocker b] [--next text] [--priority P] [--category c] [--due D|none] [--parent KEY|none] [--repo id|none] [--no-code yes|no]
  worktree list [--all] [--json]            worktree remove <KEY>  (ticket worktrees under <quill home>/worktrees; a dirty one is never removed)
  repo add <path> [--id id] [--project id] [--repo-file]   repo list [--json]   repo remove <id>
  repo clone <KEY> [--url <remote>] [--confirm]   (preview, then clone a ticket's repository into [tracker] auto_clone_dir)
  approve [--checkpoint <id>] --session <id> dismiss [--checkpoint <id>] --session <id>
  approve --run [<id>] [--json]             dismiss --run <id>  (runs proposed from a shared page)
  status [--json] [--session <id>] | status --statusline
  doctor
  worker run | start | stop | status       worker install | uninstall  (start the worker at login)
  sync [--notes]                            replay --into <dir> [--switch]
  import <note.md>                          note restore <KEY>
  ui [--no-open] | ui --static <out.html> [--open] | ui --revoke  (sign every browser out)
                                            export --projects a,b --fields k1,k2 --out <file> [--include-links] [--yes]
  mirror status|open [--dir <folder>] [--json] | mirror write   (read-only copy for other machines)
  handoff <KEY> [--mode m] [--note text] [--read-source] [--edit-source] [--commit] [--push-branch <b>] [--draft-pr] [--access autonomous|standard|settings|full] [--scope s]... [--planned glob]... [--max-turns n] [--budget usd]
  handoff list                              handoff cancel <run-id> | handoff cancel --batch <batch-id>  (queued runs of a batch)
  agent list [--ticket KEY] [--json]        agent show <recipe> [--ticket KEY]
  agent run <recipe> <KEY> [--note text] [--no-read-source] [--commit] [--push-branch <b>] [--draft-pr] [--edit-files] [--delete-files] [--access autonomous|standard|settings|full] [--scope s]... [--planned glob]... [--max-turns n] [--budget usd]
  agent suggestions <KEY> [--json]          agent accept|dismiss <run-id> <suggestion-id>
  agent resume <run-id>                     (a run interrupted by a worker restart, as a new run)
  memory list [--repo <id>] [--machine] [--quarantine] [--json]   memory show <id> [--json]
  memory retire <id>                        memory pin <id> [--unpin]   memory note "<text>" (--repo <id> | --machine) [--section s] [--key k]
  agent install <https git URL|folder> [--ref r] [--only a,b] [--replace] [--confirm]   agent uninstall <recipe> [--force]
  publish list [--json]                     publish [<name>] [--confirm]
  tracker import [--json]                   (open issues assigned to you become tickets)
  tracker push <KEY> [--to "<status>"] [--comment text] [--confirm]   (needs [tracker] write_back = true)
  migrate --source <dir> [--profile <name|path.json>] [--dry-run] [--backup <dir>] | migrate rollback --manifest <file>
  hook <EventName>                          (reads host JSON on stdin)

Inside an agent run (QUILL_HANDOFF_ID set) only status, doctor, ticket show|list|children, agent list|show|suggestions, handoff list, repo list and memory list|show (without quarantined learnings) run; everything else exits 2 (cli-in-run).
`;

export async function main(argv, { env = process.env, stdout, stderr, stdin } = {}) {
  const io = new Io({ stdout, stderr, stdin });
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (!command || command === 'help' || flags.help) {
    io.out(HELP);
    return command ? 0 : 1;
  }
  const loader = COMMANDS[command];
  // ADR 0026: a run's agent cannot change anything through Quill, so only reads pass, and before
  // any command module or configuration is loaded.
  if (!isReadInRun(command, rest[0])) {
    try { refuseInRun(env); } catch (err) {
      io.error(err.message);
      if (flags.json) io.json({ error: { code: err.code, message: err.message } });
      return 2;
    }
  }
  if (!loader) {
    io.error(`unknown command: ${command}`);
    io.out(HELP);
    return 2;
  }
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      io.error(`command "${command}" is not available in this build`);
      return 2;
    }
    throw err;
  }
  try {
    const code = await mod.run({ command, args: rest, flags, io, env });
    return code ?? 0;
  } catch (err) {
    if (err instanceof TrackerError) {
      io.error(`quill ${command}: ${err.message}`);
      if (flags.json) io.json({ error: { code: err.code, message: err.message } });
      return 1;
    }
    throw err;
  }
}
