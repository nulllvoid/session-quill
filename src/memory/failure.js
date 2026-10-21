// The failure ledger (FR-2.3, ADR 0032). When the worker's test gate (ADR 0023) fails a run, the
// run's Run note records a `failure`: only fields the worker itself produced, never the test
// output or test names (ADR 0027 tool-output rule): the gate's status, the configured test command,
// its exit code, a signature of the failure and the files the run changed. A later run on the same
// ticket that hits the same signature is told so before its test-repair turn, as data.
import { createHash } from 'node:crypto';
import { redactCapped } from '../handoff/stream.js';
import { deliverableRunNotes, memoryLine } from './deliver.js';
import { instructionLike } from './instructions.js';

// A changed file's name is the agent's choice: one that reads like an instruction is withheld (R29).
export const WITHHELD_FILE = '[withheld: instruction-like file name]';

export const SIGNATURE_LINES = 5;
export const FAILURE_FILES = 20;
const FIELD_CHARS = 300;
const TRIED_ATTEMPTS = 5;

// Lines that say something failed, in the formats of common test runners.
const MARKER = /\b(?:fail(?:s|ed|ure|ures|ing)?|error|errors|assert(?:ion)?(?:error)?|expected|exception|panic(?:ked)?|traceback|not ok|uncaught|unhandled|segmentation fault|timed? ?out)\b|[✗✖×]/i;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
// Absolute paths: file URLs, drive-letter paths, UNC paths and POSIX paths of two or more parts.
const ABS_PATHS = [
  /file:\/\/\S+/gi,
  /\b[A-Za-z]:[\\/][^\s'"()<>|:]*/g,
  /\\\\[^\s'"()<>|]+/g,
  /(?<![\w.~-])\/(?:[^\s/'"()<>:]+\/)+[^\s/'"()<>:]*/g,
];
const DURATION = /\b\d+(?:[.,]\d+)?\s*(?:ns|µs|us|ms|msec|s|sec|secs|seconds?|m|min|mins|minutes?|h)\b/gi;
const HEX_RUN = /\b(?:0x)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/gi;

function normaliseLine(line) {
  let s = String(line).replace(ANSI, '');
  for (const re of ABS_PATHS) s = s.replace(re, '<path>');
  return s.replace(DURATION, '').replace(HEX_RUN, '<hex>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * A 16-hex-character signature of a test failure: sha256 of the first SIGNATURE_LINES lines that
 * carry a failure marker, after stripping ANSI codes, absolute paths, durations, hex runs and digits
 * (so timestamps, temp directories, run ids and timings do not change it). With no marker line the
 * last SIGNATURE_LINES non-empty lines are used.
 */
export function failureSignature(tail) {
  const lines = String(tail ?? '').split(/\r?\n/).map(normaliseLine).filter(Boolean);
  const marked = lines.filter((l) => MARKER.test(l)).slice(0, SIGNATURE_LINES);
  const picked = marked.length ? marked : lines.slice(-SIGNATURE_LINES);
  return createHash('sha256').update(picked.join('\n')).digest('hex').slice(0, 16);
}

const clean = (s, max = FIELD_CHARS) => redactCapped(String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim(), max);

/**
 * The Run note's `failure` record for a run whose worker test gate failed or timed out, else null.
 * @param {{ test_gate?: object, changed_files?: string[] }} run  the handoff after its terminal state
 * @returns {{ kind: 'test-gate', status: string, command: string|null, exit_code: number|null, signature: string, files_touched: string[] }|null}
 */
export function failureRecord(run) {
  const gate = run && run.test_gate;
  if (!gate || typeof gate !== 'object' || (gate.status !== 'failed' && gate.status !== 'timeout')) return null;
  const files = (Array.isArray(run.changed_files) ? run.changed_files : []).filter((f) => typeof f === 'string' && f.trim()).slice(0, FAILURE_FILES).map((f) => (instructionLike(f) ? WITHHELD_FILE : clean(f.split('\\').join('/'))));
  return {
    kind: 'test-gate',
    status: gate.status,
    command: typeof gate.command === 'string' && gate.command.trim() ? clean(gate.command) : null,
    exit_code: Number.isInteger(gate.exit_code) ? gate.exit_code : null,
    signature: failureSignature(gate.tail),
    files_touched: files,
  };
}

function attemptSummary(a) {
  return `${a.route || '(route not given)'}${a.tool ? ` via ${a.tool}` : ''}${a.target ? ` on ${a.target}` : ''}: ${a.outcome ?? 'unknown'}`;
}

/**
 * Repeat detection before the test-repair turn: when an earlier deliverable Run note of this
 * ticket (never a page-proposed run's, and none for a page-proposed run) recorded a failure with
 * the same signature, the one line to add to the repair prompt as data; else null.
 * @param {object} state  reduced state
 * @param {object} run  the running handoff
 * @param {{ status: string, tail?: string }} gate  the test command's result
 */
export function repeatNotice(state, run, gate) {
  if (!run || !gate || gate.status === 'passed') return null;
  const ticket = state.tickets && state.tickets.get(run.ticket_id);
  if (!ticket) return null;
  const signature = failureSignature(gate.tail);
  const hit = deliverableRunNotes(state, ticket, run).find((n) => n.failure && typeof n.failure === 'object' && n.failure.signature === signature);
  if (!hit) return null;
  const tried = (Array.isArray(hit.attempts) ? hit.attempts : []).filter((a) => a && typeof a === 'object').slice(0, TRIED_ATTEMPTS).map(attemptSummary);
  return memoryLine(`The same failure (signature ${signature}) was seen in run ${String(hit.run_id).slice(0, 8)}, which tried: ${tried.length ? tried.join('; ') : 'no attempts recorded'}`);
}
