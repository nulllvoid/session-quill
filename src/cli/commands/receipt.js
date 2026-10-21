// `quill receipt <run>` (ADR 0033): prints a run's evidence receipt, rebuilt from the journal. A
// run whose receipt went into a draft PR is rebuilt from the facts journaled through the sequence
// that receipt names, and the digest is compared with the one recorded then. Read-only: it reads
// the journal and writes nothing.
import { loadContext } from '../context.js';
import { replayState } from './sync.js';
import { buildReceipt } from '../../handoff/receipt.js';
import { TrackerError } from '../../lib/errors.js';

const USAGE = 'usage: quill receipt <run-id> [--json]';
export const MIN_RUN_PREFIX = 8;

const safe = (s, max = 80) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, max);

function findRun(state, ref) {
  if (typeof ref !== 'string' || !ref) throw new TrackerError('usage', USAGE);
  if (state.handoffs.has(ref)) return state.handoffs.get(ref);
  if (ref.length < MIN_RUN_PREFIX) throw new TrackerError('run-id-too-short', `give at least ${MIN_RUN_PREFIX} characters of the run id, as \`quill handoff list\` prints it`);
  const matches = [...state.handoffs.values()].filter((h) => h.id.toLowerCase().startsWith(ref.toLowerCase()));
  if (!matches.length) throw new TrackerError('run-unknown', `no run starts with ${safe(ref, 40)}; list them with \`quill handoff list\``);
  if (matches.length > 1) throw new TrackerError('run-ambiguous', `${safe(ref, 40)} matches ${matches.length} runs; give more of the id`);
  return matches[0];
}

/** Builds the receipt for `ref` and, when one was recorded for a draft PR, checks its digest. */
export function receiptFor(ctx, ref) {
  const { state } = replayState(ctx, { readOnly: true });
  const h = findRun(state, ref);
  const recorded = h.receipt && typeof h.receipt.sha256 === 'string' && Number.isInteger(h.receipt.through_sequence) ? h.receipt : null;
  const at = recorded ? replayState(ctx, { readOnly: true, throughSequence: recorded.through_sequence }).state : state;
  const receipt = buildReceipt(at, h.id);
  if (!receipt) throw new TrackerError('run-unknown', `run ${safe(h.id, 40).slice(0, 8)} has no journaled facts through sequence ${recorded.through_sequence}`);
  return { receipt, recorded, matches: recorded ? recorded.sha256 === receipt.sha256 : null };
}

export async function run({ args, flags, io, env }) {
  const ctx = loadContext(env);
  const { receipt, recorded, matches } = receiptFor(ctx, args[0]);
  if (flags.json) {
    io.json({ markdown: receipt.markdown, sha256: receipt.sha256, through_sequence: receipt.through_sequence, recorded_sha256: recorded ? recorded.sha256 : null, matches_recorded: matches });
    return matches === false ? 1 : 0;
  }
  io.out(receipt.markdown);
  // The note goes to stderr, so the Markdown on stdout can be pasted as it is.
  if (recorded) io.error(matches ? 'The digest matches the receipt recorded when the draft PR was opened.' : `The digest differs from the one recorded when the draft PR was opened (${recorded.sha256}): the journal no longer gives the same facts.`);
  else io.error('No receipt was recorded for a draft PR of this run; this one is built from the journal as it is now.');
  return matches === false ? 1 : 0;
}
