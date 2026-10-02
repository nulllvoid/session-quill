import { esc, attr, keyEl, sessionChip, timeEl, ticketById, pager, icon, emptyState, countLabel, normalizeSnapshot } from '../components.js';

export const SESSIONS_PAGE_SIZE = 50;

export function renderSessions(rawSnapshot, filters, { now, page = 0, selected = null }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  let sessions = [...snapshot.sessions];
  if (filters.machine) sessions = sessions.filter((s) => s.machine_name === filters.machine);
  if (filters.project) sessions = sessions.filter((s) => (s.project_ids ?? []).includes(filters.project) || s.ticket_ids.some((id) => (ticketById(snapshot, id) ?? {}).project_id === filters.project));
  if (filters.q) {
    const q = filters.q.toLowerCase();
    sessions = sessions.filter((s) => `${s.host_session_id} ${s.title ?? ''} ${s.machine_name} ${s.ticket_ids.map((id) => (ticketById(snapshot, id) ?? {}).key ?? '').join(' ')}`.toLowerCase().includes(q));
  }
  const order = { live: 0, idle: 1, extinct: 2, ended: 3 };
  sessions.sort((a, b) => (order[a.state] - order[b.state]) || (a.last_event_at < b.last_event_at ? 1 : -1));
  if (!sessions.length) return `<section class="view view-sessions" aria-labelledby="tab-sessions">${emptyState('No sessions recorded', 'Sessions appear when a Claude Code session with the plugin loaded starts. Live means recent activity, not a running process.')}</section>`;
  const pages = Math.ceil(sessions.length / SESSIONS_PAGE_SIZE);
  const rows = sessions.slice(page * SESSIONS_PAGE_SIZE, (page + 1) * SESSIONS_PAGE_SIZE).map((s) => {
    const current = s.current_ticket_id ? ticketById(snapshot, s.current_ticket_id) : null;
    const history = s.bindings.filter((b) => b.ticket_id && b.ticket_id !== s.current_ticket_id).map((b) => ticketById(snapshot, b.ticket_id)).filter(Boolean);
    const flags = [];
    if (s.unpromoted) flags.push(`<span class="chip warning" title="A complete checkpoint has not been approved or dismissed">${icon('alert')}Unpromoted checkpoint</span>`);
    if (s.gate_enabled === false) flags.push(`<span class="chip critical">${icon('alert')}Gate off</span>`);
    if (s.capture_health && s.capture_health.status !== 'ok') flags.push(`<span class="chip warning">${icon('alert')}Capture ${esc(s.capture_health.status)}${s.capture_health.reason ? `: ${esc(s.capture_health.reason)}` : ''}</span>`);
    return `<tr data-session="${attr(s.id)}">
  <td>${sessionChip(s.state)}</td>
  <td><div class="session-id">${esc(s.host_session_id)}${s.agent_id ? ` <span class="muted small">agent ${esc(s.agent_id)}</span>` : ''}</div>${s.title ? `<div class="small muted">${esc(s.title)}</div>` : ''}</td>
  <td>${current ? `<button type="button" class="link" data-open="${attr(current.id)}">${keyEl(current.key)}</button>` : '<span class="muted">Unbound</span>'}${history.length ? `<div class="small muted">Earlier: ${history.map((h) => `<button type="button" class="link" data-open="${attr(h.id)}">${esc(h.key)}</button>`).join(', ')}</div>` : ''}<div class="small muted">binding rev ${esc(s.current_binding_revision)}</div></td>
  <td>${esc(s.machine_name)}</td>
  <td>${timeEl(s.started_at, now, tz)}</td>
  <td>${esc(s.successful_write_count)} <span class="small muted">/ ${esc(s.change_coverage)}</span></td>
  <td class="preview">${s.last_checkpoint_preview ? `<span title="${attr(s.last_checkpoint_preview.slice(0, 300))}">${esc(s.last_checkpoint_preview.slice(0, 80))}${s.last_checkpoint_preview.length > 80 ? '…' : ''}</span>` : '<span class="muted">—</span>'}</td>
  <td>${flags.join(' ') || '<span class="muted">—</span>'}</td>
</tr>`;
  }).join('');
  const machines = [...new Set(snapshot.sessions.map((s) => s.machine_name))];
  return `<section class="view view-sessions" aria-labelledby="tab-sessions">
<p class="section-count">${esc(countLabel(sessions.length, 'session'))}${machines.length > 1 ? ` · <label>Machine <select data-filter="machine"><option value="">All</option>${machines.map((m) => `<option value="${attr(m)}" ${filters.machine === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}</p>
<div class="table-wrap"><table class="sessions"><thead><tr><th scope="col">State</th><th scope="col">Session</th><th scope="col">Binding</th><th scope="col">Machine</th><th scope="col">Started</th><th scope="col">Writes / coverage</th><th scope="col">Checkpoint</th><th scope="col">Indicators</th></tr></thead><tbody>${rows}</tbody></table></div>
${pager(page, pages, { prefix: 'sessions' })}
</section>`;
}
