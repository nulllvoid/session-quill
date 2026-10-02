// `tracker hook <Event>`: reads host JSON on stdin, persists ingress, and for PreToolUse emits the
// gate decision. No network, no model calls, no journal scans (TRD §Durability 8, ADR 0003).
import fs from 'node:fs';
import path from 'node:path';
import { makeEvent } from '../core/events.js';
import { writeIngress } from '../core/ingress.js';
import { putBlob } from '../core/blobs.js';
import { sessionKey } from '../core/state.js';
import { matchApprovalPhrase } from '../core/approval.js';
import { decideGate, WRITE_TOOLS, isPlanFileWrite, DENIAL_REASON } from '../gate/decide.js';
import { readBindingSnapshot, readHeartbeat, readRuntimeIdentity, readPlanClaim, writePlanClaim } from './binding-snapshot.js';
import { hostPlansDir, healthErrorsPath } from '../lib/paths.js';
import { ensureDir } from '../lib/atomic-fs.js';
import { nowIso } from '../lib/time.js';
import {
  sanitizeTitle, writePathsFor, commitFromBash, prFromBash, planFromExitPlanMode, extractConclusions, preview,
} from './payload.js';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'];

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function denyOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function contextOutput(eventName, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

function recordHealthError(env, record) {
  try {
    ensureDir(path.dirname(healthErrorsPath(env)));
    fs.appendFileSync(healthErrorsPath(env), JSON.stringify(record) + '\n');
  } catch { /* storage unavailable; nothing else to do */ }
}

function identityOf(input) {
  const session_id = typeof input.session_id === 'string' && SESSION_ID_RE.test(input.session_id) ? input.session_id : null;
  const agent_id = typeof input.agent_id === 'string' && SESSION_ID_RE.test(input.agent_id) ? input.agent_id : null;
  return { session_id, agent_id };
}

function persist(ev, env, result, { covered = false } = {}) {
  try {
    const receipt = writeIngress(ev, env);
    result.persisted = true;
    if (receipt.slow) {
      result.stderr += `Session Tracker: capture took ${receipt.elapsed} ms (budget 1000 ms)\n`;
      recordHealthError(env, { at: ev.occurred_at, kind: 'slow-capture', elapsed: receipt.elapsed, event_id: ev.event_id });
    }
    return true;
  } catch (err) {
    result.persisted = false;
    result.stderr += `Session Tracker: capture gap — could not persist ${ev.kind} event (${err.message}). Run \`tracker doctor\`.\n`;
    recordHealthError(env, { at: ev.occurred_at, kind: 'capture-gap', event_kind: ev.kind, error: err.message });
    if (covered) {
      result.stdout = denyOutput('Session Tracker: capture storage unavailable; covered writes are denied until `tracker doctor` reports healthy storage (or /session-tracker:ticket off).');
    }
    return false;
  }
}

function bindingContext(snapshot, session_id) {
  if (snapshot && snapshot.ticket_id) {
    return `Session Tracker session: ${session_id}. Bound to ${snapshot.ticket_key}${snapshot.ticket_title ? ` (${snapshot.ticket_title})` : ''}, binding revision ${snapshot.binding_revision}. Supported writes are permitted. Use /session-tracker:ticket show for details.`;
  }
  const gateNote = snapshot && snapshot.gate_enabled === false ? 'Ticket gate is OFF for this session (audited).' : 'Ticket gate is ON: supported write tools are denied until bound.';
  return `Session Tracker session: ${session_id}. This session is unbound. ${gateNote} Run /session-tracker:ticket create "<title>" or /session-tracker:ticket bind <KEY>; pass --session ${session_id} to the tracker CLI.`;
}

export function runHook(eventName, input, { env = process.env, now } = {}) {
  const result = { exitCode: 0, stdout: '', stderr: '', persisted: null };
  const occurred_at = now ?? nowIso();
  if (!input || typeof input !== 'object') {
    result.stderr += 'Session Tracker: malformed hook input\n';
    return result;
  }
  const identity = readRuntimeIdentity(env);
  const { session_id, agent_id } = identityOf(input);
  const covered = eventName === 'PreToolUse' && !!input.tool_name && !['Read', 'Glob', 'Grep'].includes(input.tool_name);

  if (!identity) {
    result.stderr += 'Session Tracker: not initialized; run `tracker init` to enable capture and the ticket gate.\n';
    return result;
  }
  if (!session_id) {
    result.stderr += 'Session Tracker: hook input has no session_id; identity unresolved (no cwd fallback).\n';
    if (covered && WRITE_TOOLS.has(input.tool_name)) result.stdout = denyOutput(`${DENIAL_REASON} (host provided no session identity)`);
    return result;
  }

  const key = sessionKey({ session_id, agent_id });
  const base = { store_id: identity.store_id, machine_id: identity.machine_id, producer: 'hook', session_id, agent_id, occurred_at };
  // A handoff agent session runs with TRACKER_HANDOFF_* set by the worker: its tool calls are
  // attributed to the handoff's ticket instead of being gated as unbound.
  const handoff = env.TRACKER_HANDOFF_ID && env.TRACKER_HANDOFF_TICKET_ID
    ? { id: env.TRACKER_HANDOFF_ID, ticket_id: env.TRACKER_HANDOFF_TICKET_ID, ticket_key: env.TRACKER_HANDOFF_TICKET_KEY ?? null }
    : null;
  let snapshot = readBindingSnapshot(key, env);
  if (handoff && !(snapshot && snapshot.ticket_id)) {
    snapshot = { ticket_id: handoff.ticket_id, ticket_key: handoff.ticket_key, ticket_title: null, binding_revision: snapshot ? snapshot.binding_revision ?? 0 : 0, gate_enabled: true, handoff_id: handoff.id };
  }
  const gateEnabled = identity.gate_enabled !== false && !(snapshot && snapshot.gate_enabled === false);

  switch (eventName) {
    case 'SessionStart': {
      const ev = makeEvent({ ...base, kind: 'session-start', payload: { source: input.source ?? 'startup', cwd: input.cwd ?? null, agent_type: input.agent_type ?? null, handoff_id: handoff ? handoff.id : null }, source_identity: `session-start:${key}:${input.source ?? 'startup'}:${occurred_at}` });
      persist(ev, env, result);
      if (handoff) {
        const bind = makeEvent({ ...base, kind: 'bind', payload: { ticket_id: handoff.ticket_id, project_id: null, handoff_id: handoff.id }, ticket_id: handoff.ticket_id, source_identity: `bind:${key}:handoff:${handoff.id}` });
        persist(bind, env, result);
        result.stdout = contextOutput('SessionStart', `Session Tracker session: ${session_id}. This is handoff ${handoff.id} for ticket ${handoff.ticket_key ?? handoff.ticket_id}; tool activity is attributed to that ticket. Permissions are limited to what the handoff request granted.`);
        return result;
      }
      result.stdout = contextOutput('SessionStart', bindingContext(snapshot, session_id));
      return result;
    }
    case 'UserPromptSubmit': {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      const ev = makeEvent({ ...base, kind: 'prompt', payload: {
        title_candidate: sanitizeTitle(prompt) || null,
        approval_candidate: identity.approval_phrases_enabled === true && matchApprovalPhrase(prompt),
        length: prompt.length,
      } });
      persist(ev, env, result);
      return result;
    }
    case 'PreToolUse': {
      const tool_name = input.tool_name;
      const tool_call_id = typeof input.tool_use_id === 'string' ? input.tool_use_id : null;
      const hb = readHeartbeat(env, occurred_at);
      let planPath = null;
      const planDir = hostPlansDir(env);
      if (WRITE_TOOLS.has(tool_name) && input.permission_mode === 'plan') {
        const claim = readPlanClaim(key, env);
        const target = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
        if (claim && claim.plan_path) planPath = claim.plan_path;
        else if (target && isPlanFileWrite({ file_path: target, planPath: target, hostPlanDir: planDir })) {
          planPath = target;
          try { writePlanClaim(key, target, env); } catch { /* best effort */ }
        }
      }
      const gate = decideGate({ tool_name, tool_input: input.tool_input ?? {}, binding: snapshot ?? { ticket_id: null, binding_revision: 0 }, workerHealthy: hb.healthy, gateEnabled, planPath, hostPlanDir: planDir, allowTools: identity.allow_tools ?? [] });
      const denied = gate.decision === 'deny';
      const ev = makeEvent({
        ...base, kind: 'pre-tool', tool_call_id,
        ticket_id: snapshot && snapshot.ticket_id ? snapshot.ticket_id : null,
        binding_revision: snapshot ? snapshot.binding_revision ?? null : null,
        payload: { tool_name, denied, gate_reason: gate.reason && !denied ? gate.reason : null, write_target: summarizeTarget(tool_name, input.tool_input), gate_enabled: gateEnabled },
        source_identity: tool_call_id ? `pre-tool:${key}:${tool_call_id}` : undefined,
      });
      if (denied) result.stdout = denyOutput(gate.reason);
      persist(ev, env, result, { covered: covered && !denied && WRITE_TOOLS.has(tool_name) });
      return result;
    }
    case 'PostToolUse': {
      const tool_name = input.tool_name;
      const tool_call_id = typeof input.tool_use_id === 'string' ? input.tool_use_id : null;
      const tool_input = input.tool_input ?? {};
      const response = input.tool_response ?? input.tool_output ?? null;
      const payload = { tool_name, success: true, write_paths: writePathsFor(tool_name, tool_input, input.cwd), commit: null, pr: null, plan_ref: null, plan_preview: null, repo_id: null };
      if (tool_name === 'Bash' || tool_name === 'PowerShell') {
        payload.commit = commitFromBash(tool_input.command, response);
        payload.pr = prFromBash(tool_input.command, response);
      }
      if (tool_name === 'ExitPlanMode') {
        const plan = planFromExitPlanMode(tool_input, response);
        if (plan) {
          try {
            payload.plan_ref = putBlob(plan, env).hash;
            payload.plan_preview = preview(plan);
          } catch (err) {
            result.stderr += `Session Tracker: capture gap — plan blob not stored (${err.message})\n`;
          }
        }
      }
      const ev = makeEvent({ ...base, kind: 'post-tool', tool_call_id, payload, source_identity: tool_call_id ? `post-tool:${key}:${tool_call_id}` : undefined });
      persist(ev, env, result);
      return result;
    }
    case 'PostToolUseFailure': {
      const tool_call_id = typeof input.tool_use_id === 'string' ? input.tool_use_id : null;
      const ev = makeEvent({ ...base, kind: 'tool-failure', tool_call_id, payload: { tool_name: input.tool_name, error: typeof input.error === 'string' ? input.error.slice(0, 300) : null, write_paths: writePathsFor(input.tool_name, input.tool_input ?? {}, input.cwd) }, source_identity: tool_call_id ? `tool-failure:${key}:${tool_call_id}` : undefined });
      persist(ev, env, result);
      return result;
    }
    case 'Stop':
    case 'SubagentStop': {
      const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
      let content_ref = null;
      let complete = false;
      if (message !== null) {
        try {
          content_ref = putBlob(message, env).hash;
          complete = true;
        } catch (err) {
          result.stderr += `Session Tracker: capture gap — checkpoint blob not stored (${err.message})\n`;
        }
      }
      const ev = makeEvent({ ...base, kind: eventName === 'Stop' ? 'stop' : 'subagent-stop', payload: {
        content_ref, preview: preview(message ?? ''), length: message ? message.length : 0, complete, conclusions: complete ? extractConclusions(message) : [], agent_type: input.agent_type ?? null,
      }, source_identity: `${eventName === 'Stop' ? 'stop' : 'subagent-stop'}:${key}:${content_ref ?? 'missing'}:${occurred_at}` });
      persist(ev, env, result);
      return result;
    }
    case 'SubagentStart': {
      const ev = makeEvent({ ...base, kind: 'subagent-start', payload: { agent_id, agent_type: input.agent_type ?? null, parent_session_id: session_id } });
      persist(ev, env, result);
      return result;
    }
    case 'PreCompact': {
      const ev = makeEvent({ ...base, kind: 'pre-compact', payload: { trigger: input.trigger ?? 'auto' } });
      persist(ev, env, result);
      return result;
    }
    case 'SessionEnd': {
      const ev = makeEvent({ ...base, kind: 'session-end', payload: { reason: input.reason ?? 'other' } });
      persist(ev, env, result);
      return result;
    }
    default:
      result.stderr += `Session Tracker: unsupported hook event ${eventName}\n`;
      return result;
  }
}

function summarizeTarget(tool_name, tool_input) {
  if (!tool_input) return null;
  if (tool_input.file_path) return String(tool_input.file_path).slice(0, 300);
  if (tool_input.notebook_path) return String(tool_input.notebook_path).slice(0, 300);
  if (typeof tool_input.command === 'string') return tool_input.command.slice(0, 120);
  return null;
}

export async function readStdinJson(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}
