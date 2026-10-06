// `quill hook <Event>`: reads host JSON on stdin, persists ingress, and for PreToolUse emits the
// gate decision. No network, no model calls, no journal scans (TRD §Durability 8, ADR 0003).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEvent } from '../core/events.js';
import { writeIngress } from '../core/ingress.js';
import { putBlob } from '../core/blobs.js';
import { sessionKey } from '../core/state.js';
import { matchApprovalPhrase } from '../core/approval.js';
import { decideGate, WRITE_TOOLS, READ_TOOLS, isPlanFileWrite, DENIAL_REASON } from '../gate/decide.js';
import { readBindingSnapshot, readHeartbeat, readRuntimeIdentity, readPlanClaim, writePlanClaim, writeBindingSnapshot, bindingSnapshotPath } from './binding-snapshot.js';
import { scopeFor } from './scope.js';
import { planAutoBind } from './autobind.js';
import { markUnboundWork, shouldNudge, markNudged, nudgeReason } from './nudge.js';
import { keyExample, renderUrl, externalTicketId, branchTitle } from '../core/external-keys.js';
import { currentBranch } from '../lib/git-head.js';
import { hostPlansDir, healthErrorsPath } from '../lib/paths.js';
import { ensureDir, removeIfExists } from '../lib/atomic-fs.js';
import { nowIso } from '../lib/time.js';
import {
  sanitizeTitle, writePathsFor, commitFromBash, prFromBash, planFromExitPlanMode, extractConclusions, preview,
} from './payload.js';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'];

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const bundledCli = fileURLToPath(new URL('../../bin/quill.js', import.meta.url)).replaceAll('\\', '/');

function taskContext(session_id) {
  return `Session Quill task tracking: tickets represent tasks, not sessions or individual prompts. Before substantive work on a distinct task, inspect existing tickets with node ${JSON.stringify(bundledCli)} ticket list --json. Reuse the matching task with ticket bind <KEY> --session ${session_id}, or run ticket work "<concise task title>" --session ${session_id} to reuse/create and bind an open task. Use --category feature for FEAT or --category bugfix for FIX; other tasks use DEV. Keep follow-up questions, corrections, retries, and approvals on the same task. Switch bindings before working on another task; switching never moves earlier activity. A task can span multiple sessions. Do not create tickets just for session startup, greetings, or status questions. Do not ask the user to do routine local ticket setup. Never treat a binding as permission to commit, push, or deploy.`;
}

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
      result.stderr += `Session Quill: capture took ${receipt.elapsed} ms (budget 1000 ms)\n`;
      recordHealthError(env, { at: ev.occurred_at, kind: 'slow-capture', elapsed: receipt.elapsed, event_id: ev.event_id });
    }
    return true;
  } catch (err) {
    result.persisted = false;
    result.stderr += `Session Quill: capture gap — could not persist ${ev.kind} event (${err.message}). Run \`quill doctor\`.\n`;
    recordHealthError(env, { at: ev.occurred_at, kind: 'capture-gap', event_kind: ev.kind, error: err.message });
    if (covered) {
      result.stdout = denyOutput('Session Quill: capture storage unavailable; covered writes are denied until `quill doctor` reports healthy storage (or /session-quill:ticket off).');
    }
    return false;
  }
}

function bindingContext(snapshot, session_id, mode, tracker) {
  if (snapshot && snapshot.ticket_id) {
    const title = snapshot.ticket_title && snapshot.ticket_title !== snapshot.ticket_key ? ` (${snapshot.ticket_title})` : '';
    return `Session Quill session: ${session_id}. Bound to ${snapshot.ticket_key}${title}, binding revision ${snapshot.binding_revision}. Supported writes are permitted. Use /session-quill:ticket show for details.`;
  }
  const gateNote = mode === 'off'
    ? 'Ticket gate is OFF for this session (audited).'
    : mode === 'nudge'
      ? 'Writes are not blocked (gate mode nudge); unlinked work is raised once at the end of a turn.'
      : 'Ticket gate is ON: supported write tools are denied until bound.';
  const how = tracker ? `Mention a ticket key (for example ${keyExample(tracker)}) in a prompt to link this session, or run` : 'Run';
  return `Session Quill session: ${session_id}. This session is unbound. ${gateNote} ${how} /session-quill:ticket create "<title>" or /session-quill:ticket bind <KEY>; pass --session ${session_id} to the quill CLI.`;
}

