import fs from 'node:fs';
import path from 'node:path';
import { classifyShell } from './shell-grammar.js';

export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'Agent',
  'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ListAgents', 'Skill', 'ToolSearch', 'Monitor', 'NotebookRead']);
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SHELL_TOOLS = { Bash: 'bash', PowerShell: 'powershell' };

export const DENIAL_REASON = 'Session Tracker: this session is not bound to a ticket. Run /session-tracker:ticket bind <KEY> or /session-tracker:ticket create "<title>" (or /session-tracker:ticket off to disable the gate for this session).';
export const WORKER_UNAVAILABLE_REASON = 'Session Tracker: tracker worker unavailable or binding unreadable; covered writes are denied. Run `tracker doctor` (or /session-tracker:ticket off to disable the gate for this session).';

const TRACKER_SUBCOMMANDS = new Set(['ticket', 'approve', 'dismiss', 'status', 'init', 'doctor']);
const TICKET_VERBS = new Set(['create', 'bind', 'show', 'off', 'on', 'relink', 'children', 'list']);
const UNSAFE_OUTSIDE_QUOTES = /[|&;<>$`(){}\n\r*?[\]~!]/;

function splitArgs(command) {
  const tokens = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (inQuote) {
      if (ch === '"') { inQuote = false; continue; }
      if (ch === '$' || ch === '`' || ch === '\n') return null;
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === "'") return null;
    if (ch === ' ') { if (cur) { tokens.push(cur); cur = ''; } continue; }
    if (UNSAFE_OUTSIDE_QUOTES.test(ch)) return null;
    cur += ch;
  }
  if (inQuote) return null;
  if (cur) tokens.push(cur);
  return tokens;
}

// Narrow exemption: direct tracker CLI invocations that change tracker state, so a user can bind
// before source writes. Wrappers (bash -c, pipelines, substitutions) are not exempt.
export function isTrackerCliCommand(command) {
  if (typeof command !== 'string') return false;
  const tokens = splitArgs(command.trim());
  if (!tokens || tokens.length < 2) return false;
  let idx = 0;
  const first = tokens[0];
  if (first === 'node' || first === 'node.exe') {
    const script = tokens[1] ?? '';
    if (!/[\\/]bin[\\/]tracker\.js$/.test(script)) return false;
    idx = 2;
  } else if (first === 'tracker' || first === 'session-tracker') {
    idx = 1;
  } else {
    return false;
  }
  const sub = tokens[idx];
  if (!TRACKER_SUBCOMMANDS.has(sub)) return false;
  if (sub === 'ticket') {
    const verb = tokens[idx + 1];
    if (!TICKET_VERBS.has(verb)) return false;
  }
  return true;
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function withinDir(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The plan-file exemption permits only the exact canonical host-designated plan path for this
// session, under the verified plan directory, excluding symlink/reparse escapes (TRD §Ticket gate).
export function isPlanFileWrite({ file_path, planPath, hostPlanDir }) {
  if (!file_path || !planPath || !hostPlanDir) return false;
  if (isSymlink(planPath) || isSymlink(file_path)) return false;
  const dir = realpathOrNull(hostPlanDir);
  if (!dir) return false;
  const resolvedPlan = path.resolve(planPath);
  const resolvedTarget = path.resolve(file_path);
  const realPlan = realpathOrNull(resolvedPlan) ?? resolvedPlan;
  const realTarget = realpathOrNull(resolvedTarget) ?? resolvedTarget;
  if (realPlan !== realTarget) return false;
  // The plan file must sit directly inside the verified plan directory.
  return withinDir(realPlan, dir) && path.dirname(realPlan) === dir;
}

function writeTargets(tool_name, tool_input) {
  if (!tool_input) return [];
  if (tool_name === 'NotebookEdit') return [tool_input.notebook_path].filter(Boolean);
  if (tool_name === 'MultiEdit') return [tool_input.file_path, ...(Array.isArray(tool_input.edits) ? tool_input.edits.map((e) => e.file_path) : [])].filter(Boolean);
  return [tool_input.file_path].filter(Boolean);
}

export function decideGate({ tool_name, tool_input = {}, binding, workerHealthy = true, gateEnabled = true, planPath = null, hostPlanDir = null, allowTools = [] }) {
  if (gateEnabled === false) return { decision: 'none', reason: 'gate-off' };
  if (READ_TOOLS.has(tool_name)) return { decision: 'none', reason: 'read-tool' };
  if (Array.isArray(allowTools) && allowTools.includes(tool_name)) return { decision: 'none', reason: 'registered-non-mutating' };

  const shell = SHELL_TOOLS[tool_name];
  if (shell) {
    const command = tool_input && typeof tool_input.command === 'string' ? tool_input.command : '';
    if (shell === 'bash' && isTrackerCliCommand(command)) return { decision: 'none', reason: 'tracker-cli' };
    const r = classifyShell(command, { shell });
    if (r.allowed) return { decision: 'none', reason: `read-only shell: ${r.form}` };
    if (!workerHealthy) return { decision: 'deny', reason: WORKER_UNAVAILABLE_REASON };
    if (binding && binding.ticket_id) return { decision: 'none', reason: 'bound' };
    return { decision: 'deny', reason: `${DENIAL_REASON} Shell command rejected by the read-only grammar: ${r.reason}.` };
  }

  if (WRITE_TOOLS.has(tool_name)) {
    const targets = writeTargets(tool_name, tool_input);
    if (targets.length && targets.every((t) => isPlanFileWrite({ file_path: t, planPath, hostPlanDir }))) {
      return { decision: 'none', reason: 'plan-file-exception' };
    }
  }

  if (!workerHealthy) return { decision: 'deny', reason: WORKER_UNAVAILABLE_REASON };
  if (binding && binding.ticket_id) return { decision: 'none', reason: 'bound' };
  return { decision: 'deny', reason: DENIAL_REASON };
}
