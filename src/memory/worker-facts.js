// Worker-observed memory (spec §6.2 "verified — worker-observed (test gate, denials, inventory)").
// These describe the environment, not the agent's claims, so they are filed for every finished run
// (done or not, page-proposed or not), are `verified`, and do not count against the 15-learning cap.
// They are built ONLY from structured fields the worker recorded itself: the test gate's status and
// exit code with the repository's configured test command, the guard's deny code and the tool name,
// and the init inventory's version, server names, sources and statuses. No agent-authored text (a
// command summary, a tool input, a result excerpt beyond the deny code) ever reaches an entry.
//
// Every fact is keyed, so a later different outcome under the same key supersedes the old entry and
// the same outcome confirms it:
//   test:<command>          repo, build-test   "Worker test gate: `<command>` passed (exit 0)"
//   denied:<code>:<tool>    repo (else machine), pitfalls   "<tool> calls were refused by the Quill guard (<code>) under <access> access"
//   tool:claude-code        machine, tools     "Claude Code <version> is installed"
//   connector:<name>        machine, connectors "MCP server <name> (source <source>) was <status>"
import { redactCapped } from '../handoff/stream.js';

export const MAX_DENIAL_FACTS = 10;
export const MAX_CONNECTOR_FACTS = 50;
const KEY_CHARS = 100;

const NAME = /^[\w.@-]{1,64}$/;
const TOOL = /^[\w.@-]{1,100}$/;
const WORD = /^[\w.-]{1,40}$/;
const CODE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : 'unknown');
const key = (s) => s.slice(0, KEY_CHARS);

// The guard's own refusal code from a deny line: `QUILL_DENIED <code>:` or a critical change.
function denyCode(line) {
  if (line.kind === 'denial') return 'permission-denied';
  for (const text of [line.reason, line.result_excerpt]) {
    if (typeof text !== 'string') continue;
    const m = /QUILL_DENIED ([a-z0-9][a-z0-9-]{0,59})\b/i.exec(text);
    if (m) return m[1].toLowerCase();
    if (/QUILL_CRITICAL_CHANGE\b/.test(text)) return 'critical-change';
  }
  return 'guard-denied';
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
    if (!l || typeof l !== 'object') continue;
    const refused = l.kind === 'denial' || (l.kind === 'guard' && l.decision === 'deny');
    if (!refused) continue;
    const tool = typeof l.tool_name === 'string' && l.tool_name ? l.tool_name : l.tool;
    if (typeof tool !== 'string' || !TOOL.test(tool)) continue;
    const code = denyCode(l);
    if (!CODE.test(code)) continue;
    const k = key(`denied:${code}:${tool}`);
    if (out.has(k)) continue;
    out.set(k, {
      scope: run.repo_id ? 'repo' : 'machine', section: 'pitfalls', kind: 'pitfall', key: k,
      text: `${tool} calls were refused by the Quill guard (${code}) under ${access} access`,
      evidence: [`ledger of run ${run.id}`],
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
  return facts.map((f) => ({ ...f, derived_from: 'worker', trust: 'verified' }));
}
