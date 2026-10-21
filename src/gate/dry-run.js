// Dry-run preflight for pinned critical writes (FR-3.2, ADR 0031). In an approved critical-change
// run whose grant says `requireDryRun`, a pinned Kubernetes or database write is allowed only after
// the run's ledger shows its dry-run twin, allowed by the guard, finishing with exit 0.
//
// The twin of a pin is derived by a blunt, exact rule, never by modelling what a command means:
//   - kubectl: the same words, any `--dry-run`/`--dry-run=*` word removed, `--dry-run=server`
//     added (before a `--`, else at the end). A client dry run never counts.
//   - psql: the same words, its one `-c`/`--command` statement prefixed with `EXPLAIN ` (never
//     ANALYZE).
// A twin counts only when the guard itself reads it as a read (prod-classify.js), so the twin of a
// verb kubectl cannot dry-run, or of a statement EXPLAIN cannot take, does not exist and the pinned
// write stays refused. Nothing here allows a call: it only adds a refusal (Review Focus 5).
//
// A twin is identified by `argv_sha`: the SHA-256 of the canonical JSON of the tool name and the
// call's one plain command (argv, redirects, stdin), as the guard parses it. The guard hook writes it
// on its ledger lines (bin/quill-guard.js); the stream collector writes each tool result with its
// exit code to the same ledger, matched by the host's tool_use_id.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parseShell, binName } from './shell-tokens.js';
import { classifyCall } from './prod-classify.js';
import { canonicalJson } from '../handoff/grant.js';

// The scopes whose pinned writes need a dry run first. terraform, gh and aws are deferred (ADR 0031).
export const DRY_RUN_SCOPES = new Set(['k8s.write', 'db.write']);
const SHELLS = { Bash: 'bash', Monitor: 'bash', PowerShell: 'powershell' };
const BASH_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const PS_BARE = /^[A-Za-z0-9_%+=:./-]+$/;
const EXPLAINABLE = /^(?:insert|update|delete|merge|select|with|values)\b/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The one plain command a text holds, or null: exactly one segment, literal words, no environment. */
export function soleCommand(text, dialect) {
  if (typeof text !== 'string') return null;
  const parsed = parseShell(text.trim(), dialect);
  if (parsed.error || parsed.segments.length !== 1) return null;
  const s = parsed.segments[0];
  if (s.unparseable || !s.argv.length || s.piped || s.nested || s.stdinDyn) return null;
  if (Object.keys(s.env ?? {}).length || (s.kinds ?? []).some((k) => k !== 'lit')) return null;
  return { argv: s.argv, redirects: (s.redirects ?? []).map((r) => [r.op, r.target]), stdin: s.stdin ?? null };
}

const commandOf = (call) => (isPlainObject(call) && isPlainObject(call.tool_input) && typeof call.tool_input.command === 'string' ? call.tool_input.command : null);

/**
 * The call's `argv_sha`, or null when it is not a shell call holding one plain command.
 * @param {{ tool_name: string, tool_input?: object }} call
 */
export function commandSha(call) {
  const tool = isPlainObject(call) ? call.tool_name : undefined;
  const dialect = SHELLS[tool];
  if (!dialect) return null;
  const sole = soleCommand(commandOf(call), dialect);
  return sole ? sha256(canonicalJson({ tool, ...sole })) : null;
}

