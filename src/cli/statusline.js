// The status-line segment: one line naming the session's ticket, the gate when it is off, plan
// drift (ADR 0037), and the worker's health or dashboard link. `quill status --statusline` and the lean `scripts/statusline.js`
// entry both print `statusLine(ctx, input)`, so the line is built in one place. This module stays
// off the command table on purpose: the host runs the status line on every refresh, and module
// loading is most of its latency (ADR 0034). It reads the binding snapshot, the heartbeat and the
// dashboard endpoint file; never the journal or the snapshot projection.
import { workerStatus, liveEndpoint, portFallbackNote } from './context.js';
import { readBindingSnapshot } from '../hooks/binding-snapshot.js';
import { sessionKey } from '../core/state.js';
import { driftSuffix } from '../core/planned-paths.js';

// The dashboard address as an OSC 8 hyperlink (ADR 0022). Only the base URL: the sign-in secret
// never appears in the status line.
function dashboardLink(ctx) {
  const endpoint = liveEndpoint(ctx);
  if (!endpoint) return '';
  const url = `http://${endpoint.host}:${endpoint.port}/`;
  const osc = '\u001b]8;;';
  const st = '\u001b\\';
  const note = portFallbackNote(endpoint);
  return ` ${osc}${url}${st}${url}${osc}${st}${note ? ` ⚠ ${note}` : ''}`;
}

export function bindingFor(ctx, session) {
  if (!session) return null;
  return readBindingSnapshot(sessionKey(session), ctx.env);
}

/** The status-line text for Claude Code's status-line JSON `input` (already parsed). */
export function statusLine(ctx, input) {
  if (!ctx.initialized) return '⌁ quill: not initialized';
  const session = input.session_id ? { session_id: input.session_id, agent_id: null } : null;
  const b = bindingFor(ctx, session);
  const ws = workerStatus(ctx);
  const warn = `${driftSuffix(b && b.drift_count)}${ws.healthy ? dashboardLink(ctx) : ' ⚠ worker'}`;
  if (b && b.ticket_id) return `⌁ ${b.ticket_key} ${b.ticket_title ?? ''}${b.gate_enabled === false ? ' (gate off)' : ''}${warn}`.trim();
  return `⌁ unbound${b && b.gate_enabled === false ? ' (gate off)' : ''}${warn}`;
}

/** Status-line JSON from stdin; anything unreadable counts as `{}`. */
export function parseStatusInput(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