// Writes the provisional snapshot before the bind event so the worker's confirmation always lands
// after it; if the event cannot be persisted, the previous snapshot is restored (ADR 0005).
function autoBind({ plan, source, titleHint, base, key, snapshot, scope, identity, env, result, occurred_at }) {
  const tracker = scope.tracker;
  const ticket_id = externalTicketId(identity.store_id, plan.key);
  const ev = makeEvent({
    ...base, kind: 'bind', ticket_id: plan.ensure_only ? null : ticket_id,
    payload: { external: { system: tracker.system, key: plan.key, url: renderUrl(plan.key, tracker) }, source, title_hint: titleHint || null, project_id: scope.project_id, repo_id: scope.repo_id, ensure_only: plan.ensure_only },
    source_identity: `bind:${key}:${source}:${plan.key}:${occurred_at}`,
  });
  if (!plan.ensure_only) {
    try {
      writeBindingSnapshot(key, {
        session_id: snapshot ? snapshot.session_id ?? null : null, ticket_id, ticket_key: plan.key, ticket_title: titleHint || plan.key, ticket_aliases: [],
        project_id: scope.project_id, binding_revision: (snapshot ? snapshot.binding_revision ?? 0 : 0) + 1, gate_enabled: !(snapshot && snapshot.gate_enabled === false),
        has_title: !!(snapshot && snapshot.has_title), provisional: true, provisional_event_id: ev.event_id, provisional_at: occurred_at,
      }, env);
    } catch (err) {
      result.stderr += `Session Quill: provisional binding not written (${err.message})\n`;
    }
  }
  if (persist(ev, env, result)) return true;
  if (!plan.ensure_only) {
    try {
      if (snapshot) writeBindingSnapshot(key, snapshot, env);
      else removeIfExists(bindingSnapshotPath(key, env));
    } catch { /* nothing more to restore */ }
  }
  return false;
}