// A word written so the guard's parser reads it back unchanged; the round trip is checked anyway.
function quote(word, dialect) {
  if (dialect === 'powershell') return PS_BARE.test(word) ? word : `'${word.replace(/'/g, "''")}'`;
  if (BASH_BARE.test(word)) return word;
  if (!/[$`"\\!]/.test(word)) return `"${word}"`;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

function kubectlTwin(argv) {
  const words = argv.filter((w, i) => i === 0 || !(w === '--dry-run' || w.startsWith('--dry-run=')));
  const end = words.indexOf('--');
  return end < 0 ? [...words, '--dry-run=server'] : [...words.slice(0, end), '--dry-run=server', ...words.slice(end)];
}

function psqlTwin(argv) {
  const hits = [];
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === '--') break;
    if ((w === '-c' || w === '--command') && i + 1 < argv.length) { hits.push({ at: i + 1, prefix: '' }); i += 1; }
    else if (w.startsWith('--command=')) hits.push({ at: i, prefix: '--command=' });
    else if (/^-c./.test(w)) hits.push({ at: i, prefix: '-c' });
  }
  if (hits.length !== 1) return null;
  const { at, prefix } = hits[0];
  const statement = argv[at].slice(prefix.length).trim();
  // Only statements PostgreSQL's EXPLAIN takes: DDL (DROP, ALTER, TRUNCATE …) has no twin.
  if (!EXPLAINABLE.test(statement)) return null;
  const out = [...argv];
  out[at] = `${prefix}EXPLAIN ${statement}`;
  return out;
}

const CLASSIFY_CTX = { cwd: undefined, env: {}, isProtectedBranch: () => true, mcpPolicy: { read: [], write: {} }, trackerHosts: [] };

/**
 * The dry-run twin of a pinned write, or null when it has none the guard accepts.
 * @param {{ tool_name: string, tool_input: { command: string } }} call  the pinned action as a call
 * @param {object} [ctx]  classifyCall's context (the guard passes its own; the default reads the
 *   twin with no checkout, as a proposal is read)
 * @returns {{ text: string, sha: string } | null}
 */
export function dryRunTwin(call, ctx = CLASSIFY_CTX) {
  const tool = isPlainObject(call) ? call.tool_name : undefined;
  const dialect = SHELLS[tool];
  if (!dialect) return null;
  const sole = soleCommand(commandOf(call), dialect);
  if (!sole || sole.redirects.length || sole.stdin !== null) return null;
  const bin = binName(sole.argv[0]);
  const argv = bin === 'kubectl' ? kubectlTwin(sole.argv) : bin === 'psql' ? psqlTwin(sole.argv) : null;
  if (!argv) return null;
  const text = argv.map((w) => quote(w, dialect)).join(' ');
  const back = soleCommand(text, dialect);
  if (!back || JSON.stringify(back.argv) !== JSON.stringify(argv) || back.redirects.length || back.stdin !== null) return null;
  const twinCall = { tool_name: tool, tool_input: { command: text } };
  const cls = classifyCall(twinCall, isPlainObject(ctx) ? ctx : CLASSIFY_CTX);
  const parts = Array.isArray(cls.calls) ? cls.calls : [cls];
  if (!parts.length || parts.some((p) => !p || p.class !== 'read')) return null;
  return { text, sha: commandSha(twinCall) };
}

/**
 * The twin the guard's preflight requires before this pinned call, or null when the preflight does
 * not apply to it: the guard classifies no part of it as a k8s.write or db.write write (a read, such
 * as a client dry run, or another scope's write), or it has no twin. One derivation for the run
 * guard (with the run's context) and the Needs you item (with the proposal's, as `dryRunTwin`).
 * @param {{ tool_name: string, tool_input: object }} call
 * @param {object} [ctx]
 * @returns {{ text: string, sha: string } | null}
 */
export function pinnedTwin(call, ctx = CLASSIFY_CTX) {
  const c = isPlainObject(ctx) ? ctx : CLASSIFY_CTX;
  const cls = classifyCall(isPlainObject(call) ? { tool_name: call.tool_name, tool_input: call.tool_input } : {}, c);
  const parts = Array.isArray(cls.calls) ? cls.calls : [cls];
  if (!parts.some((p) => p && (p.class === 'write' || p.class === 'external.write') && DRY_RUN_SCOPES.has(p.scope))) return null;
  return dryRunTwin(call, c);
}

/**
 * What the run ledger shows about the twin with this `argv_sha`: whether an allowed guard line for
 * it exists, and the exit code of the latest tool result recorded after such a line for the same
 * tool_use_id (undefined when none has one yet). Lines that do not parse are skipped.
 * @param {string} ledgerText  the ledger file's text
 * @param {string} sha
 * @returns {{ ran: boolean, exitCode: number|null|undefined }}
 */
export function dryRunRecord(ledgerText, sha) {
  const allowed = new Set();
  let ran = false;
  let exitCode;
  for (const raw of String(ledgerText ?? '').split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (!isPlainObject(line) || typeof line.tool_use_id !== 'string' || !line.tool_use_id) continue;
    if (line.kind === 'guard' && line.decision === 'allow' && line.argv_sha === sha) { allowed.add(line.tool_use_id); ran = true; continue; }
    if (line.kind === 'tool_result' && allowed.has(line.tool_use_id)) exitCode = Number.isInteger(line.exit_code) ? line.exit_code : null;
  }
  return { ran, exitCode };
}

/** The ledger's text, or null when it cannot be read (no ledger yet reads as empty). */
export function readLedgerText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { return err && err.code === 'ENOENT' ? '' : null; }
}
