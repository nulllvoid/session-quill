// Worker-observed memory (spec §6.2 "verified — worker-observed (test gate, denials, inventory)").
// These describe the environment, not the agent's claims, so they are filed for every finished run
// (done or not, page-proposed or not), are `verified`, and do not count against the 15-learning cap.
// They are built ONLY from structured fields the worker recorded itself: the test gate's status and
// exit code with the repository's configured test command, the guard's own deny code and the tool
// name from the lines the guard process wrote, and the init inventory's version, server names,
// sources and statuses. No agent-authored text (a command summary, a tool input, a tool result)
// ever reaches an entry. Every fact text also passes the instruction filter (defence in depth:
// server and tool names come from configuration a repository can control); a flagged fact is dropped.
//
// Every fact is keyed, so a later different outcome under the same key supersedes the old entry and
// the same outcome confirms it:
//   test:<command>          repo, build-test   "Worker test gate: `<command>` passed (exit 0)"
//   denied:<code>:<tool>    repo (else machine), pitfalls   "Under <access> access the Quill guard refused <tool> calls (<code>)"
//   tool:claude-code        machine, tools     "Claude Code <version> is installed"
//   connector:<name>        machine, connectors "MCP server <name> (source <source>) was <status>"
import { redactCapped } from '../handoff/stream.js';
import { instructionLike } from './instructions.js';

export const MAX_DENIAL_FACTS = 10;
export const MAX_CONNECTOR_FACTS = 50;
// Key prefixes only worker facts may use; an agent learning with one of them is re-keyed (file.js).
export const WORKER_KEY_PREFIXES = ['test:', 'denied:', 'tool:', 'connector:'];
const KEY_CHARS = 100;

// The guard's own refusal codes (src/gate/run-guard.js REASONS, bin/quill-guard.js REASONS), plus
// critical-change. Nothing else is ever filed, so a forged line cannot mint a code of its own.
export const GUARD_CODES = new Set([
  'grant-tampered', 'guard-error', 'no-commit-permission', 'no-edit-permission', 'no-pr-permission', 'no-push-permission', 'no-readonly-credentials',
  'outside-readable', 'outside-writable', 'protected-branch', 'protected-path', 'quill-privileged', 'unknown-prod', 'unparseable', 'untrusted-mcp-server',
  'wildcard-too-broad', 'wildcard-unchecked',
]);

const NAME = /^[\w.@-]{1,64}$/;
const TOOL = /^[\w.@-]{1,100}$/;
const WORD = /^[\w.-]{1,40}$/;
const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : 'unknown');
const key = (s) => s.slice(0, KEY_CHARS);

// A deny line the guard process itself wrote (bin/quill-guard.js): kind 'guard' with its own `ts`,
// `tool_name` and `reason`, and no tool output. The stream's 'guard' lines are read from tool result
// text (they carry `result_excerpt`), and Claude Code's permission denials carry no code: neither
// is used.
const isGuardLine = (l) => l.kind === 'guard' && l.decision === 'deny' && typeof l.ts === 'string' && typeof l.reason === 'string' && typeof l.tool_name === 'string' && !('result_excerpt' in l);

// The guard's code at the very start of its reason, when it is one of the guard's own codes.
function denyCode(reason) {
  const m = /^QUILL_DENIED ([a-z][a-z-]{0,59}):/.exec(reason);
  if (m) return GUARD_CODES.has(m[1]) ? m[1] : null;
  return /^QUILL_CRITICAL_CHANGE scope=/.test(reason) ? 'critical-change' : null;
}

function testGateFact(run, gate) {
  if (!gate || typeof gate !== 'object' || typeof run.repo_id !== 'string' || !run.repo_id) return null;
  const command = typeof gate.command === 'string' ? redactCapped(gate.command.replace(/\s+/g, ' ').trim(), 300) : '';
  if (!command) return null;
  const outcome = gate.status === 'passed' ? 'passed' : gate.status === 'failed' ? 'failed' : gate.status === 'timeout' ? 'timed out' : null;
  if (!outcome) return null;
  const exit = Number.isInteger(gate.exit_code) ? ` (exit ${gate.exit_code})` : '';
  return {
    scope: 'repo', section: 'build-test', kind: 'fact', key: key(`test:${command}`),
    text: `Worker test gate: \`${command}\` ${outcome}${exit}`,
    evidence: [`worker test gate on run ${run.id}: ${outcome}${exit}`],
  };
}

function denialFacts(run, ledger) {
  const out = new Map();
  const access = word(run.access ?? 'standard');
  for (const l of Array.isArray(ledger) ? ledger : []) {
    if (!l || typeof l !== 'object' || !isGuardLine(l) || !TOOL.test(l.tool_name)) continue;
    const code = denyCode(l.reason);
    if (!code) continue;
    const k = key(`denied:${code}:${l.tool_name}`);
    if (out.has(k)) continue;
    out.set(k, {
      scope: run.repo_id ? 'repo' : 'machine', section: 'pitfalls', kind: 'pitfall', key: k,
      // Access first: "change … autonomous access" would read as a request to widen access.
      text: `Under ${access} access the Quill guard refused ${l.tool_name} calls (${code})`,
      evidence: [`guard ledger of run ${run.id}`],
    });
    if (out.size >= MAX_DENIAL_FACTS) break;
  }
  return [...out.values()];
}

function inventoryFacts(run, inv) {
  if (!inv || typeof inv !== 'object') return [];
  const out = [];
  const at = typeof inv.at === 'string' ? inv.at.slice(0, 10) : '';
  if (typeof inv.version === 'string' && /^\d+\.\d+\.\d+$/.test(inv.version)) {
    out.push({ scope: 'machine', section: 'tools', kind: 'tool', key: 'tool:claude-code', text: `Claude Code ${inv.version} is installed`, evidence: [`init inventory of run ${run.id}${at ? ` (${at})` : ''}`] });
  }
  for (const s of (Array.isArray(inv.mcpServers) ? inv.mcpServers : []).slice(0, MAX_CONNECTOR_FACTS)) {
    // Server names come from configuration a repository can control (.mcp.json): plain names only.
    if (!s || typeof s.name !== 'string' || !NAME.test(s.name)) continue;
    out.push({ scope: 'machine', section: 'connectors', kind: 'tool', key: key(`connector:${s.name}`), text: `MCP server ${s.name} (source ${word(s.source)}) was ${word(s.status)}`, evidence: [`init inventory of run ${run.id}${at ? ` (${at})` : ''}`] });
  }
  return out;
}

/**
 * Worker-observed facts of one finished run, as filing candidates (trust `verified`, derived_from
 * `worker`). Pass them to fileLearnings({ workerFacts }) to file them through the same key and
 * dedupe rules.
 * @param {{ run: object, ledger?: object[], testGate?: object|null, inventory?: object|null }} opts
 */
export function workerLearnings({ run, ledger = [], testGate = null, inventory = null } = {}) {
  if (!run || typeof run.id !== 'string' || !run.id) return [];
  const facts = [testGateFact(run, testGate), ...denialFacts(run, ledger), ...inventoryFacts(run, inventory)].filter(Boolean);
  return facts.filter((f) => !instructionLike(f.text)).map((f) => ({ ...f, derived_from: 'worker', trust: 'verified' }));
}
