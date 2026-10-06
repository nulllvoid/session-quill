import fs from 'node:fs';
import path from 'node:path';
import { classifyShell } from './shell-grammar.js';

export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'Agent',
  'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ListAgents', 'Skill', 'ToolSearch', 'Monitor', 'NotebookRead']);
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SHELL_TOOLS = { Bash: 'bash', PowerShell: 'powershell' };

export const DENIAL_REASON = 'Session Quill: this session is not bound to a ticket. Run /session-quill:ticket bind <KEY> or /session-quill:ticket create "<title>" (or /session-quill:ticket off to disable the gate for this session).';
export const WORKER_UNAVAILABLE_REASON = 'Session Quill: quill worker unavailable or binding unreadable; covered writes are denied. Run `quill doctor` (or /session-quill:ticket off to disable the gate for this session).';

const QUILL_SUBCOMMANDS = new Set(['ticket', 'approve', 'dismiss', 'status', 'init', 'start', 'ui', 'doctor']);
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

// Narrow exemption: direct quill CLI invocations that change quill state, so a user can bind
// before source writes. Wrappers (bash -c, pipelines, substitutions) are not exempt.
export function isTrackerCliCommand(command) {
  if (typeof command !== 'string') return false;
  const tokens = splitArgs(command.trim());
  if (!tokens || tokens.length < 2) return false;
  let idx = 0;
  const first = tokens[0];
  if (first === 'node' || first === 'node.exe') {
    const script = tokens[1] ?? '';
    if (!/[\\/]bin[\\/]quill\.js$/.test(script)) return false;
    idx = 2;
  } else if (first === 'quill' || first === 'session-quill') {
    idx = 1;
  } else {
    return false;
  }
  const sub = tokens[idx];
  if (!QUILL_SUBCOMMANDS.has(sub)) return false;
  // Opening the local dashboard is a recovery action; writing an export is not.
  if (sub === 'ui' && tokens.slice(idx + 1).some((arg) => /^--static(?:=|$)/.test(arg))) return false;
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

// Canonical form for a path that may not exist yet (a `Write` creates its target): resolve the
// nearest existing ancestor and re-append the remaining segments. Without this, 8.3 short names
// or casing differences in the un-resolved spelling never match the resolved plan directory.
function canonicalPath(p) {
  const resolved = path.resolve(p);
  const direct = realpathOrNull(resolved);
  if (direct) return direct;
  const tail = [];
  let cursor = resolved;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    tail.unshift(path.basename(cursor));
    const real = realpathOrNull(parent);
    if (real) return path.join(real, ...tail);
    cursor = parent;
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
  const realPlan = canonicalPath(planPath);
  const realTarget = canonicalPath(file_path);
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

export function decideGate({ tool_name, tool_input = {}, binding, workerHealthy = true, gateEnabled = true, planPath = null, hostPlanDir = null, allowTools = [], mode = 'strict' }) {
  if (gateEnabled === false || mode === 'off') return { decision: 'none', reason: 'gate-off' };
  if (READ_TOOLS.has(tool_name)) return { decision: 'none', reason: 'read-tool' };
  if (Array.isArray(allowTools) && allowTools.includes(tool_name)) return { decision: 'none', reason: 'registered-non-mutating' };
  // Nudge never blocks a tool call; unlinked work is raised once at Stop instead (ADR 0005).
  if (mode === 'nudge') return { decision: 'none', reason: binding && binding.ticket_id ? 'bound' : 'nudge-unbound' };

  const shell = SHELL_TOOLS[tool_name];
  if (shell) {
    const command = tool_input && typeof tool_input.command === 'string' ? tool_input.command : '';
    if (shell === 'bash' && isTrackerCliCommand(command)) return { decision: 'none', reason: 'quill-cli' };
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