export function runHook(eventName, input, { env = process.env, now } = {}) {
  const result = { exitCode: 0, stdout: '', stderr: '', persisted: null };
  const occurred_at = now ?? nowIso();
  if (!input || typeof input !== 'object') {
    result.stderr += 'Session Quill: malformed hook input\n';
    return result;
  }
  const identity = readRuntimeIdentity(env);
  const { session_id, agent_id } = identityOf(input);
  // Every tool outside the dedicated read set is "covered".
  const toolCovered = eventName === 'PreToolUse' && !!input.tool_name && !READ_TOOLS.has(input.tool_name) && !(identity && Array.isArray(identity.allow_tools) && identity.allow_tools.includes(input.tool_name));

  if (!identity) {
    if (eventName === 'SessionStart') result.stdout = contextOutput('SessionStart', `Session Quill session: ${session_id ?? 'unknown'}. Quill is not enabled yet. If the user wants tracking, run /session-quill:start. Do not interrupt normal work or claim activity is being captured.`);
    return result;
  }
  const scope = scopeFor(identity, input.cwd);
  if (!session_id) {
    result.stderr += 'Session Quill: hook input has no session_id; identity unresolved (no cwd fallback).\n';
    if (toolCovered && scope.gate_mode !== 'nudge') result.stdout = denyOutput(`${DENIAL_REASON} (host provided no session identity)`);
    return result;
  }

  const key = sessionKey({ session_id, agent_id });
  const base = { store_id: identity.store_id, machine_id: identity.machine_id, producer: 'hook', session_id, agent_id, occurred_at };
  // A handoff agent session runs with QUILL_HANDOFF_* set by the worker: its tool calls are
  // attributed to the handoff's ticket instead of being gated as unbound.
  const handoff = env.QUILL_HANDOFF_ID && env.QUILL_HANDOFF_TICKET_ID
    ? { id: env.QUILL_HANDOFF_ID, ticket_id: env.QUILL_HANDOFF_TICKET_ID, ticket_key: env.QUILL_HANDOFF_TICKET_KEY ?? null }
    : null;
  let snapshot = readBindingSnapshot(key, env);
  if (handoff && !(snapshot && snapshot.ticket_id)) {
    snapshot = { ticket_id: handoff.ticket_id, ticket_key: handoff.ticket_key, ticket_title: null, binding_revision: snapshot ? snapshot.binding_revision ?? 0 : 0, gate_enabled: true, handoff_id: handoff.id };
  }
  const gateEnabled = identity.gate_enabled !== false && !(snapshot && snapshot.gate_enabled === false);
  const mode = gateEnabled ? scope.gate_mode : 'off';
  // Capture failures fail closed for covered tools except in nudge mode, which never blocks.
  const covered = toolCovered && scope.gate_mode !== 'nudge';

  switch (eventName) {
    case 'SessionStart': {
      const ev = makeEvent({ ...base, kind: 'session-start', payload: { source: input.source ?? 'startup', cwd: input.cwd ?? null, agent_type: input.agent_type ?? null, handoff_id: handoff ? handoff.id : null }, source_identity: `session-start:${key}:${input.source ?? 'startup'}:${occurred_at}` });
      persist(ev, env, result);
      if (handoff) {
        const bind = makeEvent({ ...base, kind: 'bind', payload: { ticket_id: handoff.ticket_id, project_id: null, handoff_id: handoff.id }, ticket_id: handoff.ticket_id, source_identity: `bind:${key}:handoff:${handoff.id}` });
        persist(bind, env, result);
        result.stdout = contextOutput('SessionStart', `Session Quill session: ${session_id}. This is handoff ${handoff.id} for ticket ${handoff.ticket_key ?? handoff.ticket_id}; tool activity is attributed to that ticket. Permissions are limited to what the handoff request granted.`);
        return result;
      }
      let current = snapshot;
      if (!(current && current.ticket_id) && scope.tracker) {
        const branch = currentBranch(input.cwd);
        const plan = branch ? planAutoBind({ source: 'branch', text: branch, snapshot: current, tracker: scope.tracker }) : null;
        if (plan && autoBind({ plan, source: 'branch', titleHint: branchTitle(branch, plan.key), base, key, snapshot: current, scope, identity, env, result, occurred_at })) current = readBindingSnapshot(key, env);
      }
      result.stdout = contextOutput('SessionStart', `${bindingContext(current, session_id, mode, scope.tracker)} ${taskContext(session_id)}`);
      return result;
    }
    case 'UserPromptSubmit': {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      // Only the first prompt of a session contributes a title; later prompts are inspected for
      // approval matching only and no text is retained (TRD §Capture and approval).
      const needsTitle = !(snapshot && snapshot.has_title);
      const ev = makeEvent({ ...base, kind: 'prompt', payload: {
        title_candidate: needsTitle ? (sanitizeTitle(prompt) || null) : null,
        approval_candidate: identity.approval_phrases_enabled === true && matchApprovalPhrase(prompt),
        length: prompt.length,
      } });
      persist(ev, env, result);
      const context = [];
      // A session started before `quill init` (or whose SessionStart was missed) learns its id here.
      if (!snapshot) context.push(bindingContext(null, session_id, mode, scope.tracker));
      if (!handoff) {
        const plan = planAutoBind({ source: 'prompt', text: prompt, snapshot, tracker: scope.tracker });
        if (plan && autoBind({ plan, source: 'prompt', titleHint: sanitizeTitle(prompt), base, key, snapshot, scope, identity, env, result, occurred_at }) && !plan.ensure_only) {
          const was = snapshot && snapshot.ticket_id ? ` (previously ${snapshot.ticket_key})` : '';
          context.length = 0;
          context.push(`Session Quill session: ${session_id}. Linked to ${plan.key}${was} because the prompt mentions it; captured work is attributed to it from now on.`);
        }
      }
      if (!handoff) context.push(taskContext(session_id));
      if (context.length) result.stdout = contextOutput('UserPromptSubmit', context.join(' '));
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
        const target = input.tool_input && input.tool_input.file_path;
        if (claim && claim.plan_path) planPath = claim.plan_path;
        // The claim is narrow: the first `Write` of a Markdown file directly inside the verified
        // plan directory while in plan mode (ADR 0004). Edits, other tools and other file types never claim.
        else if (tool_name === 'Write' && typeof target === 'string' && /\.md$/i.test(target) && isPlanFileWrite({ file_path: target, planPath: target, hostPlanDir: planDir })) {
          planPath = target;
          try { writePlanClaim(key, target, env); } catch { /* best effort */ }
        }
      }
      const gate = decideGate({ tool_name, tool_input: input.tool_input ?? {}, binding: snapshot ?? { ticket_id: null, binding_revision: 0 }, workerHealthy: hb.healthy, gateEnabled, planPath, hostPlanDir: planDir, allowTools: identity.allow_tools ?? [], mode });
      const denied = gate.decision === 'deny';
      const reason = denied && scope.tracker ? `${gate.reason} Mentioning a ticket key such as ${keyExample(scope.tracker)} in a prompt also links the session.` : gate.reason;
      const ev = makeEvent({
        ...base, kind: 'pre-tool', tool_call_id,
        ticket_id: snapshot && snapshot.ticket_id ? snapshot.ticket_id : null,
        binding_revision: snapshot ? snapshot.binding_revision ?? null : null,
        payload: { tool_name, denied, gate_reason: gate.reason && !denied ? gate.reason : null, write_target: summarizeTarget(tool_name, input.tool_input), gate_enabled: gateEnabled, gate_mode: mode },
        source_identity: tool_call_id ? `pre-tool:${key}:${tool_call_id}` : undefined,
      });
      if (denied) result.stdout = denyOutput(reason);
      persist(ev, env, result, { covered: covered && !denied && gate.reason !== 'read-tool' && !/^read-only shell/.test(gate.reason ?? '') && gate.reason !== 'quill-cli' && gate.reason !== 'plan-file-exception' });
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
            result.stderr += `Session Quill: capture gap — plan blob not stored (${err.message})\n`;
          }
        }
      }
      if (mode === 'nudge' && !(snapshot && snapshot.ticket_id) && (payload.write_paths.length || payload.commit)) {
        try { markUnboundWork(key, env, occurred_at); } catch { /* best effort; never blocks capture */ }
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
          result.stderr += `Session Quill: capture gap — checkpoint blob not stored (${err.message})\n`;
        }
      }
      const nudge = eventName === 'Stop' && mode === 'nudge' && !(snapshot && snapshot.ticket_id) && input.stop_hook_active !== true && shouldNudge(key, env);
      const ev = makeEvent({ ...base, kind: eventName === 'Stop' ? 'stop' : 'subagent-stop', payload: {
        content_ref, preview: preview(message ?? ''), length: message ? message.length : 0, complete, conclusions: complete ? extractConclusions(message) : [], agent_type: input.agent_type ?? null, nudged: nudge,
      }, source_identity: `${eventName === 'Stop' ? 'stop' : 'subagent-stop'}:${key}:${content_ref ?? 'missing'}:${occurred_at}` });
      persist(ev, env, result);
      if (nudge) {
        try { markNudged(key, env, occurred_at); } catch { /* stop_hook_active still prevents a loop */ }
        result.stdout = JSON.stringify({ decision: 'block', reason: nudgeReason(scope.tracker) });
      }
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
      result.stderr += `Session Quill: unsupported hook event ${eventName}\n`;
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
