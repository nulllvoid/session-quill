import { runHook, readStdinJson, HOOK_EVENTS } from '../../hooks/adapter.js';
import { READ_TOOLS } from '../../gate/decide.js';
import { readRuntimeIdentity } from '../../hooks/binding-snapshot.js';

const DENY = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// Without a readable tool call the hook cannot resolve the repository scope, so it fails closed
// when no identity is readable or any configured scope is not nudge (ADR 0005).
function failsClosed(env) {
  let identity = null;
  try { identity = readRuntimeIdentity(env); } catch { identity = null; }
  if (!identity) return true;
  const modes = [identity.gate_mode ?? 'strict', ...(Array.isArray(identity.repos) ? identity.repos.map((r) => (r && r.gate_mode) ?? 'strict') : [])];
  return modes.some((m) => m !== 'nudge');
}

// `quill hook <EventName>`: never throws out to the host. Non-gate hooks always exit 0 without a
// decision; a PreToolUse the hook cannot evaluate fails closed for covered tools (TRD §Durability 8).
export async function run({ args, io, env }) {
  const [eventName] = args;
  if (!HOOK_EVENTS.includes(eventName)) {
    io.error(`Session Quill: unsupported hook event ${eventName}`);
    return 0;
  }
  let input;
  try {
    const raw = await io.readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    io.error(`Session Quill: malformed hook input (${err.message})`);
    if (eventName === 'PreToolUse' && failsClosed(env)) io.out(DENY('Session Quill: the gate could not read this tool call (malformed hook input); covered operations are denied. Run `quill doctor`.'));
    return 0;
  }
  let result;
  try {
    result = runHook(eventName, input, { env });
  } catch (err) {
    io.error(`Session Quill: hook failure (${err.message})`);
    if (eventName === 'PreToolUse' && input && input.tool_name && !READ_TOOLS.has(input.tool_name) && failsClosed(env)) {
      io.out(DENY(`Session Quill: the gate failed while evaluating ${input.tool_name} (${err.message}); covered operations are denied. Run \`quill doctor\`.`));
    }
    return 0;
  }
  if (result.stdout) io.out(result.stdout);
  if (result.stderr) io.err(result.stderr);
  return result.exitCode ?? 0;
}

export { readStdinJson };
