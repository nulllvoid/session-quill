import { parseArgs, Io } from './context.js';
import { TrackerError } from '../lib/errors.js';

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
};

const HELP = `quill — Session Quill CLI

Usage: quill <command> [options]

  start [--repo <path>] [--store <path>] [--session <id>] [--share-settings]
  init [--store <path>] [--project <id>] [--project-name <name>] [--repo <path>] [--timezone <tz>] [--yes]
  ticket create "<title>" [--category c] [--priority P2] [--parent KEY] [--project id] [--due YYYY-MM-DD] [--bind] --session <id>
  ticket bind <KEY> --session <id>          ticket show --session <id> [--json]
  ticket off --session <id>                 ticket on --session <id>
  ticket relink <KEY> --external <EXT-KEY> [--system s] [--url <url>] --session <id>   (--jira is an alias)
  ticket children <KEY>                     ticket list [--status s] [--json]
  ticket set <KEY> [--title t] [--status s] [--blocker b] [--next text] [--priority P] [--category c] [--due D|none] [--parent KEY|none] [--repo id|none]
  repo add <path> [--id id] [--project id] [--repo-file]   repo list [--json]   repo remove <id>
  approve [--checkpoint <id>] --session <id> dismiss [--checkpoint <id>] --session <id>
  status [--json] [--session <id>] | status --statusline
  doctor
  worker run | start | stop | status
  sync [--notes]                            replay --into <dir> [--switch]
  import <note.md>                          note restore <KEY>
  ui [--static <out.html>] [--open]         export --projects a,b --fields k1,k2 --out <file> [--include-links] [--yes]
  handoff <KEY> [--mode m] [--note text] [--read-source] [--edit-source] [--commit] [--push-branch <b>] [--draft-pr]
  agent list [--ticket KEY] [--json]        agent show <recipe> [--ticket KEY]
  agent run <recipe> <KEY> [--note text] [--no-read-source] [--commit] [--push-branch <b>] [--draft-pr]
  agent suggestions <KEY> [--json]          agent accept|dismiss <run-id> <suggestion-id>
  publish list [--json]                     publish [<name>] [--confirm]
  migrate --source <dir> [--profile <name|path.json>] [--dry-run] [--backup <dir>] | migrate rollback --manifest <file>
  hook <EventName>                          (reads host JSON on stdin)
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
