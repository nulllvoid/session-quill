// Inside an agent run (QUILL_HANDOFF_ID is set on the run's process tree) the CLI refuses every
// command that changes anything (spec §4.2, ADR 0026): a run cannot approve its own proposals,
// grant itself scopes, queue runs or edit tickets through Quill, whatever its access level. The
// dispatcher (main.js) checks this before it loads any command, so a command added later refuses
// unless it is added to the read list below on purpose.
import { TrackerError } from '../lib/errors.js';

export const CLI_IN_RUN_MESSAGE = 'quill: refused inside an agent run (cli-in-run)';

// Spec §4.2, verbatim: `status`, `ticket show|list|children`, `agent list|show|suggestions`,
// `handoff list`, `repo list`, `doctor`. '*' means any subcommand.
export const IN_RUN_READS = Object.freeze({
  status: '*',
  doctor: '*',
  ticket: Object.freeze(['show', 'list', 'children']),
  agent: Object.freeze(['list', 'show', 'suggestions']),
  handoff: Object.freeze(['list']),
  repo: Object.freeze(['list']),
});

/** Whether `quill <command> <sub>` only reads, and so may run inside an agent run. */
export function isReadInRun(command, sub) {
  if (!Object.hasOwn(IN_RUN_READS, command)) return false;
  const allowed = IN_RUN_READS[command];
  return allowed === '*' || (typeof sub === 'string' && allowed.includes(sub));
}

/** Throws `cli-in-run` when this process runs inside an agent run. */
export function refuseInRun(env = process.env) {
  if (env && typeof env.QUILL_HANDOFF_ID === 'string' && env.QUILL_HANDOFF_ID !== '') throw new TrackerError('cli-in-run', CLI_IN_RUN_MESSAGE);
}
